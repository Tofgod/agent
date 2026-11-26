import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../lib/studio/store";
import { McpManager } from "../lib/studio/mcp";
import { SkillLibrary } from "../lib/studio/skills";
import { PresetPlugins } from "../lib/studio/preset-plugins";
import { tool } from "../lib/studio/file-tools";
import { Schedules } from "../lib/studio/schedules";
import { LocalMediaStore, SQLiteDatabase } from "../server/storage";
import { advanceRun } from "../lib/studio/engine";
import { trajectory, trajectoryContent } from "../lib/studio/trajectory";
import { projectArchive, restoreProjectArchive } from "../lib/studio/project-archive";
import { moveSession, searchSessions, sessionOutline, setSessionArchived, setSessionPinned } from "../lib/studio/session-workspace";
import { sessionMarkdown, sessionZip } from "../lib/studio/session-export";
import { openStudioZip } from "../lib/studio/zip";
import { DEFAULT_SETTINGS, type AgentMessage, type ModelAttemptTrace, type Project } from "../lib/studio/types";
import { createAgentModel, type AgentFunction } from "../lib/studio/providers";
import sharp from "sharp";

const settings = { ...DEFAULT_SETTINGS, textApiKey: "model-test" };
const reply = (content: string): AgentMessage => ({ role: "assistant", content });
const call = (id: string, name: string, args: unknown): AgentMessage => ({ ...reply("正在处理"),
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const doc = (name: string, body: string, fields = "") => "---\nname: " + name + "\ndescription: 处理测试\n" + fields + "---\n\n" + body;

function database(filename = ":memory:") { const db = new SQLiteDatabase(filename); db.initialize("drizzle"); return db; }
async function send(store: Store, project: Project, text: string, session = "") {
  await store.acceptChat(project.id, { requestId: crypto.randomUUID(), text, attachmentIds: [] }, undefined, session);
  const snapshot = await store.snapshot(project.id, "local", session);
  const run = snapshot.runs.find((item) => !item.parentRunId && item.status === "queued");
  assert.ok(run);
  return run;
}

test("session management preserves project isolation, history, and exact attachment versions", async (t) => {
  const db = database(); t.after(() => db.close());
  const store = new Store(db), project = await store.createProject("local", { title: "Session test" });
  const other = await store.createProject("another-user", { title: "Never list this" });
  const session = await store.createSession(project.id, "Story");
  const separate = await store.createSession(project.id, "Private sibling");
  const document = await store.createProjectDocument(project.id, "/01_创作/稿件.md", "Version for export");
  await store.acceptChat(project.id, { requestId: crypto.randomUUID(), text: "跨项目查找剧情", attachmentIds: [document.id] }, undefined, session.id);
  const active = (await store.snapshot(project.id, "local", session.id)).runs[0];
  await advanceRun(store, project, active.id, settings, undefined, async () => reply("Story reply"));
  const job = crypto.randomUUID(), time = new Date().toISOString();
  await db.prepare(`INSERT INTO runs (id,project_id,session_id,parent_run_id,intent,agent_role,stage,status,progress,label,payload,created_at,updated_at,background)
    VALUES (?,?,?,?,'agent','media','composing','queued',0,'Fixture job','{}',?,?,1)`)
    .bind(job, project.id, session.id, active.id, time, time).run();
  const siblingRun = await send(store, project, "Sibling private body", separate.id);
  await store.putArtifact(project.id, { path: document.path, kind: "document", content: "Newer draft", expectedVersion: document.version });
  await store.acceptChat(other.id, { requestId: crypto.randomUUID(), text: "另一个账户的跨项目查找剧情", attachmentIds: [] });
  assert.deepEqual(searchSessions(store, "local", "跨项目查找剧情", true).map(({ sessionId }) => sessionId), [session.id]);
  assert.deepEqual(searchSessions(store, "local", "跨项目查找剧情", false), []);
  assert.equal(sessionOutline(store, project.id, session.id)[0]?.reply, "Story reply");
  await setSessionPinned(store, project.id, session.id, true);
  assert.equal(store.sessions(project.id)[0].id, session.id);
  await moveSession(store, project.id, separate.id, "", false);
  assert.deepEqual(store.sessions(project.id).map(({ id }) => id), [session.id, separate.id, ""]);
  const schedules = new Schedules(store);
  const scheduled = await schedules.save(project.id, { title: "Repeat", prompt: "Repeat prompt",
    timing: { kind: "after", after_seconds: 60 }, target: { kind: "session", id: session.id } });
  const blocked = await setSessionArchived(store, project.id, session.id, true, false);
  assert.equal(blocked.activity?.schedules[0]?.id, scheduled.id);
  assert.deepEqual(blocked.activity?.runs.map(({ id, kind }) => ({ id, kind })), [{ id: job, kind: "job" }]);
  const archived = await setSessionArchived(store, project.id, session.id, true, true);
  assert.equal(archived.sessions?.find(({ id }) => id === session.id)?.archived, true);
  assert.equal(schedules.get(project.id, scheduled.id).status, "paused");
  assert.equal((await store.run(job, project.id)).status, "cancelled");
  await assert.rejects(() => send(store, project, "No new input until restore", session.id), { code: "SESSION_ARCHIVED" });
  assert.equal((await store.snapshot(project.id, "local", separate.id)).runs[0].status, "queued");
  assert.match(sessionMarkdown(store, project.id, session.id), /> 跨项目查找剧情[\s\S]*Story reply/);
  const log = openStudioZip(await new Response(sessionZip(store, project.id, session.id).stream).arrayBuffer());
  const text = new TextDecoder();
  assert.match(text.decode(log.read("对话.md")), /Story reply/);
  assert.doesNotMatch(text.decode(log.read("消息.jsonl")), /Sibling private body/);
  assert.equal(text.decode(log.read("附件/1/稿件.md")), "Version for export");
  const zip = await new Response(projectArchive(store, project.id, undefined)).arrayBuffer();
  const imported = await restoreProjectArchive(store, "local", zip, undefined, AbortSignal.timeout(3000));
  assert.equal(store.sessions(imported.id).find(({ title }) => title === "Story")?.archived, true);
  const restored = await setSessionArchived(store, project.id, session.id, false, false);
  assert.equal(restored.sessions?.find(({ id }) => id === session.id)?.pinned, false);
  assert.equal(schedules.get(project.id, scheduled.id).status, "paused");
  assert.deepEqual((await store.dueRuns()).filter(({ projectId }) => projectId === project.id).map(({ id }) => id), [siblingRun.id]);
  await send(store, project, "Continue after restore", session.id);
});

test("project skills override global ones, stay editable, and cannot read a symlinked resource", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "doman-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skills = new SkillLibrary(root);
  const project = crypto.randomUUID(), other = crypto.randomUUID();
  skills.save(project, "global", doc("scene-check", "全局要求"));
  skills.save(project, "project", doc("scene-check", "项目要求", "disable-model-invocation: true\n"));
  assert.deepEqual(skills.catalog(project, null, "model"), []);
  assert.equal(skills.load(project, "scene-check", null, "user"), "项目要求");
  assert.equal(skills.load(other, "scene-check", null, "model"), "全局要求");
  assert.throws(() => skills.load(project, "scene-check", [], "user"), /不能调用/);
  const dir = path.join(root, "projects", project, "scene-check");
  await writeFile(path.join(dir, "outline.md"), "可读资源");
  await symlink(path.join(root, "global", "scene-check", "SKILL.md"), path.join(dir, "escape.md"));
  assert.equal(skills.load(project, "scene-check", null, "user", "outline.md"), "可读资源");
  assert.throws(() => skills.load(project, "scene-check", null, "user", "escape.md"), /本地目录/);
  skills.save(project, "project", doc("scene-check", "新正文"), "scene-check");
  assert.equal(skills.load(project, "scene-check", null, "model"), "新正文");
  skills.remove(project, "project", "scene-check");
  assert.equal(skills.load(project, "scene-check", null, "model"), "全局要求");
});

test("an incomplete extension Skill catalog retains candidates and the caller can cancel a pending read", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "doman-skill-provider-")), library = new SkillLibrary(root);
  t.after(async () => { library.close(); await rm(root, { recursive: true, force: true }); });
  const entered = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<void>();
  let lists = 0;
  const provider = async () => ({ complete: ++lists > 2, candidates: [{
    name: "sample-skill", description: "Fixture",
    async read(_resource: unknown, signal: AbortSignal) { entered.resolve(signal); await release.promise; return "正文"; },
  }] });
  const project = crypto.randomUUID();
  const partial = await library.discover(project, [provider]);
  assert.equal(partial.complete, false);
  assert.equal(partial.entries[0].entry.name, "sample-skill");
  assert.equal((await library.discover(project, [provider])).complete, false);
  assert.equal((await library.discover(project, [provider])).complete, true);
  await library.discover(project, [provider]);
  assert.equal(lists, 3);
  const controller = new AbortController(), reason = new Error("fixture user stopped");
  const pending = assert.rejects(partial.entries[0].read(undefined, "model", controller.signal), (error) => error === reason);
  try {
    const passed = await entered.promise;
    controller.abort(reason);
    assert.equal(passed.reason, reason);
    await pending;
  } finally { release.resolve(); }
  await assert.rejects(library.discover(project, [provider], undefined, [], controller.signal), (error) => error === reason);
});

test("skill directory import preserves resources and can be repeated after removal", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "doman-skill-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const custom = path.join(root, "custom"), managed = path.join(root, "managed");
  const external = path.join(custom, "external-notes");
  await mkdir(external, { recursive: true });
  const source = path.join(external, "SKILL.md");
  await writeFile(source, doc("external-notes", "外部技能"));
  const skills = new SkillLibrary(managed, [custom]);
  const project = crypto.randomUUID();
  const bundle = new Map([
    ["SKILL.md", Buffer.from(doc("scene-check", "包内技能"))],
    ["resources/scene.md", Buffer.from("包内资源")],
  ]);
  skills.importBundle(project, "project", bundle);
  assert.equal(skills.load(project, "scene-check", null, "user", "resources/scene.md"), "包内资源");
  assert.equal(skills.load(project, "external-notes", null, "user"), "外部技能");
  await writeFile(source, doc("external-notes", "更新外部技能"));
  assert.equal(skills.load(project, "external-notes", null, "user"), "更新外部技能");
  skills.remove(project, "project", "scene-check");
  assert.deepEqual(skills.list(project).map(({ name }) => name), ["external-notes"]);
  skills.importBundle(project, "project", bundle);
  assert.equal(skills.load(project, "scene-check", null, "model"), "包内技能");
});

test("filesystem skill changes invalidate cached discovery and recheck invocation before loading", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "doman-skill-watch-"));
  const custom = path.join(root, "custom"), library = new SkillLibrary(path.join(root, "managed"), [custom]);
  t.after(async () => { library.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(custom);
  const file = path.join(custom, "watch.md");
  await writeFile(file, doc("watch", "original", "whenToUse: Before editing\nmetadata: {type: editorial}\n"));
  const project = crypto.randomUUID();
  const entry = (await library.discover(project)).entries[0];
  assert.equal(entry.entry.whenToUse, "Before editing");
  assert.deepEqual(entry.entry.metadata, { type: "editorial" });
  await delay(30);
  await writeFile(file, doc("watch", "updated", "disable-model-invocation: true\n").replace("处理测试", "updated description"));
  await assert.rejects(entry.read(undefined, "model"), { code: "SKILL_UNAVAILABLE" });
  const deadline = Date.now() + 2000;
  while ((await library.discover(project)).entries[0]?.entry.description !== "updated description" && Date.now() < deadline) await delay(15);
  assert.equal((await library.discover(project)).entries[0].entry.description, "updated description");
  assert.equal(await entry.read(undefined, "user"), "updated");
});

test("filesystem skill failures discard only the failed root, report an incomplete catalog and retry", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "doman-skill-health-"));
  const first = path.join(root, "first"), second = path.join(root, "second");
  const library = new SkillLibrary(path.join(root, "managed"), [first, second]);
  t.after(async () => { library.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(first); await mkdir(second);
  await writeFile(path.join(first, "draft.md"), doc("draft", "first root"));
  await writeFile(path.join(second, "draft.md"), doc("draft", "fallback root"));
  await symlink("loop", path.join(first, "loop"));
  const project = crypto.randomUUID();
  const partial = await library.discover(project);
  assert.equal(partial.complete, false);
  assert.equal(await partial.entries[0].read(), "fallback root");
  await rm(path.join(first, "loop"));
  const healthy = await library.discover(project);
  assert.equal(healthy.complete, true);
  assert.equal(await healthy.entries[0].read(), "first root");
});

test("session presets retain their chosen revision and explicit skill invocation enters the real agent request", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "doman-presets-"));
  const db = database(), skills = new SkillLibrary(root), store = new Store(db, { skills });
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const project = await store.createProject("local", {}), session = await store.createSession(project.id, "编辑");
  skills.save(project.id, "project", doc("notes", "挂载的专用技能正文", "disable-model-invocation: true\n"));
  const preset = await store.presets.save("local", { name: "编辑", instructions: "先核对已有设定", skills: ["notes"], mcpServers: [], tools: ["list_files"] });
  await store.presets.select("local", project.id, session.id, preset.id);
  const { id, ...config } = preset;
  await store.presets.save("local", { ...config, instructions: "另一个修订" }, id);
  const input = "请用 /notes 检查第三幕，也请按 /notes 核对结尾。";
  const run = await send(store, project, input, session.id);
  await assert.rejects(store.presets.select("local", project.id, session.id, null), /停止执行/);
  await advanceRun(store, project, run.id, settings, undefined, async (system, messages, tools) => {
    assert.match(system, /先核对已有设定/);
    assert.doesNotMatch(system, /另一个修订/);
    assert.ok(messages.some(({ content }) => content === input));
    assert.equal(messages.filter(({ content }) => content?.includes("挂载的专用技能正文")).length, 1);
    assert.deepEqual(tools.map(({ function: item }) => item.name), ["list_files"]);
    return reply("已检查");
  });
  assert.equal((await store.run(run.id, project.id)).status, "done");
  const reopened = new Store(db, { skills });
  assert.equal(reopened.presets.get(project.id, session.id)?.instructions, "先核对已有设定");
  await reopened.presets.select("local", project.id, session.id, preset.id);
  assert.equal(reopened.presets.get(project.id, session.id)?.instructions, "另一个修订");
  assert.equal(reopened.presets.get(project.id, ""), null);
});

const rpc = `
function respond(message) {
  if (message.id == null) return null;
  let result;
  switch (message.method) {
    case "initialize": result = { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "fixture", version: "1" }, instructions: "Fixture instructions" }; break;
    case "tools/list": result = { tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }; break;
    case "tools/call": result = { content: [{ type: "text", text: message.params.arguments.text + " " + (globalThis.mcpSecret || "") }] }; break;
    case "resources/list": result = message.params?.cursor === "next" ?
      { resources: [{ uri: "fixture://later", name: "later" }] } :
      { resources: [{ uri: "fixture://notes", name: "notes" }], nextCursor: "next" }; break;
    case "resources/templates/list": result = { resourceTemplates: [] }; break;
    case "resources/read": result = { contents: [{ uri: "fixture://notes", mimeType: "text/plain", text: "notes" }] }; break;
    case "prompts/list": result = { prompts: [{ name: "prompt" }] }; break;
    case "prompts/get": result = { messages: [{ role: "user", content: { type: "text", text: "fixture prompt" } }] }; break;
    default: return { jsonrpc:"2.0", id:message.id, error:{ code:-32601, message:"not available" } };
  }
  return { jsonrpc:"2.0", id:message.id, result };
}`;

test("MCP stdio dispatch uses the discovered schema and removes credentials from model-visible results", async (t) => {
  const db = database(), manager = new McpManager(db, "x".repeat(40));
  t.after(async () => { await manager.close(); db.close(); });
  const script = rpc + `
globalThis.mcpSecret=process.env.MCP_FIXTURE;
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const output=respond(JSON.parse(line));
  if (output) process.stdout.write(JSON.stringify(output)+"\\n");
});`;
  const view = await manager.save("local", { name: "检索", transport: "stdio", enabled: true, command: process.execPath,
    credentials: { MCP_FIXTURE: "secret-marker" }, args: ["-e", script] });
  assert.equal(view.hasCredentials, true);
  assert.doesNotMatch(JSON.stringify(manager.list("local")), /secret-marker/);
  const { registrations } = await manager.tools("local", [view.id]);
  assert.equal(registrations.length, 4);
  assert.equal((await manager.tools("local", [])).registrations.length, 0);
  const echo = registrations.find((item) => item.label.includes("echo"))!;
  const result = await echo.execute({ signal: new AbortController().signal } as never, "1", { text: "测试" });
  assert.match(JSON.stringify(result), /测试.*凭据/);
  const resource = registrations.find((item) => item.label.endsWith("read_mcp_resource"))!;
  const scope = { signal: new AbortController().signal } as never;
  assert.match(JSON.stringify(await resource.execute(scope, "2", { server: "检索", uri: "fixture://notes" })), /notes/);
  const list = registrations.find((item) => item.label.endsWith("list_mcp_resources"))!;
  assert.deepEqual((await list.execute(scope, "3", { server: "检索", cursor: "next" }) as { result: { data: unknown } }).result.data,
    { resources: [{ uri: "fixture://later", name: "later" }] });
  assert.match(JSON.stringify(await list.execute(scope, "4", { server: "检索" })), /fixture:\/\/later/);
  await assert.rejects(list.execute(scope, "5", { server: "other" }), { code: "MCP_SERVER_NOT_FOUND" });
  const changedSchema = script.replace('required: ["text"]', 'required: []');
  await manager.save("local", { name: "检索", transport: "stdio", enabled: true, command: process.execPath, args: ["-e", changedSchema],
    startupTimeoutMs: 5000, toolCallTimeoutMs: 2300 }, view.id);
  const replaced = (await manager.tools("local", [view.id])).registrations.find((item) => item.label.includes("echo"))!;
  assert.equal(replaced.name, echo.name);
  assert.notDeepEqual(replaced.schema, echo.schema);
  assert.equal(replaced.timeoutMs, 2300);
  await manager.save("local", { name: "检索", transport: "stdio", enabled: false, command: process.execPath, args: ["-e", script] }, view.id);
  assert.equal(echo.available?.({} as never), false);
  assert.equal((await manager.tools("local", null)).registrations.length, 0);
});

test("MCP tools that require task mode never receive a standard call", async (t) => {
  const db = database(), manager = new McpManager(db, "x".repeat(40));
  const directory = await mkdtemp(path.join(tmpdir(), "doman-mcp-task-")), calls = path.join(directory, "calls");
  t.after(async () => { await manager.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  const script = rpc + `
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line), output = respond(request);
  if (!output) return;
  if (request.method === "initialize") output.result.protocolVersion = "2025-11-25";
  if (request.method === "tools/list") output.result.tools[0].execution = { taskSupport: "required" };
  if (request.method === "tools/call") require("node:fs").appendFileSync(process.argv[1], "called");
  process.stdout.write(JSON.stringify(output) + "\\n");
});`;
  const saved = await manager.save("local", { name: "fixture", transport: "stdio", enabled: true, command: process.execPath, args: ["-e", script, calls] });
  const { registrations } = await manager.tools("local", [saved.id]);
  const entry = registrations.find(({ name }) => name === "mcp__fixture__echo");
  assert.ok(entry);
  await assert.rejects(entry.execute({ signal: AbortSignal.timeout(2000) } as never, "fixture", { text: "fixture" }),
    { code: "MCP_TASK_REQUIRED" });
  await assert.rejects(readFile(calls), { code: "ENOENT" });
});

test("MCP Streamable HTTP discovers and calls a local server with its own encrypted headers", async (t) => {
  const db = database(), manager = new McpManager(db, "x".repeat(40));
  const server = createServer(async (req, res) => {
    if (req.method === "GET" || req.method === "DELETE") { res.writeHead(405).end(); return; }
    if (req.headers.authorization !== "Bearer mcp-fixture") { res.writeHead(401).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const output = respond(JSON.parse(Buffer.concat(chunks).toString()));
    if (!output) { res.writeHead(202).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(output));
  });
  // Shared fixture understands a standard 2025 MCP handshake.
  const respond = new Function(rpc + "\nreturn respond;")() as (value: unknown) => unknown;
  try { await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject)); }
  catch (error) {
    db.close();
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("本地 TCP 监听不可用"); return; }
    throw error;
  }
  t.after(async () => { await manager.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const view = await manager.save("local", { name: "http", enabled: true, transport: "streamable-http",
    url: "http://127.0.0.1:" + address.port + "/mcp", credentials: { Authorization: "Bearer mcp-fixture" } });
  const probe = await manager.test("local", view.id);
  assert.ok(probe.ok);
  assert.equal(probe.toolCount, 1);
  const { registrations, instructions } = await manager.tools("local", null);
  assert.equal(instructions.length, 1);
  const echo = registrations.find((item) => item.label.includes("echo"))!;
  assert.match(JSON.stringify(await echo.execute({ signal: AbortSignal.timeout(2000) } as never, "1", { text: "HTTP 已调用" })), /HTTP 已调用/);
});

test("MCP probing uses an independent budget and strict plugin startup rolls back when a connection fails", async (t) => {
  const db = database(), manager = new McpManager(db, "x".repeat(40));
  const plugins = new PresetPlugins(db, manager, [{ id: "strict-mcp", name: "Strict MCP", setup(scope) {
    scope.registerMcp("strict", { transport: "stdio", command: process.execPath, args: ["-e", "process.exit(1)"],
      startupTimeoutMs: 1000, failOnStartupError: true });
  } }]);
  t.after(async () => { await plugins.close(); await manager.close(); db.close(); });
  const script = rpc + `
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const message = JSON.parse(line);
  const result = respond(message);
  if (result) setTimeout(() => process.stdout.write(JSON.stringify(result) + "\\n"), message.method === "initialize" ? 250 : 0);
});`;
  const row = await manager.save("local", { name: "slow", transport: "stdio", command: process.execPath,
    args: ["-e", script], enabled: false, startupTimeoutMs: 50, closeTimeoutMs: 1000 });
  const result = await manager.test("local", row.id);
  assert.ok(result.ok);
  assert.equal(result.closeConfirmed, true);
  assert.deepEqual(result.toolNames, ["echo"]);
  assert.equal(result.truncated, false);
  await assert.rejects(plugins.start("local", ["strict-mcp"]), { code: "PRESET_PLUGIN_FAILED" });
  assert.deepEqual(manager.list("local").map(({ name }) => name), ["slow"]);
});

test("MCP probes a disabled server and preserves returned image pixels in the project", async (t) => {
  const db = database(), store = new Store(db), manager = new McpManager(db, "x".repeat(40));
  const directory = await mkdtemp(path.join(tmpdir(), "doman-mcp-image-"));
  t.after(async () => { await manager.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  const project = await store.createProject("local", {}), bucket = new LocalMediaStore(directory, db);
  const png = await sharp({ create: { width: 8, height: 7, channels: 3, background: "#ff8800" } }).png().toBuffer();
  const script = rpc + `
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const message=JSON.parse(line);
  const output=message.method==="tools/call" ? {jsonrpc:"2.0",id:message.id,
    result:{content:[{type:"text",text:"before"},{type:"image",mimeType:"image/png",data:${JSON.stringify(png.toString("base64"))}},
      {type:"text",text:"after"}]}} : respond(message);
  if (output) process.stdout.write(JSON.stringify(output)+"\\n");
});`;
  const config = { name: "图片返回", transport: "stdio", command: process.execPath, args: ["-e", script] };
  const disabled = await manager.save("local", { ...config, enabled: false });
  const probe = await manager.test("local", disabled.id);
  assert.ok(probe.ok);
  assert.equal(probe.toolCount, 1);
  assert.equal((await manager.tools("local", [disabled.id])).registrations.length, 0);
  await manager.save("local", { ...config, enabled: true }, disabled.id);
  const { registrations } = await manager.tools("local", [disabled.id]);
  const tool = registrations.find((item) => item.label.includes("echo"))!;
  const receipt = await tool.execute({ project, bucket, settings, signal: AbortSignal.timeout(3000) } as never, "picture", { text: "image" });
  assert.ok("result" in receipt);
  assert.deepEqual(receipt.images?.map(({ width, height }) => [width, height]), [[8, 7]]);
  const file = await bucket.get(receipt.images![0].objectKey);
  assert.ok(file && file.size === receipt.images![0].bytes);
  const imageUrl = "data:image/png;base64," + png.toString("base64");
  const toolName = typeof tool.schema === "function" ? assert.fail("expected MCP schema") : tool.schema.function.name;
  const request = [call("picture", toolName, { text: "image" }),
    { role: "tool" as const, tool_call_id: "picture", content: JSON.stringify(receipt.result), images: receipt.images }];
  for (const native of [false, true]) {
    const fetch = t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)).messages;
      const content: { type: string; text?: string }[] = native ? sent.at(-1).content[0].content : sent.at(-1).content;
      const projection = content.map((part) => part.type === "text" ? part.text : part.type);
      assert.deepEqual(projection, ["before", native ? "image" : "image_url", "after"]);
      return Response.json(native ? { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } :
        { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }] });
    });
    try {
      const route = { ...settings, textBaseUrl: native ? "https://api.deepseek.com/anthropic" : "https://api.deepseek.com" };
      const result = await createAgentModel(route)("fixture", request, [], { resolveImage: async () => imageUrl });
      assert.equal(result.content, "ok");
    } finally { fetch.mock.restore(); }
  }
  const active = new Store(db, { mcp: manager });
  const run = await send(active, project, "use the MCP image");
  await advanceRun(active, project, run.id, settings, bucket, async () => call("archive-image", toolName, { text: "image" }));
  await advanceRun(active, project, run.id, settings, bucket, async () => assert.fail("expected MCP tool step"));
  await advanceRun(active, project, run.id, settings, bucket, async () => reply("done"));
  const zip = await new Response(projectArchive(active, project.id, bucket)).arrayBuffer();
  const archive = await restoreProjectArchive(active, "local", zip, bucket, AbortSignal.timeout(3000));
  const restored = db.prepare("SELECT output_images FROM execution_steps WHERE project_id=? AND name=?")
    .bind(archive.id, toolName).rows<{ output_images: string }>().at(0);
  assert.ok(restored?.output_images);
  const [image] = JSON.parse(restored.output_images);
  assert.ok(image.objectKey.startsWith(archive.id + "/"));
  assert.ok(await bucket.get(image.objectKey));
});

test("MCP reconnects a dropped server and holds its catalog between connections", async (t) => {
  const db = database(), manager = new McpManager(db, "x".repeat(40));
  t.after(async () => { await manager.close(); db.close(); });
  const script = rpc + `
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const message=JSON.parse(line);
  const output=respond(message);
  if (!output) return;
  process.stdout.write(JSON.stringify(output)+"\\n", () => {
    if (message.method==="tools/call" && message.params.arguments.text==="disconnect") process.exit(0);
  });
});`;
  const server = await manager.save("local", { name: "自动连接", transport: "stdio", enabled: true, command: process.execPath, args: ["-e", script] });
  const registrations = async () => (await manager.tools("local", [server.id])).registrations;
  const before = await registrations();
  const echo = before.find(({ label }) => label.endsWith(" · echo"))!;
  const context = { signal: AbortSignal.timeout(5000) } as never;
  await echo.execute(context, "first", { text: "disconnect" });
  const status = () => manager.list("local")[0]?.status;
  for (let i = 0; i < 200 && status() !== "reconnecting"; i++) await delay(10);
  assert.equal(status(), "reconnecting");
  assert.deepEqual((await registrations()).map(({ name }) => name), before.map(({ name }) => name));
  for (let i = 0; i < 200 && status() !== "ready"; i++) await delay(10);
  assert.equal(status(), "ready");
  const recovered = (await registrations()).find(({ name }) => name === echo.name)!;
  assert.match(JSON.stringify(await recovered.execute(context, "restored", { text: "restored" })), /restored/);
});

test("MCP watch reports credential availability and rotation replaces only the affected connection", { timeout: 8000 }, async (t) => {
  const db = database(), manager = new McpManager(db, "x".repeat(40));
  const watcher = new AbortController();
  t.after(async () => { watcher.abort(); await manager.close(); db.close(); });
  const reader = manager.watch("local", watcher.signal).body!.getReader();
  const decoder = new TextDecoder();
  const read = async () => JSON.parse(decoder.decode((await reader.read()).value).slice(6).trim()) as ReturnType<McpManager["list"]>;
  assert.deepEqual(await read(), []);
  const script = rpc + `
globalThis.mcpSecret = process.env.VAULT_TOKEN === "first-fixture-key" ? "phase-one" : "phase-two";
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const result=respond(JSON.parse(line));
  if (result) process.stdout.write(JSON.stringify(result)+"\\n");
});`;
  const view = await manager.save("local", { name: "凭据测试", transport: "stdio", command: process.execPath, args: ["-e", script],
    credentials: { VAULT_TOKEN: "${credential:TEST_KEY}" } });
  const untilStatus = async (status: string) => {
    let item;
    for (let i = 0; i < 6; i++) {
      item = (await read()).find(({ id }) => id === view.id);
      if (item?.status === status) return item;
    }
    assert.equal(item?.status, status);
    return item!;
  };
  await untilStatus("waiting-credentials");
  const noCredentials = await manager.test("local", view.id);
  assert.ok(!noCredentials.ok);
  assert.equal(noCredentials.code, "MCP_CREDENTIALS_MISSING");
  assert.equal(noCredentials.stage, "connect");
  assert.equal(noCredentials.closeConfirmed, true);
  await manager.putCredential("other", "TEST_KEY", "separate-user-key");
  assert.deepEqual(manager.credentialNames("local"), []);
  await manager.putCredential("local", "TEST_KEY", "first-fixture-key");
  await untilStatus("ready");
  const getEcho = async () => (await manager.tools("local", [view.id])).registrations.find((item) => item.label.endsWith(" · echo"))!;
  const context = { signal: AbortSignal.timeout(2000) } as never;
  const first = await getEcho();
  assert.match(JSON.stringify(await first.execute(context, "one", { text: "运行" })), /phase-one/);
  await manager.putCredential("local", "TEST_KEY", "second-fixture-key");
  await untilStatus("ready");
  const second = await getEcho();
  assert.equal(second.name, first.name);
  assert.match(JSON.stringify(await second.execute(context, "two", { text: "运行" })), /phase-two/);
  assert.doesNotMatch(JSON.stringify(db.connection.prepare("SELECT * FROM mcp_credentials").all()), /fixture-key/);
  await manager.putCredential("local", "TEST_KEY", null);
  await untilStatus("waiting-credentials");
  watcher.abort();
  assert.equal((await reader.read()).done, true);
});

test("preset generations isolate tools, MCP and registered skill sources and retire after their last owner exits", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "doman-preset-generation-"));
  const db = database(), mcp = new McpManager(db, "x".repeat(40));
  let mounted = 0;
  const retired: number[] = [];
  const local = new PresetPlugins(db, mcp, [{ id: "review", name: "审阅扩展", setup(scope) {
    const instance = ++mounted;
    scope.registerSkillProvider(() => [{ name: "remote-review", description: "注册的技能", read: () => "scoped-skill-" + instance }]);
    scope.registerSkillProvider(() => { throw new Error("模拟来源离线"); });
    scope.registerTool({ schema: tool("scoped_review", "测试预设作用域", {}, []), label: "审阅",
      execute: async () => ({ result: { instance } }) });
    scope.registerMcp("内部检索", { transport: "stdio", command: process.execPath,
      args: ["-e", rpc + `require("node:readline").createInterface({input:process.stdin}).on("line",line=>{const out=respond(JSON.parse(line));if(out) console.log(JSON.stringify(out));})`] });
    return () => { retired.push(instance); };
  } }]);
  t.after(async () => { await local.close(); await mcp.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  const store = new Store(db, { skills: new SkillLibrary(directory), mcp, presetPlugins: local });
  const project = await store.createProject("local", {});
  const preset = await store.presets.save("local", { name: "审阅", instructions: "version-one", plugins: ["review"] });
  const a = await store.createSession(project.id, "A", preset.id), b = await store.createSession(project.id, "B", preset.id);
  const ask = async (session: string, instance: number | null) => {
    const run = await send(store, project, "请按 /remote-review 核对", session);
    await advanceRun(store, project, run.id, settings, undefined, async (system, messages, tools) => {
      const names = tools.map(({ function: fn }) => fn.name);
      assert.equal(names.includes("scoped_review"), instance !== null);
      assert.equal(names.some((name) => name.startsWith("mcp_")), instance !== null);
      if (instance !== null) {
        assert.match(system, instance === 1 ? /version-one/ : /version-two/);
        assert.ok(messages.some(({ content }) => content?.includes("scoped-skill-" + instance)));
        assert.ok(messages.some(({ content }) => content?.includes("部分技能来源暂不可用")));
      } else assert.ok(!messages.some(({ content }) => content?.includes("scoped-skill-")));
      return reply("已核对");
    });
    assert.equal((await store.run(run.id, project.id)).status, "done");
  };
  await ask(a.id, 1);
  await ask(b.id, 1);
  await ask("", null);
  assert.equal(mounted, 1);
  const original = await local.acquire("local", preset);
  await original.release();
  const { id, ...config } = preset;
  await store.presets.save("local", { ...config, instructions: "version-two" }, id);
  await store.presets.select("local", project.id, a.id, id);
  await ask(a.id, 2);
  await ask(b.id, 1);
  assert.deepEqual(retired, []);
  assert.ok((await mcp.tools("local", null, original.key)).registrations.length);
  await store.presets.select("local", project.id, b.id, null);
  assert.deepEqual(retired, [1]);
  assert.deepEqual(mcp.list("local"), []);
  assert.deepEqual((await mcp.tools("local", null, original.key)).registrations, []);
});

test("scheduled prompts do not act as explicit user skill gestures", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "doman-scheduled-skills-"));
  const db = database(), skills = new SkillLibrary(directory), store = new Store(db, { skills });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const project = await store.createProject("local", {}), schedules = new Schedules(store);
  skills.save(project.id, "project", doc("notes", "explicit-only-marker", "disable-model-invocation: yes\n"));
  const prompt = "请用 /notes 核对", next = new Date(Date.now() + 60_000).toISOString();
  const record = await schedules.save(project.id, { title: "检查", prompt, timing: { kind: "once", at: next }, target: { kind: "session", id: "" } });
  await schedules.runNow(record);
  await schedules.change(schedules.get(project.id, record.id), "delete");
  const run = (await store.dueRuns()).find(({ projectId }) => projectId === project.id);
  assert.ok(run);
  await advanceRun(store, project, run.id, settings, undefined, async (_system, messages) => {
    assert.ok(messages.some(({ content }) => content?.includes("reminder_prompt_json: " + JSON.stringify(prompt))));
    assert.ok(!messages.some(({ content }) => content?.includes("explicit-only-marker")));
    return reply("已核对");
  });
  assert.equal((await store.run(run.id, project.id)).status, "done");
});

test("scheduled delivery is atomic after reopening, coalesces missed slots and keeps its target conversation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "doman-schedule-"));
  const filename = path.join(root, "schedule.sqlite");
  let db = database(filename);
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const first = new Store(db), project = await first.createProject("local", {});
  const start = Date.parse("2026-11-25T00:00:00Z"), time = Date.parse("2026-11-28T01:15:00Z");
  const row = await new Schedules(first).save(project.id, { title: "复查", prompt: "复查本周素材",
    timing: { kind: "rrule", rrule: "DTSTART;TZID=Asia/Shanghai:20261125T090000\nRRULE:FREQ=DAILY" }, target: { kind: "new_once" } }, undefined, undefined, start);
  assert.equal(row.nextAt, Date.parse("2026-11-25T01:00:00Z"));
  db.close(); db = database(filename);
  const reopened = new Store(db), service = new Schedules(reopened);
  await Promise.all([service.runDue(time), service.runDue(time)]);
  const updated = service.get(project.id, row.id);
  assert.equal(updated.last?.scheduledFor, Date.parse("2026-11-28T01:00:00Z"));
  assert.equal(updated.nextAt, Date.parse("2026-11-29T01:00:00Z"));
  assert.equal(reopened.sessions(project.id).length, 2);
  await reopened.dueRuns();
  const target = (await reopened.snapshot(project.id, "local", updated.sessionId!));
  assert.deepEqual(target.messages.filter((message) => message.role === "user").map(({ content }) => content), ["复查本周素材"]);
  const paused = await service.change(updated, "pause", undefined, time);
  await service.runDue(time + 86400000);
  assert.equal(service.get(project.id, row.id).last?.requestId, updated.last?.requestId);
  const manual = await service.runNow(paused!, time + 86400000);
  assert.equal(manual?.sessionId, updated.sessionId);
  assert.equal(service.get(project.id, row.id).status, "paused");
  await service.change(service.get(project.id, row.id), "delete");
  assert.deepEqual(service.list(project.id), []);
});

test("an agent-created schedule and its tool receipt commit together", async (t) => {
  const db = database(), store = new Store(db, { scheduleToolsEnabled: true });
  t.after(() => db.close());
  const project = await store.createProject("local", {}), run = await send(store, project, "定时检查素材");
  const args = { title: "素材核对", prompt: "核对分镜", timing: { kind: "once", at: new Date(Date.now() + 900000).toISOString() },
    target: { kind: "session", id: "" } };
  await advanceRun(store, project, run.id, settings, undefined, async (_system, _messages, tools) => {
    assert.ok(tools.some(({ function: item }) => item.name === "schedule_create"));
    return call("schedule-once", "schedule_create", args);
  });
  await advanceRun(store, project, run.id, settings, undefined, async () => assert.fail("仅应提交定时工具"));
  const [item] = new Schedules(new Store(db)).list(project.id);
  assert.equal(item.title, args.title);
  assert.equal((await store.toolReceipt(run.id, "schedule-once"))?.result.id, item.id);
});

test("a checked intra-turn anchor forks committed model input and tool results without future content", async (t) => {
  const db = database(), store = new Store(db);
  t.after(() => db.close());
  const project = await store.createProject("local", {}), first = await send(store, project, "原对话");
  const perform = (model: AgentFunction) => advanceRun(store, project, first.id, settings, undefined, model);
  await perform(async () => call("write-a", "write_file", { file_path: "/01_创作/保留.md", content: "# 保留", kind: "document" }));
  const beforeTool = trajectory(store, project.id, "", Number.MAX_SAFE_INTEGER, "").rows.find((row) => row.label === "model/accepted");
  assert.ok(beforeTool?.forkable);
  const early = await store.forkSession(project.id, "", first.id, "工具前", beforeTool.seq);
  assert.equal((await store.artifacts(project.id)).length, 0);
  assert.ok(store.sessionSeed(project.id, early.id)?.messages.some(({ content }) => content?.includes("TOOL_NOT_STARTED")));
  await perform(async () => assert.fail("只执行已提交工具"));
  const afterTool = trajectory(store, project.id, "", Number.MAX_SAFE_INTEGER, "").rows.find((row) => row.label === "tools/settled");
  assert.ok(afterTool?.forkable);
  await perform(async () => reply("切点之后的源回复"));
  const fork = await store.forkSession(project.id, "", first.id, "工具后", afterTool.seq);
  const inherited = await store.snapshot(project.id, "local", fork.id);
  assert.equal(inherited.steps[0]?.status, "done");
  assert.equal(inherited.messages.some(({ content }) => content.includes("切点之后")), false);
  assert.equal(inherited.replies.some(({ content }) => content.includes("切点之后")), false);
  const boundaries = db.prepare("SELECT id,type,data FROM events WHERE project_id=? AND type IN ('turn/start','turn/end')").bind(project.id).rows();
  assert.ok(boundaries.some((row) => row.type === "turn/end" && JSON.parse(String(row.data)).reason?.reason === "forked"), JSON.stringify(boundaries));
  const branch = await send(store, project, "改写为分支", fork.id);
  await advanceRun(store, project, branch.id, settings, undefined, async (_system, messages) => {
    assert.ok(messages.some((message) => message.tool_call_id === "write-a" && message.content?.includes("保留.md")));
    assert.ok(!messages.some((message) => message.content?.includes("切点之后")));
    return reply("独立分支");
  });
  const trace = trajectory(store, project.id, "", Number.MAX_SAFE_INTEGER, "").rows.find((row) => row.kind === "request");
  assert.ok(trace?.detailId);
  assert.match(trajectoryContent(store, project.id, "", first.id, trace.detailId, "request", 0).text!, /system/);
  assert.throws(() => trajectoryContent(store, project.id, fork.id, first.id, trace.detailId!, "request", 0), /不存在/);
  await assert.rejects(store.forkSession(project.id, fork.id, first.id, "跨会话", afterTool.seq), /不属于/);
});

test("an exact fork retains the source-turn preset and survives project archive import", async (t) => {
  const db = database(), store = new Store(db);
  t.after(() => db.close());
  const project = await store.createProject("local", {});
  const a = await store.presets.save("local", { name: "A", instructions: "旧预设" });
  const b = await store.presets.save("local", { name: "B", instructions: "新预设" });
  await store.presets.select("local", project.id, "", a.id);
  const run = await send(store, project, "分支之前的用户问题");
  await advanceRun(store, project, run.id, settings, undefined, async () => call("archive-write", "write_file",
    { file_path: "/01_创作/存档.md", content: "已结算内容", kind: "document" }));
  await advanceRun(store, project, run.id, settings, undefined, async () => assert.fail("只执行工具"));
  await advanceRun(store, project, run.id, settings, undefined, async () => reply("切点之后的正文"));
  await store.presets.select("local", project.id, "", b.id);
  const check = async (project: Project) => {
    const rows = trajectory(store, project.id, "", Number.MAX_SAFE_INTEGER, "").rows;
    const before = rows.findLast((row) => row.label === "model/accepted" && row.forkable)!;
    const after = rows.find((row) => row.label === "tools/settled" && row.forkable)!;
    assert.ok(before && after);
    const fork = await store.forkSession(project.id, "", after.runId, "结算后", after.seq);
    assert.equal(store.presets.get(project.id, fork.id)?.id, a.id);
    assert.ok(store.sessionSeed(project.id, fork.id)?.messages.some((entry) => entry.tool_call_id === "archive-write" && entry.content?.includes("存档.md")));
    assert.ok(!store.sessionSeed(project.id, fork.id)?.messages.some((entry) => entry.content?.includes("切点之后的正文")));
    const early = await store.forkSession(project.id, "", before.runId, "工具前", before.seq);
    assert.ok(store.sessionSeed(project.id, early.id)?.messages.some((entry) => entry.content?.includes("TOOL_NOT_STARTED")));
    const dispatched = rows.find((row) => row.kind === "tool/dispatched" && row.forkable)!;
    const middle = await store.forkSession(project.id, "", dispatched.runId, "工具已调用", dispatched.seq);
    assert.ok(store.sessionSeed(project.id, middle.id)?.messages.some((entry) => entry.content?.includes("TOOL_OUTCOME_UNKNOWN")));
    const inherited = trajectory(store, project.id, fork.id, Number.MAX_SAFE_INTEGER, "").rows.find((row) => row.label === "tools/settled" && row.forkable)!;
    assert.ok(inherited);
    const nested = await store.forkSession(project.id, fork.id, inherited.runId, "再分支", inherited.seq);
    assert.equal(store.presets.get(project.id, nested.id)?.id, a.id);
    return fork;
  };
  const fromLive = await check(project);
  const zip = await new Response(projectArchive(store, project.id, undefined)).arrayBuffer();
  const imported = await restoreProjectArchive(store, "local", zip, undefined, new AbortController().signal);
  await check(imported);
  const importedBranch = store.sessions(imported.id).find((item) => item.title === fromLive.title);
  assert.ok(importedBranch);
  const inherited = trajectory(store, imported.id, importedBranch.id, Number.MAX_SAFE_INTEGER, "").rows.find((row) => row.label === "tools/settled" && row.forkable);
  assert.ok(inherited);
  const newBranch = await store.forkSession(imported.id, importedBranch.id, inherited.runId, "导入前分支再分支", inherited.seq);
  assert.ok(store.sessionSeed(imported.id, newBranch.id)?.messages.some((entry) => entry.tool_call_id === "archive-write"));
});

test("the reference Cron evaluator, pending run coalescing and paged delivery receipts share the same schedule", async (t) => {
  const db = database(), store = new Store(db);
  t.after(() => db.close());
  const project = await store.createProject("local", {}), schedules = new Schedules(store);
  const at = Date.parse("2030-01-02T00:55:00Z");
  const item = await schedules.save(project.id, { title: "工作日检查", prompt: "核对片段",
    timing: { kind: "cron", expression: "0 9 * * 1-5", timeZone: "Asia/Shanghai" }, target: { kind: "new" } }, undefined, undefined, at);
  assert.equal(item.nextAt, at + 300_000);
  const [first, repeated] = await Promise.all([schedules.runNow(item, at), schedules.runNow(item, at + 1000)]);
  assert.equal(first?.requestId, repeated?.requestId);
  assert.equal(repeated && "alreadyPending" in repeated && repeated.alreadyPending, true);
  assert.equal(store.sessions(project.id).length, 2);
  assert.equal(schedules.history(project.id, item.id).rows.length, 1);
  await schedules.runDue(at + 300_000);
  const receipts = schedules.history(project.id, item.id).rows;
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].prompt, "核对片段");
  assert.equal(receipts[1].requestId, first?.requestId);
  assert.equal(schedules.history(project.id, item.id, receipts[0].seq).rows[0].requestId, first?.requestId);
  assert.equal(store.sessions(project.id).length, 3);
});

test("due recurring schedules for one conversation share one input and retain individual receipts", async (t) => {
  const db = database(), store = new Store(db);
  t.after(() => db.close());
  const project = await store.createProject("local", {}), other = await store.createSession(project.id, "另一对话");
  const schedules = new Schedules(store), now = Date.parse("2030-01-02T00:55:00Z");
  const timing = { kind: "cron", expression: "0 9 * * *", timeZone: "Asia/Shanghai" };
  const add = (prompt: string, id: string) => schedules.save(project.id, {
    title: prompt, prompt, timing, target: { kind: "session", id },
  }, undefined, undefined, now);
  const a = await add("核对剧本", ""), b = await add("检查分镜", ""), c = await add("整理素材", other.id);
  const at = now + 300_000;
  await Promise.all([schedules.runDue(at), schedules.runDue(at)]);
  const receipts = [a, b, c].map((row) => schedules.history(project.id, row.id).rows);
  assert.deepEqual(receipts.map((rows) => rows.length), [1, 1, 1]);
  assert.equal(receipts[0][0].requestId, receipts[1][0].requestId);
  assert.notEqual(receipts[0][0].requestId, receipts[2][0].requestId);
  await store.dueRuns();
  const users = (await store.snapshot(project.id, "local")).messages.filter((entry) => entry.role === "user");
  assert.equal(users.length, 1);
  const payload = JSON.parse(users[0].content.split("reminders_json: ")[1]);
  assert.deepEqual(payload.map(({ reminder_prompt }: { reminder_prompt: string }) => reminder_prompt).sort(), ["核对剧本", "检查分镜"]);
});

test("64 due tasks with unconsumed deliveries leave room for a different project", async (t) => {
  const db = database(), store = new Store(db);
  t.after(() => db.close());
  const schedules = new Schedules(store), first = await store.createProject("local", {}), second = await store.createProject("local", {});
  const start = Date.parse("2030-01-02T00:59:00Z");
  const target = { kind: "session", id: "" };
  const timing = { kind: "cron", expression: "0 9 * * *", timeZone: "Asia/Shanghai" };
  const tasks = await Promise.all(Array.from({ length: 64 }, (_, i) => schedules.save(first.id,
    { title: "重复 " + i, prompt: "检查", timing, target }, undefined, undefined, start)));
  await schedules.runDue(start + 60_000);
  const now = start + 86_520_000;
  const unrelated = await schedules.save(second.id, { title: "独立任务", prompt: "整理", target,
    timing: { kind: "once", at: new Date(now).toISOString() } }, undefined, undefined, start);
  await schedules.runDue(now);
  assert.equal(schedules.history(second.id, unrelated.id).rows.length, 1);
  assert.ok(tasks.every(({ id }) => schedules.history(first.id, id).rows.length === 1));
});

test("new-conversation schedule intervals and history retention are configurable", async (t) => {
  const db = database(), store = new Store(db, { schedulePolicy: { newSessionIntervalSeconds: 120, historyRecords: 2 } });
  t.after(() => db.close());
  const project = await store.createProject("local", {}), schedules = new Schedules(store), now = Date.parse("2030-01-02T00:55:00Z");
  const task = await schedules.save(project.id, { title: "定时检查", prompt: "检查", target: { kind: "new" },
    timing: { kind: "cron", expression: "0 9 * * *", timeZone: "Asia/Shanghai" } }, undefined, undefined, now);
  const first = await schedules.runNow(task, now);
  const suppressed = await schedules.runNow(schedules.get(project.id, task.id), now + 90_000);
  assert.equal(suppressed?.requestId, first?.requestId);
  await schedules.runNow(schedules.get(project.id, task.id), now + 120_000);
  await schedules.runNow(schedules.get(project.id, task.id), now + 240_000);
  assert.deepEqual(schedules.history(project.id, task.id).rows.map(({ at }) => at), [now + 240_000, now + 120_000]);
});

test("host schedule management remains owner-scoped and a reserved dialogue runs in its selected project directory", async (t) => {
  const db = database(), store = new Store(db);
  t.after(() => db.close());
  const first = await store.createProject("local", {}), second = await store.createProject("local", {});
  const other = await store.createProject("other-owner", {});
  const service = new Schedules(store), start = Date.parse("2030-06-01T00:00:00Z");
  const preset = await store.presets.save("local", { name: "计划检查", instructions: "使用定时预设" });
  const make = (project: Project, after_seconds: number, create?: { cwd: string; agentPreset: string }) => service.save(project.id,
    { title: "定时核对", prompt: "写入记录", timing: { kind: "after", after_seconds }, target: { kind: "new_once", create } }, undefined, undefined, start);
  const task = await make(first, 60, { cwd: "/01_创作/定时", agentPreset: preset.id });
  await make(second, 3600);
  const unrelated = await make(other, 600);
  assert.deepEqual(service.listOwned("local").map(({ projectId }) => projectId), [first.id, second.id]);
  assert.throws(() => service.owned("local", unrelated.id), { code: "SCHEDULE_MISSING" });
  await assert.rejects(make(first, 120, { cwd: "/../outside", agentPreset: preset.id }), { code: "INVALID_PATH" });
  assert.ok(task.sessionId && !store.sessions(first.id).some(({ id }) => id === task.sessionId));
  await service.runDue(start + 60_001);
  const delivered = service.get(first.id, task.id);
  assert.deepEqual(delivered.target, { kind: "session", id: task.sessionId });
  assert.equal(store.sessionCwd(first.id, task.sessionId!), "/01_创作/定时");
  assert.equal(store.presets.get(first.id, task.sessionId!)?.id, preset.id);
  assert.ok(delivered.updatedAt! > task.updatedAt!);
  const run = (await store.dueRuns()).find(({ projectId }) => projectId === first.id)!;
  await advanceRun(store, first, run.id, settings, undefined, async (system) => {
    assert.match(system, /使用定时预设/);
    return call("scheduled-file", "write_file", { file_path: "已核对.md", content: "定时产物", kind: "document" });
  });
  await advanceRun(store, first, run.id, settings, undefined, async () => assert.fail("只执行工具"));
  assert.deepEqual((await store.artifacts(first.id)).map(({ path }) => path), ["/01_创作/定时/已核对.md"]);
  assert.deepEqual(await service.deleteFinished("local"), { removed: 1 });
  assert.equal(service.listOwned("local").length, 1);
  assert.equal(service.listOwned("other-owner").length, 1);
});

test("archiving pauses active reminders atomically and restoring a legacy archive skips overdue reminders", async (t) => {
  const db = database(), store = new Store(db);
  t.after(() => db.close());
  const project = await store.createProject("local", {}), schedules = new Schedules(store);
  const start = Date.parse("2031-01-02T00:00:00Z");
  const task = await schedules.save(project.id, { title: "到期核对", prompt: "核对", timing: { kind: "every", every_seconds: 120 },
    target: { kind: "session", id: "" } }, undefined, undefined, start);
  await assert.rejects(store.archiveProject(project.id, "local", true), { code: "PROJECT_SCHEDULES_ACTIVE" });
  const archived = await store.archiveProject(project.id, "local", true, true);
  assert.equal(archived.status, "archived");
  assert.equal(schedules.get(project.id, task.id).status, "paused");
  await store.archiveProject(project.id, "local", false);
  await schedules.runDue(start + 180000);
  assert.equal(schedules.history(project.id, task.id).rows.length, 0);
  const resumed = await schedules.change(schedules.get(project.id, task.id), "resume", undefined, start + 180000);
  assert.equal(resumed?.nextAt, start + 240000);
  // Older local databases can already have archived projects with active tasks.
  await db.prepare("UPDATE projects SET status='archived' WHERE id=?").bind(project.id).run();
  await store.archiveProject(project.id, "local", false);
  await schedules.runDue(start + 270000);
  assert.equal(schedules.get(project.id, task.id).status, "paused");
  assert.equal(schedules.history(project.id, task.id).rows.length, 0);
});

test("the scheduler groups all recurring deliveries for the same conversation beyond its former scan size", async (t) => {
  const db = database(), store = new Store(db), schedules = new Schedules(store);
  t.after(() => db.close());
  const project = await store.createProject("local", {}), start = Date.parse("2098-12-31T00:00:00Z");
  for (let index = 0; index < 65; index++)
    await schedules.save(project.id, { title: "提醒 " + index, prompt: "核对 " + index, target: { kind: "session", id: "" },
      timing: { kind: "rrule", rrule: "DTSTART:20990101T000000Z\nRRULE:FREQ=DAILY;COUNT=2" } }, undefined, undefined, start);
  await schedules.runDue(start + 86_400_000);
  const receipts = schedules.list(project.id).map(({ last }) => last?.requestId).filter(Boolean);
  assert.equal(receipts.length, 65);
  assert.equal(new Set(receipts).size, 1);
  assert.equal(db.prepare("SELECT 1 FROM chat_queue WHERE project_id=? AND status='pending'").bind(project.id).rows().length, 1);
});

test("trajectory forward pagination fills the entire gap even when the newest sixty have moved", async (t) => {
  const db = database(), store = new Store(db);
  t.after(() => db.close());
  const project = await store.createProject("local", {}), run = await send(store, project, "检查执行窗口");
  const append = async (first: number, last: number) => {
    const events = Array.from({ length: last - first }, (_, index) => store.event(project.id, "turn/start", { runId: run.id, turn: first + index }));
    return (await db.batch(events)).map(({ meta }) => meta.last_row_id!);
  };
  await append(1, 81);
  const older = trajectory(store, project.id, "", Number.MAX_SAFE_INTEGER, "");
  const expected = await append(81, 246);
  const latest = trajectory(store, project.id, "", Number.MAX_SAFE_INTEGER, "");
  const ids = latest.rows.map(({ seq }) => seq);
  let cursor: number | null = older.rows[0].seq;
  while (cursor !== null) {
    const page = trajectory(store, project.id, "", latest.rows.at(-1)!.seq, "", cursor);
    ids.push(...page.rows.map(({ seq }) => seq));
    cursor = page.after ?? null;
  }
  assert.deepEqual(ids.sort((a, b) => a - b), expected);
});

for (const committed of [false, true]) test("continuing an imported conversation preserves an unfinished tool batch: " +
  (committed ? "committed receipt" : "not started"), async (t) => {
  const db = database(), store = new Store(db);
  t.after(() => db.close());
  const project = await store.createProject("local", {}), run = await send(store, project, "准备写入");
  const filePath = "/01_创作/检查点.md", toolId = "unfinished-write";
  const result = call(toolId, "write_file", { file_path: filePath, content: "不可重放" });
  await advanceRun(store, project, run.id, settings, undefined, async () => result);
  if (committed) {
    assert.ok(await store.claimRun(run.id, project.id));
    const current = await store.run(run.id, project.id);
    await store.beginStep(current, result.tool_calls![0], current.payload.agent?.toolRequestId, 0);
    await store.dispatchStep(current, toolId);
    await store.putArtifact(project.id, { path: filePath, kind: "document", content: "不可重放",
      toolReceipt: { run: current, callId: toolId } });
  }
  const zip = await new Response(projectArchive(store, project.id, undefined)).arrayBuffer();
  const copy = await restoreProjectArchive(store, "local", zip, undefined, new AbortController().signal);
  const followUp = await send(store, copy, "查看上轮结果");
  let checked = false;
  const resumed = await advanceRun(store, copy, followUp.id, settings, undefined, async (_system, messages) => {
    const receipt = JSON.parse(messages.find(({ tool_call_id }) => tool_call_id === toolId)?.content ?? "{}");
    if (committed) assert.equal(receipt.path, filePath);
    else assert.equal(receipt.code, "TOOL_NOT_STARTED");
    checked = true;
    return reply("上次调用没有开始");
  });
  assert.equal(resumed.status, "done", resumed.error ?? "");
  assert.ok(checked);
  assert.deepEqual((await store.artifacts(copy.id)).map(({ version }) => version), committed ? [1] : []);
});

test("an imported conversation retains scoped pagination for original tool output and reference snapshots", async (t) => {
  const db = database(), store = new Store(db);
  t.after(() => db.close());
  const project = await store.createProject("local", {}), branch = await store.createSession(project.id, "已有分支");
  const source = await store.createSession(project.id, "原对话");
  const run = await send(store, project, "继续读长回执", branch.id);
  const outputRef = crypto.randomUUID(), snapshotId = crypto.randomUUID(), stamp = new Date().toISOString();
  const raw = JSON.stringify({ content: "内容".repeat(2500) + "保留的末尾" });
  const messages: AgentMessage[] = [{ role: "assistant", content: "", tool_calls: call("long-result", "read_file", {}).tool_calls },
    { role: "tool", tool_call_id: "long-result", content: JSON.stringify({ result_ref: outputRef }), outputRef },
    { role: "user", content: JSON.stringify({ snapshot_id: snapshotId }), source: { kind: "session-reference", snapshotIds: [snapshotId] } }];
  await db.batch([
    db.prepare("UPDATE project_sessions SET seed=? WHERE id=?").bind(JSON.stringify({ messages }), branch.id),
    db.prepare(`INSERT INTO execution_steps(project_id,run_id,call_id,name,status,arguments,result,summary,started_at,finished_at,output_ref)
      VALUES(?,?,?,'read_file','done','{}',?,'',?,?,?)`).bind(project.id, run.id, "long-result", raw, stamp, stamp, outputRef),
    db.prepare(`INSERT INTO session_reference_snapshots(id,project_id,target_session_id,input_id,source_session_id,preview,total_lines)
      VALUES(?,?,?,?,?,?,2)`).bind(snapshotId, project.id, branch.id, "fixture-input", source.id, JSON.stringify({ snapshot_id: snapshotId })),
    db.prepare("INSERT INTO session_reference_lines(snapshot_id,line,text) VALUES(?,1,'第一行'),(?,2,'全文末尾')").bind(snapshotId, snapshotId),
  ]);
  const zip = await new Response(projectArchive(store, project.id, undefined)).arrayBuffer();
  const copy = await restoreProjectArchive(store, "local", zip, undefined, new AbortController().signal);
  const session = store.sessions(copy.id).find(({ title }) => title === branch.title)!;
  const seed = store.sessionSeed(copy.id, session.id)!;
  const copiedTool = seed.messages[1], copiedReference = seed.messages[2];
  assert.equal(copiedTool.outputRef, outputRef);
  assert.equal(JSON.parse(copiedTool.content!).result_ref, copiedTool.outputRef);
  const copiedId = JSON.parse(copiedReference.content!).snapshot_id;
  assert.notEqual(copiedId, snapshotId);
  assert.deepEqual(copiedReference.source, { kind: "session-reference", snapshotIds: [copiedId] });
  const followUp = await send(store, copy, "续读", session.id);
  const result = await store.readAgentToolResult(followUp, { runId: followUp.id, reference: copiedTool.outputRef }, 4800);
  assert.match(result.result.text!, /保留的末尾/);
  assert.equal(store.readSessionReference(followUp, copiedId, 2, 1).content, "全文末尾");
  assert.throws(() => store.readSessionReference({ ...followUp, sessionId: "" }, copiedId, 1, 1), { code: "SESSION_REFERENCE_UNAVAILABLE" });
});

test("new conversations and delegated instances can use different persisted preset revisions", async (t) => {
  const db = database(), base = new Store(db);
  t.after(() => db.close());
  const writer = await base.presets.save("local", { name: "编剧", instructions: "writer-preset", tools: ["list_files"] });
  const main = await base.presets.save("local", { name: "制片", instructions: "main-preset", childPresets: [writer.id] });
  await base.presets.setDefault("local", main.id);
  const project = await base.createProject("local", {}), session = await base.createSession(project.id, "新会话");
  assert.equal(base.presets.get(project.id, "")?.id, main.id);
  assert.equal(base.presets.get(project.id, session.id)?.id, main.id);
  const run = await send(base, project, "委派编剧", session.id);
  let mainSystem = "", namedPreset = false;
  await advanceRun(base, project, run.id, settings, undefined, async (system, _messages, tools) => {
    mainSystem = system;
    namedPreset = JSON.stringify(tools).includes(writer.id);
    return call("delegate-with-preset", "delegate", { role: "writer", instruction: "写一场戏", agent_preset: writer.id });
  });
  assert.match(mainSystem, /main-preset/);
  assert.equal(namedPreset, true);
  await advanceRun(base, project, run.id, settings, undefined, async () => reply("unexpected model"));
  const child = (await base.snapshot(project.id, "local", session.id)).runs.find((row) => row.parentRunId === run.id);
  assert.ok(child);
  await base.presets.save("local", { name: "编剧修订", instructions: "changed-preset" }, writer.id);
  let childSystem = "", childTools: string[] = [];
  await advanceRun(new Store(db), project, child.id, settings, undefined, async (system, _messages, tools) => {
    childSystem = system;
    childTools = tools.map((tool) => tool.function.name);
    return reply("已写场景");
  });
  assert.match(childSystem, /writer-preset/);
  assert.doesNotMatch(childSystem, /main-preset|changed-preset/);
  assert.deepEqual(childTools, ["list_files"]);
});

test("a child step can seed a branch in its own directory, including after archive import", async (t) => {
  const db = database(), store = new Store(db);
  t.after(() => db.close());
  const project = await store.createProject("local", {}), run = await send(store, project, "主对话不应进入分支");
  await advanceRun(store, project, run.id, settings, undefined, async () => call("fork-child", "delegate",
    { role: "writer", instruction: "子任务独立输入", cwd: "/01_创作/写作" }));
  await advanceRun(store, project, run.id, settings, undefined, async () => assert.fail("only dispatch"));
  const [child] = await store.children(run);
  assert.ok(child);
  await advanceRun(store, project, child.id, settings, undefined, async () => reply("子任务已完成"));
  const check = async (subject: Project) => {
    const item = trajectory(store, subject.id, "", Number.MAX_SAFE_INTEGER, "").rows.find((row) => row.child && row.label === "model/accepted");
    assert.ok(item?.forkable);
    const branch = await store.forkSession(subject.id, "", item.runId, "子任务分支", item.seq);
    const seed = store.sessionSeed(subject.id, branch.id)!;
    assert.ok(seed.messages.some(({ content }) => content?.includes("子任务独立输入")));
    assert.ok(!seed.messages.some(({ content }) => content?.includes("主对话不应进入分支")));
    assert.equal(store.sessionCwd(subject.id, branch.id), "/01_创作/写作");
    assert.equal((await store.snapshot(subject.id, "local", branch.id)).runs.length, 1);
  };
  await check(project);
  const zip = await new Response(projectArchive(store, project.id, undefined)).arrayBuffer();
  await check(await restoreProjectArchive(store, "local", zip, undefined, new AbortController().signal));
});

test("ordinary user events and inherited events can seed a fork with no future assistant output", async (t) => {
  const db = database(), store = new Store(db);
  t.after(() => db.close());
  const project = await store.createProject("local", {});
  const root = await send(store, project, "message-anchor");
  const point = trajectory(store, project.id, "", Number.MAX_SAFE_INTEGER, "").rows.find(({ kind, label }) => kind === "message" && label === "message-anchor");
  assert.ok(point?.forkable);
  const initial = await store.forkSession(project.id, "", root.id, "在用户消息处", point.seq);
  assert.ok(store.sessionSeed(project.id, initial.id)?.messages.some((message) => message.content === "message-anchor"));
  await advanceRun(store, project, root.id, settings, undefined, async () => reply("future-answer-marker"));
  const fromOld = trajectory(store, project.id, initial.id, Number.MAX_SAFE_INTEGER, "").rows.find(({ kind, label }) => kind === "message" && label === "message-anchor");
  assert.ok(fromOld?.forkable);
  db.connection.prepare("DELETE FROM fork_event_ancestry WHERE event_id=?").run(fromOld.seq);
  const [, backfill] = (await readFile("drizzle/0034_fork_event_ancestry.sql", "utf8")).split("--> statement-breakpoint");
  db.connection.exec(backfill);
  const mapped = db.connection.prepare("SELECT origin_event_id FROM fork_event_ancestry WHERE event_id=?").get(fromOld.seq);
  assert.equal(mapped?.origin_event_id, point.seq);
  const second = await store.forkSession(project.id, initial.id, fromOld.runId, "继承记录再分支", fromOld.seq);
  const seed = store.sessionSeed(project.id, second.id);
  assert.ok(seed?.messages.some((message) => message.content === "message-anchor"));
  assert.ok(!seed?.messages.some((message) => message.content === "future-answer-marker"));
});

test("tool receipts and model input are searchable and the previous system prompt is diffed", async (t) => {
  const db = database(), store = new Store(db);
  t.after(() => db.close());
  const project = await store.createProject("local", {});
  const old = await store.presets.save("local", { name: "A", instructions: "prompt-old-marker" });
  await store.presets.select("local", project.id, "", old.id);
  const first = await send(store, project, "内容 A");
  await advanceRun(store, project, first.id, settings, undefined, async () => reply("A"));
  const next = await store.presets.save("local", { name: "B", instructions: "prompt-new-marker" });
  await store.presets.select("local", project.id, "", next.id);
  const second = await send(store, project, "内容 B");
  await advanceRun(store, project, second.id, settings, undefined, async () => call("tool-query", "list_files", { path: "/01_创作" }));
  await advanceRun(store, project, second.id, settings, undefined, async () => reply("unexpected"));
  const hit = trajectory(store, project.id, "", Number.MAX_SAFE_INTEGER, "prompt-new-marker").rows.find((row) => row.kind === "request" && row.runId === second.id);
  assert.ok(hit?.detailId);
  const diff = trajectoryContent(store, project.id, "", second.id, hit.detailId, "system-diff", 0);
  assert.match(diff.text ?? "", /-prompt-old-marker/);
  assert.match(diff.text ?? "", /\+prompt-new-marker/);
  assert.ok(trajectory(store, project.id, "", Number.MAX_SAFE_INTEGER, "/01_创作").rows.some(({ kind }) => kind === "step"));
});


test("rejected step inputs stay outside model history and a failed tool body reaches postTool", async (t) => {
  const db = database(), manager = new McpManager(db, "x".repeat(40));
  const proposals: string[][] = [];
  const plugins = new PresetPlugins(db, manager, [{ id: "admission-witness", name: "Admission", setup(scope) {
    scope.registerExecutionHooks({
      preStep({ messages }) {
        const texts = messages.flatMap(({ role, source, content }) => role === "user" && !source && content ? [content] : []);
        proposals.push(texts);
        if (texts.includes("reject")) return { kind: "reject" };
        if (texts.includes("rewrite")) return { kind: "accept", messages: [{ role: "user", content: "rewritten" }] };
      },
      postTool({ call, outcome }) {
        if (call.function.name === "throws" && "result" in outcome && outcome.result.code === "TOOL_ERROR")
          return { result: { code: "FIXTURE_TRANSFORMED" } };
      },
    });
    scope.registerTool({ schema: tool("throws", "Fixture", {}), label: "Fixture", async execute() { throw new Error("tool failed"); } });
  } }]);
  t.after(async () => { await plugins.close(); await manager.close(); db.close(); });
  await plugins.start("local", ["admission-witness"]);
  const store = new Store(db, { presetPlugins: plugins }), project = await store.createProject("local", {});
  const requests: string[][] = [];
  for (const prompt of ["accepted", "reject", "rewrite"]) {
    const run = await send(store, project, prompt);
    let executed = 0;
    for (let step = 0; step < 8; step++) {
      const turn = await advanceRun(store, project, run.id, settings, undefined, async (_system, messages) => {
        requests.push(messages.flatMap(({ role, source, content }) => role === "user" && !source && content ? [content] : []));
        if (prompt === "rewrite" && !executed++) return call("failed", "throws", {});
        if (prompt === "rewrite") assert.equal(JSON.parse(messages.findLast(({ role }) => role === "tool")!.content!).code, "FIXTURE_TRANSFORMED");
        return reply("done");
      });
      if (turn.status === "done") break;
      assert.ok(step < 7 && turn.status !== "failed", turn.error ?? undefined);
    }
  }
  assert.deepEqual(proposals, [["accepted"], ["reject"], ["rewrite"], []]);
  assert.deepEqual(requests, [["accepted"], ["accepted", "rewritten"], ["accepted", "rewritten"]]);
  const denied = trajectory(store, project.id, "", Number.MAX_SAFE_INTEGER, "").rows.find(({ label }) => label === "reject");
  assert.ok(denied?.forkable);
  const branch = await store.forkSession(project.id, "", denied.runId, "Rejected input cut", denied.seq);
  assert.ok(!store.sessionSeed(project.id, branch.id)?.messages.some(({ content }) => content === "reject"));
});

test("a replacement registration cannot run a model call admitted under the old tool", async (t) => {
  const db = database();
  t.after(() => db.close());
  const executions: string[] = [];
  const registration = (name: string) => ({ schema: tool("replaceable", "Fixture", {}), label: "Fixture",
    async execute() { executions.push(name); return { result: { name } }; } });
  const registrations = [registration("old")];
  const store = new Store(db, { tools: registrations }), project = await store.createProject("local", {});
  const run = await send(store, project, "tool binding");
  await advanceRun(store, project, run.id, settings, undefined, async () => call("binding", "replaceable", {}));
  registrations[0] = registration("new");
  await advanceRun(store, project, run.id, settings, undefined, async () => assert.fail("expected tool step"));
  await advanceRun(store, project, run.id, settings, undefined, async (_system, messages) => {
    assert.equal(JSON.parse(messages.findLast(({ role }) => role === "tool")!.content!).code, "UNKNOWN_TOOL");
    return reply("done");
  });
  assert.deepEqual(executions, []);
});

test("records the original Messages stream on failure and restores it from an archive", async (t) => {
  const db = database();
  t.after(() => db.close());
  const store = new Store(db), project = await store.createProject("local", {});
  const run = await send(store, project, "Trace message");
  const start = { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } };
  const thinking = { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "partial thinking fixture" } };
  const signature = { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fixture-signature" } };
  const toolStart = { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "incomplete", name: "write_file", input: {} } };
  const frames = [{ type: "message_start", message: {} }, start, thinking, signature, { type: "content_block_stop", index: 0 }, toolStart];
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0]) => {
    assert.equal(new URL(String(url)).origin, "https://api.deepseek.com");
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "deepseek-flash" }] });
    return new Response(frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join(""),
      { headers: { "content-type": "text/event-stream" } });
  });
  await advanceRun(store, project, run.id, { ...settings, textBaseUrl: "https://api.deepseek.com/anthropic", textThinking: true });
  assert.equal(db.prepare("SELECT 1 FROM execution_steps WHERE run_id=?").bind(run.id).rows().length, 0);
  const read = (projectId: string): ModelAttemptTrace => {
    const row = trajectory(store, projectId, "", Number.MAX_SAFE_INTEGER, "").rows.find(({ kind }) => kind === "request")!;
    assert.equal(row.status, "failed");
    const detail = trajectoryContent(store, projectId, "", row.runId, row.detailId!, "stream", 0);
    return JSON.parse(detail.text!);
  };
  const trace = read(project.id);
  assert.equal(trace.protocol, "messages");
  assert.deepEqual(trace.frames.map(({ data }) => JSON.parse(data)), frames);
  assert.equal(trace.truncated, false);
  const zip = await new Response(projectArchive(store, project.id, undefined)).arrayBuffer();
  const imported = await restoreProjectArchive(store, "local", zip, undefined, AbortSignal.timeout(3000));
  assert.deepEqual(read(imported.id), trace);
  const requestField = (projectId: string, field: "system" | "messages" | "tools" | "response") => {
    const row = trajectory(store, projectId, "", Number.MAX_SAFE_INTEGER, "").rows.find(({ kind }) => kind === "request")!;
    let text = "", offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = trajectoryContent(store, projectId, "", row.runId, row.detailId!, field, offset);
      text += page.text ?? "";
      offset = page.nextOffset;
    }
    return text;
  };
  for (const field of ["system", "messages", "tools", "response"] as const) {
    const original = requestField(project.id, field);
    assert.ok(original);
    const restored = requestField(imported.id, field);
    assert.ok(restored);
    if (field === "system") assert.equal(restored, original);
    else assert.deepEqual(JSON.parse(restored), JSON.parse(original));
  }
});
