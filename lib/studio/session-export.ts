import { AppError } from "./security";
import type { BlobStore } from "./storage";
import type { Store } from "./store";
import type { AgentImage, MessageAttachment } from "./types";
import { streamZip, type ZipEntry } from "./zip";

type LogMessage = { id: string; run_id: string | null; role: string; content: string; created_at: string; attachments: string | null };
type LogRun = { id: string; parent_run_id: string | null; label: string; agent_role: string; status: string; created_at: string };
const imageExtensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

const jsonLines = (rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
const quoted = (text: string) => text.split(/\r?\n/).map((line) => "> " + line).join("\n");
const htmlText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function capture(store: Store, project: string, session: string, full = true) {
  return store.db.read(() => {
    const metadata = store.sessions(project).find(({ id }) => id === session);
    if (!metadata) throw new AppError("对话不存在", 404, "SESSION_NOT_FOUND");
    const messages = store.db.prepare(`SELECT id,run_id,role,content,created_at,attachments FROM messages
      WHERE project_id=? AND session_id=? ORDER BY rowid`).bind(project, session).rows<LogMessage>();
    const runs = store.db.prepare(`SELECT id,parent_run_id,label,agent_role,status,created_at,updated_at FROM runs
      WHERE project_id=? AND session_id=? ORDER BY rowid`).bind(project, session).rows<LogRun>();
    const requests = store.db.prepare(`SELECT c.id,c.run_id,c.status,c.visible_text AS text,c.error_code,c.created_at,c.settled_at
      ${full ? ",c.usage,c.response,c.request AS request_meta,c.request_header_id" : ""}
      FROM model_calls c JOIN runs r ON r.id=c.run_id WHERE r.project_id=? AND r.session_id=? ORDER BY c.rowid`)
      .bind(project, session).rows<{ run_id: string; text: string; status: string; request_meta: string }>();
    const parts = full ? store.db.prepare(`WITH requests AS (
      SELECT c.request,c.request_header_id FROM model_calls c JOIN runs r ON r.id=c.run_id WHERE r.project_id=? AND r.session_id=?
    ), needed AS (SELECT request_header_id AS id FROM requests UNION SELECT part.value FROM requests,json_each(requests.request,'$.messageParts') part
      WHERE part.type='text') SELECT p.id,p.content FROM model_request_parts p JOIN needed n ON n.id=p.id`)
      .bind(project, session).rows() : [];
    const tools = store.db.prepare(`SELECT ${full ? "s.*,receipt.result AS receipt" : "s.run_id,s.name,s.status"} FROM execution_steps s JOIN runs r ON r.id=s.run_id
      ${full ? "LEFT JOIN tool_receipts receipt ON receipt.run_id=s.run_id AND receipt.call_id=s.call_id" : ""}
      WHERE r.project_id=? AND r.session_id=? ORDER BY s.seq`).bind(project, session)
      .rows<{ run_id: string; name: string; status: string; output_images?: string | null }>();
    const output = full ? store.db.prepare(`SELECT o.* FROM background_job_output o JOIN runs r ON r.id=o.job_id
      WHERE r.project_id=? AND r.session_id=? ORDER BY o.seq`).bind(project, session).rows() : [];
    const timeline = full ? store.db.prepare(`SELECT e.id,e.type,e.data,e.created_at FROM events e WHERE e.project_id=? AND (
      EXISTS(SELECT 1 FROM runs r WHERE r.id=COALESCE(json_extract(e.data,'$.runId'),CASE WHEN e.type='run' THEN json_extract(e.data,'$.id') END)
        AND r.project_id=e.project_id AND r.session_id=?) OR (e.type='message' AND EXISTS(
        SELECT 1 FROM messages m WHERE m.id=json_extract(e.data,'$.id') AND m.project_id=e.project_id AND m.session_id=?))) ORDER BY e.id`)
      .bind(project, session, session).rows() : [];
    return { metadata, messages, runs, requests, parts, tools, output, timeline };
  });
}

function markdown(log: ReturnType<typeof capture>) {
  const parts = ["# " + log.metadata.title];
  const byRun = new Map<string, { replies: string[]; tools: string[] }>();
  for (const run of log.runs.filter(({ parent_run_id }) => !parent_run_id)) byRun.set(run.id, { replies: [], tools: [] });
  for (const request of log.requests) if (request.text) byRun.get(request.run_id)?.replies.push(request.text);
  for (const tool of log.tools) byRun.get(tool.run_id)?.tools.push(tool.name + " · " + tool.status);
  const lastUser = new Map<string, string>();
  const assistant = new Map<string, LogMessage>();
  for (const message of log.messages) if (message.run_id) {
    if (message.role === "user") lastUser.set(message.run_id, message.id);
    else if (message.role === "assistant") assistant.set(message.run_id, message);
  }
  const append = (message: LogMessage) => {
    const attachments = (JSON.parse(message.attachments ?? "[]") as MessageAttachment[]).map(({ path }) => "附件 · " + path);
    const content = [message.content.trim(), ...attachments].filter(Boolean).join("\n\n");
    if (message.role === "user") { if (content) parts.push(quoted(content)); return; }
    const group = message.run_id ? byRun.get(message.run_id) : undefined;
    const earlier = group?.replies.filter((text, index, all) => index !== all.length - 1 || text.trim() !== message.content.trim()) ?? [];
    const process = [...earlier, ...(group?.tools ?? [])];
    if (process.length) parts.push("<details>\n<summary>执行过程</summary>\n\n" + process.map(htmlText).join("\n\n") + "\n\n</details>");
    if (content) parts.push(content);
  };
  for (const message of log.messages) {
    const runId = message.run_id;
    if (message.role === "assistant" && runId && lastUser.has(runId)) continue;
    append(message);
    const reply = runId && lastUser.get(runId) === message.id ? assistant.get(runId) : undefined;
    if (reply) append(reply);
  }
  return parts.join("\n\n") + "\n";
}

export function sessionMarkdown(store: Store, project: string, session: string) {
  return markdown(capture(store, project, session, false));
}

export function sessionZip(store: Store, project: string, session: string, bucket?: BlobStore) {
  const log = capture(store, project, session), entries: ZipEntry[] = [], encoder = new TextEncoder();
  const write = (name: string, value: string) => entries.push({ name, async open() { return encoder.encode(value); } });
  const attachments = new Map<string, string>();
  const toolImages = new Map<string, string>();
  for (const message of log.messages) for (const file of JSON.parse(message.attachments ?? "[]") as MessageAttachment[]) {
    const reference = `${file.id}/${file.version}`;
    if (attachments.has(reference)) continue;
    const [version] = store.db.prepare(`SELECT v.content,v.metadata FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id
      WHERE a.project_id=? AND a.id=? AND v.version=? UNION ALL
      SELECT content,metadata FROM artifacts WHERE project_id=? AND id=? AND version=? LIMIT 1`)
      .bind(project, file.id, file.version, project, file.id, file.version).rows<{ content: string; metadata: string }>();
    if (!version) continue;
    const filename = file.path.split("/").pop()?.replace(/[^\p{L}\p{N} ._-]+/gu, "_").replace(/^\.+/, "") || "附件";
    const name = `附件/${attachments.size + 1}/${filename}`;
    const key = JSON.parse(version.metadata).objectKey;
    attachments.set(reference, name);
    if (typeof key === "string" && key.startsWith(project + "/")) entries.push({ name, async open() {
      const object = await bucket?.get(key);
      if (!object) throw new AppError("归档缺少附件 " + filename, 404);
      return object.body;
    } });
    else write(name, version.content);
  }
  for (const step of log.tools) for (const image of JSON.parse(step.output_images ?? "[]") as AgentImage[]) {
    const key = image.objectKey;
    if (!key?.startsWith(project + "/") || toolImages.has(key)) continue;
    const extension = imageExtensions[image.mediaType] ?? "bin";
    const name = `回执图片/${toolImages.size + 1}.${extension}`;
    toolImages.set(key, name);
    entries.push({ name, async open() {
      const object = await bucket?.get(key);
      if (!object || object.size !== image.bytes) throw new AppError("归档缺少回执图片", 404);
      return object.body;
    } });
  }
  write("对话.md", markdown(log));
  write("会话.json", JSON.stringify({ format: "doman-session-log", version: 1, session: log.metadata,
    attachments: Object.fromEntries(attachments), toolImages: Object.fromEntries(toolImages) }));
  write("消息.jsonl", jsonLines(log.messages));
  write("执行.jsonl", jsonLines(log.runs));
  write("模型请求.jsonl", jsonLines(log.requests));
  write("模型请求片段.jsonl", jsonLines(log.parts));
  write("工具回执.jsonl", jsonLines(log.tools));
  write("后台输出.jsonl", jsonLines(log.output));
  write("会话事件.jsonl", jsonLines(log.timeline));
  return { stream: streamZip(entries), title: log.metadata.title };
}
