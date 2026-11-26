import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixture } from "./support";
import { Store } from "../lib/studio/store";
import { advanceRun } from "../lib/studio/engine";
import { repairToolHistory } from "../lib/studio/tool-history";
import { readModelStream } from "../lib/studio/model-stream";
import { decodeMessagesResult, normalizeMessagesStream } from "../lib/studio/deepseek-messages";
import { projectChatFlow } from "../lib/studio/conversation";
import { createAgentModel } from "../lib/studio/providers";
import { DEFAULT_SETTINGS, type AgentMessage, type WorkspaceFrame } from "../lib/studio/types";
import { applyWorkspaceDelta } from "../lib/studio/workspace-feed";
import { SQLiteDatabase } from "../server/storage";
import { configureRuntime } from "../server/runtime";
import { GET, POST } from "../app/api/studio/[...path]/route";
import type { BlobStore } from "../lib/studio/storage";
const tool = (id: string, name = "read_file", args: unknown = {}) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

test("conversation creation accepts blank sessions and rejects unavailable fork boundaries", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  configureRuntime({ database: store.db, media: {} as BlobStore, userId: "alice", workerSecret: "fixture", encryptionSecret: "fixture" });
  const parts = ["projects", project.id, "sessions"];
  const create = (input: unknown) => POST(new Request("http://localhost/api/studio/" + parts.join("/"), {
    method: "POST", body: JSON.stringify(input),
  }), { params: Promise.resolve({ path: parts }) });
  assert.equal((await create({ title: "无效分支", forkRunId: crypto.randomUUID() })).status, 409);
  assert.equal(store.sessions(project.id).length, 1);
  const response = await create({ title: "独立对话" });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.title, "独立对话");
  assert.equal(store.sessionSeed(project.id, result.id), undefined);
});

test("branching copies the visible timeline through the selected turn and continues its model context exactly once", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  configureRuntime({ database: store.db, media: {} as BlobStore, userId: "alice", workerSecret: "fixture", encryptionSecret: "fixture" });
  const settings = { ...DEFAULT_SETTINGS, textApiKey: "test" };
  const send = (text: string, sessionId = "") => store.acceptChat(project.id, {
    requestId: crypto.randomUUID(), text, attachmentIds: [],
  }, undefined, sessionId);
  const active = async (sessionId = "") => (await store.snapshot(project.id, "alice", sessionId)).runs
    .find((run) => !run.parentRunId && run.status === "queued")!;
  const reply = (content: string): AgentMessage => ({ role: "assistant", content });
  await send("初始设定");
  const first = await active();
  await advanceRun(store, project, first.id, settings, undefined, async () => ({
    ...reply("我先写下设定。"),
    tool_calls: [tool("save", "write_file", { file_path: "/01_创作/人物.md", content: "# 人物", kind: "document" })],
  }));
  await advanceRun(store, project, first.id, settings, undefined, async () => assert.fail("这一步只执行工具"));
  assert.equal(await store.claimRun(first.id, project.id), true);
  const actor = await store.run(first.id, project.id);
  const background = await store.startChild(actor, "background", "media", "后台输出", { stage: "media", background: true,
    payload: { instruction: "后台输出", sourceVersions: {} } });
  await store.updateRun(actor, { status: "queued" });
  await advanceRun(store, project, first.id, settings, undefined, async () => reply("设定完成。"));
  assert.equal((await store.run(first.id, project.id)).status, "done");
  const backgroundId = String(background.task_id);
  await store.updateRun(await store.run(backgroundId, project.id), { status: "done", resultText: "分支截点之后才出现的后台结果" }, true);
  await send("这是后面的原对话");
  await advanceRun(store, project, (await active()).id, settings, undefined, async () => reply("原对话的新内容。"));

  const parts = ["projects", project.id, "sessions"];
  const create = (forkRunId: string, source = "") => POST(new Request("http://localhost/api/studio/" + parts.join("/") + "?session=" + source, {
    method: "POST", body: JSON.stringify({ title: "分支", forkRunId }),
  }), { params: Promise.resolve({ path: parts }) });
  const response = await create(first.id);
  assert.equal(response.status, 201);
  const branch = await response.json();
  const reopened = new Store(store.db), snapshot = await reopened.snapshot(project.id, "alice", branch.id);
  assert.deepEqual(snapshot.messages.map(({ content }) => content), ["初始设定", "设定完成。"]);
  assert.ok(snapshot.replies.some(({ content }) => content === "我先写下设定。"));
  assert.equal(snapshot.steps.length, 1);
  const [copied] = snapshot.runs, [step] = snapshot.steps;
  assert.notEqual(copied.id, first.id);
  assert.equal(copied.canFork, true);
  assert.equal(copied.payload.inherited, true);
  const recordedBackground = snapshot.runs.find((run) => run.background);
  assert.ok(recordedBackground);
  assert.equal(recordedBackground.label, "分支时尚未完成");
  assert.equal(recordedBackground.resultText, "");
  const detail = await reopened.executionDetail(project.id, copied.id, step.seq);
  assert.equal(JSON.parse(detail.output!).path, "/01_创作/人物.md");
  const [change] = snapshot.changesByRun![copied.id];
  assert.equal((await reopened.compareTurnFile(project.id, copied.id, change.id, change.afterVersion)).kind, "text");
  assert.equal(reopened.searchHistory(project.id, branch.id, "初始设定").length, 1);
  assert.equal(await reopened.claimRun(copied.id, project.id), false);
  assert.equal((await create(copied.id)).status, 409);
  const nested = await create(copied.id, branch.id);
  assert.equal(nested.status, 201);
  const nestedSession = await nested.json();
  assert.equal((await reopened.snapshot(project.id, "alice", nestedSession.id)).steps.length, 1);

  await send("接着试另一个方向", branch.id);
  const fresh = await active(branch.id);
  await advanceRun(reopened, project, fresh.id, settings, undefined, async (_system, messages) => {
    assert.equal(messages.filter(({ content }) => content === "初始设定").length, 1);
    assert.ok(messages.some(({ content }) => content === "设定完成。"));
    assert.ok(messages.some(({ content }) => content === "接着试另一个方向"));
    assert.ok(!messages.some(({ content }) => content?.includes("这是后面的原对话")));
    assert.ok(!messages.some(({ content }) => content?.includes("分支截点之后才出现的后台结果")));
    return reply("分支的新结果。");
  });
  assert.equal((await reopened.run(fresh.id, project.id)).status, "done");
});

test("tool details read the bounded durable receipt on demand and are scoped to its run and project", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), other = await store.createProject("alice", {});
  configureRuntime({ database: store.db, media: {} as BlobStore, userId: "alice", workerSecret: "fixture", encryptionSecret: "fixture" });
  const root = await store.createRun(project.id, { instruction: "读文件", sourceVersions: {} });
  assert.ok(await store.claimRun(root.id, project.id));
  const parent = await store.run(root.id, project.id);
  const { task_id } = await store.startChild(parent, "delegate", "writer", "读文件");
  const childId = String(task_id);
  assert.ok(await store.claimRun(childId, project.id));
  const child = await store.run(childId, project.id);
  await store.beginStep(child, tool("read", "read_file", { file_path: "/01_创作/剧本.md" }));
  const [step] = await store.executionHistory(project.id, parent.id);
  const get = (projectId: string, ownerId: string) => {
    const parts = ["projects", projectId, "runs", ownerId, "history", String(step.seq)];
    return GET(new Request("http://localhost/api/studio/" + parts.join("/")), { params: Promise.resolve({ path: parts }) });
  };
  assert.equal((await get(other.id, child.id)).status, 404);
  assert.equal((await get(project.id, parent.id)).status, 404);
  assert.equal((await (await get(project.id, child.id)).json()).output, null);

  const result = { content: "雨".repeat(8400) };
  await store.commitReadReceipt(child, "read", result);
  const receipt = await (await get(project.id, child.id)).json();
  assert.deepEqual(JSON.parse(receipt.input), { file_path: "/01_创作/剧本.md" });
  assert.equal(receipt.inputTruncated, false);
  assert.equal(receipt.output.length, 8000);
  assert.equal(receipt.outputTruncated, true);
  assert.equal((await new Store(store.db).toolResult(child.id, "read"))?.content, result.content);
  assert.deepEqual(await store.executionHistory(project.id, parent.id), [step]);

  await store.settleSteps(child, [{ role: "tool", tool_call_id: "read", content: JSON.stringify(result) }]);
  assert.deepEqual(await (await get(project.id, child.id)).json(), receipt);
  assert.equal((await store.executionHistory(project.id, parent.id))[0].status, "done");
});

function valid(messages: AgentMessage[]) {
  let pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") { assert.ok(pending.delete(message.tool_call_id!)); continue; }
    assert.equal(pending.size, 0, "all tool replies must precede subsequent messages");
    if (message.tool_calls?.length) pending = new Set(message.tool_calls.map((call) => call.id));
  }
  assert.equal(pending.size, 0);
}

async function readFeedFrame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  for (;;) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    const frame = decoder.decode(chunk.value);
    const line = frame.split("\n").find((part) => part.startsWith("data: "));
    if (!line) continue;
    const value = JSON.parse(line.slice(6)) as WorkspaceFrame;
    const id = value.type === "delta" ? value.cursor : value.snapshot.cursor;
    assert.match(frame, new RegExp("^id: " + id + "$", "m"));
    return value;
  }
}

test("workspace SSE resumes replies and all missed tool rows after disconnect and a database restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mujian-feed-"));
  const filename = path.join(directory, "studio.sqlite");
  let db = new SQLiteDatabase(filename), reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const open = (projectId: string, after?: number, lastEventId?: number) => GET(new Request(
    "http://localhost/api/studio/projects/" + projectId + "/events" + (after === undefined ? "" : "?after=" + after),
    { headers: lastEventId === undefined ? {} : { "Last-Event-ID": String(lastEventId) } },
  ), { params: Promise.resolve({ path: ["projects", projectId, "events"] }) });
  const initialize = () => {
    db.initialize("drizzle");
    configureRuntime({ database: db, media: {} as BlobStore, userId: "alice", workerSecret: "fixture", encryptionSecret: "fixture" });
    return new Store(db);
  };
  try {
    let store = initialize();
    const project = await store.createProject("alice", {});
    const other = await store.createProject("alice", {});
    const userId = await store.addMessage(project.id, "user", "当前要求");
    const run = await store.createRun(project.id, { instruction: "当前要求", sourceVersions: {} });
    await store.addMessage(project.id, "assistant", "", "main", run.id);
    assert.ok(await store.claimRun(run.id, project.id));
    const claimed = await store.run(run.id, project.id), requestId = "fixture-live-reply";
    const parent = await store.beginModelCall({ ...claimed, payload: { ...claimed.payload,
      agent: { messages: [], seenUserIds: [userId], step: 0, toolIndex: 0, artifactIds: [], pendingRequest: { id: requestId } } } },
      requestId, { purpose: "creation" });
    const opening = await open(project.id);
    reader = opening.body!.getReader();
    const baseline = await readFeedFrame(reader);
    assert.equal(baseline.type, "snapshot");

    assert.ok(await store.publishStream(parent, requestId, "刚开始回复"));
    const live = await readFeedFrame(reader);
    assert.equal(live.type, "delta");
    assert.equal(live.after, baseline.snapshot.cursor);
    assert.deepEqual(Object.keys(live).sort(), ["after", "cursor", "projectId", "replies", "type"]);
    const current = applyWorkspaceDelta(baseline.snapshot, live);
    assert.ok(current);
    assert.equal(current.replies[0].content, "刚开始回复");
    const originalAnchor = current.replies[0].eventSeq;
    await reader.cancel();
    reader = undefined;

    await store.settleModelCall(parent, requestId, { status: "completed", response: { role: "assistant", content: "完整回复已恢复" } });
    const foreign = await store.addMessage(other.id, "user", "另一个项目的消息");
    const outsideCursor = (await store.snapshot(other.id, "alice")).cursor;
    await store.addMessage(project.id, "user", "追加说明");
    const childId = String((await store.startChild(parent, "delegate-fixture", "writer", "补充剧本")).task_id);
    assert.ok(await store.claimRun(childId, project.id));
    const child = await store.run(childId, project.id);
    const feedback: AgentMessage[] = [];
    for (let i = 0; i < 205; i++) {
      const id = "replay-step-" + i;
      await store.beginStep(child, tool(id));
      feedback.push({ role: "tool", tool_call_id: id, content: "{}" });
    }
    await store.settleSteps(child, feedback);
    const created = await store.putArtifact(project.id, { path: "/01_创作/断线期间.md", kind: "document", content: "新文件", lease: child });
    await store.updateProject(project.id, "alice", { title: "恢复后标题" });

    db.close(); db = new SQLiteDatabase(filename); store = initialize();
    const result = await open(project.id, baseline.snapshot.cursor, current.cursor);
    reader = result.body!.getReader();
    const replay = await readFeedFrame(reader);
    assert.equal(replay.type, "delta");
    assert.equal(replay.after, current.cursor);
    assert.equal(replay.replies?.[0].eventSeq, originalAnchor);
    assert.equal(replay.messages?.some((row) => row.id === foreign), false);
    assert.equal(replay.steps?.length, 205);
    const restored = applyWorkspaceDelta(current, replay);
    assert.ok(restored);
    assert.equal(restored.replies[0].content, "完整回复已恢复");
    assert.equal(restored.replies[0].status, "settled");
    assert.ok(restored.steps.every((step) => step.status === "done" && step.eventSeq !== undefined));
    assert.equal(restored.stepCounts[run.id], 205);
    assert.equal(restored.stepCounts[childId], 205);
    assert.equal(restored.changesByRun?.[run.id][0].id, created.id);
    assert.equal(restored.project.title, "恢复后标题");
    assert.equal(applyWorkspaceDelta(restored, replay), restored);
    assert.equal(applyWorkspaceDelta(current, { ...replay, after: current.cursor + 1 }), null);
    assert.equal(store.workspaceFrame(project.id, "alice", restored.cursor).frame, null);
    assert.equal(store.workspaceFrame(project.id, "alice", outsideCursor).frame?.type, "snapshot");
  } finally {
    await reader?.cancel();
    db.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("an empty streamed attempt is removed when it settles to tool calls only", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const requested = await store.createRun(project.id, { instruction: "读取文件", sourceVersions: {} });
  assert.ok(await store.claimRun(requested.id, project.id));
  const run = await store.beginModelCall(await store.run(requested.id, project.id), "empty-attempt", { purpose: "creation" });
  const initial = await store.snapshot(project.id, "alice");
  assert.equal(initial.replies[0].status, "running");
  const call = tool("read-mentioned-file");
  await store.settleModelCall(run, "empty-attempt", { status: "completed", response: { role: "assistant", content: null, tool_calls: [call] } });
  await store.beginStep(run, call);
  const { frame } = store.workspaceFrame(project.id, "alice", initial.cursor);
  assert.ok(frame?.type === "delta");
  assert.deepEqual(frame.removedReplies, ["empty-attempt"]);
  const updated = applyWorkspaceDelta(initial, frame);
  assert.deepEqual(updated?.replies, []);
  assert.equal(updated?.steps[0].callId, call.id);
});
test("child notifications and human messages never split a tool call group", async () => {
  const messages: AgentMessage[] = [{ role: "assistant", content: null, tool_calls: [tool("a"), tool("b")] }, { role: "tool", tool_call_id: "a", content: "first result" }, { role: "user", content: "child completed" }, { role: "user", content: "latest human instruction" }, { role: "tool", tool_call_id: "b", content: "second result" }];
  const result = await repairToolHistory(messages, async () => null); valid(result.messages);
  assert.deepEqual(result.messages.map((m) => m.content), [null, "first result", "second result", "child completed", "latest human instruction"]); assert.ok(result.repaired);
});
test("recovery reconstructs missing committed receipts and labels unknown outcomes without claiming success", async () => {
  const messages: AgentMessage[] = [{ role: "assistant", content: null, tool_calls: [tool("saved"), tool("unknown")] }, { role: "user", content: "continue" }];
  const result = await repairToolHistory(messages, async (id) => id === "saved" ? { id: "file", version: 2 } : null); valid(result.messages);
  assert.equal(JSON.parse(result.messages[1].content!).version, 2); assert.equal(JSON.parse(result.messages[2].content!).status, "unknown"); assert.match(result.messages[2].content!, /不要声称已完成/);
});
test("unpaired old results remain data and cannot become invalid tool-role messages", async () => {
  const result = await repairToolHistory([{ role: "tool", tool_call_id: "missing", content: "retained file result" }], async () => null);
  valid(result.messages); assert.equal(result.messages[0].role, "user"); assert.match(result.messages[0].content!, /retained file result/);
});
test("the parent can call the model after a child result arrives during wait_for_tasks", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), settings = { ...DEFAULT_SETTINGS, textApiKey: "test" };
  await store.addMessage(project.id, "user", "委派一个小任务并等待");
  const run = await store.createRun(project.id, { instruction: "delegate", sourceVersions: {} });
  let count = 0;
  const model = async (_system: string, messages: AgentMessage[]): Promise<AgentMessage> => {
    valid(messages); count++;
    if (count === 1) return { role: "assistant", content: null, tool_calls: [tool("delegate", "delegate", { role: "writer", instruction: "写一段" })] };
    if (count === 2) return { role: "assistant", content: null, tool_calls: [tool("wait", "wait_for_tasks", { task_ids: [(await store.children(run))[0].id], wait: true })] };
    assert.ok(messages.find((message) => message.tool_call_id === "wait")?.content?.includes("子任务实际结果"));
    assert.ok(!messages.some((message) => message.source?.kind === "task-result"));
    return { role: "assistant", content: "已收到子任务结果" };
  };
  await advanceRun(store, project, run.id, settings, undefined, model); await advanceRun(store, project, run.id, settings, undefined, model);
  await advanceRun(store, project, run.id, settings, undefined, model); await advanceRun(store, project, run.id, settings, undefined, model);
  const child = (await store.children(run))[0];
  const restarted = new Store(store.db);
  assert.equal((await restarted.run(run.id, project.id)).status, "waiting");
  assert.equal(await restarted.claimRun(run.id, project.id), false);
  assert.ok(!(await restarted.dueRuns()).some(({ id }) => id === run.id));
  await restarted.updateRun(child, { status: "done", resultText: "子任务实际结果", stage: "done" }, true);
  assert.ok((await restarted.dueRuns()).some(({ id }) => id === run.id));
  await advanceRun(restarted, project, run.id, settings, undefined, model);
  assert.equal((await store.run(run.id, project.id)).status, "done");
  const snapshot = await new Store(store.db).snapshot(project.id, "alice"); assert.equal(snapshot.stepCounts[run.id], 2); assert.ok(snapshot.steps.every((s) => s.status === "done"));
});
test("execution history persists independently of compressed model context and paginates over descendants", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), run = await store.createRun(project.id, { instruction: "test", sourceVersions: {} });
  await store.claimRun(run.id, project.id); const owner = await store.run(run.id, project.id);
  const queued = await store.startChild(owner, "delegate", "writer", "test"); await store.claimRun(String(queued.task_id), project.id); const child = await store.run(String(queued.task_id), project.id);
  for (let i = 0; i < 65; i++) {
    const actor = i % 2 ? child : owner, call = tool("read-" + i, "read_file", { file_path: "/01_创作/剧本.md" }); await store.beginStep(actor, call);
    await store.settleSteps(actor, [{ role: "tool", tool_call_id: call.id, content: JSON.stringify(i === 10 ? { error: "文件已变化" } : { path: "/01_创作/剧本.md", version: 1 }) }]);
  }
  const reopened = new Store(store.db), first = await reopened.executionHistory(project.id, run.id), second = await reopened.executionHistory(project.id, run.id, first[0].seq);
  assert.equal(first.length, 50); assert.equal(second.length, 15); assert.equal(new Set([...first, ...second].map((s) => s.seq)).size, 65);
  assert.equal((await reopened.snapshot(project.id, "alice")).stepCounts[run.id], 65); assert.ok(second.some((s) => s.status === "failed"));
});
test("older paged messages keep their execution history beyond 160 turns without sending model state to the browser", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), payload = { instruction: "test", sourceVersions: {} };
  const original = await store.createRun(project.id, payload);
  await store.claimRun(original.id, project.id); const owner = await store.run(original.id, project.id);
  await store.beginStep(owner, tool("first"));
  await store.settleSteps(owner, [{ role: "tool", tool_call_id: "first", content: "file read" }]);
  await store.addMessage(project.id, "assistant", "首轮回复", "main", owner.id);
  await store.updateRun(owner, { status: "done", payload: { ...payload, agent: { messages: [{ role: "user", content: "internal durable model context" }], seenUserIds: [], step: 1, toolIndex: 0, artifactIds: [] } } }, true);
  for (let i = 0; i < 165; i++) { const run = await store.createRun(project.id, payload); await store.updateRun(run, { status: "done" }, true); }
  const snapshot = await store.snapshot(project.id, "alice");
  assert.equal(snapshot.runs.length, 24);
  assert.ok(!snapshot.runs.some((run) => run.id === original.id));
  let before = snapshot.historyBefore, oldest = snapshot;
  const seen = new Set(snapshot.runs.map((run) => run.id));
  while (before) {
    const page = store.historyPage(project.id, "", before);
    for (const run of page.runs) { assert.ok(!seen.has(run.id)); seen.add(run.id); }
    oldest = { ...snapshot, ...page };
    before = page.historyBefore;
  }
  assert.equal(seen.size, 166);
  assert.equal(oldest.stepCounts[original.id], 1);
  assert.ok(oldest.messages.some((message) => message.runId === original.id && message.content === "首轮回复"));
  assert.ok(!JSON.stringify(oldest).includes("internal durable model context"));
  assert.ok(!JSON.stringify(snapshot).includes("internal durable model context"));
  assert.match(JSON.stringify((await store.run(original.id, project.id)).payload.agent), /internal durable model context/);
});
test("the active background roster survives history paging and updates only in its conversation", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const payload = { instruction: "制作镜头", sourceVersions: {} };
  const original = await store.createRun(project.id, payload);
  assert.ok(await store.claimRun(original.id, project.id));
  const owner = await store.run(original.id, project.id);
  const outputPath = "/04_视频/镜头.mp4";
  const background = await store.startChild(owner, "video", "media", "制作镜头", { stage: "media", background: true,
    payload: { ...payload, operation: { toolCallId: "video", name: "generate_video", path: outputPath, prompt: "咖啡蒸汽" } } });
  const job = await store.run(String(background.task_id), project.id);
  await store.updateRun(job, { status: "waiting", label: "视频 · 供应商生成中" }, true);
  await store.updateRun(owner, { status: "done" }, true);
  for (let i = 0; i < 24; i++) {
    const newer = await store.createRun(project.id, payload);
    await store.updateRun(newer, { status: "done" }, true);
  }

  const other = await store.createSession(project.id, "另一对话");
  const otherSnapshot = await store.snapshot(project.id, "alice", other.id);
  const opening = await store.snapshot(project.id, "alice");
  assert.ok(!opening.runs.some((run) => run.id === owner.id || run.id === job.id));
  assert.deepEqual(opening.activeBackgroundTasks, [{
    id: job.id, projectId: project.id, status: "waiting", label: "视频 · 供应商生成中", path: outputPath,
  }]);
  assert.deepEqual(otherSnapshot.activeBackgroundTasks, []);

  await store.controlTree(await store.run(job.id, project.id), "pause");
  const { frame } = store.workspaceFrame(project.id, "alice", opening.cursor);
  assert.ok(frame?.type === "delta");
  assert.deepEqual(frame.activeBackgroundTasks, []);
  assert.deepEqual(applyWorkspaceDelta(opening, frame)?.activeBackgroundTasks, []);
  const isolated = store.workspaceFrame(project.id, "alice", otherSnapshot.cursor, other.id).frame;
  assert.ok(isolated?.type === "delta");
  assert.equal(isolated.activeBackgroundTasks, undefined);
});
test("web sources remain available when the persisted raw receipt needs pagination", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const run = await store.createRun(project.id, { instruction: "参考资料", sourceVersions: {} });
  assert.ok(await store.claimRun(run.id, project.id));
  const owner = await store.run(run.id, project.id), search = tool("search", "web_search", { queries: ["动画"] });
  await store.beginStep(owner, search);
  await store.settleSteps(owner, [{ role: "tool", tool_call_id: search.id, content: JSON.stringify({
    sources: [
      { url: "https://example.com/first", title: "第一条", snippet: "外部内容".repeat(3000) },
      { url: "javascript:alert(1)", title: "非法链接" },
      { url: "https://example.com/last", title: "最后一条" },
    ],
  }) }]);
  const [step] = await store.executionHistory(project.id, owner.id);
  const detail = await store.executionDetail(project.id, owner.id, step.seq);
  assert.equal(detail.outputTruncated, true);
  assert.deepEqual(detail.web?.sources.map(({ title }) => title), ["第一条", "最后一条"]);
  assert.equal(detail.web?.sources[0].description?.length, 300);
});
test("normal streamed output is not rejected because protocol framing exceeds one MiB", async () => {
  const payload = Array.from({ length: 4000 }, () => 'data: ' + JSON.stringify({ id: "x".repeat(300), choices: [{ delta: { content: "字" }, finish_reason: null }] }) + '\n\n').join('') + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  assert.ok(Buffer.byteLength(payload) > 1024 * 1024);
  const result = await readModelStream(new Response(payload)); assert.equal(result.content, "字".repeat(4000));
});

const messagesStart = { type: "message_start", message: { usage: { input_tokens: 1 } } };
const messagesEnd = (stop_reason: string) => [
  { type: "message_delta", delta: { stop_reason } }, { type: "message_stop" },
];
const messagesStream = (frames: readonly object[]) => new Response(
  frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join(""),
  { headers: { "content-type": "text/event-stream" } },
);

test("Messages checks response framing and preserves complete reasoning-only responses", async () => {
  const block = (type: string, fields = {}) => [
    { type: "content_block_start", index: 0, content_block: { type, ...fields } },
    { type: "content_block_stop", index: 0 },
  ];
  const stop = messagesEnd("end_turn");
  await assert.rejects(readModelStream(normalizeMessagesStream(messagesStream([messagesStart, ...stop]))), { code: "MODEL_EMPTY_RESPONSE" });
  await assert.rejects(readModelStream(normalizeMessagesStream(messagesStream([messagesStart, messagesStart, ...stop]))), { code: "MODEL_RESPONSE_INVALID" });
  await assert.rejects(readModelStream(normalizeMessagesStream(messagesStream([...block("text", { text: "out of order" }), ...stop]))),
    { code: "MODEL_RESPONSE_INVALID" });
  await assert.rejects(readModelStream(normalizeMessagesStream(messagesStream([messagesStart, ...block("unknown"), ...stop]))),
    { code: "MODEL_UNSUPPORTED_CONTENT" });
  const replay: unknown[] = [];
  const reasoning = { thinking: "fixture", signature: "fixture-signature" };
  const result = await readModelStream(normalizeMessagesStream(messagesStream([messagesStart, ...block("thinking", reasoning), ...stop]),
    (blocks) => replay.push(...blocks)));
  assert.equal(result.content, null);
  assert.deepEqual(replay, [{ type: "thinking", ...reasoning }]);
  assert.throws(() => decodeMessagesResult({ content: [], stop_reason: "end_turn" }), { code: "MODEL_EMPTY_RESPONSE" });
  assert.throws(() => decodeMessagesResult({ content: [{ type: "unknown" }], stop_reason: "end_turn" }), { code: "MODEL_UNSUPPORTED_CONTENT" });
  assert.throws(() => decodeMessagesResult({ content: [{ type: "tool_use", id: "fixture", name: "write_file", input: [] }], stop_reason: "tool_use" }),
    { code: "MODEL_RESPONSE_INVALID" });
});

test("Messages replays original block order without thinking and applies the final cumulative usage", async (t) => {
  const block = (index: number, content_block: object) => [
    { type: "content_block_start", index, content_block }, { type: "content_block_stop", index },
  ];
  const frames = [
    { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 10 } } },
    ...block(0, { type: "text", text: "工具前" }),
    ...block(1, { type: "tool_use", id: "probe", name: "probe", input: {} }),
    ...block(2, { type: "text", text: "工具后" }),
    { type: "message_delta", delta: { stop_reason: "tool_use" },
      usage: { input_tokens: 116, output_tokens: 9, cache_read_input_tokens: 14, cache_creation_input_tokens: 12 } },
    { type: "message_stop" },
  ];
  const wire: Array<{ role: string; content: unknown[] }[]> = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    wire.push(JSON.parse(String(init.body)).messages);
    return wire.length === 1 ? messagesStream(frames) :
      messagesStream([messagesStart, ...block(0, { type: "text", text: "完成" }), ...messagesEnd("end_turn")]);
  });
  const settings = { ...DEFAULT_SETTINGS, textBaseUrl: "https://api.deepseek.com/anthropic", textApiKey: "fixture", textThinking: false };
  const model = createAgentModel(settings), user = { role: "user", content: "开始" } as const;
  let usage;
  const first = await model("测试", [user], [], { onUsage: async (value) => { usage = value; } });
  assert.deepEqual(usage, { inputTokens: 142, outputTokens: 9, totalTokens: 151, cachedInputTokens: 14, cacheWriteInputTokens: 12 });
  await model("测试", [user, first, { role: "tool", tool_call_id: "probe", content: "工具结果" }], []);
  assert.deepEqual(wire[1].find(({ role }) => role === "assistant")?.content, [
    { type: "text", text: "工具前" }, { type: "tool_use", id: "probe", name: "probe", input: {} }, { type: "text", text: "工具后" },
  ]);
});

test("Messages retries an empty response and rejects a malformed tool batch before dispatch", async (t) => {
  const store = fixture(), project = await store.createProject("alice", {});
  await store.acceptChat(project.id, { requestId: crypto.randomUUID(), text: "写入测试文档", attachmentIds: [] });
  const initial = (await store.snapshot(project.id, "alice")).runs[0];
  const toolFrames = (index: number, partial_json: string) => [
    { type: "content_block_start", index, content_block: { type: "tool_use", id: "write-" + index, name: "write_file", input: {} } },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } },
    { type: "content_block_stop", index },
  ];
  const responses = [
    [messagesStart, ...messagesEnd("end_turn")],
    [messagesStart, ...toolFrames(0, JSON.stringify({ file_path: "/01_创作/测试.md", content: "fixture", kind: "document" })),
      ...toolFrames(1, '{"file_path":'), ...messagesEnd("tool_use")],
  ];
  let requests = 0, clock = 2_000_000_000_000;
  t.mock.method(Date, "now", () => clock);
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "deepseek-flash" }] });
    assert.ok(responses[requests]);
    return messagesStream(responses[requests++]);
  });
  const settings = { ...DEFAULT_SETTINGS, textApiKey: "messages-empty-fixture", textBaseUrl: "https://api.deepseek.com/anthropic" };
  const waiting = await advanceRun(store, project, initial.id, settings);
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.errorCode, "MODEL_EMPTY_RESPONSE");
  const readRetries = () => store.db.prepare("SELECT type,data FROM events WHERE project_id=? AND type LIKE 'llm/retry%' ORDER BY id")
    .bind(project.id).rows<{ type: string; data: string }>().map(({ type, data }) => ({ type, data: JSON.parse(data) }));
  const [scheduled] = readRetries();
  assert.equal(scheduled.type, "llm/retry");
  assert.equal(scheduled.data.retry, 1);
  assert.equal(scheduled.data.maxRetries, 5);
  assert.equal(scheduled.data.provider, "deepseek-messages");
  assert.equal(scheduled.data.failure.code, "MODEL_EMPTY_RESPONSE");
  assert.equal(scheduled.data.nextAttemptAt, waiting.nextAttemptAt);
  assert.equal(readRetries().length, 1);
  clock = waiting.nextAttemptAt;
  const failed = await advanceRun(store, project, initial.id, settings);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "MODEL_RESPONSE_INVALID");
  assert.equal(requests, 2);
  const [, started] = readRetries();
  assert.equal(started.type, "llm/retry-started");
  assert.equal(started.data.retryId, scheduled.data.retryId);
  assert.equal(started.data.previousRequestId, scheduled.data.requestId);
  assert.notEqual(started.data.requestId, scheduled.data.requestId);
  assert.equal(failed.payload.modelRetry, undefined);
  assert.deepEqual(await store.executionHistory(project.id, initial.id), []);
  assert.deepEqual(await store.artifacts(project.id), []);
});

test("provider output exhaustion closes the turn without executing a partial tool batch", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), settings = { ...DEFAULT_SETTINGS, textApiKey: "test" };
  await store.acceptChat(project.id, { requestId: crypto.randomUUID(), text: "写一份长剧本", attachmentIds: [] });
  const [run] = (await store.snapshot(project.id, "alice")).runs;
  await advanceRun(store, project, run.id, settings, undefined, async () => {
    assert.equal((await store.run(run.id, project.id)).label, "正在回复");
    return readModelStream(new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"partial","function":{"name":"write_file","arguments":"{\\\"file_path\\\":"}}]},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'));
  });
  const finished = await store.run(run.id, project.id);
  assert.equal(finished.status, "done"); assert.equal(finished.attempts, 0);
  assert.equal(finished.errorCode, "MODEL_TRUNCATED");
  assert.equal(finished.label, "回复已截断");
  const snapshot = await store.snapshot(project.id, "alice");
  assert.equal(snapshot.replies.find(({ runId }) => runId === run.id)?.status, "truncated");
  assert.ok(projectChatFlow(snapshot.messages, snapshot.runs, snapshot.replies, snapshot.steps).some(({ nodes }) =>
    nodes?.some((node) => node.kind === "reply" && node.reply.runId === run.id && node.reply.status === "truncated")));
  const ending = store.db.prepare("SELECT data FROM events WHERE project_id=? AND type='turn/end'").bind(project.id).rows<{ data: string }>().at(-1);
  assert.deepEqual(JSON.parse(ending!.data).reason, { kind: "max-tokens" });
  assert.equal((await store.artifacts(project.id)).length, 0); assert.equal((await store.executionHistory(project.id, run.id)).length, 0);
  await advanceRun(store, project, run.id, settings, undefined, async () => assert.fail("已结束的回复不能自动重发"));
});
