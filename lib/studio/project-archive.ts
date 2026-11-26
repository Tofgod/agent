import { recordModelRequest } from "./model-request-record";
import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import type { BlobStore } from "./storage";
import type { AgentImage, AgentMessage } from "./types";
import { now, uid, type Store } from "./store";
import { z } from "zod";
import { AppError } from "./security";
import { projectOutputPath, projectTrashPath, projectWorkingDirectory } from "./project-layout";
import { openStudioZip, streamZip, type ZipEntry } from "./zip";
import { leadAgentId } from "./agent-identity";
import { JOB_OUTPUT_RETAIN_BYTES, type JobOutputChannel } from "./background-jobs";
import { replaySession, type SessionEntry, type SessionPatch } from "./session-journal";
import { presetInput } from "./session-presets";
import { parseToolArguments } from "./tool-history";
import { committedRunEvent, runBoundaries } from "./session-fork";

type ArchiveFile = { id: string; path: string | null; version: number; content: string; metadata: string; kind: string | null };

function archiveFilePath(folder: string, path: string) {
  const segments = path.replace(/^\/+/, "").split("/");
  if (segments.some((part) => !part || part === "." || part === ".." || /[\\:\u0000-\u001f]/.test(part)))
    throw new AppError("归档包含无效文件路径", 409);
  return folder + "/" + segments.join("/");
}

export function projectArchive(store: Store, projectId: string, bucket: BlobStore | undefined) {
  const snapshot = store.db.read(() => {
    const files = store.db.prepare("SELECT id,path,version,content,metadata,kind,status,locked,created_at,updated_at FROM artifacts WHERE project_id=? ORDER BY path")
      .bind(projectId).rows<ArchiveFile>();
    const versions = store.db.prepare(`SELECT v.artifact_id AS id,v.path,v.version,v.content,v.metadata,v.kind,v.created_at,v.run_id,v.previous_path
      FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE a.project_id=? ORDER BY v.rowid`)
      .bind(projectId).rows<ArchiveFile>();
    const messages = store.db.prepare("SELECT * FROM messages WHERE project_id=? ORDER BY rowid").bind(projectId).rows();
    const tasks = store.db.prepare(`SELECT id,session_id,parent_run_id,agent_role,status,stage,label,error,result_text,created_at,updated_at,
      background,progress,COALESCE(json_extract(payload,'$.operation.path'),json_extract(payload,'$.archivedOutputPath')) AS background_path,
      EXISTS(SELECT 1 FROM background_job_truncation f WHERE f.job_id=runs.id) AS output_truncated,
      json_extract(payload,'$.sourceVersions') AS source_versions,json_extract(payload,'$.operation') AS operation,
      json_extract(payload,'$.providerModel') AS provider_model,json_extract(payload,'$.batch') AS batch,
      json_extract(payload,'$.forkChanges') AS fork_changes,json_extract(payload,'$.inherited') AS inherited,
      json_extract(payload,'$.forkSource') AS fork_source,turn_preset,
      COALESCE(json_extract(payload,'$.childExecution.cwd'),json_extract(payload,'$.workingDirectory')) AS working_directory
      FROM runs WHERE project_id=? ORDER BY rowid`).bind(projectId).rows();
    const jobOutput = store.db.prepare(`SELECT o.job_id,o.line,o.created_at,o.channel,o.fragment
      FROM runs r JOIN background_job_output o ON o.job_id=r.id WHERE r.project_id=? AND r.background=1 ORDER BY o.seq`)
      .bind(projectId).rows<{ job_id: string; line: string; created_at: string; channel: JobOutputChannel; fragment: number }>();
    const replies = store.db.prepare(`SELECT c.id,c.run_id,c.visible_text AS content,c.status,c.created_at,c.settled_at,c.first_output_at,c.last_output_at,c.error_code,c.usage,c.response,c.request AS request_meta,c.request_header_id,
      json_extract(c.request,'$.purpose') AS purpose,json_extract(c.request,'$.turn') AS turn,
      json_extract(c.request,'$.step') AS step,json_extract(c.request,'$.attempt') AS attempt,json_extract(c.request,'$.model') AS model
      FROM model_calls c JOIN runs r ON r.id=c.run_id WHERE r.project_id=? ORDER BY c.rowid`)
      .bind(projectId).rows<Record<string, unknown> & { usage: string | null; response: string | null; request_meta: string; request_header_id: string | null }>()
      .map((row) => ({ ...row, usage: row.usage ? JSON.parse(row.usage) : null }));
    const requestParts = store.db.prepare(`WITH calls AS (SELECT c.request,c.request_header_id
      FROM model_calls c JOIN runs r ON r.id=c.run_id WHERE r.project_id=? AND c.request_header_id IS NOT NULL),
      needed AS (
        SELECT request_header_id AS id FROM calls
        UNION SELECT part.value FROM calls,json_each(calls.request,'$.messageParts') part WHERE part.type='text'
      ) SELECT p.id,p.content FROM needed JOIN model_request_parts p ON p.id=needed.id`)
      .bind(projectId).rows<{ id: string; content: string }>();
    const steps = store.db.prepare(`SELECT s.*,t.result AS receipt_result FROM execution_steps s
      LEFT JOIN tool_receipts t ON t.run_id=s.run_id AND t.call_id=s.call_id WHERE s.project_id=? ORDER BY s.seq`)
      .bind(projectId).rows<Record<string, unknown> & { output_images: string | null; receipt_result: string | null }>();
    const references = store.db.prepare(`SELECT id,target_session_id,input_id,source_session_id,preview,total_lines
      FROM session_reference_snapshots WHERE project_id=?`).bind(projectId).rows<{
        id: string; target_session_id: string; input_id: string; source_session_id: string; preview: string; total_lines: number;
      }>();
    const referenceLines = store.db.prepare(`SELECT l.snapshot_id,l.text FROM session_reference_lines l
      JOIN session_reference_snapshots s ON s.id=l.snapshot_id WHERE s.project_id=? ORDER BY l.snapshot_id,l.line`)
      .bind(projectId).rows<{ snapshot_id: string; text: string }>();
    const deliveries = store.db.prepare("SELECT d.* FROM deliveries d JOIN runs r ON r.id=d.run_id WHERE r.project_id=? ORDER BY d.rowid")
      .bind(projectId).rows();
    const sessions = store.sessions(projectId).map((session) => ({ ...session, cwd: store.sessionCwd(projectId, session.id),
      seed: store.sessionSeed(projectId, session.id)?.messages }));
    const timeline = store.db.prepare(`WITH boundaries AS (${runBoundaries})
      SELECT e.id AS seq,e.type,e.data,e.created_at,a.origin_event_id AS origin,a.root_run_id AS origin_run
      FROM events e LEFT JOIN fork_event_ancestry a ON a.event_id=e.id
      WHERE e.project_id=? AND (${committedRunEvent}) AND (e.type='message' OR json_type(e.data,'$.runId')='text')
      UNION ALL SELECT seq,type,data,created_at,NULL,NULL FROM boundaries WHERE seq IS NOT NULL ORDER BY seq,type`)
      .bind(projectId, projectId).rows();
    const checkpoints = store.db.prepare(`SELECT j.run_id,j.revision,j.event_seq,j.patch FROM agent_session_events j JOIN runs r ON j.run_id=r.id
      WHERE r.project_id=? AND r.background=0 AND r.agent_role<>'media'
      UNION ALL SELECT j.run_id,j.revision,j.event_seq,j.patch FROM archived_fork_checkpoints j JOIN runs r ON j.run_id=r.id
      WHERE r.project_id=? AND r.background=0 AND r.agent_role<>'media' ORDER BY run_id,revision`)
      .bind(projectId, projectId).rows<{ run_id: string; revision: number; event_seq: number | null; patch: string }>();
    const [project] = store.db.prepare("SELECT title,brief,style,ratio,duration FROM projects WHERE id=?").bind(projectId).rows();
    return { project, files, versions, messages, tasks, jobOutput, replies, requestParts, steps, deliveries, sessions, timeline, checkpoints,
      references, referenceLines,
      team: sessions.map(({ id, teamEnabled }) => ({ session: id, enabled: teamEnabled, tasks: store.teamTasks(projectId, id, true)
        .map((task) => task.ownerId === leadAgentId ? { ...task, ownerId: null, ownerIsLead: true } : task) })) };
  });
  const encoder = new TextEncoder(), entries: ZipEntry[] = [];
  const write = (name: string, contents: string) => entries.push({ name, open: async () => encoder.encode(contents) });
  const files = new Map(snapshot.files.map((file) => [file.id, file]));
  const include = (file: ArchiveFile, folder: string) => {
    const path = archiveFilePath(folder, file.path ?? files.get(file.id)?.path ?? file.id);
    const key = JSON.parse(file.metadata).objectKey;
    if (typeof key === "string" && key.startsWith(projectId + "/")) {
      entries.push({ name: path, async open() {
        const object = await bucket?.get(key);
        if (!object) throw new AppError("归档缺少素材：" + file.path, 404);
        return object.body;
      } });
    } else if (!["image", "video", "audio", "final"].includes(file.kind ?? "")) {
      write(path, file.content);
    }
  };
  for (const file of snapshot.files) include(file, "项目文件");
  for (const version of snapshot.versions) include(version, "文件版本/" + version.id + "/v" + version.version);
  const { files: current, versions, steps, jobOutput, checkpoints, replies, requestParts, sessions, references, referenceLines, ...history } = snapshot;
  const snapshotLines = new Map<string, string[]>();
  for (const { snapshot_id, text } of referenceLines) {
    const lines = snapshotLines.get(snapshot_id) ?? [];
    lines.push(text);
    snapshotLines.set(snapshot_id, lines);
  }
  for (const item of references) write(referenceEntry(item.id), JSON.stringify(snapshotLines.get(item.id) ?? []));
  const byJob = new Map<string, Omit<typeof jobOutput[number], "job_id">[]>();
  for (const { job_id, ...line } of jobOutput) {
    const lines = byJob.get(job_id) ?? [];
    lines.push(line);
    byJob.set(job_id, lines);
  }
  for (const task of snapshot.tasks)
    if (task.background === 1) write(backgroundLogEntry(String(task.id)), JSON.stringify(byJob.get(String(task.id)) ?? []));
  const receiptEntries = new Map<string, string>();
  const archiveImage = ({ objectKey, ...image }: AgentImage) => {
      if (!objectKey.startsWith(projectId + "/")) throw new AppError("回执图片不属于当前项目", 403);
      let entry = receiptEntries.get(objectKey);
      if (!entry) {
        entry = "回执图片/" + receiptEntries.size;
        receiptEntries.set(objectKey, entry);
        entries.push({ name: entry, async open() {
          const object = await bucket?.get(objectKey);
          if (!object || object.size !== image.bytes) throw new AppError("归档缺少回执图片：" + image.path, 404);
          return object.body;
        } });
      }
      return { ...image, entry };
  };
  const archiveMessage = ({ images, source, ...message }: AgentMessage) => ({
    ...message,
    ...(source?.kind === "runtime-context" || source?.kind === "compaction" || source?.kind === "session-reference" ||
      source?.kind === "schedule-change" ? { source } : {}),
    ...(images?.length ? { images: images.map(archiveImage) } : {}),
  });
  const archiveSteps = steps.map(({ output_images, receipt_result, ...step }) => ({
    ...step, result: step.result ?? receipt_result,
    ...(output_images ? { receipt_images: (JSON.parse(output_images) as AgentImage[]).map(archiveImage) } : {}),
  }));
  const archiveCheckpoints = checkpoints.map(({ patch, ...row }) => {
    const change = (JSON.parse(patch) as SessionPatch).messages;
    return { ...row, messages: change ? { ...change, insert: change.insert.map(archiveMessage) } : undefined };
  });
  const parts = new Map(requestParts.map(({ id, content }) => [id, content]));
  const requestHeaders: Record<string, Record<string, unknown>> = {};
  const requestMessages: Record<string, ReturnType<typeof archiveMessage>> = {};
  const archiveReplies = replies.map(({ response, request_meta, request_header_id, ...row }) => {
    let metadata = JSON.parse(request_meta) as Record<string, unknown>;
    let header = request_header_id;
    if (!header && Array.isArray(metadata.messages)) {
      const record = recordModelRequest(metadata);
      header = record.headerId; metadata = record.metadata;
      for (const [id, body] of record.parts) parts.set(id, body);
    }
    const storedHeader = header ? parts.get(header) : undefined;
    if (!storedHeader) return { ...row, response: typeof response === "string" ? archiveMessage(JSON.parse(response) as AgentMessage) : undefined };
    if (!Array.isArray(metadata.messageParts) || !header) throw new AppError("归档缺少模型请求记录", 409, "ARCHIVE_REQUEST_MISSING");
    requestHeaders[header] ??= JSON.parse(storedHeader);
    const { messageParts, ...request } = metadata;
    const messages = messageParts.map((part) => {
      if (typeof part !== "string") return archiveMessage(part as AgentMessage);
      const content = parts.get(part);
      if (!content) throw new AppError("归档缺少模型输入记录", 409, "ARCHIVE_REQUEST_MISSING");
      requestMessages[part] ??= archiveMessage(JSON.parse(content) as AgentMessage);
      return part;
    });
    return { ...row, response: typeof response === "string" ? archiveMessage(JSON.parse(response) as AgentMessage) : undefined,
      request_snapshot: { header, request, messages } };
  });
  write("项目记录.json", JSON.stringify({ formatVersion: 1, projectId, ...history, steps: archiveSteps,
    references,
    replies: archiveReplies, request_headers: requestHeaders, request_messages: requestMessages, checkpoints: archiveCheckpoints, sessions: sessions.map(({ seed, ...row }) => ({ ...row, seed: seed?.map(archiveMessage) })),
    files: current.map(({ content: _content, ...file }) => file), versions: versions.map(({ content: _content, ...file }) => file) }, null, 2));
  return streamZip(entries);
}

const backgroundLogEntry = (jobId: string) => "后台任务/" + jobId + ".json";
const referenceEntry = (id: string) => "对话引用/" + id + ".json";
const identifier = z.string().uuid();
const time = z.string().max(40);
const version = z.number().int().positive().safe();
const flag = z.union([z.literal(0), z.literal(1)]);
const jobLog = z.array(z.object({ line: z.string().max(JOB_OUTPUT_RETAIN_BYTES), created_at: time, channel: z.enum(["stdout", "stderr", "log"]).default("stdout"), fragment: z.union([z.literal(0), z.literal(1)]).default(0) }))
  .max(JOB_OUTPUT_RETAIN_BYTES);
const kind = z.enum(["script", "storyboard", "characters", "review", "image", "video", "audio", "final", "document"]);
const mediaKinds = new Set(["image", "video", "audio", "final"]);
const label = z.string().max(600);
const fileShape = z.object({ id: identifier, path: label.nullable(), version, metadata: z.string().max(100000), kind: kind.nullable(), created_at: time.optional() });
const fileRef = z.object({ id: identifier, path: label, kind, version, label: label.optional() });
const receiptImageTypes = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const;
const receiptImage = z.object({ id: identifier.or(z.string().regex(/^mcp-[a-f0-9]{64}$/)), path: label, version, mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  bytes: z.number().int().positive().max(30 * 1024 * 1024), width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), entry: z.string().regex(/^回执图片\/(0|[1-9]\d{0,8})$/) });
const forkMessage = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]), content: z.string().nullable(),
  tool_call_id: label.optional(), tool_calls: z.array(z.object({ id: label, providerId: label.optional(), type: z.literal("function"),
    function: z.object({ name: label, arguments: z.string() }) })).optional(),
  finishReason: z.literal("max-tokens").optional(),
  attemptTrace: z.object({ protocol: z.enum(["chat-completions", "messages"]), truncated: z.boolean(),
    frames: z.array(z.object({ at: z.number().int().nonnegative().safe(), data: z.string().max(2 * 1024 * 1024) })).max(8192),
  }).refine(({ frames }) => frames.reduce((total, { data }) => total + Buffer.byteLength(data, "utf8"), 0) <= 2 * 1024 * 1024).optional(),
  outputRef: identifier.optional(),
  orderedToolContent: z.array(z.union([z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("image"), index: z.number().int().nonnegative().safe() })])).optional(),
  chatReasoning: z.object({ endpoint: z.string(), model: z.string(), text: z.string() }).optional(),
  messagesReplay: z.object({ endpoint: z.string(), model: z.string(), blocks: z.array(z.union([
    z.object({ type: z.literal("text"), length: z.number().int().nonnegative().safe() }),
    z.object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string().optional() }),
    z.object({ type: z.literal("tool_use"), callIndex: z.number().int().nonnegative().safe() }),
  ])) }).optional(),
  source: z.union([z.object({ kind: z.literal("compaction") }),
    z.object({ kind: z.literal("schedule-change"), id: label }),
    z.object({ kind: z.literal("session-reference"), snapshotIds: z.array(identifier).optional() }),
    z.object({ kind: z.literal("runtime-context"), sections: z.array(z.object({ name: z.string(), text: z.string() })) })]).optional(),
  images: z.array(receiptImage).optional(),
});
const requestPartId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const checkpoint = z.object({ run_id: identifier, revision: version, event_seq: version.nullable(),
  messages: z.object({ start: z.number().int().nonnegative().safe(), remove: z.number().int().nonnegative().safe(), insert: z.array(forkMessage) }).optional() });
const manifest = z.object({
  formatVersion: z.literal(1), project: z.object({ title: z.string().min(1).max(100), brief: z.string().max(12000),
    style: z.string().max(2000), ratio: z.enum(["16:9", "9:16"]), duration: z.number().int().positive() }),
  files: z.array(fileShape.extend({ updated_at: time, locked: z.union([z.literal(0), z.literal(1)]), status: z.enum(["ready", "generating", "failed", "stale"]) })).max(10000),
  versions: z.array(fileShape.extend({ run_id: identifier.nullable(), previous_path: label.nullable() })).max(20000),
  sessions: z.array(z.object({ id: z.union([z.literal(""), identifier]), title: label, createdAt: time, forkRunId: identifier.optional(),
    cwd: label.optional(), seed: z.array(forkMessage).optional(), archived: z.boolean().optional(), pinned: z.boolean().optional(),
    position: z.number().int().nonnegative().safe().optional() })).max(3000),
  checkpoints: z.array(checkpoint).max(150000).optional(),
  references: z.array(z.object({ id: identifier, target_session_id: z.string(), input_id: label, source_session_id: z.string(),
    preview: z.string(), total_lines: z.number().int().positive().safe() })).max(30000).optional(),
  tasks: z.array(z.object({ id: identifier, session_id: z.string(), parent_run_id: identifier.nullable(), agent_role: label,
    status: z.string(), stage: z.string(), label, result_text: z.string(), error: z.string().nullable(), created_at: time, updated_at: time,
    batch: z.string().nullable(), source_versions: z.string().nullable(), fork_changes: z.string().nullable().optional(),
    turn_preset: z.string().max(100000).nullable().optional(),
    inherited: flag.nullable().optional(), fork_source: z.string().nullable().optional(),
    working_directory: label.nullable().optional(),
    background: flag.optional(), progress: z.number().min(0).max(100).optional(),
    background_path: label.nullable().optional(), output_truncated: flag.optional() })).max(20000),
  messages: z.array(z.object({ id: identifier, session_id: z.string(), role: z.enum(["user", "assistant"]), agent: label.nullable(), run_id: identifier.nullable(),
    content: z.string(), artifact_ids: z.string(), attachments: z.string(), created_at: time })).max(30000),
  steps: z.array(z.object({ run_id: identifier, call_id: label, name: label, status: z.string(), arguments: z.string(),
    result: z.string().nullable(), summary: label, started_at: time, finished_at: time.nullable(),
    request_id: identifier.nullable().optional(), call_index: z.number().int().nonnegative().nullable().optional(),
    provider_call_id: label.nullable().optional(), output_ref: identifier.nullable().optional(), dispatched_at: time.nullable().optional(),
    receipt_images: z.array(receiptImage).max(24).optional() })).max(50000),
  request_headers: z.record(requestPartId, z.record(z.unknown())).optional(),
  request_messages: z.record(requestPartId, forkMessage).optional(),
  replies: z.array(z.object({ id: identifier, run_id: identifier, content: z.string(), status: z.string(), created_at: time, settled_at: time.nullable(),
    error_code: z.string().nullable().optional(), purpose: z.enum(["creation", "compaction", "manual-compaction"]).nullable().optional(),
    model: label.nullable().optional(), first_output_at: time.nullable().optional(), last_output_at: time.nullable().optional(), usage: z.object({ inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(), totalTokens: z.number().nonnegative(), cachedInputTokens: z.number().nonnegative().optional(),
      cacheWriteInputTokens: z.number().nonnegative().optional() }).nullable().optional(),
    response: forkMessage.optional(),
    request_snapshot: z.object({ header: requestPartId, request: z.record(z.unknown()),
      messages: z.array(z.union([requestPartId, forkMessage])) }).optional(),
    turn: z.number().int().nonnegative().nullable().optional(), step: version.nullable().optional(), attempt: version.nullable().optional() })).max(30000),
  deliveries: z.array(z.object({ id: identifier, run_id: identifier, files: z.string() })).max(10000),
  timeline: z.array(z.object({ seq: version.optional(), origin: version.nullable().optional(), origin_run: identifier.nullable().optional(),
    type: z.string().regex(/^[a-z][a-z0-9_/-]{0,125}$/).refine((type) => type !== "run" && type !== "stream"),
    data: z.string(), created_at: time })).max(150000),
  team: z.array(z.object({ session: z.string(), enabled: z.boolean().optional(), tasks: z.array(z.object({ id: identifier, title: label, detail: z.string().max(16384),
    status: z.enum(["pending", "in_progress", "done", "deleted"]), revision: version, ownerId: identifier.nullable(), ownerIsLead: z.literal(true).optional(),
    dependencies: z.array(identifier).max(256),
    writeScopes: z.array(z.string().max(260)).max(64).optional() })).max(20000) })).max(3000),
});

/** Restore a distinct project with historical work sealed. Provider submissions and credentials stay on the original. */
export async function restoreProjectArchive(store: Store, userId: string, buffer: ArrayBuffer, bucket: BlobStore | undefined, signal: AbortSignal) {
  const invalid = () => new AppError("只能导入 do漫 导出的有效项目归档", 400, "ARCHIVE_INVALID");
  const open = () => {
    try { return openStudioZip(buffer); }
    catch { throw invalid(); }
  };
  const zip = open();
  const read = (name: string) => {
    try { return zip.read(name); }
    catch { throw invalid(); }
  };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const record = read("项目记录.json");
  if (!record || record.byteLength > 96 * 1024 * 1024) throw invalid();
  let archive: z.infer<typeof manifest>;
  try { archive = manifest.parse(JSON.parse(decoder.decode(record))); }
  catch { throw invalid(); }
  const projectId = uid(), createdAt = now();
  const title = (archive.project.title + "（导入）").slice(0, 100);
  const idMap = (ids: string[]) => {
    if (ids.length !== new Set(ids).size) throw invalid();
    return new Map(ids.map((id) => [id, uid()]));
  };
  const ids = idMap(archive.files.map(({ id }) => id));
  const tasks = idMap(archive.tasks.map(({ id }) => id));
  const messages = idMap(archive.messages.map(({ id }) => id));
  const replies = idMap(archive.replies.map(({ id }) => id));
  const sessions = idMap(archive.sessions.filter(({ id }) => id !== "").map(({ id }) => id));
  const referenceIds = idMap((archive.references ?? []).map(({ id }) => id));
  const outputIds = new Set(archive.steps.flatMap(({ output_ref, finished_at, result }) =>
    output_ref && finished_at && result !== null ? [output_ref] : []));
  const session = (id: string) => {
    if (id === "") return "";
    const target = sessions.get(id);
    if (!target) throw invalid();
    return target;
  };
  const taskRows = new Map(archive.tasks.map((task) => [task.id, task]));
  const sortedTasks: typeof archive.tasks = [];
  const visiting = new Set<string>(), visited = new Set<string>();
  const visitTask = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw invalid();
    const task = taskRows.get(id);
    if (!task) throw invalid();
    visiting.add(id);
    if (task.parent_run_id) {
      if (taskRows.get(task.parent_run_id)?.session_id !== task.session_id) throw invalid();
      visitTask(task.parent_run_id);
    }
    visiting.delete(id);
    visited.add(id);
    sortedTasks.push(task);
  };
  for (const { id } of archive.tasks) visitTask(id);
  const refs = (value: string) => z.array(fileRef).max(100).parse(JSON.parse(value))
    .flatMap((ref) => ids.has(ref.id) ? [{ ...ref, id: ids.get(ref.id)! }] : []);
  const mapSources = (source: unknown) => {
    const parsed = z.record(z.string(), version).safeParse(source);
    return parsed.success ? Object.fromEntries(Object.entries(parsed.data).flatMap(([id, version]) => ids.has(id) ? [[ids.get(id)!, version]] : [])) : {};
  };
  const media = new Map<string, { data: Uint8Array; type: string; key: string }>();
  const receiptObjects = new Map<string, Pick<AgentImage, "objectKey" | "width" | "height" | "bytes" | "mediaType" | "sha256">>();
  const detachedImages = new Map<string, string>();
  const importReceiptImage = (image: z.infer<typeof receiptImage>): AgentImage => {
    signal.throwIfAborted();
    let object = receiptObjects.get(image.entry);
    if (!object) {
      const data = read(image.entry);
      if (!data || data.byteLength !== image.bytes) throw invalid();
      let shape: ReturnType<typeof imageSize>;
      try { shape = imageSize(data); } catch { throw invalid(); }
      const type = receiptImageTypes[shape.type as keyof typeof receiptImageTypes];
      if (!type) throw invalid();
      const objectKey = projectId + "/import/receipts/" + image.entry.split("/")[1];
      object = { objectKey, width: shape.width, height: shape.height, bytes: data.byteLength,
        mediaType: type, sha256: createHash("sha256").update(data).digest("hex") };
      receiptObjects.set(image.entry, object);
      media.set(image.entry, { data, type, key: objectKey });
    }
    if (object.mediaType !== image.mediaType || object.width !== image.width || object.height !== image.height ||
      object.bytes !== image.bytes || (image.sha256 && object.sha256 !== image.sha256)) throw invalid();
    const id = ids.get(image.id) ?? detachedImages.get(image.id) ?? uid();
    if (!ids.has(image.id)) detachedImages.set(image.id, id);
    return { ...object, id, version: image.version, path: image.id.startsWith("mcp-") || /^MCP 图片 \d+$/.test(image.path) ? image.path : projectOutputPath(image.path) };
  };
  const remapReference = (text: string) => text.replace(/("snapshot_id"\s*:\s*")([0-9a-f-]{36})(")/gi,
    (value, prefix: string, id: string, suffix: string) => referenceIds.has(id) ? prefix + referenceIds.get(id) + suffix : value);
  const importMessage = ({ images, source, outputRef, content, ...message }: z.infer<typeof forkMessage>): AgentMessage => ({
    ...message,
    content: content && source?.kind === "session-reference" ? remapReference(content) : content,
    ...(source ? { source: source.kind === "session-reference"
      ? { ...source, snapshotIds: source.snapshotIds?.flatMap((id) => referenceIds.get(id) ?? []) } : source } : {}),
    ...(outputRef && outputIds.has(outputRef) ? { outputRef } : {}),
    ...(images?.length ? { images: images.map(importReceiptImage) } : {}),
  });
  const checkpointRuns = new Map<string, { entry: SessionEntry; seq: number | null }[]>();
  for (const row of archive.checkpoints ?? []) {
    const task = taskRows.get(row.run_id);
    if (!task || task.background || task.agent_role === "media") throw invalid();
    const entries = checkpointRuns.get(row.run_id) ?? [];
    entries.push({ entry: { revision: row.revision, kind: "checkpoint", reference: null,
      patch: row.messages ? { messages: { ...row.messages, insert: row.messages.insert.map(importMessage) } } : {} }, seq: row.event_seq });
    checkpointRuns.set(row.run_id, entries);
  }
  for (const entries of checkpointRuns.values()) {
    entries.sort((a, b) => a.entry.revision - b.entry.revision);
    try { replaySession(entries.map(({ entry }) => entry)); } catch { throw invalid(); }
  }
  const localPresets = new Map(store.presets.list(userId).map((preset) => [preset.id, preset]));
  const restoredPreset = (raw: string | null | undefined) => {
    if (!raw || raw === "null") return raw ?? null;
    const parsed = presetInput.extend({ id: identifier }).safeParse(JSON.parse(raw));
    const local = parsed.success ? localPresets.get(parsed.data.id) : undefined;
    return local && parsed.success ? JSON.stringify({ ...parsed.data, plugins: parsed.data.plugins.filter((id) => local.plugins.includes(id)) }) : "null";
  };
  const restoredFiles = new Map(archive.files.map((file) => [file.id, file]));
  const restoreFile = (entry: z.infer<typeof fileShape>, isVersion: boolean) => {
    const parent = restoredFiles.get(entry.id);
    if (!parent?.path || !parent.kind) throw invalid();
    const sourcePath = entry.path ?? parent.path;
    const trashed = !isVersion && sourcePath === projectTrashPath(entry.id);
    const filePath = trashed ? projectTrashPath(ids.get(entry.id)!) : projectOutputPath(sourcePath), fileKind = entry.kind ?? parent.kind;
    const name = archiveFilePath(isVersion ? "文件版本/" + entry.id + "/v" + entry.version : "项目文件", sourcePath);
    const bytes = read(name), mediaFile = mediaKinds.has(fileKind);
    const metadata = z.record(z.string(), z.unknown()).parse(JSON.parse(entry.metadata));
    const versionKey = entry.id + ":" + entry.version;
    if (mediaFile && bytes && !media.has(versionKey)) {
      const type = String(metadata.contentType ?? "");
      if (!/^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm)|audio\/(mpeg|wav|mp4|webm|ogg))$/.test(type)) throw invalid();
      media.set(versionKey, { data: bytes, type, key: projectId + "/import/" + ids.get(entry.id) + "/" + entry.version });
    }
    delete metadata.objectKey;
    delete metadata.providerUrl;
    if (metadata.sourceVersions) metadata.sourceVersions = mapSources(metadata.sourceVersions);
    if (mediaFile && bytes) metadata.objectKey = media.get(versionKey)!.key;
    const url = mediaFile && bytes ? "/api/studio/projects/" + projectId + "/media/" + ids.get(entry.id) : null;
    return { filePath, fileKind, metadata: JSON.stringify(metadata), url,
      content: !mediaFile && bytes ? decoder.decode(bytes) : "", available: Boolean(bytes) };
  };
  const db = store.db, project = archive.project;
  const mainSession = archive.sessions.find(({ id }) => id === "");
  const save = [db.prepare("INSERT INTO projects(id,user_id,title,brief,style,ratio,duration,status,created_at,updated_at,main_session_title) VALUES(?,?,?,?,?,?,?,'draft',?,?,?)")
    .bind(projectId, userId, title, project.brief, project.style, project.ratio, project.duration, createdAt, createdAt, mainSession?.title || "主对话")];
  for (const task of sortedTasks) {
    const status = ["done", "failed", "cancelled"].includes(task.status) ? task.status : "cancelled";
    const archivedBatch = task.batch ? z.object({ id: identifier, title: label, key: label, dependencies: z.array(identifier).max(24) }).parse(JSON.parse(task.batch)) : null;
    const forkChanges = task.fork_changes ? z.array(z.object({ id: identifier, kind, path: label, previousPath: label.nullable(),
      beforeVersion: version.nullable(), afterVersion: version })).parse(JSON.parse(task.fork_changes))
      .flatMap((change) => ids.has(change.id) ? [{ ...change, id: ids.get(change.id)! }] : []) : undefined;
    const taskId = tasks.get(task.id)!;
    const originalFork = task.fork_source ? z.object({ runId: identifier, revision: z.number().int().nonnegative().safe() })
      .parse(JSON.parse(task.fork_source)) : undefined;
    const originalId = originalFork && tasks.get(originalFork.runId);
    const background = task.background === 1;
    let resultText = task.result_text;
    let archivedOutputPath: string | undefined;
    let lines: z.infer<typeof jobLog> | undefined;
    if (background) {
      const entry = read(backgroundLogEntry(task.id));
      if (!entry || entry.byteLength > 32 * 1024 * 1024) throw invalid();
      try {
        lines = jobLog.parse(JSON.parse(decoder.decode(entry)));
        if (task.background_path) archivedOutputPath = projectOutputPath(task.background_path);
      } catch { throw invalid(); }
      try {
        const result = JSON.parse(resultText);
        if (typeof result?.id === "string" && ids.has(result.id)) resultText = JSON.stringify({ ...result, id: ids.get(result.id) });
      } catch { /* Plain completion text is valid. */ }
    }
    save.push(db.prepare(`INSERT INTO runs(id,project_id,session_id,parent_run_id,intent,status,stage,progress,label,error,payload,agent_role,result_text,created_at,updated_at,background,turn_preset)
      VALUES(?,?,?,?,'agent',?,'done',?,?,?,?,?,?,?,?,?,?)`).bind(taskId, projectId, session(task.session_id),
      task.parent_run_id ? tasks.get(task.parent_run_id) : null, status, background ? task.progress ?? 100 : 100, task.label, task.error,
      JSON.stringify({ instruction: "", imported: true, archivedOutputPath,
        ...(checkpointRuns.has(task.id) ? { archivedFork: true } : {}),
        ...(task.working_directory ? { workingDirectory: projectWorkingDirectory(task.working_directory) } : {}),
        ...(task.inherited ? { inherited: true } : {}),
        ...(originalId ? { forkSource: { runId: originalId, revision: 0 } } : {}),
        sourceVersions: task.source_versions ? mapSources(JSON.parse(task.source_versions)) : {},
        forkChanges,
        ...(archivedBatch ? { batch: { ...archivedBatch, dependencies: archivedBatch.dependencies.flatMap((id) => tasks.has(id) ? [tasks.get(id)] : []) } } : {}) }),
      task.agent_role, resultText, task.created_at, task.updated_at, Number(background), restoredPreset(task.turn_preset)));
    if (lines) save.push(db.prepare(`INSERT INTO background_job_output(job_id,line,created_at,channel,fragment)
      SELECT ?,json_extract(value,'$.line'),json_extract(value,'$.created_at'),json_extract(value,'$.channel'),json_extract(value,'$.fragment') FROM json_each(?) ORDER BY CAST(key AS INTEGER)`)
      .bind(taskId, JSON.stringify(lines)));
    if (background && task.output_truncated === 1) save.push(db.prepare(`INSERT INTO background_job_truncation(job_id,through_seq)
      SELECT ?,COALESCE(MIN(seq),1) FROM background_job_output WHERE job_id=?
      ON CONFLICT(job_id) DO UPDATE SET through_seq=MAX(through_seq,excluded.through_seq)`).bind(taskId, taskId));
  }
  for (const row of archive.sessions.filter(({ id }) => id !== "")) {
    save.push(db.prepare("INSERT INTO project_sessions(id,project_id,title,created_at,fork_run_id,seed,working_directory) VALUES(?,?,?,?,?,?,?)")
      .bind(session(row.id), projectId, row.title, row.createdAt, row.forkRunId ? tasks.get(row.forkRunId) ?? null : null,
        row.seed ? JSON.stringify({ messages: row.seed.map(importMessage), step: 0, toolIndex: 0, artifactIds: [], seenUserIds: [] }) : null,
        row.cwd ? projectWorkingDirectory(row.cwd) : null));
  }
  for (const row of archive.sessions) if (row.archived || row.pinned || row.position !== undefined) {
    save.push(db.prepare("INSERT INTO session_management(project_id,session_id,archived,pinned,position) VALUES(?,?,?,?,?)")
      .bind(projectId, session(row.id), Number(Boolean(row.archived)), Number(!row.archived && Boolean(row.pinned)), row.position ?? null));
  }
  for (const file of archive.files) {
    const restored = restoreFile(file, false);
    save.push(db.prepare(`INSERT INTO artifacts(id,project_id,path,kind,content,version,status,locked,url,metadata,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(ids.get(file.id), projectId, restored.filePath, restored.fileKind, restored.content,
      file.version, restored.available && file.status !== "generating" ? file.status : "failed", file.locked, restored.url, restored.metadata, file.created_at ?? createdAt, file.updated_at));
  }
  for (const row of archive.versions) {
    const restored = restoreFile(row, true);
    save.push(db.prepare(`INSERT INTO artifact_versions(id,artifact_id,version,content,url,metadata,created_at,run_id,path,previous_path,kind)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(uid(), ids.get(row.id), row.version, restored.content, restored.url, restored.metadata, row.created_at ?? createdAt,
      row.run_id ? tasks.get(row.run_id) ?? null : null, restored.filePath, row.previous_path, restored.fileKind));
  }
  for (const row of archive.messages) {
    const artifactIds = z.array(identifier).parse(JSON.parse(row.artifact_ids)).flatMap((id) => ids.has(id) ? [ids.get(id)] : []);
    save.push(db.prepare(`INSERT INTO messages(id,project_id,session_id,role,agent,content,run_id,artifact_ids,attachments,request_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(messages.get(row.id), projectId, session(row.session_id), row.role, row.agent, row.content,
      row.run_id ? tasks.get(row.run_id) ?? null : null, JSON.stringify(artifactIds), JSON.stringify(refs(row.attachments)),
      row.role === "user" ? uid() : null, row.created_at));
  }
  for (const row of archive.steps) {
    if (!tasks.has(row.run_id)) throw invalid();
    save.push(db.prepare(`INSERT INTO execution_steps(project_id,run_id,call_id,name,status,arguments,result,summary,started_at,finished_at,
      request_id,call_index,provider_call_id,output_ref,dispatched_at,output_images) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(projectId, tasks.get(row.run_id), row.call_id, row.name, row.status === "running" ? "interrupted" : row.status,
      row.arguments, row.result, row.summary, row.started_at, row.finished_at,
      row.request_id ? replies.get(row.request_id) ?? null : null, row.call_index ?? null, row.provider_call_id ?? null,
      row.output_ref && outputIds.has(row.output_ref) ? row.output_ref : null,
      row.dispatched_at === undefined ? row.started_at : row.dispatched_at,
      row.receipt_images?.length ? JSON.stringify(row.receipt_images.map(importReceiptImage)) : null));
    // The worker may have committed a receipt before the loop could settle its trace row.
    const receipt = !row.finished_at && row.result ? parseToolArguments(row.result) : undefined;
    if (receipt && receipt.status !== "pending") save.push(db.prepare(
      "INSERT INTO tool_receipts(run_id,call_id,result,created_at) VALUES(?,?,?,?)")
      .bind(tasks.get(row.run_id), row.call_id, row.result, row.started_at));
  }
  const restoredRequestParts = new Set<string>();
  const restoredRequestMessages = new Map<string, AgentMessage>();
  for (const row of archive.replies) {
    if (!tasks.has(row.run_id)) throw invalid();
    let request: Record<string, unknown> = { purpose: row.purpose ?? "creation", turn: row.turn, step: row.step, attempt: row.attempt, model: row.model };
    if (row.request_snapshot) {
      const snapshot = row.request_snapshot;
      const header = archive.request_headers?.[snapshot.header];
      if (!header) throw invalid();
      const messages = snapshot.messages.map((part) => {
        if (typeof part !== "string") return importMessage(part);
        const existing = restoredRequestMessages.get(part);
        if (existing) return existing;
        const message = archive.request_messages?.[part];
        if (!message) throw invalid();
        const restored = importMessage(message);
        restoredRequestMessages.set(part, restored);
        return restored;
      });
      request = { ...snapshot.request, ...header, messages };
    }
    const record = recordModelRequest(request);
    for (const [id, content] of record.parts) {
      if (restoredRequestParts.has(id)) continue;
      restoredRequestParts.add(id);
      save.push(db.prepare("INSERT OR IGNORE INTO model_request_parts(id,content) VALUES(?,?)").bind(id, content));
    }
    const status = ["completed", "failed"].includes(row.status) ? row.status : "interrupted";
    save.push(db.prepare(`INSERT INTO model_calls(id,run_id,request,status,visible_text,created_at,settled_at,error_code,first_output_at,usage,response,last_output_at,request_header_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(replies.get(row.id), tasks.get(row.run_id), JSON.stringify(record.metadata),
      status, row.content, row.created_at, row.settled_at, row.error_code ?? null, row.first_output_at ?? null, row.usage ? JSON.stringify(row.usage) : null,
      row.response && (status === "completed" || row.response.attemptTrace) ? JSON.stringify(importMessage(row.response)) : null, row.last_output_at ?? null,
      record.headerId));
  }
  for (const row of archive.deliveries) {
    if (!tasks.has(row.run_id)) throw invalid();
    save.push(db.prepare("INSERT INTO deliveries(id,run_id,files) VALUES(?,?,?)").bind(uid(), tasks.get(row.run_id), JSON.stringify(refs(row.files))));
  }
  for (const row of archive.references ?? []) {
    const bytes = read(referenceEntry(row.id));
    if (!bytes || bytes.byteLength > 96 * 1024 * 1024) throw invalid();
    const lines = z.array(z.string()).parse(JSON.parse(decoder.decode(bytes)));
    if (lines.length !== row.total_lines) throw invalid();
    const id = referenceIds.get(row.id)!;
    save.push(db.prepare(`INSERT INTO session_reference_snapshots(id,project_id,target_session_id,input_id,source_session_id,preview,total_lines)
      VALUES(?,?,?,?,?,?,?)`).bind(id, projectId, session(row.target_session_id), messages.get(row.input_id) ?? row.input_id,
      session(row.source_session_id), remapReference(row.preview), lines.length),
    db.prepare(`INSERT INTO session_reference_lines(snapshot_id,line,text)
      SELECT ?,CAST(key AS INTEGER)+1,value FROM json_each(?)`).bind(id, JSON.stringify(lines)));
  }
  const archivedRuns = new Map(archive.tasks.map((task) => [task.id, task]));
  for (const board of archive.team) {
    const boardIds = idMap(board.tasks.map(({ id }) => id));
    if (board.enabled !== undefined) save.push(db.prepare("INSERT INTO team_modes(project_id,session_id,enabled) VALUES(?,?,?)")
      .bind(projectId, session(board.session), Number(board.enabled)));
    for (const task of board.tasks) {
      const owner = task.ownerId ? archivedRuns.get(task.ownerId) : undefined;
      const ownerIsLead = task.ownerIsLead ||
        Boolean(owner && owner.session_id === board.session && owner.parent_run_id === null && owner.agent_role === "main");
      const ownerId = !ownerIsLead && owner?.session_id === board.session && task.ownerId ? tasks.get(task.ownerId) ?? null : null;
      save.push(db.prepare(`INSERT INTO team_tasks(id,project_id,session_id,title,detail,status,revision,owner_id,owner_is_lead,dependencies,created_at,write_scopes)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(boardIds.get(task.id), projectId, session(board.session), task.title, task.detail, task.status, task.revision,
        ownerId, Number(ownerIsLead), JSON.stringify(task.dependencies.flatMap((id) => boardIds.has(id) ? [boardIds.get(id)] : [])), createdAt,
        JSON.stringify(task.writeScopes ?? [])));
    }
  }
  for (const row of archive.timeline) {
    const raw = JSON.parse(row.data);
    const id = messages.get(raw.id), runId = tasks.get(raw.runId), requestId = replies.get(raw.requestId);
    if ((row.type === "step" || row.type === "tool/dispatched") && runId && typeof raw.callId === "string") {
      save.push(db.prepare(`INSERT INTO events(project_id,type,data,created_at)
        SELECT ?,?,json_object('runId',run_id,'callId',call_id,'stepSeq',seq,'requestId',request_id,'callIndex',call_index,
          'status',COALESCE(?,status),'dispatchedAt',dispatched_at,'archiveSeq',?),?
        FROM execution_steps WHERE run_id=? AND call_id=?`).bind(projectId, row.type, raw.status ?? null, row.seq ?? null, row.created_at, runId, raw.callId));
      continue;
    }
    const data = row.type === "message" ? id ? { id } : runId && { runId }
      : row.type === "request" ? runId && requestId && { runId, requestId, turn: raw.turn, step: raw.step, attempt: raw.attempt }
      : row.type === "reply" ? runId && requestId && { runId, requestId, status: raw.status, errorCode: raw.errorCode }
      : row.type === "step" ? null
        : row.type === "trajectory/checkpoint" ? runId && { runId, phase: raw.phase, turn: raw.turn, step: raw.step }
        : runId && { ...raw, runId, sessionId: typeof raw.sessionId === "string" ? session(raw.sessionId) : undefined,
          ...(raw.requestId ? { requestId } : {}),
          ...(row.type === "llm/retry" || row.type === "llm/retry-started" ? { retryId: [runId, raw.turn, raw.step].join(":"),
            ...(raw.previousRequestId ? { previousRequestId: replies.get(raw.previousRequestId) } : {}) } : {}),
          ...(row.type === "inbox/rejected" && Array.isArray(raw.messageIds)
            ? { messageIds: raw.messageIds.flatMap((original: string) => messages.get(original) ?? []) } : {}) };
    if (data) save.push(db.prepare("INSERT OR IGNORE INTO events(project_id,type,data,created_at) VALUES(?,?,?,?)")
      .bind(projectId, row.type, JSON.stringify({ ...data, archiveSeq: row.seq }), row.created_at));
  }
  const archivedEvent = "(SELECT id FROM events WHERE project_id=? AND json_extract(data,'$.archiveSeq')=? LIMIT 1)";
  for (const [run, entries] of checkpointRuns) {
    for (const { entry, seq } of entries) save.push(db.prepare(`INSERT INTO archived_fork_checkpoints(run_id,revision,event_seq,patch)
      VALUES(?,?,${archivedEvent},?)`).bind(tasks.get(run), entry.revision, projectId, seq, JSON.stringify(entry.patch)));
  }
  for (const row of archive.timeline) if (row.seq && row.origin && row.origin_run && tasks.has(row.origin_run)) {
    save.push(db.prepare(`INSERT INTO fork_event_ancestry(event_id,origin_event_id,root_run_id)
      SELECT current,original,? FROM (SELECT ${archivedEvent} AS current,${archivedEvent} AS original)
      WHERE current IS NOT NULL AND original IS NOT NULL`).bind(tasks.get(row.origin_run), projectId, row.seq, projectId, row.origin));
  }
  if (media.size && !bucket) throw new AppError("素材存储未配置", 503);
  const stored: string[] = [];
  try {
    for (const entry of media.values()) {
      signal.throwIfAborted();
      stored.push(entry.key);
      await bucket!.put(entry.key, entry.data, { httpMetadata: { contentType: entry.type } });
    }
    signal.throwIfAborted();
    await db.batch(save);
  } catch (error) {
    if (bucket?.remove) await Promise.allSettled(stored.map((key) => bucket.remove!(key)));
    throw error;
  }
  return store.project(projectId, userId);
}
