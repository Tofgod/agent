import { goalObjective, interactionDecision, workflowCommand } from "@/lib/studio/workflow-types";
import { streamJobOutput } from "@/lib/studio/background-jobs";
import { z } from "zod";
import { serverContext, bodyJson, errorResponse } from "@/lib/studio/server";
import { publicSettings } from "@/lib/studio/contracts";
import { AppError } from "@/lib/studio/security";
import { createModel } from "@/lib/studio/providers";
import { controlRun } from "@/lib/studio/control";
import { settingsInput, mergeSettings } from "@/lib/studio/settings";
import { clearLocalModelKeys } from "@/server/model-keys";
import { cleanDeletedProject } from "@/server/project-deletion";
import { uid } from "@/lib/studio/store";
import { textZip } from "@/lib/studio/zip";
import { PROJECT_FOLDERS, PROJECT_TRASH, referencePath } from "@/lib/studio/project-layout";
import { CHAT_ATTACHMENT_LIMIT } from "@/lib/studio/types";
import { streamWorkspace } from "@/lib/studio/workspace-feed";
import { projectArchive, restoreProjectArchive } from "@/lib/studio/project-archive";
import { parseSessionReferences } from "@/lib/studio/session-reference";
import { skillName } from "@/lib/studio/session-presets";
import { scheduleInput, Schedules } from "@/lib/studio/schedules";
import { traceAttachments, trajectory, trajectoryContent, trajectoryImages, trajectoryMessage } from "@/lib/studio/trajectory";
import { presetToolCatalog } from "@/lib/studio/agent-tools";
import { mcpCredentialName } from "@/lib/studio/mcp";
import { canInvokeSkill, SKILL_BUNDLE_MAX_BYTES } from "@/lib/studio/skills";
import { moveSession, searchSessions, sessionOutline, setSessionArchived, setSessionPinned } from "@/lib/studio/session-workspace";
import { sessionMarkdown, sessionZip } from "@/lib/studio/session-export";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const projectInput = z.object({
  title: z.string().min(1).max(100), brief: z.string().max(12000), style: z.string().max(2000),
  ratio: z.enum(["16:9", "9:16"]), duration: z.number().int().min(15).max(600),
});
const chatFields = {
  text: z.string().trim().max(16000),
  attachmentIds: z.array(z.string().uuid()).max(CHAT_ATTACHMENT_LIMIT).default([]).refine((ids) => new Set(ids).size === ids.length, "素材重复"),
};
const nonemptyChat = ({ text, attachmentIds }: { text: string; attachmentIds: string[] }) => Boolean(text || attachmentIds.length);
async function handle(request: Request, context: Context): Promise<Response> {
  const { path: p } = await context.params;
  const { userId, store, bucket, encryptionSecret, disk } = await serverContext(request);
  const method = request.method;
  if (p[0] === "bootstrap" && method === "GET") {
    const [projects, settings] = await Promise.all([store.listProjects(userId), store.getSettings(userId, encryptionSecret)]);
    return Response.json({ projects, settings: publicSettings(settings) });
  }
  if (p[0] === "sessions" && p[1] === "search" && p.length === 2 && method === "GET") {
    const search = new URL(request.url).searchParams;
    const query = z.string().trim().min(1).max(160).parse(search.get("query"));
    return Response.json(searchSessions(store, userId, query, search.get("content") !== "false"));
  }
  if (p[0] === "settings") {
    if (p.length === 2 && p[1] === "keys" && method === "DELETE") {
      clearLocalModelKeys(store.db, userId);
      return Response.json(publicSettings(await store.getSettings(userId, encryptionSecret)));
    }
    if (method === "GET") return Response.json(publicSettings(await store.getSettings(userId, encryptionSecret)));
    if (method === "PUT") {
      const input = settingsInput.parse(await bodyJson(request));
      return Response.json(publicSettings(await store.saveSettings(userId, input, encryptionSecret)));
    }
    if (p[1] === "test" && method === "POST") {
      const saved = await store.getSettings(userId, encryptionSecret);
      const settings = mergeSettings(saved, settingsInput.partial().parse(await bodyJson(request)));
      const result = await createModel(settings)({ system: '连接测试，输出 JSON {"ok":true}', input: { test: true }, maxTokens: 80, temperature: 0 });
      return Response.json({ ok: Boolean(result) });
    }
  }
  if (p[0] === "extensions") {
    if (p[1] === "schedules" && p.length === 2 && method === "GET") {
      const params = new URL(request.url).searchParams;
      const { active, ...options } = z.object({ active: z.enum(["true", "false"]).optional(),
        status: z.enum(["active", "paused", "finished"]).optional(), query: z.string().trim().max(160).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().nonnegative().safe().default(0) })
        .parse(Object.fromEntries(params));
      return Response.json(new Schedules(store).listOwned(userId, { ...options, active: active === undefined ? undefined : active === "true" }));
    }
    if (p[1] === "schedules" && p[2] === "finished" && p.length === 3 && method === "DELETE")
      return Response.json(await new Schedules(store).deleteFinished(userId));
    if (p[1] === "tools" && p.length === 2 && method === "GET") return Response.json(presetToolCatalog);
    if (p[1] === "plugins" && p.length === 2 && method === "GET") return Response.json(store.presetPlugins?.list() ?? []);
    if (p[1] === "mcp" && p[2] === "watch" && p.length === 3 && method === "GET" && store.mcp)
      return store.mcp.watch(userId, request.signal);
    if (p[1] === "mcp" && p[2] === "credentials" && p.length === 3 && store.mcp) {
      if (method === "GET") return Response.json(store.mcp.credentialNames(userId));
      if (method === "PUT") {
        const { name, value } = z.strictObject({ name: mcpCredentialName, value: z.string().min(1).max(8192).nullable() }).parse(await bodyJson(request));
        return Response.json(await store.mcp.putCredential(userId, name, value));
      }
    }
    if (p[1] === "presets" && p[2] === "default") {
      if (method === "GET") return Response.json({ id: store.presets.defaultId(userId) });
      if (method === "PUT") return Response.json({ id: await store.presets.setDefault(userId, z.object({ id: z.string().uuid().nullable() }).parse(await bodyJson(request)).id) });
    }
    const id = p[2] ? z.string().uuid().parse(p[2]) : undefined;
    if (p[1] === "presets") {
      if (method === "GET" && !id) return Response.json(store.presets.list(userId));
      if (method === "POST" && !id || method === "PUT" && id) return Response.json(await store.presets.save(userId, await bodyJson(request), id));
      if (method === "DELETE" && id) { await store.presets.remove(userId, id); return Response.json({ ok: true }); }
    }
    if (p[1] === "mcp" && store.mcp) {
      if (method === "GET" && !id) return Response.json(store.mcp.list(userId));
      if (method === "POST" && p[3] === "test" && id) return Response.json(await store.mcp.test(userId, id, request.signal));
      if (method === "POST" && p[3] === "restart" && id) return Response.json(await store.mcp.restart(userId, id));
      if (method === "POST" && !id || method === "PUT" && id) return Response.json(await store.mcp.save(userId, await bodyJson(request), id));
      if (method === "DELETE" && id) { await store.mcp.remove(userId, id); return Response.json({ ok: true }); }
    }
    throw new AppError("接口不存在", 404);
  }
  if (p[0] !== "projects") throw new AppError("接口不存在", 404);
  if (p.length === 2 && p[1] === "import" && method === "POST") {
    if (request.headers.get("Content-Type") !== "application/zip") throw new AppError("请选择 do漫 的项目归档（ZIP）");
    return Response.json(await restoreProjectArchive(store, userId, await request.arrayBuffer(), bucket, request.signal), { status: 201 });
  }
  if (p.length === 1) {
    if (method === "GET") return Response.json(await store.listProjects(userId));
    if (method === "POST") {
      const input = projectInput.partial().parse(await bodyJson(request));
      const created = await store.createProject(userId, input);
      return Response.json(created, { status: 201 });
    }
  }
  if (p.length === 2 && method === "DELETE") {
    const id = z.string().uuid().parse(p[1]);
    await store.deleteArchivedProject(id, userId);
    try { await cleanDeletedProject(store, id, bucket, disk); }
    catch { throw new AppError("项目记录已删除，本地文件清理失败，请重试", 500, "PROJECT_CLEANUP_FAILED"); }
    return Response.json({ ok: true });
  }
  const project = await store.project(p[1], userId);
  const assertProjectWritable = async () => {
    if ((await store.project(project.id, userId)).status === "archived") throw new AppError("请先恢复项目再继续工作", 409, "PROJECT_ARCHIVED");
  };
  const params = new URL(request.url).searchParams;
  const sessionId = params.get("session") ?? "";
  store.assertSession(project.id, sessionId);
  if (p.length === 2) {
    if (method === "GET") return Response.json(await store.snapshot(project.id, userId, sessionId));
    if (method === "PATCH") {
      const updated = await store.updateProject(project.id, userId, projectInput.partial().parse(await bodyJson(request)));
      return Response.json(updated);
    }
  }
  if (p[2] === "events" && method === "GET") return streamWorkspace(request, store, project.id, userId, sessionId);
  if (p.length === 3 && p[2] === "sessions" && method === "GET") return Response.json(store.sessions(project.id));
  if (p[2] === "archive" && method === "PATCH") {
    const { archived, stopSchedules } = z.object({ archived: z.boolean(), stopSchedules: z.boolean().optional() }).parse(await bodyJson(request));
    return Response.json(await store.archiveProject(project.id, userId, archived, stopSchedules));
  }
  if (project.status === "archived" && method !== "GET")
    throw new AppError("请先恢复项目再继续工作", 409, "PROJECT_ARCHIVED");
  if (p[2] === "workflow") {
    const scope = { projectId: project.id, sessionId };
    if (method === "GET" && p.length === 3) return Response.json(store.workflow.view(scope));
    if (method === "PATCH" && p[3] === "approval") {
      store.assertActiveSession(project.id, sessionId);
      const { policy } = z.strictObject({ policy: z.enum(["ask", "never"]) }).parse(await bodyJson(request));
      await store.workflow.setApprovalPolicy(scope, policy);
      return Response.json({ policy });
    }
    if (p[3] === "interactions" && p[4] && method === "POST") {
      store.assertActiveSession(project.id, sessionId);
      const id = z.string().uuid().parse(p[4]);
      if (p[5] === "hold") await store.workflow.holdQuestion(scope, id);
      else await store.workflow.decide(scope, id, interactionDecision.parse(await bodyJson(request)));
      return Response.json({ ok: true });
    }
  }
  if (p[2] === "skills" && store.skills) {
    const library = store.skills;
    const cwd = store.sessionCwd(project.id, sessionId);
    if (method === "GET" && p[3] === "watch" && p.length === 4) return library.observe(request.signal);
    if (method === "GET" && (p[3] === "commands" || p.length === 3 || p[3] === "provider")) {
      const preset = store.presets.get(project.id, sessionId);
      const scope = await store.presetPlugins?.acquire(userId, preset);
      try {
        const { entries } = await library.discover(project.id, scope?.providers, cwd, scope?.scopedProviders, request.signal);
        if (p[3] === "commands")
          return Response.json(entries.map(({ entry }) => entry).filter((entry) => canInvokeSkill(entry, preset?.skills, "user")));
        if (p.length === 3) return Response.json([...library.list(project.id, undefined, cwd), ...entries.map(({ entry }) => entry).filter(({ scope }) => scope === "provider")]);
        const name = skillName.parse(p[4]);
        const skill = entries.find(({ entry }) => entry.scope === "provider" && entry.name === name);
        if (!skill) throw new AppError("技能不存在或无效", 404, "SKILL_NOT_FOUND");
        return Response.json({ text: await skill.read(undefined, undefined, request.signal) });
      } finally { await scope?.release(); }
    }
    if (p[3] === "bundle" && method === "POST") {
      const form = await request.formData(), scope = z.enum(["project", "global"]).parse(form.get("scope"));
      const files = new Map<string, Uint8Array>();
      let total = 0;
      for (const [relative, file] of form) {
        if (relative === "scope") continue;
        if (!(file instanceof File) || files.size >= 64 || files.has(relative) || (total += file.size) > SKILL_BUNDLE_MAX_BYTES)
          throw new AppError("技能包最多包含 64 个文件及 16 MiB 内容", 413);
        files.set(relative, new Uint8Array(await file.arrayBuffer()));
      }
      await assertProjectWritable();
      return Response.json(library.importBundle(project.id, scope, files));
    }
    const scope = z.enum(["project", "global", "external"]).parse(p[3]);
    const name = p[4] ? skillName.parse(p[4]) : undefined;
    if (method === "GET" && name) {
      const query = new URL(request.url).searchParams;
      const resource = query.get("resource");
      if (resource !== null) {
        const bytes = library.file(project.id, scope, name, resource, cwd);
        if (query.get("download") === "1") {
          const filename = encodeURIComponent(resource.split("/").at(-1)!).replace(/['()*]/g, (character) => "%" + character.charCodeAt(0).toString(16));
          return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/octet-stream",
            "Content-Disposition": "attachment; filename*=UTF-8''" + filename, "X-Content-Type-Options": "nosniff" } });
        }
        let text = null;
        if (!bytes.includes(0)) {
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
          catch { /* Binary resources can be downloaded. */ }
        }
        return Response.json({ text });
      }
      if (query.get("directory") === "1") return Response.json(await library.files(project.id, scope, name, cwd));
      return Response.json({ text: library.source(project.id, scope, name, cwd) });
    }
    if (scope === "external") throw new AppError("请在本机目录中编辑该技能", 403);
    if (method === "POST" && !name || method === "PUT" && name) {
      const { text } = z.strictObject({ text: z.string() }).parse(await bodyJson(request));
      await assertProjectWritable();
      return Response.json(library.save(project.id, scope, text, name));
    }
    if (method === "DELETE" && name) { library.remove(project.id, scope, name); return Response.json({ ok: true }); }
  }
  if (p[2] === "preset" && p.length === 3) {
    if (method === "GET") return Response.json(store.presets.get(project.id, sessionId));
    if (method === "PUT") {
      const { id } = z.strictObject({ id: z.string().uuid().nullable() }).parse(await bodyJson(request));
      return Response.json(await store.presets.select(userId, project.id, sessionId, id));
    }
  }
  if (p[2] === "schedules") {
    const schedules = new Schedules(store), id = p[3] ? z.string().uuid().parse(p[3]) : undefined;
    if (method === "GET") return Response.json(id && p[4] === "history" ? schedules.history(project.id, id,
      params.has("before") ? z.coerce.number().int().positive().safe().parse(params.get("before")) : undefined) : id ? schedules.get(project.id, id) : schedules.list(project.id));
    if (method === "POST" && !id) return Response.json(await schedules.save(project.id, await bodyJson(request)), { status: 201 });
    if (id && (method === "PUT" || method === "PATCH")) {
      const prior = schedules.get(project.id, id), { version, expectedUpdatedAt, ...data } = await bodyJson(request);
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== (prior.updatedAt ?? null))
        throw new AppError("任务状态已变化，请刷新后重试", 409, "SCHEDULE_CONFLICT");
      if (method === "PATCH" && data.action === "run") return Response.json(await schedules.runNow(prior));
      if (version !== undefined ? version !== prior.version : expectedUpdatedAt === undefined)
        throw new AppError("定时任务已变化，请刷新再试", 409, "SCHEDULE_CONFLICT");
      if (method === "PUT") {
        const changes = scheduleInput.partial().parse(data);
        return Response.json(await schedules.save(project.id, { title: prior.title, prompt: prior.prompt, timing: prior.timing, target: prior.target, ...changes },
          prior, undefined, undefined, undefined, changes.target !== undefined));
      }
      const action = z.enum(["pause", "resume", "delete"]).parse(data.action);
      return Response.json(await schedules.change(prior, action));
    }
  }
  if (p[2] === "trajectory" && method === "GET") {
    if (p.length === 3) return Response.json(trajectory(store, project.id, sessionId,
      z.coerce.number().int().positive().safe().parse(params.get("before") || Number.MAX_SAFE_INTEGER),
      z.string().trim().max(160).parse(params.get("query") || ""),
      params.has("after") ? z.coerce.number().int().nonnegative().safe().parse(params.get("after")) : undefined,
      params.has("watch") ? z.array(z.coerce.number().int().positive().safe()).max(60).parse(params.get("watch")!.split(",")) : undefined));
    const runId = z.string().uuid().parse(p[3]), channel = z.enum(["model", "tool", "message"]).parse(params.get("channel") ?? "model");
    const id = channel === "tool" ? String(z.coerce.number().int().positive().safe().parse(p[4])) : z.string().uuid().parse(p[4]);
    if (p[5] === "image" && channel !== "message") {
      const index = z.coerce.number().int().nonnegative().safe().parse(p[6]);
      const image = trajectoryImages(store, project.id, sessionId, runId, id, channel)[index];
      const object = image && image.objectKey.startsWith(project.id + "/") ? await bucket.get(image.objectKey) : null;
      if (!object || !image || object.size !== image.bytes || !/^image\/(png|jpeg|gif|webp)$/.test(image.mediaType))
        throw new AppError("检查记录中的图片不可用", 404);
      return new Response(object.body, { headers: { "Content-Type": image.mediaType, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
    }
    if (p.length === 5) {
      const offset = z.coerce.number().int().nonnegative().safe().parse(params.get("offset") || 0);
      if (channel === "message") return Response.json(trajectoryMessage(store, project.id, sessionId, runId, id));
      if (channel === "tool") {
        const run = await store.run(runId, project.id);
        if ((run.sessionId ?? "") !== sessionId) throw new AppError("执行记录不存在", 404);
        const field = z.enum(["input", "output"]).parse(params.get("field") ?? "output");
        return Response.json({ ...store.executionPart(project.id, runId, Number(id), field, offset),
          ...(!offset && field === "output" ? { attachments: traceAttachments(store, project.id, sessionId, runId, id, "tool") } : {}) });
      }
      return Response.json(trajectoryContent(store, project.id, sessionId, runId, id,
        z.enum(["request", "messages", "system", "system-diff", "tools", "response", "thinking", "text", "stream"]).parse(params.get("field") || "request"), offset));
    }
  }
  if (p.length === 3 && p[2] === "sessions" && method === "POST") {
    const input = z.strictObject({ title: z.string().trim().min(1).max(100).default("新对话"),
      forkRunId: z.string().uuid().optional(), atSeq: z.number().int().positive().safe().optional(), presetId: z.string().uuid().optional() })
      .refine((value) => value.atSeq === undefined || Boolean(value.forkRunId)).safeParse(await bodyJson(request));
    if (!input.success) throw new AppError("新建对话请求无效", 400);
    const { title, forkRunId, atSeq, presetId } = input.data;
    return Response.json(forkRunId ? await store.forkSession(project.id, sessionId, forkRunId, title, atSeq)
      : await store.createSession(project.id, title, presetId), { status: 201 });
  }
  if (p.length === 4 && p[2] === "sessions" && p[3] === "management" && method === "PATCH") {
    if (project.status === "archived") throw new AppError("请先恢复项目", 409);
    const input = z.discriminatedUnion("action", [
      z.strictObject({ action: z.literal("archive"), archived: z.boolean(), stopActivity: z.boolean().default(false) }),
      z.strictObject({ action: z.literal("pin"), pinned: z.boolean() }),
      z.strictObject({ action: z.literal("move"), target: z.union([z.literal(""), z.string().uuid()]), after: z.boolean() }),
    ]).parse(await bodyJson(request));
    if (input.action === "archive") return Response.json(await setSessionArchived(store, project.id, sessionId, input.archived, input.stopActivity));
    if (input.action === "pin") return Response.json({ sessions: await setSessionPinned(store, project.id, sessionId, input.pinned) });
    return Response.json({ sessions: await moveSession(store, project.id, sessionId, input.target, input.after) });
  }
  if (p.length === 4 && p[2] === "sessions" && p[3] === "outline" && method === "GET")
    return Response.json(sessionOutline(store, project.id, sessionId));
  if (p.length === 4 && p[2] === "sessions" && p[3] === "export" && method === "GET") {
    if (params.get("format") === "markdown") return new Response(sessionMarkdown(store, project.id, sessionId),
      { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
    const { stream, title } = sessionZip(store, project.id, sessionId, bucket);
    return new Response(stream, { headers: { "Content-Type": "application/zip",
      "Content-Disposition": "attachment; filename=session.zip; filename*=UTF-8''" + encodeURIComponent(title + ".zip") } });
  }
  if (p.length === 3 && p[2] === "sessions" && method === "PATCH") {
    const input = z.union([z.strictObject({ title: z.string().trim().min(1).max(100) }), z.strictObject({ teamEnabled: z.boolean() })]).parse(await bodyJson(request));
    return Response.json("title" in input ? await store.renameSession(project.id, sessionId, input.title) :
      await store.setTeamEnabled(project.id, sessionId, input.teamEnabled));
  }
  if (p.length === 4 && p[2] === "sessions" && p[3] === "metrics" && method === "GET")
    return Response.json(store.sessionExecutionMetrics(project.id, sessionId));
  if (p[2] === "history" && method === "GET") {
    if (params.has("query")) {
      const query = z.string().trim().max(160).parse(params.get("query"));
      return Response.json(store.searchHistory(project.id, sessionId, query));
    }
    const before = z.coerce.number().int().positive().safe().parse(params.get("before"));
    return Response.json(store.historyPage(project.id, sessionId, before));
  }
  if (p[2] === "export" && method === "GET") {
    if (params.get("format") === "archive") {
      return new Response(projectArchive(store, project.id, bucket), { headers: { "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=project.zip; filename*=UTF-8''" + encodeURIComponent(project.title + ".zip") } });
    }
    const snapshot = await store.snapshot(project.id, userId);
    const files = snapshot.artifacts.filter((a) => !["image", "video", "audio", "final"].includes(a.kind))
      .map((a) => ({ name: a.path.replace(/^\/+/, ""), content: a.content }));
    files.unshift(...PROJECT_FOLDERS.map((folder) => ({ name: folder.path.slice(1) + "/", content: "" })));
    return new Response(textZip(files), { headers: { "Content-Type": "application/zip",
      "Content-Disposition": "attachment; filename=project.zip; filename*=UTF-8''" + encodeURIComponent(project.title + ".zip") } });
  }
  if (p[2] === "files" && p[3] === "native" && method === "POST") {
    if (!disk) throw new AppError("本机工作目录未配置", 503);
    await disk.reveal(project.id);
    return Response.json({ ok: true });
  }
  if (p[2] === "artifacts" && !p[3] && method === "POST") {
    if (project.status === "archived") throw new AppError("请先恢复项目", 409);
    const { path } = z.object({ path: z.string().min(1).max(600) }).parse(await bodyJson(request));
    return Response.json(await store.createProjectDocument(project.id, path), { status: 201 });
  }
  if (p[2] === "artifacts" && p[3]) {
    const file = await store.artifact(p[3], project.id);
    if (p[4] === "versions" && method === "GET") return Response.json(await store.versions(file.id, project.id, params.get("view") === "index"));
    if (method === "GET" && params.has("version")) {
      const version = z.coerce.number().int().positive().safe().parse(params.get("version"));
      return Response.json(await store.artifactVersion(project.id, file.id, version));
    }
    if (file.path.startsWith(PROJECT_TRASH)) throw new AppError("文件已移除", 404);
    if (p[4] === "location" && method === "PATCH") {
      if (project.status === "archived") throw new AppError("请先恢复项目", 409);
      const input = z.object({ path: z.string().min(1).max(600).nullable(), version: z.number().int().positive() }).parse(await bodyJson(request));
      if (file.version !== input.version) throw new AppError("文件已有新版本", 409, "VERSION_CONFLICT");
      const result = await store.changeProjectFile(project.id, file, input.path ?? undefined);
      return Response.json(input.path === null ? { id: result.id, removed: true } : result);
    }
    if (method === "PATCH") {
      const input = z.object({ content: z.string().max(700000).optional(), version: z.number().int().optional(), locked: z.boolean().optional() }).parse(await bodyJson(request));
      if (input.locked !== undefined) await store.lockArtifact(file.id, project.id, input.locked);
      if (input.content !== undefined) {
        if (!input.version) throw new AppError("缺少文件版本号");
        const saved = await store.putArtifact(project.id, { path: file.path, kind: file.kind, content: input.content, expectedVersion: input.version, expectedArtifactId: file.id,
          metadata: { ...file.metadata, structuredVersion: null, editedByUser: true } });
        return Response.json(saved);
      }
      return Response.json(await store.artifact(file.id, project.id));
    }
  }
  if (p[2] === "media" && p[3] && method === "GET") {
    if (!bucket) throw new AppError("素材存储未配置", 503);
    const current = await store.artifact(p[3], project.id);
    const requested = new URL(request.url).searchParams.get("version");
    const version = requested === null ? undefined : Number(requested);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw new AppError("素材版本无效");
    const file = version === undefined ? current : await store.mediaArtifact(current.id, version);
    if (typeof file.metadata.objectKey !== "string") throw new AppError("素材尚未生成", 404);
    const rangeHeader = request.headers.get("range");
    const object = await bucket.get(file.metadata.objectKey, rangeHeader ? { range: request.headers } : undefined);
    if (!object) throw new AppError("素材不存在", 404);
    const headers = new Headers({ "Cache-Control": "private, max-age=60", "Accept-Ranges": "bytes" });
    object.writeHeaders(headers);
    headers.set("ETag", object.etag);
    if (object.range && "offset" in object.range) {
      const start = object.range.offset || 0, length = object.range.length || object.size;
      headers.set("Content-Range", "bytes " + start + "-" + (start + length - 1) + "/" + object.size);
      headers.set("Content-Length", String(length));
    } else headers.set("Content-Length", String(object.size));
    return new Response(object.body, { status: object.range ? 206 : 200, headers });
  }
  if (p[2] === "upload" && method === "POST") {
    const form = await request.formData(), file = form.get("file");
    if (!(file instanceof File)) throw new AppError("请选择文件");
    if (file.size > 60 * 1024 * 1024) throw new AppError("文件不能超过 60 MB");
    const type = file.type;
    if (/\.md$/i.test(file.name)) {
      if (file.size > 2 * 1024 * 1024) throw new AppError("参考文档不能超过 2 MB");
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); } catch { throw new AppError("请上传 UTF-8 编码的 Markdown 文件"); }
      if (content.length > 700000) throw new AppError("参考文档不能超过 70 万字符");
      return Response.json(await store.putArtifact(project.id, { path: referencePath(file.name, "text/markdown"), kind: "document", content, metadata: { uploaded: true, reference: true } }));
    }
    if (!/^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm)|audio\/(mpeg|wav|mp4|webm|ogg))$/.test(type)) throw new AppError("支持图片、视频、音频或 Markdown 文件");
    if (!bucket) throw new AppError("素材存储未配置", 503);
    const kind = type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : "audio";
    const path = referencePath(file.name, type);
    const objectKey = project.id + "/uploads/" + uid();
    const bytes = await file.arrayBuffer();
    await assertProjectWritable();
    await bucket.put(objectKey, bytes, { httpMetadata: { contentType: type } });
    try {
      return Response.json(await store.putArtifact(project.id, {
        path, kind, content: "", serveMedia: true,
        metadata: { objectKey, contentType: type, reference: type.startsWith("image/"), uploaded: true },
      }));
    } catch (error) {
      await bucket.remove?.(objectKey).catch(() => {});
      throw error;
    }
  }
  if (p[2] === "chat" && method === "POST") {
    const parsed = z.object({
      ...chatFields,
      requestId: z.string().uuid(),
      mode: z.literal("next-turn").optional(),
    }).refine(nonemptyChat, "请输入消息或选择素材").safeParse(await bodyJson(request));
    if (!parsed.success) throw new AppError("消息或素材引用无效，请检查后重试", 400, "CHAT_INPUT_INVALID");
    const input = parsed.data;
    for (const id of parseSessionReferences(input.text, sessionId).references.keys()) store.assertSession(project.id, id);
    const selected = workflowCommand(input.text);
    if (selected) {
      store.assertActiveSession(project.id, sessionId);
      const scope = { projectId: project.id, sessionId };
      const result = await store.workflow.runCommand(scope, input.requestId, async () => {
        if (selected.name === "plan") {
          const active = selected.input !== "off";
          if (!active && input.attachmentIds.length)
            throw new AppError("/plan off 无需附件", 400, "PLAN_INPUT");
          if (active && (selected.input || input.attachmentIds.length)) {
            const settings = await store.getSettings(userId, encryptionSecret);
            if (!settings.textApiKey) throw new AppError("请先在设置中连接大模型", 409, "MODEL_NOT_CONFIGURED");
            await store.acceptChatAtStep(project.id, { ...input, text: selected.input }, sessionId);
          }
          await store.workflow.setPlan(scope, active);
          return active ? "计划模式已选中" : "计划模式已关闭或将在下一步关闭";
        }
        const goal = store.workflow.goal(scope);
        if (!selected.input) return goal
          ? goal.objective + " · " + goal.roundsStarted + "/" + goal.maxGoalRounds + " 轮"
          : "当前对话没有目标";
        const control = ["pause", "resume", "clear"].includes(selected.input)
          ? selected.input as "pause" | "resume" | "clear" : undefined;
        const edit = selected.input === "edit" || selected.input.startsWith("edit ");
        if (control || edit) {
          if (!goal) throw new AppError("当前对话没有目标", 409, "GOAL_NOT_FOUND");
          if (control && input.attachmentIds.length) throw new AppError("此目标命令无需附件", 400, "GOAL_INPUT");
          const objective = edit ? goalObjective.parse(selected.input.slice(4).trim()) : undefined;
          await store.workflow.updateGoal(scope, { action: control ?? "edit", goal_id: goal.id, revision: goal.revision,
            ...(objective ? { objective } : {}) });
          if (control === "pause" || control === "clear") {
            const id = store.workflow.activeGoalRun(scope, goal.id);
            if (id) await controlRun(store, await store.run(id, project.id), "cancel", await store.getSettings(userId, encryptionSecret));
          }
        } else {
          const settings = await store.getSettings(userId, encryptionSecret);
          if (!settings.textApiKey) throw new AppError("请先在设置中连接大模型", 409, "MODEL_NOT_CONFIGURED");
          await store.workflow.createGoal(scope, selected.input);
        }
        if (input.attachmentIds.length) await store.acceptChatAtStep(project.id,
          { ...input, text: "这些附件供当前目标参考。" }, sessionId);
        return control === "pause" ? "目标已暂停" : control === "resume" ? "目标续轮已启用"
          : control === "clear" ? "目标已清除" : edit ? "目标已更新" : "目标已创建";
      });
      return Response.json({ requestId: input.requestId, notice: result });
    }
    const command = /^\/compact(?:\s|$)/.test(input.text);
    if (command && (input.text !== "/compact" || input.attachmentIds.length))
      throw new AppError("/compact 直接发送即可，无需参数或素材", 400, "COMPACTION_INPUT");
    const queued = input.mode === "next-turn";
    const acknowledged = command ? await store.compactionAcknowledged(project.id, input.requestId, sessionId) :
      await store.queuedChatAcknowledged(project.id, input, sessionId) || (!queued && await store.acceptedChat(project.id, input, sessionId));
    if (!acknowledged) {
      const settings = await store.getSettings(userId, encryptionSecret);
      if (!settings.textApiKey) throw new AppError("请先在设置中连接大模型", 409, "MODEL_NOT_CONFIGURED");
      if (command) await store.requestCompaction(project.id, input.requestId, sessionId);
      else if (queued) await store.enqueueChat(project.id, input, sessionId);
      else await store.acceptChatAtStep(project.id, input, sessionId);
    }
    if (request.headers.get("Prefer") === "return=minimal") return Response.json({ requestId: input.requestId });
    return Response.json(await store.snapshot(project.id, userId, sessionId));
  }
  if (p[2] === "chat-queue" && !p[3] && method === "PATCH") {
    const { runId, items } = z.object({ runId: z.string().uuid(),
      items: z.array(z.object({ requestId: z.string().uuid(), version: z.number().int().positive() })).min(1) }).parse(await bodyJson(request));
    return Response.json({ moved: await store.steerQueuedChats(project.id, runId, items, sessionId) });
  }
  if (p[2] === "chat-queue" && p[3] && method === "PATCH") {
    const requestId = z.string().uuid().parse(p[3]), version = z.number().int().positive();
    const edit = z.discriminatedUnion("action", [
      z.object({ action: z.literal("cancel"), version }),
      z.object({ action: z.literal("steer"), version, runId: z.string().uuid() }),
      z.object({ action: z.literal("replace"), version, ...chatFields }),
    ]).refine((value) => value.action !== "replace" || nonemptyChat(value), "请输入消息或选择素材").parse(await bodyJson(request));
    if (edit.action === "replace") for (const id of parseSessionReferences(edit.text, sessionId).references.keys()) store.assertSession(project.id, id);
    await store.editQueuedChat(project.id, requestId, edit, sessionId);
    return Response.json({ ok: true });
  }
  if (p[2] === "runs" && p[3]) {
    if (p.length === 5 && p[4] === "metrics" && method === "GET") return Response.json(store.executionMetrics(project.id, p[3]));
    const run = await store.run(p[3], project.id);
    if (p[4] === "output" && method === "GET") {
      if (!run.background || (run.sessionId ?? "") !== sessionId || run.payload.inherited)
        throw new AppError("后台任务不存在", 404, "JOB_NOT_FOUND");
      return streamJobOutput(request, store, run);
    }
    if (p[4] === "changes" && p[5] && method === "GET") {
      const requested = new URL(request.url).searchParams.get("through");
      const through = requested === null ? undefined : Number(requested);
      if (through !== undefined && (!Number.isSafeInteger(through) || through < 1)) throw new AppError("对比版本无效");
      return Response.json(await store.compareTurnFile(project.id, run.id, p[5], through));
    }
    if (p[4] === "history" && method === "GET") {
      if (p[5]) {
        const seq = z.coerce.number().int().positive().safe().parse(p[5]);
        if (params.has("field")) {
          const field = z.enum(["input", "output"]).parse(params.get("field"));
          const offset = z.coerce.number().int().nonnegative().safe().parse(params.get("offset") ?? 0);
          return Response.json(store.executionPart(project.id, run.id, seq, field, offset));
        }
        const detail = await store.executionDetail(project.id, run.id, seq);
        const images = traceAttachments(store, project.id, run.sessionId ?? "", run.id, String(seq), "tool");
        return Response.json({ ...detail, ...(images.length ? { images } : {}) });
      }
      const before = z.coerce.number().int().positive().parse(new URL(request.url).searchParams.get("before") || Number.MAX_SAFE_INTEGER);
      return Response.json({ steps: await store.executionHistory(project.id, run.id, before) });
    }
    if (method === "PATCH") {
      const { action } = z.object({ action: z.enum(["pause", "resume", "cancel", "resubmit"]) }).parse(await bodyJson(request));
      await controlRun(store, run, action, await store.getSettings(userId, encryptionSecret));
      if (request.headers.get("Prefer") === "return=minimal") return Response.json({ ok: true });
      return Response.json(await store.snapshot(project.id, userId, run.sessionId));
    }
  }
  throw new AppError("接口不存在", 404);
}
async function respond(request: Request, context: Context) {
  try { return await handle(request, context); }
  catch (error) {
    return errorResponse(error instanceof z.ZodError ? new AppError("输入无效：" +
      (error.issues[0]?.path.join(".") || "请检查提交内容"), 400, "INVALID_INPUT") : error);
  }
}
export { respond as GET, respond as POST, respond as PATCH, respond as PUT, respond as DELETE };
