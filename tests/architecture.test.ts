import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixture } from "./support";
import { advanceRun } from "../lib/studio/engine";
import { executeFileTool } from "../lib/studio/file-tools";
import { controlRun, controlTaskFromTool } from "../lib/studio/control";
import { replaySession, sessionPatch } from "../lib/studio/session-journal";
import { Store } from "../lib/studio/store";
import { LocalMediaStore, SQLiteDatabase } from "../server/storage";
import { DEFAULT_SETTINGS, IMAGE_MODELS, type AgentMessage, type AgentState, type Project, type Run } from "../lib/studio/types";
import type { AgentFunction } from "../lib/studio/providers";
import type { BlobStore } from "../lib/studio/storage";
import { AppError } from "../lib/studio/security";
import { projectArchive, restoreProjectArchive } from "../lib/studio/project-archive";

const settings = { ...DEFAULT_SETTINGS, textApiKey: "model-test", arkApiKey: "ark-test" };
const reply = (content: string): AgentMessage => ({ role: "assistant", content });
function toolCall(id: string, name: string, args: unknown): AgentMessage {
  return { ...reply(""), tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}
async function send(store: Store, project: Project, text: string) {
  await store.acceptChat(project.id, { requestId: crypto.randomUUID(), text, attachmentIds: [] });
  const run = (await store.snapshot(project.id, "alice")).runs.find((item) => !item.parentRunId && item.status === "queued");
  assert.ok(run);
  return run;
}
const discardCache = (store: Store, run: Run) => store.db.prepare(
  "UPDATE runs SET payload=json_remove(payload,'$.agent','$.agentRevision') WHERE id=?",
).bind(run.id).run();

test("session journal folds appended replies, a prefix compaction and metadata deletion", () => {
  const a: AgentState = { messages: [{ role: "user", content: "a" }], seenUserIds: ["a"], step: 0, toolIndex: 0, artifactIds: [] };
  const b = { ...a, messages: [...a.messages, reply("b"), reply("c")], step: 2, finalReply: "c" };
  const c = { ...b, messages: [reply("summary"), b.messages[2]], summary: "a b", finalReply: undefined };
  assert.deepEqual(sessionPatch(a, b)?.messages, { start: 1, remove: 0, insert: [reply("b"), reply("c")] });
  assert.deepEqual(sessionPatch(b, c)?.messages, { start: 0, remove: 2, insert: [reply("summary")] });
  const entries = [
    { revision: 1, kind: "checkpoint", reference: null, patch: sessionPatch(undefined, a)! },
    { revision: 2, kind: "model/accepted", reference: "request", patch: sessionPatch(a, b)! },
    { revision: 3, kind: "context/compacted", reference: "summary", patch: sessionPatch(b, c)! },
  ] as const;
  assert.deepEqual(replaySession(entries), JSON.parse(JSON.stringify(c)));
  assert.throws(() => replaySession([entries[0], entries[2]]), /缺少检查点/);
});

test("independent conversations can finish simultaneously and existing forks keep their saved model history", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const alternate = await store.createSession(project.id, "备选方案");
  const first = await send(store, project, "原会话里只有的约定");
  const input = { requestId: crypto.randomUUID(), text: "备选方案消息", attachmentIds: [] };
  await store.acceptChat(project.id, input, undefined, alternate.id);
  const second = (await store.snapshot(project.id, "alice", alternate.id)).runs[0];
  assert.equal(second.sessionId, alternate.id);
  for (const [run, expected, excluded] of [[first, "原会话里只有的约定", input.text], [second, input.text, "原会话里只有的约定"]] as const) {
    for (let step = 0; step < 3 && (await store.run(run.id, project.id)).status !== "done"; step++)
      await advanceRun(store, project, run.id, settings, undefined, async (_system, messages) => {
        assert.ok(messages.some((message) => message.content === expected));
        assert.ok(!messages.some((message) => message.content === excluded));
        return reply("已记下 " + expected);
      });
    assert.equal((await store.run(run.id, project.id)).status, "done");
  }
  const forkId = crypto.randomUUID(), completed = await store.run(first.id, project.id);
  await store.db.prepare("INSERT INTO project_sessions(id,project_id,title,created_at,fork_run_id,seed) VALUES(?,?,?,?,?,?)")
    .bind(forkId, project.id, "已有分支", completed.updatedAt, first.id, JSON.stringify(completed.payload.agent)).run();
  await store.acceptChat(project.id, { ...input, requestId: crypto.randomUUID(), text: "接着分支讨论" }, undefined, forkId);
  const reopened = new Store(store.db), branch = (await reopened.snapshot(project.id, "alice", forkId)).runs[0];
  await advanceRun(reopened, project, branch.id, settings, undefined, async (_system, messages) => {
    assert.ok(messages.some((message) => message.content === "已记下 原会话里只有的约定"));
    assert.ok(messages.some((message) => message.content === "接着分支讨论"));
    assert.ok(!messages.some((message) => message.content === input.text));
    return reply("分支独立");
  });
  const defaultFrame = reopened.workspaceFrame(project.id, "alice", 0);
  assert.equal(defaultFrame.frame?.type, "delta");
  if (defaultFrame.frame?.type === "delta") assert.ok(defaultFrame.frame.runs?.every((run) => !run.sessionId));
});

test("shared task revisions validate dependencies and a durable batch releases only eligible members", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const created = await send(store, project, "比较两版开场");
  await store.claimRun(created.id, project.id);
  const parent = await store.run(created.id, project.id);
  const first = await store.changeTeamTask(parent, "task-a", { title: "写开场" });
  const follow = await store.changeTeamTask(parent, "task-b", { title: "核对对白", dependencies: [String(first.id)] });
  assert.equal(follow.ready, false);
  await assert.rejects(store.changeTeamTask(parent, "cycle", { dependencies: [String(follow.id)] }, { id: String(first.id), revision: 1 }), /循环/);
  await store.changeTeamTask(parent, "done", { status: "done" }, { id: String(first.id), revision: 1 });
  assert.equal(store.teamTasks(project.id, "").find(({ id }) => id === follow.id)?.ready, true);
  await assert.rejects(store.changeTeamTask(parent, "old-revision", { detail: "旧编辑" }, { id: String(first.id), revision: 1 }), /最新修订/);
  const specs = [
    { key: "opening", role: "writer", instruction: "写开场", dependencies: [] },
    { key: "compare", role: "director", instruction: "核对开场", dependencies: ["opening"] },
    { key: "separate", role: "writer", instruction: "另写一版", dependencies: [] },
  ];
  const receipt = await store.startBatch(parent, "batch", "三项协作", specs);
  assert.deepEqual(await new Store(store.db).startBatch(parent, "batch", "三项协作", specs), receipt);
  const [opening, compare, separate] = (receipt.tasks as { task_id: string }[]).map(({ task_id }) => task_id);
  const due = (await store.dueRuns()).map(({ id }) => id);
  assert.ok(due.includes(opening) && due.includes(separate) && !due.includes(compare));
  assert.equal(await store.claimRun(compare, project.id), false);
  await advanceRun(store, project, opening, settings, undefined, async () => reply("第一个开场"));
  assert.equal((await store.run(opening, project.id)).status, "done");
  assert.ok((await store.dueRuns()).some(({ id }) => id === compare));
  await advanceRun(store, project, compare, settings, undefined, async (_system, messages) => {
    assert.ok(messages.some((message) => message.content?.includes("第一个开场")));
    return reply("核对完成");
  });
  assert.equal((await store.run(compare, project.id)).status, "done");
});

test("concurrent cross-turn messages wake one lead turn and stay in their conversation", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), first = await send(store, project, "最初的故事设定");
  assert.ok(await store.claimRun(first.id, project.id));
  const lead = await store.run(first.id, project.id);
  const [writer, director] = await Promise.all(["writer", "director"].map((role) =>
    store.startChild(lead, "start-" + role, role, "检查故事", undefined, false, undefined, role)));
  await store.releaseLease(lead);
  const done = await advanceRun(store, project, lead.id, settings, undefined, async () => reply("保留原设定"));
  assert.equal(done.status, "done");
  const other = await store.createSession(project.id, "另一段对话");
  await store.acceptChat(project.id, { requestId: crypto.randomUUID(), text: "独立任务", attachmentIds: [] }, undefined, other.id);
  const otherRun = (await store.snapshot(project.id, "alice", other.id)).runs.find((run) => !run.parentRunId)!;
  assert.equal(await store.resolveCollaborator(otherRun, String(writer.task_id)), undefined);
  const children = await Promise.all([writer, director].map(async ({ task_id }) => {
    const id = String(task_id);
    assert.ok(await store.claimRun(id, project.id));
    return store.run(id, project.id);
  }));
  await assert.rejects(store.sendAgentMessage(children[0], "cross", otherRun.id, "不该送达"), { code: "AGENT_NOT_REACHABLE" });
  // The historical root UUID is also a valid address for the same lead.
  const receipts = await Promise.all(children.map((child, index) => store.sendAgentMessage(child, "note", index ? "lead" : lead.id, "发现 " + index)));
  const wake = String(receipts[0].task_id);
  assert.notEqual(wake, lead.id);
  assert.equal(receipts[1].task_id, wake);
  assert.equal(receipts[1].agent_id, "lead");
  assert.deepEqual(await store.sendAgentMessage(children[0], "note", "lead", "发现 0"), receipts[0]);
  assert.deepEqual((await store.inputs(await store.run(otherRun.id, project.id))).map(({ content }) => content), ["独立任务"]);
  const reopened = new Store(store.db);
  await advanceRun(reopened, project, wake, settings, undefined, async (_system, messages) => {
    assert.ok(messages.some(({ content }) => content === "最初的故事设定"));
    for (const index of [0, 1]) assert.equal(messages.filter(({ content }) => content?.includes("发现 " + index)).length, 1);
    return reply("已收到两个发现");
  });
  assert.equal((await store.run(wake, project.id)).status, "done");
  assert.equal((await store.run(lead.id, project.id)).generation, lead.generation);
  const primary = (await store.snapshot(project.id, "alice")).runs.filter(({ parentRunId }) => !parentRunId);
  assert.deepEqual(new Set(primary.map(({ id }) => id)), new Set([lead.id, wake]));
});

test("the current turn can wait for an earlier child and consume its result once", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), first = await send(store, project, "先委派检查");
  assert.ok(await store.claimRun(first.id, project.id));
  const lead = await store.run(first.id, project.id);
  const child = String((await store.startChild(lead, "review", "writer", "检查开场")).task_id);
  await store.releaseLease(lead);
  assert.equal((await advanceRun(store, project, first.id, settings, undefined, async () => reply("已委派"))).status, "done");

  const second = await send(store, project, "等检查结果");
  await advanceRun(store, project, second.id, settings, undefined, async () => toolCall("wait-old", "wait_for_tasks", { task_ids: [child], wait: true }));
  assert.equal((await advanceRun(store, project, second.id, settings)).status, "waiting");
  assert.equal((await advanceRun(store, project, child, settings, undefined, async () => reply("开场检查完成"))).status, "done");
  const completed = await advanceRun(store, project, second.id, settings, undefined, async (_system, messages) => {
    const receipt = messages.find(({ tool_call_id }) => tool_call_id === "wait-old");
    assert.equal(JSON.parse(receipt!.content!).tasks[0].result, "开场检查完成");
    return reply("已收到检查结果");
  });
  assert.equal(completed.status, "done");
  assert.equal((await store.dueRuns()).length, 0);
});

test("migrating and archiving a team preserves the lead and child assignments", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "doman-session-owner-"));
  const db = new SQLiteDatabase(":memory:");
  t.after(async () => { db.close(); await rm(folder, { recursive: true, force: true }); });
  await cp("drizzle", folder, { recursive: true, filter: (source) => path.basename(source) !== "0029_session_collaboration_identity.sql" });
  db.initialize(folder);
  const legacy = new Store(db), project = await legacy.createProject("alice", {});
  const first = await legacy.createRun(project.id, { instruction: "旧主轮", sourceVersions: {} });
  assert.ok(await legacy.claimRun(first.id, project.id));
  const lead = await legacy.run(first.id, project.id);
  const child = await legacy.startChild(lead, "start", "writer", "保留负责人");
  const tasks = db.prepare(`INSERT INTO team_tasks(id,project_id,session_id,title,detail,status,owner_id,dependencies,created_at)
    VALUES(?,?,'',?,'','in_progress',?,'[]',?)`);
  await tasks.bind(crypto.randomUUID(), project.id, "主任务", lead.id, lead.createdAt).run();
  await tasks.bind(crypto.randomUUID(), project.id, "子任务", child.task_id, lead.createdAt).run();
  db.initialize("drizzle");
  db.initialize("drizzle");
  const store = new Store(db), migrated = store.teamTasks(project.id, "");
  assert.deepEqual(migrated.map(({ ownerId }) => ownerId), ["lead", child.task_id]);
  assert.equal(db.connection.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  assert.deepEqual(db.connection.prepare("PRAGMA foreign_key_check").all(), []);

  const zip = await new Response(projectArchive(store, project.id, undefined)).arrayBuffer();
  const restored = await restoreProjectArchive(store, "alice", zip, undefined, new AbortController().signal);
  const imported = store.teamTasks(restored.id, "");
  assert.equal(imported[0].ownerId, "lead");
  assert.notEqual(imported[1].ownerId, child.task_id);
  assert.equal((await store.run(imported[1].ownerId!, restored.id)).agentRole, "writer");
});

test("delegated batch members have separate directories and pass complete structured results to dependents", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), parent = await send(store, project, "比较两份片段");
  const output_schema = { type: "object", properties: { note: { type: "string" } }, required: ["note"] };
  const callId = "batch-config";
  const model = async () => toolCall(callId, "delegate_batch", { title: "比较", tasks: [
    { key: "a", role: "writer", instruction: "方案甲", cwd: "/01_创作/甲", output_schema },
    { key: "b", role: "writer", instruction: "方案乙", cwd: "/01_创作/乙", output_schema },
    { key: "compare", role: "director", instruction: "汇总", dependencies: ["a", "b"] },
  ] });
  await advanceRun(store, project, parent.id, settings, undefined, model);
  await advanceRun(store, project, parent.id, settings);
  const receipt = await store.toolResult(parent.id, callId);
  const [a, b, compare] = (receipt?.tasks as { task_id: string }[]).map(({ task_id }) => task_id);
  assert.equal(await store.claimRun(compare, project.id), false);
  const large = "较长的乙方案结果".repeat(170);
  for (const [taskId, note, scope] of [[a, "短结果", "甲"], [b, large, "乙"]]) {
    let requests = 0;
    const childModel = async () => {
      requests++;
      if (requests === 1) return toolCall("escape", "write_file", { file_path: "../outside.md", content: note });
      if (requests === 2) return toolCall("write", "write_file", { file_path: "notes.md", content: scope });
      return toolCall("submit", "structured_output", { note });
    };
    let task;
    for (let attempt = 0; attempt < 9 && task?.status !== "done"; attempt++) task = await advanceRun(store, project, taskId, settings, undefined, childModel);
    assert.equal(task?.status, "done");
    assert.equal((await store.toolHistoryResult(taskId, "escape"))?.code, "INVALID_PATH");
    assert.equal((await store.toolResult(taskId, "write"))?.path, "/01_创作/" + scope + "/notes.md");
  }
  const sibling = await store.run(compare, project.id);
  const sources = store.batchInputs(sibling);
  assert.deepEqual(sources.map(({ key }) => key), ["a", "b"]);
  assert.deepEqual(sources.find(({ key }) => key === "a")?.structured, { note: "短结果" });
  const locator = sources.find(({ key }) => key === "b")?.structured_receipt;
  assert.ok(locator?.seq);
  let text = "", offset = 0;
  for (;;) {
    const { result } = await store.readAgentToolResult(sibling, { runId: locator.task_id, seq: locator.seq }, offset);
    text += result.text;
    if (!result.nextOffset) break;
    offset = result.nextOffset;
  }
  assert.deepEqual(JSON.parse(text).structured, { note: large });
  await advanceRun(store, project, compare, settings, undefined, async (_system, messages) => {
    assert.ok(messages.some((message) => message.content?.includes("短结果") && message.content.includes("structured_receipt")));
    return reply("汇总完成");
  });
  assert.equal((await store.run(compare, project.id)).status, "done");
});

test("job submission and delivery keep the original media version after the reference path changes", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "doman-version-"));
  const database = new SQLiteDatabase(":memory:");
  t.after(async () => { database.close(); await rm(folder, { recursive: true, force: true }); });
  database.initialize("drizzle");
  const bucket = new LocalMediaStore(folder, database), store = new Store(database), project = await store.createProject("alice", {});
  const inputPath = "/02_参考/人物.png";
  const putReference = async (content: string) => {
    const objectKey = project.id + "/" + content;
    await bucket.put(objectKey, content, { httpMetadata: { contentType: "image/png" } });
    return store.putArtifact(project.id, { path: inputPath, kind: "image", content: "", serveMedia: true,
      metadata: { objectKey, contentType: "image/png" } });
  };
  const original = await putReference("original-bytes");
  const parent = await send(store, project, "只生成角色图");
  const imageSettings = { ...settings, imageModel: IMAGE_MODELS[0] };
  const model = async () => toolCall("image", "generate_image", { file_path: "/03_图片/角色.png", prompt: "角色设定", reference_paths: [inputPath] });
  await advanceRun(store, project, parent.id, imageSettings, bucket, model);
  await advanceRun(store, project, parent.id, imageSettings, bucket, model);
  const [child] = await store.children(parent);
  assert.deepEqual(child.payload.operation?.referenceVersions?.map(({ id, version }) => [id, version]), [[original.id, 1]]);
  await putReference("replacement");
  let submitted = false;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    submitted = true;
    assert.deepEqual(JSON.parse(String(init?.body)).image, ["data:image/png;base64," + Buffer.from("original-bytes").toString("base64")]);
    return Response.json({ error: { message: "mock rejected after verifying input" } }, { status: 422 });
  });
  await advanceRun(store, project, child.id, imageSettings, bucket, model);
  assert.ok(submitted);
  await store.claimRun(parent.id, project.id);
  const active = await store.run(parent.id, project.id);
  const delivery = await store.presentFiles(active, "delivery", [{ path: inputPath, version: 1 }]);
  const snapshot = await new Store(database).snapshot(project.id, "alice");
  assert.deepEqual(snapshot.deliveries?.[0], delivery);
  const historical = await store.artifactVersion(project.id, original.id, 1);
  assert.equal(historical.metadata.objectKey, project.id + "/original-bytes");
  await store.renameSession(project.id, "", "故事开发");
  const zip = await new Response(projectArchive(store, project.id, bucket)).arrayBuffer();
  const restored = await restoreProjectArchive(store, "alice", zip, bucket, new AbortController().signal);
  const reopened = await store.snapshot(restored.id, "alice");
  assert.notEqual(restored.id, project.id);
  assert.equal(reopened.sessions?.find(({ id }) => id === "")?.title, "故事开发");
  assert.ok(reopened.runs.every((run) => run.payload.imported && !["queued", "running", "waiting"].includes(run.status)));
  const oldAttachment = reopened.deliveries?.[0].files[0];
  assert.equal(oldAttachment?.version, 1);
  assert.notEqual(oldAttachment?.id, original.id);
  const oldMedia = await store.artifactVersion(restored.id, oldAttachment!.id, 1);
  const oldBytes = await bucket.get(String(oldMedia.metadata.objectKey));
  assert.equal(Buffer.from(await oldBytes!.arrayBuffer()).toString(), "original-bytes");
});

test("reopening SQLite replays the model step and reuses a committed file receipt after a crash", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "doman-journal-"));
  let db = new SQLiteDatabase(path.join(dir, "studio.sqlite"));
  try {
    db.initialize("drizzle");
    const store = new Store(db), project = await store.createProject("alice", {});
    const run = await send(store, project, "写一段雨夜对话");
    const filename = "/01_创作/雨夜.md", instruction = toolCall("write", "write_file", { file_path: filename, content: "# 雨夜" });
    await advanceRun(store, project, run.id, settings, undefined, async () => instruction);
    assert.equal(await store.claimRun(run.id, project.id), true);
    const held = await store.run(run.id, project.id);
    await store.beginStep(held, instruction.tool_calls![0]);
    const result = await executeFileTool(store, held, "write", "write_file", { file_path: filename, content: "# 雨夜" });
    assert.equal(result.version, 1);
    const dead = spawnSync(process.execPath, ["-e", ""], { timeout: 2000 });
    assert.equal(dead.status, 0);
    await store.db.prepare("UPDATE runs SET lease_owner=? WHERE id=?").bind(dead.pid, run.id).run();
    await discardCache(store, run);
    db.close();
    db = new SQLiteDatabase(path.join(dir, "studio.sqlite"));
    db.initialize("drizzle");
    db.releaseAbandonedLeases();
    const reopened = new Store(db);
    const restored = await reopened.run(run.id, project.id);
    assert.equal(restored.leaseUntil, 0);
    assert.equal(restored.payload.agent?.messages.at(-1)?.tool_calls?.[0].id, "write");
    assert.deepEqual(restored.payload.agent, replaySession(reopened.sessionEntries(run.id, project.id)));
    await advanceRun(reopened, project, run.id, settings, undefined, async () => assert.fail("已提交的工具须先结算"));
    await advanceRun(reopened, project, run.id, settings, undefined, async (_system, messages) => {
      assert.deepEqual(JSON.parse(messages.find((message) => message.tool_call_id === "write")!.content!), result);
      return reply("已保存雨夜对话。");
    });
    const files = await reopened.artifacts(project.id), state = await reopened.run(run.id, project.id);
    assert.equal(state.status, "done");
    assert.deepEqual(files.map((file) => [file.path, file.version]), [[filename, 1]]);
    const history = await reopened.snapshot(project.id, "alice");
    assert.equal(history.steps.find((step) => step.callId === "write")?.status, "done");
    assert.ok(history.replies.some(({ content }) => content === "已保存雨夜对话。"));
    assert.ok(reopened.sessionEntries(run.id, project.id).some(({ kind, reference }) => kind === "tools/settled" && reference === "write"));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a persisted final reply closes the turn after restart without another model call", async (t) => {
  const store = fixture(), project = await store.createProject("alice", {});
  const run = await send(store, project, "告诉我项目内容");
  t.mock.method(store, "finishAgent", async () => true);
  await advanceRun(store, project, run.id, settings, undefined, async () => reply("项目是空的。"));
  await discardCache(store, run);
  const reopened = new Store(store.db);
  assert.equal((await reopened.run(run.id, project.id)).payload.agent?.finalReply, "项目是空的。");
  await advanceRun(reopened, project, run.id, settings, undefined, async () => assert.fail("已经收到最终回复"));
  assert.equal((await reopened.run(run.id, project.id)).status, "done");
  assert.equal((await reopened.modelCalls(project.id)).length, 1);
  assert.equal((await reopened.messages(project.id)).find((message) => message.runId === run.id)?.content, "项目是空的。");
});

test("tool scope at model request is durable and generation tools register without unrelated gates", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const run = await send(store, project, "查看项目");
  await advanceRun(store, project, run.id, { ...settings, webSearchEnabled: false }, undefined, async (_system, _messages, tools) => {
    const names = tools.map((entry) => entry.function.name);
    assert.ok(names.includes("generate_video") && names.includes("delegate"));
    assert.ok(!names.includes("web_search"));
    return toolCall("not-admitted", "web_search", { query: "测试" });
  });
  await discardCache(store, run);
  await advanceRun(new Store(store.db), project, run.id, settings, undefined, async () => assert.fail("工具调用先结算"));
  const state = (await store.run(run.id, project.id)).payload.agent!;
  assert.equal(JSON.parse(state.messages.find((message) => message.tool_call_id === "not-admitted")!.content!).code, "UNKNOWN_TOOL");
  assert.equal(await store.toolResult(run.id, "not-admitted"), null);
});

test("a recovered tool call uses the media route and declaration of its own model step", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const run = await send(store, project, "按本次选定线路生成");
  const original = { ...settings, aiclubApiKey: "fixture-gateway", videoModel: "zimao-2.0" as const };
  const changed = { ...original, videoModel: "MiniMax-H3" as const, minimaxApiKey: "fixture-minimax" };
  await advanceRun(store, project, run.id, original, undefined, async (_system, _messages, tools) => {
    const video = tools.find((entry) => entry.function.name === "generate_video")!.function.parameters;
    assert.ok(Object.hasOwn(video.properties as object, "last_image_path"));
    assert.ok(Array.isArray(video.required) && !video.required.includes("image_path"));
    return toolCall("planned-video", "generate_video", { file_path: "/04_视频/片段.mp4", prompt: "夜景", duration: 5 });
  });
  await discardCache(store, run);
  const reopened = new Store(store.db);
  await advanceRun(reopened, project, run.id, changed, undefined, async () => assert.fail("先执行原步骤的工具"));
  const [job] = await reopened.children(run);
  assert.equal(job.payload.operation?.videoModel, original.videoModel);
  assert.match(job.payload.operation!.mediaBaseUrl!, /^https:\/\/aiclub\./);
  const [request] = await reopened.modelCalls(project.id);
  assert.ok(!String(request.request).includes(original.aiclubApiKey));
  await advanceRun(reopened, project, run.id, changed, undefined, async (_system, _messages, tools) => {
    const video = tools.find((entry) => entry.function.name === "generate_video")!.function.parameters;
    assert.ok(Array.isArray(video.required) && !video.required.includes("image_path") && video.required.includes("duration"));
    assert.deepEqual((video.properties as Record<string, unknown>).resolution, { type: "string", enum: ["768P", "2K"], description: "视频输出分辨率" });
    return reply("视频已登记。");
  });
  assert.equal((await reopened.run(run.id, project.id)).status, "done");
});

test("queued image generation uses the selected model and API path, including after restart", async (t) => {
  const store = fixture(), project = await store.createProject("alice", {}), run = await send(store, project, "生成一张图");
  const original = { ...settings, imageModel: IMAGE_MODELS[0] };
  const changed = { ...original, imageModel: IMAGE_MODELS[1], arkBaseUrl: original.arkBaseUrl + "/new", aiclubApiKey: "fixture-gateway" };
  await advanceRun(store, project, run.id, original, undefined, async () =>
    toolCall("planned-image", "generate_image", { file_path: "/03_图片/夜景.png", prompt: "夜景" }));
  await advanceRun(store, project, run.id, changed, undefined, async () => assert.fail("应先登记图片工作"));
  const [job] = await store.children(run);
  const fetch = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, original.arkBaseUrl + "/images/generations");
    assert.equal(JSON.parse(String(init.body)).model, IMAGE_MODELS[0]);
    return Response.json({ data: [{ url: "https://fixture.example/image.png" }] });
  });
  await advanceRun(new Store(store.db), project, job.id, changed, {} as BlobStore);
  assert.equal(fetch.mock.callCount(), 1);
  const submitted = await store.run(job.id, project.id);
  assert.equal(submitted.payload.providerModel, IMAGE_MODELS[0]);
  assert.equal(submitted.payload.outputUrl, "https://fixture.example/image.png");
});

test("separate model requests can reuse a provider tool id without sharing an execution receipt", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const run = await send(store, project, "保存两份不同版本");
  for (const version of ["甲", "乙"]) {
    await advanceRun(store, project, run.id, settings, undefined, async () =>
      toolCall("reused-provider-id", "write_file", { file_path: "/01_创作/" + version + ".md", content: version }));
    await advanceRun(store, project, run.id, settings, undefined, async () => assert.fail("先写文件"));
  }
  assert.deepEqual((await store.artifacts(project.id)).map((file) => file.content), ["乙", "甲"]);
  const steps = await store.executionHistory(project.id, run.id);
  assert.equal(steps.length, 2);
  assert.notEqual(steps[0].callId, steps[1].callId);
});

test("a new turn inherits completed work from a failed turn without replaying it", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const first = await send(store, project, "先确定方向");
  await advanceRun(store, project, first.id, settings, undefined, async () => reply("方向已确定。"));
  const second = await send(store, project, "写第二版开场");
  await advanceRun(store, project, second.id, settings, undefined, async () =>
    toolCall("saved-before-failure", "write_file", { file_path: "/01_创作/开场.md", content: "# 第二版" }));
  await advanceRun(store, project, second.id, settings, undefined, async () => assert.fail("先保存文件"));
  await advanceRun(store, project, second.id, settings, undefined, async (_system, _messages, _tools, options) => {
    await options?.onText?.("不完整的失败尝试");
    throw new AppError("模拟无效结束", 502, "MODEL_RESPONSE_INVALID");
  });
  assert.equal((await store.run(second.id, project.id)).status, "failed");
  await discardCache(store, second);
  const reopened = new Store(store.db);
  const next = await send(reopened, project, "刚才保存的是哪版");
  await advanceRun(reopened, project, next.id, settings, undefined, async (_system, messages) => {
    const index = messages.findIndex((message) => message.tool_call_id === "saved-before-failure");
    assert.ok(index > 0);
    assert.equal(messages[index - 1].tool_calls![0].id, "saved-before-failure");
    assert.equal(JSON.parse(messages[index].content!).version, 1);
    assert.ok(!messages.some((message) => message.content === "不完整的失败尝试"));
    return reply("已保存第二版。");
  });
  assert.equal((await reopened.run(next.id, project.id)).status, "done");
  assert.equal((await reopened.artifacts(project.id))[0].version, 1);
});

test("model rate-limit retries retain the attempt log and reuse clean context", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const run = await send(store, project, "写一段开场");
  await advanceRun(store, project, run.id, settings, undefined, async () => {
    throw new AppError("模型限流", 429, "MODEL_RATE_LIMIT");
  });
  assert.equal((await store.run(run.id, project.id)).status, "waiting");
  await store.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=?").bind(run.id).run();
  await advanceRun(new Store(store.db), project, run.id, { ...settings, textBaseUrl: "https://other.example.com" }, undefined, async (_system, messages) => {
    assert.deepEqual(messages.filter((message) => message.role === "user" && !message.source).map((message) => message.content), ["写一段开场"]);
    return reply("这是开场。");
  });
  assert.equal((await store.run(run.id, project.id)).status, "done");
  const calls = await store.modelCalls(project.id);
  assert.deepEqual(calls.map((entry) => entry.error_code), ["MODEL_RATE_LIMIT", null]);
  const [first, second] = calls.map((entry) => JSON.parse(String(entry.request)));
  assert.deepEqual(second, { ...first, attempt: first.attempt + 1 });
  const events = store.db.prepare(`SELECT type,data FROM events WHERE project_id=? AND json_extract(data,'$.runId')=?
    AND type IN ('turn/start','step/start','step/end','turn/end') ORDER BY id`)
    .bind(project.id, run.id).rows<{ type: string; data: string }>();
  assert.deepEqual(events.map(({ type }) => type), ["turn/start", "step/start", "step/end", "turn/end"]);
  assert.deepEqual(JSON.parse(events.at(-1)!.data).reason, { kind: "completed" });
});

test("control effects roll back with their receipts and replay an already committed action", async (t) => {
  const store = fixture(), project = await store.createProject("alice", {}), parent = await send(store, project, "控制子任务");
  assert.ok(await store.claimRun(parent.id, project.id));
  const owner = await store.run(parent.id, project.id);
  const childId = String((await store.startChild(owner, "create-writer", "writer", "编剧任务")).task_id);
  const child = await store.run(childId, project.id);
  await store.db.prepare(`CREATE TEMP TRIGGER reject_control_receipt BEFORE INSERT ON tool_receipts
    WHEN NEW.call_id='rollback-pause' BEGIN SELECT RAISE(ABORT, 'fixture receipt write failed'); END`).run();
  await assert.rejects(controlTaskFromTool(store, child, "pause", settings, { run: owner, callId: "rollback-pause" }), /fixture receipt write failed/);
  assert.equal((await store.run(child.id, project.id)).status, "queued");
  await store.releaseLease(owner);
  await advanceRun(store, project, parent.id, settings, undefined, async () =>
    toolCall("pause-writer", "control_task", { task_id: child.id, action: "pause" }));
  const realUpdate = store.updateRun.bind(store);
  t.mock.method(store, "updateRun", async (...args: Parameters<Store["updateRun"]>) => {
    if (args[4] === "pause-writer") throw new AppError("模拟进程在控制完成后退出", 409, "RUN_STOPPED");
    return realUpdate(...args);
  });
  await advanceRun(store, project, parent.id, settings, undefined, async () => assert.fail("先暂停子任务"));
  const paused = { task_id: child.id, action: "pause", status: "paused", generation: child.generation };
  assert.deepEqual(await store.toolResult(owner.id, "pause-writer"), paused);
  assert.equal((await store.run(child.id, project.id)).status, "paused");
  await discardCache(store, parent);
  const reopened = new Store(store.db);
  await controlRun(reopened, await reopened.run(child.id, project.id), "resume", settings);
  await advanceRun(reopened, project, parent.id, settings, undefined, async () => assert.fail("应先接纳已提交的暂停回执"));
  const replayed = (await reopened.run(parent.id, project.id)).payload.agent!.messages.find((message) => message.tool_call_id === "pause-writer");
  assert.deepEqual(JSON.parse(replayed!.content!), paused);
  assert.equal((await reopened.run(child.id, project.id)).status, "queued");
  assert.ok(await reopened.claimRun(owner.id, project.id));
  const nextOwner = await reopened.run(owner.id, project.id);
  assert.equal((await controlTaskFromTool(reopened, child, "pause", settings, { run: nextOwner, callId: "pause-again" })).status, "paused");
  assert.equal((await controlTaskFromTool(reopened, child, "resume", settings, { run: nextOwner, callId: "resume-writer" })).status, "queued");
  assert.equal((await controlTaskFromTool(reopened, child, "cancel", settings, { run: nextOwner, callId: "cancel-writer" })).status, "cancelled");
});

test("an independent media job survives turn completion and another turn's cancellation, then reports once", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const run = await send(store, project, "将这个片段后台合成，继续讨论下一镜");
  const clip = await store.putArtifact(project.id, { path: "/04_视频/雨.mp4", kind: "video", content: "", url: "/clip" });
  await advanceRun(store, project, run.id, settings, undefined, async () => toolCall("job", "compose_video", {
    file_path: "/07_成片/雨夜.mp4", clips: [{ video_path: clip.path, duration: 2 }],
  }));
  await advanceRun(store, project, run.id, settings, undefined, async () => assert.fail("应先登记后台任务"));
  const [job] = await store.children(run);
  assert.equal(job.background, true);
  await advanceRun(store, project, run.id, settings, undefined, async (_system, messages) => {
    assert.equal(JSON.parse(messages.find((message) => message.tool_call_id === "job")!.content!).task_id, job.id);
    return reply("合成已经排入后台。");
  });
  assert.equal((await store.run(run.id, project.id)).status, "done");
  assert.equal((await store.run(job.id, project.id)).status, "queued");

  const another = await send(store, project, "只讨论下一镜");
  await controlRun(store, another, "cancel", settings);
  assert.equal((await store.run(job.id, project.id)).status, "queued");
  await controlRun(store, job, "pause", settings);
  assert.equal((await store.run(job.id, project.id)).status, "paused");
  await controlRun(store, job, "resume", settings);
  assert.equal(await store.claimRun(job.id, project.id), true);
  const artifact = await store.finishComposition(await store.run(job.id, project.id), "fake-final", 0);
  assert.equal(artifact.path, "/07_成片/雨夜.mp4");

  const statusMessages = (messages: AgentMessage[]) => messages.filter((message) => message.content?.startsWith("子任务状态通知") && message.content.includes(job.id));
  const reopened = new Store(store.db);
  for (const text of ["合成好了吗", "继续说下一镜"]) {
    const next = await send(reopened, project, text);
    await advanceRun(reopened, project, next.id, settings, undefined, async (_system, messages) => {
      assert.equal(statusMessages(messages).length, 1);
      assert.match(statusMessages(messages)[0].content!, new RegExp(artifact.id));
      return reply("已保存雨夜成片。");
    });
  }
  const [start, finish] = store.db.prepare("SELECT type,id FROM events WHERE project_id=? AND type IN ('job/registered','job/settled') ORDER BY id").bind(project.id).rows<{ type: string; id: number }>();
  const closed = store.db.prepare("SELECT id FROM events WHERE type='session/turn-end' AND json_extract(data,'$.runId')=?").bind(run.id).rows<{ id: number }>()[0];
  assert.equal(start.type, "job/registered");
  assert.equal(finish.type, "job/settled");
  assert.ok(start.id < closed.id && closed.id < finish.id);
});

test("a late creative result joins a newer active turn in the same conversation", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const origin = await send(store, project, "委派编剧");
  await advanceRun(store, project, origin.id, settings, undefined, async () => toolCall("delegate", "delegate", { role: "writer", instruction: "写开场" }));
  await advanceRun(store, project, origin.id, settings, undefined, async () => assert.fail("先结算委派"));
  const [child] = await store.children(origin);
  await advanceRun(store, project, origin.id, settings, undefined, async () => reply("已委派"));
  const current = await send(store, project, "接着讨论");
  await advanceRun(store, project, child.id, settings, undefined, async () => reply("开场已写好"));
  const reopened = new Store(store.db);
  assert.deepEqual((await reopened.dueRuns()).filter(({ interactive }) => interactive).map(({ id }) => id), [current.id]);
  await advanceRun(reopened, project, current.id, settings, undefined, async (_, messages) => {
    assert.equal(messages.filter(({ source, content }) => source?.kind === "task-result" && content?.includes(child.id)).length, 1);
    assert.ok(messages.some(({ content }) => content === "接着讨论"));
    return reply("收到编剧结果");
  });
  assert.equal((await reopened.run(current.id, project.id)).status, "done");
  assert.equal((await reopened.dueRuns()).length, 0);
});

test("a later turn can explicitly wait for a project job and another project cannot control it", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const first = await send(store, project, "后台合成");
  await store.claimRun(first.id, project.id);
  const parent = await store.run(first.id, project.id);
  const { task_id } = await store.startChild(parent, "create", "media", "合成", { stage: "composing", background: true,
    payload: { instruction: "合成", sourceVersions: {}, operation: { name: "compose_video", toolCallId: "create", path: "/07_成片/等待.mp4" } } });
  await controlRun(store, parent, "cancel", settings);
  assert.equal((await store.run(task_id as string, project.id)).status, "queued");

  const other = await store.createProject("alice", {});
  const outsider = await send(store, other, "查看另一项目");
  await advanceRun(store, other, outsider.id, settings, undefined, async () => toolCall("foreign", "control_task", { task_id, action: "cancel" }));
  await advanceRun(store, other, outsider.id, settings, undefined, async () => assert.fail("应先拒绝跨项目控制"));
  assert.equal((await store.run(task_id as string, project.id)).status, "queued");

  const current = await send(store, project, "等合成完成再回答");
  const next: AgentFunction = async () => toolCall("wait", "wait_for_tasks", { task_ids: [task_id], wait: true });
  await advanceRun(store, project, current.id, settings, undefined, next);
  await advanceRun(store, project, current.id, settings, undefined, next);
  assert.equal((await store.run(current.id, project.id)).status, "waiting");
  assert.equal(await store.claimRun(task_id as string, project.id), true);
  const job = await store.run(task_id as string, project.id);
  await store.finishComposition(job, "fake-waited", 0);
  assert.equal((await store.run(current.id, project.id)).nextAttemptAt, 0);
  await advanceRun(store, project, current.id, settings, undefined, async (_system, messages) => {
    const settled = JSON.parse(messages.find((message) => message.tool_call_id === "wait")!.content!);
    assert.equal(settled.tasks[0].status, "done");
    assert.ok(!messages.some((message) => message.source?.kind === "task-result" && message.content?.includes(String(task_id))));
    return reply("已经合成。");
  });
  assert.equal((await store.run(current.id, project.id)).status, "done");
});

test("a next-step message releases a waiting turn while the independent job keeps running", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const first = await send(store, project, "后台合成");
  assert.ok(await store.claimRun(first.id, project.id));
  const { task_id } = await store.startChild(await store.run(first.id, project.id), "create", "media", "合成", {
    stage: "composing", background: true, payload: { instruction: "合成", sourceVersions: {},
      operation: { name: "compose_video", toolCallId: "create", path: "/07_成片/补充.mp4" } },
  });
  const jobId = String(task_id);
  await controlRun(store, await store.run(first.id, project.id), "cancel", settings);
  const turn = await send(store, project, "等待合成");
  await advanceRun(store, project, turn.id, settings, undefined, async () => toolCall("wait", "wait_for_tasks", { task_ids: [jobId], wait: true }));
  await advanceRun(store, project, turn.id, settings, undefined, async () => assert.fail("应先持久化等待状态"));
  assert.equal((await store.run(turn.id, project.id)).status, "waiting");

  const requestId = crypto.randomUUID();
  await store.enqueueChat(project.id, { requestId, text: "先讨论下一镜", attachmentIds: [] });
  assert.equal(await store.steerQueuedChats(project.id, turn.id, [{ requestId, version: 1 }]), 1);
  await advanceRun(store, project, turn.id, settings, undefined, async () => assert.fail("新输入应先入库"));
  await discardCache(store, turn);
  const reopened = new Store(store.db);
  await advanceRun(reopened, project, turn.id, settings, undefined, async (_system, messages) => {
    const wait = messages.findIndex((message) => message.tool_call_id === "wait");
    const input = messages.findIndex((message) => message.content === "先讨论下一镜");
    assert.ok(wait >= 0 && input > wait);
    const result = JSON.parse(messages[wait].content!);
    assert.equal(result.status, "interrupted");
    assert.equal(result.tasks[0].status, "queued");
    return reply("先讨论下一镜。");
  });
  assert.equal((await reopened.run(turn.id, project.id)).status, "done");
  assert.equal((await reopened.run(jobId, project.id)).status, "queued");
  assert.equal((await reopened.messages(project.id)).filter((message) => message.requestId === requestId).length, 1);

  assert.ok(await reopened.claimRun(jobId, project.id));
  await reopened.finishComposition(await reopened.run(jobId, project.id), "fixture-job", 0);
  const followup = await send(reopened, project, "成片现在好了吗");
  await advanceRun(reopened, project, followup.id, settings, undefined, async (_system, messages) => {
    assert.equal(messages.filter((message) => message.source?.kind === "task-result" && message.content?.includes(jobId)).length, 1);
    return reply("成片已保存。");
  });
});

test("a job settling between model response and wait execution is delivered through the durable receipt alone", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const parent = await send(store, project, "后台合成");
  assert.ok(await store.claimRun(parent.id, project.id));
  const { task_id } = await store.startChild(await store.run(parent.id, project.id), "create", "media", "合成", {
    stage: "composing", background: true, payload: { instruction: "合成", sourceVersions: {},
      operation: { name: "compose_video", toolCallId: "create", path: "/07_成片/成片.mp4" } },
  });
  const jobId = String(task_id);
  await controlRun(store, await store.run(parent.id, project.id), "cancel", settings);
  const turn = await send(store, project, "完成后告诉我");
  await advanceRun(store, project, turn.id, settings, undefined, async () => toolCall("wait-after", "wait_for_tasks", { task_ids: [jobId], wait: true }));
  assert.ok(await store.claimRun(jobId, project.id));
  const artifact = await store.finishComposition(await store.run(jobId, project.id), "fixture-finished", 0);
  await advanceRun(store, project, turn.id, settings, undefined, async () => assert.fail("接纳等待回执后再调用模型"));
  await discardCache(store, turn);
  await advanceRun(new Store(store.db), project, turn.id, settings, undefined, async (_system, messages) => {
    const wait = JSON.parse(messages.find((message) => message.tool_call_id === "wait-after")!.content!);
    assert.equal(JSON.parse(wait.tasks[0].result).id, artifact.id);
    assert.ok(!messages.some((message) => message.source?.kind === "task-result" && message.content?.includes(jobId)));
    return reply("成片已保存。");
  });
  assert.ok((await store.messages(project.id)).find((message) => message.runId === turn.id)?.artifactIds.includes(artifact.id));
});
