import { consumeJobOutput, streamJobOutput } from "../lib/studio/background-jobs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { fixture } from "./support";
import { advanceRun } from "../lib/studio/engine";
import { Store } from "../lib/studio/store";
import { ToolRegistry } from "../lib/studio/tool-registry";
import { executeToolGroup } from "../lib/studio/tool-execution";
import { tool } from "../lib/studio/file-tools";
import { AppError } from "../lib/studio/security";
import { DEFAULT_SETTINGS, type AgentMessage, type Project, type Run } from "../lib/studio/types";
import { estimateMessageTokens } from "../lib/studio/context-tokens";
import { TOOL_INLINE_TOKENS } from "../lib/studio/tool-output";
import { projectArchive, restoreProjectArchive } from "../lib/studio/project-archive";
import { projectToolHistory } from "../lib/studio/tool-history";
import { LocalMediaStore, SQLiteDatabase } from "../server/storage";
import { imageDataUrl, inspectImage } from "../lib/studio/images";
import { ImageBudgetError } from "../lib/studio/model-stream";

const settings = { ...DEFAULT_SETTINGS, textApiKey: "fixture" };
const reply = (content: string): AgentMessage => ({ role: "assistant", content });
const call = (id: string, name: string, args: unknown): AgentMessage => ({ role: "assistant", content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
async function send(store: Store, project: Project, text: string, sessionId = "") {
  await store.acceptChat(project.id, { requestId: crypto.randomUUID(), text, attachmentIds: [] }, undefined, sessionId);
  const turn = (await store.snapshot(project.id, "alice", sessionId)).runs.find((run) => !run.parentRunId && run.status === "queued");
  assert.ok(turn);
  return turn;
}
const boundaries = (store: Store, run: Run) => store.db.prepare(`SELECT type,data FROM events
  WHERE project_id=? AND json_extract(data,'$.runId')=? AND type IN ('turn/start','turn/end','step/start','step/end') ORDER BY id`)
  .bind(run.projectId, run.id).rows<{ type: string; data: string }>().map(({ type, data }) => ({ type, ...JSON.parse(data) }));

test("tool-local deadlines drain the tool and keep upstream cancellation distinct", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "测试时限");
  let cleaned = false;
  const registry = new ToolRegistry({ store, project, run: turn, settings, tasks: [], ensureCurrent: async () => {} }, [{
    schema: tool("slow_tool", "fixture", {}), label: "fixture", timeoutMs: 10,
    async execute({ signal }) {
      try {
        signal.throwIfAborted();
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        return { result: {} };
      } finally { cleaned = true; }
    },
  }]);
  const prepared = registry.prepare(call("slow", "slow_tool", {}).tool_calls![0]);
  await assert.rejects(registry.execute(prepared, new AbortController().signal), (error) => error instanceof AppError && error.code === "TOOL_TIMEOUT");
  assert.equal(cleaned, true);
  const upstream = new AbortController(), reason = new AppError("用户补充", 409, "AGENT_STEER");
  const waiting = registry.execute(prepared, upstream.signal);
  upstream.abort(reason);
  await assert.rejects(waiting, (error) => error === reason);
});

test("the parallel pool persists an ordered prefix while another tool is still running", async (t) => {
  const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "并发读取");
  assert.ok(await store.claimRun(turn.id, project.id));
  const run = await store.run(turn.id, project.id);
  const gates = ["first", "second", "third"].map(() => Promise.withResolvers<void>());
  const ready = Promise.withResolvers<void>(), prefix = Promise.withResolvers<void>(), secondReturned = Promise.withResolvers<void>();
  let started = 0;
  const persisted: string[] = [];
  const commit = store.commitReadReceipt.bind(store);
  t.mock.method(store, "commitReadReceipt", async (...args: Parameters<Store["commitReadReceipt"]>) => {
    const receipt = await commit(...args);
    persisted.push(args[1]);
    if (persisted.length === 2) prefix.resolve();
    return receipt;
  });
  const registry = new ToolRegistry({ store, project, run, settings, tasks: [], ensureCurrent: async () => {} }, [{
    schema: tool("read_probe", "fixture", {}), label: "fixture", mode: "parallel",
    async execute(_context, _id, args) {
      const { index } = args as { index: number };
      if (++started === 3) ready.resolve();
      await gates[index].promise;
      if (index === 1) secondReturned.resolve();
      return { result: { index } };
    },
  }]);
  const group = ["z", "a", "m"].map((id, index) => registry.prepare(call(id, "read_probe", { index }).tool_calls![0]));
  const work = executeToolGroup(store, run, registry, group, async () => {}, true, { index: 0 });
  try {
    await ready.promise;
    gates[1].resolve();
    await secondReturned.promise;
    assert.deepEqual(persisted, []);
    gates[0].resolve();
    await prefix.promise;
    assert.deepEqual(persisted, ["z", "a"]);
    assert.deepEqual(await store.toolResult(run.id, "a"), { index: 1 });
  } finally {
    for (const gate of gates) gate.resolve();
    await work;
  }
  assert.deepEqual(persisted, ["z", "a", "m"]);
});

test("large tool results keep their original bytes and references across turns and forks", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "等待试写");
  const advance = (model?: Parameters<typeof advanceRun>[5]) => advanceRun(store, project, turn.id, settings, undefined, model);
  const shouldNotCall = async () => assert.fail("该步只处理工具");
  await advance(async () => call("delegate-1", "delegate", { role: "writer", instruction: "试写" }));
  await advance(shouldNotCall);
  const [writer] = await store.children(turn);
  const original = "开头\n" + "故事内容。".repeat(9000) + "\n结尾";
  await store.updateRun(writer, { status: "done", resultText: original, stage: "done" }, true);
  await advance(async () => call("wait-1", "wait_for_tasks", { task_ids: [writer.id], wait: true }));
  await advance(shouldNotCall);
  let reference = "";
  await advance(async (_system, messages) => {
    const output = messages.find((message) => message.tool_call_id === "wait-1")!;
    assert.ok(estimateMessageTokens(output) <= TOOL_INLINE_TOKENS);
    const projection = JSON.parse(output.content!);
    assert.ok(projection.omitted_bytes > 0);
    assert.match(projection.excerpt, /开头/);
    assert.match(projection.excerpt, /结尾/);
    reference = projection.result_ref;
    return reply("完成试写。");
  });
  assert.ok(reference);
  const reopened = new Store(store.db);
  const history = await reopened.executionHistory(project.id, turn.id);
  const wait = history.find((step) => step.callId === "wait-1")!;
  assert.match((await reopened.executionDetail(project.id, turn.id, wait.seq)).output!, /开头/);
  const stepEnd = reopened.db.prepare(`SELECT id FROM events WHERE type='step/end' AND project_id=?
    AND json_extract(data,'$.runId')=? AND json_extract(data,'$.step')=2`).bind(project.id, turn.id).rows()[0];
  const receiptEvents = reopened.db.prepare(`SELECT id FROM events WHERE type='step' AND project_id=? AND json_extract(data,'$.stepSeq')=?
    ORDER BY id`).bind(project.id, wait.seq).rows();
  assert.equal(receiptEvents.length, 2);
  assert.ok(Number(receiptEvents[1].id) < Number(stepEnd.id));
  const next = await send(reopened, project, "取回结果");
  const target = { reference, runId: "" };
  let whole = "", offset = 0;
  for (;;) {
    const { result } = await reopened.readAgentToolResult(next, target, offset);
    whole += result.text;
    if (!result.nextOffset) break;
    offset = result.nextOffset;
  }
  assert.equal(JSON.parse(whole).tasks[0].result, original);
  const fork = await reopened.forkSession(project.id, "", turn.id, "试写分支");
  const forkTurn = await send(reopened, project, "在分支读取", fork.id);
  const inherited = (await reopened.readAgentToolResult(forkTurn, target, 0)).result;
  assert.match(inherited.text!, /开头/);
  const copiedAnchors = reopened.db.prepare(`SELECT data FROM events WHERE type='step' AND project_id=?
    AND json_extract(data,'$.runId')=? AND json_extract(data,'$.stepSeq')=? ORDER BY id`)
    .bind(project.id, inherited.task_id, inherited.seq).rows<{ data: string }>().map(({ data }) => JSON.parse(data));
  assert.equal(copiedAnchors.length, 2);
  assert.equal(copiedAnchors[0].requestId, copiedAnchors[1].requestId);
  assert.ok(copiedAnchors[0].requestId);
  const other = await reopened.createSession(project.id, "独立对话");
  const otherTurn = await send(reopened, project, "检查会话隔离", other.id);
  await assert.rejects(reopened.readAgentToolResult(otherTurn, target, 0), /超出当前会话/);
  const zip = await new Response(projectArchive(reopened, project.id, undefined)).arrayBuffer();
  const imported = await restoreProjectArchive(reopened, "alice", zip, undefined, new AbortController().signal);
  const importedTurn = await send(reopened, imported, "核对归档里的旧回执");
  const importedResult = (await reopened.readAgentToolResult(importedTurn, target, 0)).result;
  const importedAnchor = reopened.db.prepare(`SELECT json_extract(data,'$.requestId') AS request_id FROM events WHERE project_id=?
    AND type='step' AND json_extract(data,'$.stepSeq')=? LIMIT 1`)
    .bind(imported.id, importedResult.seq).rows<{ request_id: string }>();
  assert.ok((await reopened.modelCalls(imported.id)).some(({ id }) => id === importedAnchor[0]?.request_id));
  assert.match(importedResult.text!, /开头/);
});

test("the repeat reminder follows canonical arguments and stays after every tool receipt", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "查看项目");
  const received: number[] = [];
  for (let index = 0; index <= 8; index++) {
    if (index === 8) await store.acceptChat(project.id, {
      requestId: crypto.randomUUID(), text: "补充新的指令", attachmentIds: [],
    });
    await advanceRun(new Store(store.db), project, turn.id, settings, undefined, async (_system, messages) => {
      const newNotice = messages.at(-2)?.source?.kind === "repeat-tool-reminder" ? messages.at(-2) :
        messages.at(-1)?.source?.kind === "repeat-tool-reminder" ? messages.at(-1) : undefined;
      if (newNotice?.source?.kind === "repeat-tool-reminder") {
        assert.equal(messages.slice(0, messages.indexOf(newNotice)).findLast((message) => message.role === "tool")?.tool_call_id, "list-" + (index - 1));
        received.push(newNotice.source.count);
      }
      if (index === 8) {
        assert.ok(messages.some((message) => message.content === "补充新的指令"));
        return reply("已查看。");
      }
      return call("list-" + index, "list_files", index % 2 ? { directory: "/", limit: 5 } : { limit: 5, directory: "/" });
    });
    if (index < 8) await advanceRun(store, project, turn.id, settings, undefined, async () => assert.fail("工具检查应先结束"));
  }
  assert.deepEqual(received, [3, 5, 8]);
  const finished = await store.run(turn.id, project.id);
  assert.equal(finished.status, "done");
  assert.equal(finished.payload.agent?.repeatToolCall, undefined);
});

test("pending input is routed durably and a cancelled turn records one structured ending", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "先开始");
  const requestId = crypto.randomUUID();
  await store.enqueueChat(project.id, { requestId, text: "补充", attachmentIds: [] });
  const queued = () => store.db.prepare("SELECT target,wake,state FROM agent_inbox WHERE project_id=? AND id=?")
    .bind(project.id, "queue:" + requestId).rows()[0];
  assert.deepEqual({ ...queued() }, { target: "next-turn", wake: 1, state: "pending" });
  assert.equal(await store.steerQueuedChats(project.id, turn.id, [{ requestId, version: 1 }]), 1);
  assert.deepEqual({ ...queued() }, { target: "next-step", wake: 1, state: "pending" });
  assert.ok(await store.claimRun(turn.id, project.id));
  const running = await new Store(store.db).run(turn.id, project.id);
  assert.equal(await store.claimStepQueue(running), true);
  assert.equal(await store.claimStepQueue(running), false);
  assert.deepEqual((await store.inputs(running)).map(({ content }) => content), ["先开始", "补充"]);
  await store.controlTree(running, "cancel");
  await store.controlTree(running, "cancel");
  assert.deepEqual(boundaries(store, running).map(({ type }) => type), ["turn/start", "turn/end"]);
  assert.deepEqual(boundaries(store, running).at(-1).reason, { kind: "aborted", reason: "cancelled" });
});

test("a silent task settlement releases an active wait and is delivered at the next tool boundary", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "等待甲任务");
  assert.ok(await store.claimRun(turn.id, project.id));
  const initial = await store.run(turn.id, project.id);
  const start = (id: string) => store.startChild(initial, id, "media", id, {
    stage: "composing", background: true, payload: { instruction: id, sourceVersions: {} },
  });
  const first = String((await start("工作甲")).task_id), second = String((await start("工作乙")).task_id);
  await store.updateRun(initial, { status: "queued" });
  await advanceRun(store, project, turn.id, settings, undefined, async () => call("wait", "wait_for_tasks", { task_ids: [first], wait: true }));
  await advanceRun(store, project, turn.id, settings, undefined, async () => assert.fail("先登记等待"));
  assert.ok(!(await store.dueRuns()).some(({ id }) => id === turn.id));
  await store.updateRun(await store.run(second, project.id), { status: "done", stage: "done", resultText: "乙已完成" }, true);
  assert.ok((await store.dueRuns()).some(({ id }) => id === turn.id));
  await advanceRun(new Store(store.db), project, turn.id, settings, undefined, async (_system, messages) => {
    const receipt = messages.findIndex((message) => message.tool_call_id === "wait");
    const notice = messages.findIndex((message) => message.source?.kind === "task-result" && message.content?.includes("乙已完成"));
    assert.ok(receipt >= 0 && notice > receipt);
    assert.equal(JSON.parse(messages[receipt].content!).status, "interrupted");
    return reply("乙已完成，甲任务仍在后台。");
  });
  assert.equal((await store.run(first, project.id)).status, "queued");
  assert.equal((await store.run(turn.id, project.id)).status, "done");
});

test("a pause tool receipt acknowledges its reported task state without a duplicate notice", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "暂停之前的任务");
  assert.ok(await store.claimRun(turn.id, project.id));
  const actor = await store.run(turn.id, project.id);
  const task = await store.startChild(actor, "media", "media", "后台任务", {
    stage: "composing", background: true, payload: { instruction: "后台任务", sourceVersions: {} },
  });
  await store.updateRun(actor, { status: "queued" });
  await advanceRun(store, project, turn.id, settings, undefined, async () => call("pause", "control_task", { task_id: task.task_id, action: "pause" }));
  await advanceRun(store, project, turn.id, settings, undefined, async () => assert.fail("先完成暂停调用"));
  await advanceRun(new Store(store.db), project, turn.id, settings, undefined, async (_system, messages) => {
    const receipt = messages.find((message) => message.tool_call_id === "pause");
    assert.equal(JSON.parse(receipt!.content!).status, "paused");
    assert.ok(!messages.some((message) => message.source?.kind === "task-result" && message.content?.includes(String(task.task_id))));
    return reply("任务已暂停。");
  });
  assert.equal((await store.run(turn.id, project.id)).status, "done");
});

test("a crash after claiming new input cannot publish the former final reply", async (t) => {
  const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "写旧版本");
  assert.ok(await store.claimRun(turn.id, project.id));
  const active = await store.run(turn.id, project.id), [initial] = await store.inputs(active);
  await store.updateRun(active, { status: "queued", payload: { ...active.payload, agent: {
    messages: [{ role: "user", content: initial.content }, reply("旧答复")], seenUserIds: [initial.id],
    finalReply: "旧答复", step: 1, toolIndex: 0, artifactIds: [],
  } } });
  await store.acceptChat(project.id, { requestId: crypto.randomUUID(), text: "改用新版本", attachmentIds: [] });
  t.mock.method(store, "beginModelCall", async () => { throw new AppError("在写入模型请求前停止", 409, "RUN_STOPPED"); });
  await advanceRun(store, project, turn.id, settings, undefined, async () => assert.fail("模拟在请求发出前退出"));
  const reopened = new Store(store.db);
  assert.equal((await reopened.run(turn.id, project.id)).payload.agent?.finalReply, undefined);
  await advanceRun(reopened, project, turn.id, settings, undefined, async (_system, messages) => {
    assert.ok(messages.some((message) => message.content === "改用新版本"));
    return reply("新答复");
  });
  assert.equal((await reopened.run(turn.id, project.id)).resultText, "新答复");
});

test("recovery settles an interrupted model request before recording the cancelled turn ending", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "随后取消");
  assert.ok(await store.claimRun(turn.id, project.id));
  const active = await store.run(turn.id, project.id), id = crypto.randomUUID();
  const running = await store.beginModelCall({ ...active, payload: { ...active.payload, agent: {
    messages: [], seenUserIds: [], step: 0, toolIndex: 0, artifactIds: [], pendingRequest: { id },
  } } }, id, { purpose: "creation", turn: active.generation, step: 1, attempt: 1 });
  await store.publishStream(running, id, "已收到的半句");
  await store.controlTree(running, "cancel");
  assert.equal(boundaries(store, running).some(({ type }) => type === "turn/end"), false);
  await store.db.prepare("UPDATE runs SET lease_until=0 WHERE id=?").bind(running.id).run();
  const reopened = new Store(store.db);
  await reopened.recoverStoppedExecutions();
  await reopened.recoverStoppedExecutions();
  const persisted = await reopened.modelCall(running, id);
  assert.equal(persisted?.status, "interrupted");
  assert.equal(persisted?.visible_text, "已收到的半句");
  const events = reopened.db.prepare("SELECT type FROM events WHERE project_id=? AND json_extract(data,'$.runId')=? ORDER BY id")
    .bind(project.id, turn.id).rows<{ type: string }>().map(({ type }) => type);
  assert.ok(events.indexOf("reply") < events.indexOf("step/end"));
  assert.ok(events.indexOf("step/end") < events.indexOf("turn/end"));
  assert.equal(events.filter((type) => type === "turn/end").length, 1);
});

test("cancelling an accepted batch records every undispatched call and a resumed generation uses those receipts", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "写两份草稿");
  const output = call("a", "write_file", { file_path: "/01_创作/A.md", content: "A" });
  output.tool_calls!.push(call("b", "write_file", { file_path: "/01_创作/B.md", content: "B" }).tool_calls![0]);
  await advanceRun(store, project, turn.id, settings, undefined, async () => output);
  await store.controlTree(await store.run(turn.id, project.id), "cancel");
  const steps = await store.executionHistory(project.id, turn.id);
  assert.deepEqual(steps.map(({ callId, status, notDispatched }) => [callId, status, notDispatched]), [
    ["a", "interrupted", true], ["b", "interrupted", true],
  ]);
  const ending = boundaries(store, turn).find(({ type }) => type === "turn/end");
  assert.deepEqual(ending.reason, { kind: "aborted", reason: "cancelled" });
  const stopped = await store.run(turn.id, project.id);
  await store.resumeTree(stopped, stopped.payload);
  await advanceRun(new Store(store.db), project, turn.id, settings, undefined, async (_system, messages) => {
    assert.deepEqual(messages.filter(({ role }) => role === "tool").map(({ content }) => JSON.parse(content!).code),
      ["TOOL_NOT_STARTED", "TOOL_NOT_STARTED"]);
    return reply("已恢复对话。");
  });
  assert.equal((await store.run(turn.id, project.id)).status, "done");
  assert.equal((await store.artifacts(project.id)).length, 0);
});

test("terminal recovery keeps the accepted receipt for a dispatched tool and skips the rest in order", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "先查看已有素材");
  const output = call("started", "list_files", {});
  output.tool_calls!.push(call("unstarted", "list_files", {}).tool_calls![0]);
  await advanceRun(store, project, turn.id, settings, undefined, async () => output);
  assert.ok(await store.claimRun(turn.id, project.id));
  const running = await store.run(turn.id, project.id);
  await store.beginStep(running, output.tool_calls![0], running.payload.agent?.toolRequestId, 0);
  await store.dispatchStep(running, "started");
  await store.commitReadReceipt(running, "started", { directories: ["现有目录"] });
  await store.controlTree(running, "cancel");
  assert.ok(!boundaries(store, turn).some(({ type }) => type === "turn/end"));
  await store.releaseLease(running);
  const ordered = store.db.prepare("SELECT type,data FROM events WHERE project_id=? AND json_extract(data,'$.runId')=? ORDER BY id")
    .bind(project.id, turn.id).rows<{ type: string; data: string }>().filter(({ type, data }) =>
      type === "turn/end" || type === "step" && JSON.parse(data).status !== "running")
    .map(({ type, data }) => type === "step" ? JSON.parse(data).callId : type);
  assert.deepEqual(ordered, ["started", "unstarted", "turn/end"]);
  const next = await send(store, project, "从已有结果继续");
  await advanceRun(store, project, next.id, settings, undefined, async (_system, messages) => {
    assert.deepEqual(JSON.parse(messages.find(({ tool_call_id }) => tool_call_id === "started")!.content!), { directories: ["现有目录"] });
    assert.equal(JSON.parse(messages.find(({ tool_call_id }) => tool_call_id === "unstarted")!.content!).code, "TOOL_NOT_STARTED");
    return reply("已读取原结果。");
  });
  assert.equal((await store.run(next.id, project.id)).status, "done");
});

test("pruning historical spill previews keeps the durable reference and protects the latest batch", () => {
  const reference = crypto.randomUUID(), payload = JSON.stringify({ result_ref: reference, excerpt: "原".repeat(24000) });
  const old = call("old-preview", "wait_for_tasks", {}), latest = call("latest-preview", "wait_for_tasks", {});
  const toolReply = (id: string): AgentMessage => ({ role: "tool", tool_call_id: id, outputRef: reference, content: payload });
  const projected = projectToolHistory([old, toolReply("old-preview"), latest, toolReply("latest-preview")]);
  assert.equal(projected.replacements.length, 1);
  assert.equal(JSON.parse(projected.messages[1].content!).result_ref, reference);
  assert.ok(projected.messages[1].content!.length < payload.length);
  assert.equal(projected.messages[3].content, payload);
});

test("archived visual receipts restore exactly the image bytes originally read by the model", async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), "doman-receipt-images-"));
  const db = new SQLiteDatabase(":memory:");
  t.after(async () => { db.close(); await rm(folder, { force: true, recursive: true }); });
  db.initialize("drizzle");
  const store = new Store(db), bucket = new LocalMediaStore(folder, db), project = await store.createProject("alice", {});
  const sourcePath = "/03_图片/参考.jpg", sourceKey = project.id + "/test/reference.jpg";
  const source = await sharp({ create: { width: 2200, height: 40, channels: 3, background: "#347298" } }).jpeg().toBuffer();
  await bucket.put(sourceKey, source, { httpMetadata: { contentType: "image/jpeg" } });
  await store.putArtifact(project.id, { path: sourcePath, kind: "image", content: "", serveMedia: true,
    metadata: { objectKey: sourceKey, contentType: "image/jpeg" } });
  const turn = await send(store, project, "查看图像");
  await advanceRun(store, project, turn.id, settings, bucket, async () => call("inspect", "read_image", { file_path: sourcePath }));
  await advanceRun(store, project, turn.id, settings, bucket, async () => assert.fail("应先读取图片"));
  let original = "";
  await advanceRun(store, project, turn.id, settings, bucket, async (_system, messages) => {
    const image = messages.find(({ tool_call_id }) => tool_call_id === "inspect")!.images![0];
    assert.notEqual(image.objectKey, sourceKey);
    original = await imageDataUrl(image, bucket, project.id);
    return reply("已查看。");
  });
  const zip = await new Response(projectArchive(store, project.id, bucket)).arrayBuffer();
  const imported = await restoreProjectArchive(store, "alice", zip, bucket, new AbortController().signal);
  const importedTurn = await send(store, imported, "复核当时读取的图片");
  const stored = store.listAgentToolResults(importedTurn, Number.MAX_SAFE_INTEGER, "conversation").find(({ name }) => name === "read_image")!;
  const receipt = await store.readAgentToolResult(importedTurn, { runId: stored.task_id, seq: stored.seq }, 0, 0);
  assert.equal(receipt.result.image_count, 1);
  assert.equal(await imageDataUrl(receipt.images![0], bucket, imported.id), original);
});

test("a visual budget rejection offloads the oldest occurrence and replays the frozen request after restart", async (t) => {
  const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "对照两张图");
  const image = (name: string) => ({ id: crypto.randomUUID(), version: 2, path: "/03_图片/" + name + ".png",
    objectKey: project.id + "/" + name, bytes: 40, mediaType: "image/png", width: 200, height: 200 });
  const earlier = image("旧图"), latest = image("新图"), reference = crypto.randomUUID();
  const history: AgentMessage[] = [
    call("seen-image", "read_image", { file_path: earlier.path }),
    { role: "tool", tool_call_id: "seen-image", content: JSON.stringify({ result_ref: reference, excerpt: "图像" }), outputRef: reference, images: [earlier] },
    { role: "user", content: "当前要比较的图片", images: [latest] },
  ];
  await store.updateRun(turn, { payload: { ...turn.payload, agent: { messages: history, seenUserIds: (await store.inputs(turn)).map((item) => item.id),
    step: 1, toolIndex: 1, artifactIds: [] } } }, true);
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: "image_offload_required", offload_images: 1 } }, { status: 400 }));
  await advanceRun(store, project, turn.id, settings, undefined, async (system, messages, tools) => {
    assert.deepEqual(messages.flatMap((message) => message.images ?? []), [earlier, latest]);
    // Exercise the HTTP error translation without opening fixture images from disk.
    const { createAgentModel } = await import("../lib/studio/providers");
    return createAgentModel(settings)(system, messages, tools, { resolveImage: async () => "data:image/png;base64,YQ==" });
  });
  assert.equal((await store.run(turn.id, project.id)).status, "queued");
  const reopened = new Store(store.db);
  await advanceRun(reopened, project, turn.id, settings, undefined, async (_system, messages) => {
    assert.deepEqual(messages.flatMap((message) => message.images ?? []), [latest]);
    const old = JSON.parse(messages.find((message) => message.tool_call_id === "seen-image")!.content!);
    assert.equal(old.result_ref, reference);
    assert.match(old.image_context_excerpt, /read_tool_result.*旧图\.png v2/);
    return reply("已对照现有视觉上下文。");
  });
  const metrics = reopened.executionMetrics(project.id, turn.id);
  assert.deepEqual(metrics.models.map(({ status, step, attempt, errorCode }) => [status, step, attempt, errorCode]), [
    ["failed", 1, 1, "IMAGE_OFFLOAD_REQUIRED"], ["completed", 1, 2, null],
  ]);
  assert.equal((await reopened.run(turn.id, project.id)).attempts, 0);
  assert.deepEqual((await reopened.run(turn.id, project.id)).payload.agent?.messages.flatMap(({ images }) => images ?? []), [latest]);
  assert.equal(reopened.db.prepare("SELECT id FROM events WHERE project_id=? AND type='image/offload'").bind(project.id).rows().length, 1);
});

test("image limits during compaction only offload the summarized span", async () => {
  const base = fixture(), store = new Store(base.db, { contextWindow: 32000 }), project = await store.createProject("alice", {});
  const turn = await send(store, project, "保留最近的图片");
  const image = (name: string) => ({ id: crypto.randomUUID(), version: 1, path: "/03_图片/" + name + ".png", objectKey: project.id + "/" + name,
    bytes: 40, mediaType: "image/png", width: 100, height: 100 });
  const older = image("案头照"), latest = image("最新参考");
  await store.updateRun(turn, { payload: { ...turn.payload, agent: {
    messages: [{ role: "user", content: "历史素材。".repeat(7000), images: [older] }, { role: "user", content: "保留最近的图片。".repeat(700), images: [latest] }],
    seenUserIds: (await store.inputs(turn)).map((item) => item.id), step: 1, toolIndex: 0, artifactIds: [],
  } } }, true);
  const advance = (model: NonNullable<Parameters<typeof advanceRun>[5]>) => advanceRun(new Store(store.db, { contextWindow: 32000 }), project, turn.id, settings, undefined, model);
  await advance(async (system, messages) => {
    assert.match(system, /^总结此前工作/);
    assert.deepEqual(messages.flatMap(({ images }) => images ?? []), [older]);
    throw new ImageBudgetError(1);
  });
  await advance(async (system, messages) => {
    assert.match(system, /^总结此前工作/);
    assert.deepEqual(messages.flatMap(({ images }) => images ?? []), []);
    return reply("前期素材已讨论。");
  });
  await advance(async (system, messages) => {
    assert.doesNotMatch(system, /^总结此前工作/);
    assert.deepEqual(messages.flatMap(({ images }) => images ?? []), [latest]);
    return reply("已结合最新参考。");
  });
  assert.equal((await store.run(turn.id, project.id)).resultText, "已结合最新参考。");
});

test("a tool-only SSE response has durable first-output timing before the attempt settles", { timeout: 4000 }, async (t) => {
  const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "列出文件");
  const output = call("list", "list_files", {}).tool_calls![0];
  const payload = { choices: [{ delta: { tool_calls: [{ ...output, index: 0 }] }, finish_reason: null }] };
  const responseStream = new TransformStream<Uint8Array, Uint8Array>(), writer = responseStream.writable.getWriter();
  const write = (value: unknown) => writer.write(Buffer.from("data: " + (typeof value === "string" ? value : JSON.stringify(value)) + "\n\n"));
  t.mock.method(globalThis, "fetch", async () => new Response(responseStream.readable, { headers: { "Content-Type": "text/event-stream" } }));
  const running = advanceRun(store, project, turn.id, settings);
  await write(payload);
  await write({ choices: [] });
  const [live] = new Store(store.db).executionMetrics(project.id, turn.id).models;
  assert.equal(live.status, "started");
  assert.equal(typeof live.firstOutputMs, "number");
  assert.equal(live.durationMs, null);
  await write({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 24, completion_tokens: 6 } });
  await write("[DONE]");
  await writer.close();
  await running;
  const [saved] = store.executionMetrics(project.id, turn.id).models;
  assert.equal(saved.status, "completed");
  assert.equal(saved.firstOutputMs, live.firstOutputMs);
  assert.ok(saved.durationMs! >= live.firstOutputMs!);
  assert.deepEqual(saved.usage, { inputTokens: 24, outputTokens: 6, totalTokens: 30 });
});

test("a durable input wait releases its worker slot and settles on steering or expiry", async () => {
  for (const timedOut of [false, true]) {
    const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "等待我的下一条消息");
    await advanceRun(store, project, turn.id, settings, undefined, async () => call("park-input", "wait_for_input", { timeout_ms: 10000 }));
    await advanceRun(store, project, turn.id, settings, undefined, async () => assert.fail("先登记等待"));
    const reopened = new Store(store.db), waiting = await reopened.run(turn.id, project.id);
    assert.equal(waiting.status, "waiting");
    assert.equal(waiting.leaseUntil, 0);
    assert.ok(waiting.payload.agent!.waitingForInputUntil! > Date.now());
    assert.ok(!(await reopened.dueRuns()).some(({ id }) => id === turn.id));
    assert.equal(await reopened.claimRun(turn.id, project.id), false);
    if (timedOut) {
      await reopened.updateRun(waiting, { payload: { ...waiting.payload, agent: { ...waiting.payload.agent!, waitingForInputUntil: Date.now() - 1 } } }, true);
    } else {
      await reopened.acceptChat(project.id, { requestId: crypto.randomUUID(), text: "现在继续", attachmentIds: [] });
    }
    assert.ok((await reopened.dueRuns()).some(({ id }) => id === turn.id));
    await advanceRun(reopened, project, turn.id, settings, undefined, async (_, messages) => {
      const receiptIndex = messages.findIndex(({ tool_call_id }) => tool_call_id === "park-input");
      assert.deepEqual(JSON.parse(messages[receiptIndex].content!), { timedOut });
      if (!timedOut) assert.ok(messages.findIndex(({ content }) => content === "现在继续") > receiptIndex);
      return reply("本轮已恢复。");
    });
    assert.equal((await reopened.run(turn.id, project.id)).status, "done");
  }
});

test("a durable collaboration message wakes a parked child without changing its execution version", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "委派");
  assert.ok(await store.claimRun(turn.id, project.id));
  const parent = await store.run(turn.id, project.id);
  const { task_id: childId } = await store.startChild(parent, "spawn", "writer", "等待协作消息");
  assert.ok(typeof childId === "string");
  await advanceRun(store, project, childId, settings, undefined, async () => call("wait", "wait_for_input", { timeout_ms: 10000 }));
  await advanceRun(store, project, childId, settings, undefined, async () => assert.fail("先登记等待"));
  const waiting = await store.run(childId, project.id);
  assert.equal(waiting.status, "waiting");
  assert.ok(!(await store.dueRuns()).some(({ id }) => id === childId));
  await store.sendAgentMessage(parent, "send", childId, "继续修改");
  const reopened = new Store(store.db);
  assert.equal((await reopened.run(childId, project.id)).inputVersion, waiting.inputVersion);
  assert.ok((await reopened.dueRuns()).some(({ id }) => id === childId));
  await advanceRun(reopened, project, childId, settings, undefined, async (_, messages) => {
    const receipt = messages.findIndex(({ tool_call_id }) => tool_call_id === "wait");
    assert.deepEqual(JSON.parse(messages[receipt].content!), { timedOut: false });
    assert.ok(messages.findIndex(({ source }) => source?.kind === "agent-message") > receipt);
    return reply("收到协作消息");
  });
  assert.equal((await reopened.run(childId, project.id)).status, "done");
});

test("task status can be read without blocking, and a durable wait timeout leaves the task active", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "先查状态，再等一小会");
  assert.ok(await store.claimRun(turn.id, project.id));
  const lead = await store.run(turn.id, project.id);
  const child = await store.startChild(lead, "video", "media", "视频制作", {
    stage: "media", background: true, payload: { instruction: "视频制作", sourceVersions: {} },
  });
  const taskId = String(child.task_id);
  await store.updateRun(lead, { status: "queued" });
  const executeOnly = async () => assert.fail("应结算已收到的工具调用");
  const run = (model: Parameters<typeof advanceRun>[5]) => advanceRun(store, project, turn.id, settings, undefined, model);
  await run(async () => call("peek", "wait_for_tasks", { task_ids: [taskId], wait: false }));
  await run(executeOnly);
  await run(async (_system, messages) => {
    const receipt = JSON.parse(messages.find(({ tool_call_id }) => tool_call_id === "peek")!.content!);
    assert.equal(receipt.status, "pending");
    assert.equal(receipt.tasks[0].task_id, taskId);
    return call("timed-wait", "wait_for_tasks", { task_ids: [taskId], wait: true, timeout_ms: 10_000 });
  });
  await run(executeOnly);
  const reopened = new Store(store.db), waiting = await reopened.run(turn.id, project.id);
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.leaseUntil, 0);
  assert.ok(!(await reopened.dueRuns()).some(({ id }) => id === turn.id));
  assert.equal(await reopened.claimRun(turn.id, project.id), false);
  await reopened.updateRun(waiting, { payload: { ...waiting.payload, agent: {
    ...waiting.payload.agent!, waitingForTasksUntil: Date.now() - 100,
  } } }, true);
  assert.ok((await reopened.dueRuns()).some(({ id }) => id === turn.id));
  await advanceRun(reopened, project, turn.id, settings, undefined, async (_system, messages) => {
    const receipt = JSON.parse(messages.find(({ tool_call_id }) => tool_call_id === "timed-wait")!.content!);
    assert.equal(receipt.status, "timed_out");
    assert.equal(receipt.tasks[0].status, "queued");
    return reply("暂时没有结果，任务继续运行。");
  });
  assert.equal((await reopened.run(turn.id, project.id)).status, "done");
  assert.equal((await reopened.run(taskId, project.id)).status, "queued");
});

test("file mutations check the admitted input version at commit, including batch edits and moves", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), turn = await send(store, project, "改旧稿");
  const file = await store.putArtifact(project.id, { path: "/01_创作/稿.md", kind: "document", content: "保留的原稿" });
  assert.ok(await store.claimRun(turn.id, project.id));
  const stale = await store.run(turn.id, project.id);
  await store.acceptChat(project.id, { requestId: crypto.randomUUID(), text: "先别修改文件", attachmentIds: [] });
  const steer = (error: unknown) => error instanceof AppError && error.code === "AGENT_STEER";
  await assert.rejects(store.putArtifact(project.id, { path: file.path, kind: file.kind, content: "旧请求的修改", expectedVersion: 1,
    toolReceipt: { run: stale, callId: "old-write" } }), steer);
  await assert.rejects(store.editArtifacts(stale, "old-batch", [{ file, version: 1, content: "旧请求的批量修改" }]), steer);
  await assert.rejects(store.moveArtifact(stale, "old-move", file, "/01_创作/移动.md"), steer);
  assert.equal((await store.artifact(file.id, project.id)).content, "保留的原稿");
  assert.equal((await store.versions(file.id, project.id)).length, 1);
  for (const id of ["old-write", "old-batch", "old-move"]) assert.equal(await store.toolResult(turn.id, id), null);
});

test("concurrent visual reads share preparation while preserving the original file identities", async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), "doman-single-image-"));
  const db = new SQLiteDatabase(":memory:");
  t.after(async () => { db.close(); await rm(folder, { force: true, recursive: true }); });
  db.initialize("drizzle");
  const store = new Store(db), bucket = new LocalMediaStore(folder, db), project = await store.createProject("alice", {});
  const key = project.id + "/source";
  const source = await sharp({ create: { width: 2200, height: 40, channels: 3, background: "#347298" } }).jpeg().toBuffer();
  await bucket.put(key, source);
  const first = await store.putArtifact(project.id, { path: "/03_图片/原图.jpg", kind: "image", content: "", metadata: { objectKey: key } });
  const second = { ...first, id: crypto.randomUUID(), version: 2, path: "/03_图片/引用.jpg" };
  const read = t.mock.method(bucket, "get");
  const [old, alias] = await Promise.all([inspectImage(first, bucket), inspectImage(second, bucket)]);
  assert.equal(read.mock.calls.filter(({ arguments: [arg] }) => arg === key).length, 1);
  assert.notEqual(old.objectKey, key);
  assert.equal(alias.objectKey, old.objectKey);
  assert.deepEqual([alias.id, alias.path, alias.version], [second.id, second.path, 2]);
});

test("job output is incremental, replay-safe, and independent from the observation stream", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  try {
    const turn = await send(store, project, "查看后台");
    assert.ok(await store.claimRun(turn.id, project.id));
    const owner = await store.run(turn.id, project.id);
    const jobId = String((await store.startChild(owner, "create-job", "media", "后台", { stage: "composing", background: true,
      payload: { instruction: "", sourceVersions: {}, operation: { toolCallId: "create-job", name: "compose_video", path: "/07_成片/样片.mp4" } } })).task_id);
    assert.ok(await store.claimRun(jobId, project.id));
    const job = await store.run(jobId, project.id);
    const http = streamJobOutput(new Request("http://localhost/output"), store, job);
    const reader = http.body!.getReader();
    const first = await consumeJobOutput(store, owner, "first", jobId);
    assert.equal(first.status, "running");
    assert.equal((await consumeJobOutput(store, owner, "empty", jobId)).text, "");
    await store.appendBackgroundOutput(job, ["镜头一"]);
    const second = await consumeJobOutput(new Store(store.db), owner, "second", jobId);
    assert.equal(second.text, "镜头一");
    assert.deepEqual(await consumeJobOutput(store, owner, "second", jobId), second);
    const initial = await reader.read();
    assert.match(new TextDecoder().decode(initial.value), /准备制作/);
    const update = await reader.read();
    assert.match(new TextDecoder().decode(update.value), /镜头一/);
    await store.updateRun(job, { status: "done", resultText: "最终产物", label: "合成完毕", progress: 100 });
    const last = await consumeJobOutput(store, owner, "final", jobId);
    assert.equal((last.result as { result: string }).result, "最终产物");
    assert.equal((await consumeJobOutput(store, owner, "again", jobId)).result, undefined);
    await reader.cancel();
    const session = await store.createSession(project.id, "另一对话"), other = await send(store, project, "查看后台", session.id);
    await assert.rejects(consumeJobOutput(store, other, "private", jobId), { code: "JOB_NOT_FOUND" });
  } finally { (store.db as SQLiteDatabase).close(); }
});

test("a reopened conversation keeps its lead's job capacity and cursor across turns and resume", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "doman-job-admission-"));
  const filename = path.join(directory, "studio.sqlite");
  let db = new SQLiteDatabase(filename);
  const reopen = () => new Store(db, { maxConcurrentJobsPerOwner: 1, completionDelivery: "quiet" });
  try {
    db.initialize("drizzle");
    let store = reopen();
    const project = await store.createProject("alice", {});
    const claim = async (id: string) => {
      assert.ok(await store.claimRun(id, project.id));
      return store.run(id, project.id);
    };
    const create = async (owner: Run, name: string) => String((await store.startChild(owner, name, "media", name, {
      stage: "composing", background: true, payload: { instruction: "", sourceVersions: {},
        operation: { toolCallId: name, name: "compose_video", path: "/07_成片/" + name + ".mp4" } },
    })).task_id);
    const first = await claim((await send(store, project, "First turn")).id);
    const job = await claim(await create(first, "first"));
    await store.appendBackgroundOutput(job, ["before"], "lines");
    assert.match(String((await consumeJobOutput(store, first, "read-first", job.id)).text), /before/);
    await store.appendBackgroundOutput(job, ["after"], "lines");
    await store.releaseLease(job);
    await store.updateRun(first, { status: "done", stage: "done" });
    db.close();
    db = new SQLiteDatabase(filename);
    store = reopen();

    const next = await claim((await send(store, project, "Second turn")).id);
    assert.match(String((await consumeJobOutput(store, next, "read-next", job.id)).text), /after/);
    assert.equal((await consumeJobOutput(store, next, "again", job.id)).text, "");
    await assert.rejects(create(next, "second"), { code: "JOB_LIMIT_REACHED" });
    await store.controlTree(await store.run(job.id, project.id), "pause");
    const second = await create(next, "second");
    const paused = await store.run(job.id, project.id);
    await assert.rejects(store.resumeTree(paused, paused.payload), { code: "JOB_LIMIT_REACHED" });
    await store.controlTree(await store.run(second, project.id), "cancel");
    await store.resumeTree(paused, paused.payload);
    assert.equal((await store.run(job.id, project.id)).status, "queued");
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("nested delegation survives recovery, enforces depth and allocates sibling names concurrently", async () => {
  const initial = fixture(), project = await initial.createProject("alice", {});
  const store = new Store(initial.db, { maxDelegationDepth: 2 });
  try {
    const turn = await send(store, project, "写两版");
    assert.ok(await store.claimRun(turn.id, project.id));
    const parent = await store.run(turn.id, project.id);
    const siblings = await Promise.all(["一", "二"].map((name) => store.startChild(parent, name, "writer", name, undefined, true)));
    assert.equal(new Set(siblings.map(({ member_name }) => member_name)).size, 2);
    const childId = String(siblings[0].task_id);
    assert.ok(await store.claimRun(childId, project.id));
    const child = await store.run(childId, project.id);
    assert.ok(!initial.canDelegate(child));
    const grandchildId = String((await store.startChild(child, "grandchild", "director", "审稿")).task_id);
    const resumed = new Store(store.db, { maxDelegationDepth: 2 });
    assert.ok(await resumed.claimRun(grandchildId, project.id));
    const grandchild = await resumed.run(grandchildId, project.id);
    assert.equal(resumed.delegationDepth(grandchild), 2);
    await assert.rejects(resumed.startChild(grandchild, "too-deep", "writer", "超限"), { code: "AGENT_DEPTH_LIMIT" });
    await resumed.updateRun(child, { status: "done", stage: "done" }, true);
    await resumed.updateRun(grandchild, { status: "done", stage: "done", resultText: "审稿结果" }, true);
    await resumed.dueRuns();
    assert.equal((await resumed.run(child.id, project.id)).status, "queued");
    assert.equal(resumed.taskInbox(child, await resumed.agentTasks(child))[0].id, grandchild.id);
  } finally { (store.db as SQLiteDatabase).close(); }
});

test("job_output parks the owner without consuming peer notices and releases on user steering", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  try {
    const turn = await send(store, project, "等第一项合成");
    assert.ok(await store.claimRun(turn.id, project.id));
    const owner = await store.run(turn.id, project.id);
    const jobs: string[] = [];
    for (const name of ["第一项", "第二项"]) {
      jobs.push(String((await store.startChild(owner, name, "media", name, {
        stage: "media", background: true, payload: { instruction: name, sourceVersions: {} },
      })).task_id));
    }
    await store.updateRun(owner, { status: "queued" });
    const executeOnly = async () => assert.fail("应先结算本步");
    await advanceRun(store, project, turn.id, settings, undefined, async () =>
      call("wait-job", "job_output", { job_id: jobs[0], wait: true }));
    await advanceRun(store, project, turn.id, settings, undefined, executeOnly);
    const parked = await store.run(turn.id, project.id);
    assert.equal(parked.status, "waiting");
    assert.ok(parked.payload.agent?.waitingForJob);
    await store.updateRun(await store.run(jobs[1], project.id), { status: "done", label: "第二项已完成" }, true);
    assert.ok(!(await store.dueRuns()).some(({ id }) => id === turn.id));
    const requestId = crypto.randomUUID();
    await store.enqueueChat(project.id, { requestId, text: "先讨论下一镜", attachmentIds: [] });
    assert.equal(await store.steerQueuedChats(project.id, turn.id, [{ requestId, version: 1 }]), 1);
    await advanceRun(store, project, turn.id, settings, undefined, executeOnly);
    await advanceRun(store, project, turn.id, settings, undefined, async (_system, messages) => {
      const result = JSON.parse(messages.find(({ tool_call_id }) => tool_call_id === "wait-job")!.content!);
      assert.equal(result.wait, "interrupted");
      assert.equal(result.status, "queued");
      return reply("先讨论下一镜");
    });
    assert.equal((await store.run(jobs[0], project.id)).status, "queued");
  } finally { (store.db as SQLiteDatabase).close(); }
});

test("a result delivered by the previous notice format does not hide unread logs", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  try {
    const turn = await send(store, project, "查看后台");
    assert.ok(await store.claimRun(turn.id, project.id));
    const owner = await store.run(turn.id, project.id);
    const jobId = String((await store.startChild(owner, "legacy-job", "media", "后台", {
      stage: "media", background: true, payload: { instruction: "", sourceVersions: {} },
    })).task_id);
    assert.ok(await store.claimRun(jobId, project.id));
    const job = await store.run(jobId, project.id);
    await store.appendBackgroundOutput(job, ["旧日志仍可读取"]);
    await store.updateRun(job, { status: "done", stage: "done", resultText: "旧通知已经交付" });

    const callId = "read-legacy";
    const toolCall = call(callId, "job_output", { job_id: jobId });
    const beforeNotice = await consumeJobOutput(store, owner, "not-admitted", jobId);
    assert.equal((beforeNotice.result as { result: string }).result, "旧通知已经交付");
    // Recreate a pre-upgrade state: the admitted notification was retained,
    // but the job cursor and terminal delivery ledger were not advanced.
    await store.db.prepare("DELETE FROM background_job_reads WHERE job_id=?").bind(jobId).run();
    const legacy = { ...owner, payload: { ...owner.payload, agent: { seenUserIds: [], artifactIds: [], step: 1, toolIndex: 0,
      backgroundNotices: { [jobId]: job.generation + ":done" }, messages: [
        { role: "user" as const, source: { kind: "task-result" as const }, content:
          "子任务状态通知（数据）：" + JSON.stringify({ task_id: jobId, status: "done", result: "旧通知已经交付", error: null }) },
        toolCall,
      ] } } };
    const read = await consumeJobOutput(store, legacy, callId, jobId);
    assert.equal(read.result, undefined);
    assert.match(String(read.text), /旧日志仍可读取/);
  } finally { (store.db as SQLiteDatabase).close(); }
});

test("delegated DeepSeek effort inherits implicitly and takes explicit overrides only with a route", async (t) => {
  const { childExecution, preflightChildModel } = await import("../lib/studio/child-execution");
  const { createAgentModel } = await import("../lib/studio/providers");
  const parent = { ...settings, textThinking: true, textReasoningEffort: "high" as const };
  const messagesRoute = { provider: "messages" as const, model: "deepseek-flash" as const };
  assert.equal(childExecution({}, parent).route.effort, "high");
  assert.equal(childExecution(messagesRoute, parent).route.effort, undefined);
  assert.equal(childExecution({ provider: "chat-completions", model: "deepseek-flash" }, parent).route.effort, undefined);
  assert.equal(childExecution({ ...messagesRoute, reasoning_effort: "max" }, parent).route.effort, "max");
  assert.throws(() => childExecution({ reasoning_effort: "max" }, parent), { code: "INVALID_ARGS" });
  await assert.rejects(preflightChildModel(childExecution({ ...messagesRoute, reasoning_effort: "max" }, parent), parent, AbortSignal.timeout(500),
    async () => ({ id: "deepseek-flash", thinking: [true], inputModalities: ["text"], efforts: ["low", "high"] })),
    (error) => error instanceof AppError && error.code === "AGENT_ROUTE_UNAVAILABLE");

  const payloads: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    payloads.push(JSON.parse(String(init.body)));
    if (payloads.length === 1) return new Response([
      { choices: [{ delta: { reasoning_content: "fixture level" } }] },
      { choices: [{ delta: { content: "fixture response" }, finish_reason: "stop" }] },
    ].map((value) => "data: " + JSON.stringify(value) + "\n\n").join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } });
    if (payloads.length === 2) return Response.json({ choices: [{ message: { content: "received" }, finish_reason: "stop" }] });
    return Response.json({ content: [{ type: "text", text: "received" }], stop_reason: "end_turn" });
  });
  const user = { role: "user", content: "fixture" } as const;
  const tools = [tool("fixture", "Fixture", {})];
  const model = createAgentModel({ ...parent, textReasoningEffort: "low" });
  const first = await model("Fixture", [user], tools);
  assert.equal(first.chatReasoning?.text, "fixture level");
  await model("Fixture", [user, first, user], tools);
  await createAgentModel({ ...parent, textBaseUrl: "https://api.deepseek.com/anthropic", textReasoningEffort: "max" })("Fixture", [user], tools);
  assert.equal(payloads[0].reasoning_effort, "low");
  assert.equal((payloads[1].messages as Record<string, unknown>[])[2].reasoning_content, "fixture level");
  assert.deepEqual(payloads[2].output_config, { effort: "max" });
});

test("always retry uses the selected route's local backoff when provider advice exceeds the cap", async (t) => {
  const { ModelRequestError } = await import("../lib/studio/providers");
  const original = fixture();
  const store = new Store(original.db, { modelRetry: { messages: {
    mode: "always", initialDelayMs: 2, maxDelayMs: 4, jitterRatio: 0.5,
  } } });
  const project = await store.createProject("alice", {});
  const turn = await send(store, project, "请求");
  const route = { ...settings, textBaseUrl: "https://api.deepseek.com/anthropic" };
  let requests = 0, moment = 2_000_000_000_000;
  t.mock.method(Date, "now", () => moment);
  t.mock.method(Math, "random", () => 1);
  const model = async () => {
    if (requests++ === 0) throw new ModelRequestError("fixture retry after", 401, "MODEL_AUTH", 10);
    return reply("done");
  };
  const waiting = await advanceRun(store, project, turn.id, route, undefined, model);
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.nextAttemptAt - moment, 3);
  assert.equal(waiting.payload.modelRetry?.mode, "always");
  assert.equal(waiting.payload.modelRetry?.maxRetries, undefined);
  assert.equal(waiting.payload.modelRetry?.delayMs, 3);
  moment = waiting.nextAttemptAt;
  assert.equal((await advanceRun(store, project, turn.id, route, undefined, model)).status, "done");
  assert.equal(requests, 2);
  const zip = await new Response(projectArchive(store, project.id, undefined)).arrayBuffer();
  const restored = await restoreProjectArchive(store, "alice", zip, undefined, AbortSignal.timeout(2000));
  const retryEvents = (id: string) => store.db.prepare("SELECT type,data FROM events WHERE project_id=? AND type LIKE 'llm/retry%' ORDER BY id")
    .bind(id).rows<{ type: string; data: string }>().map(({ type, data }) => ({ type, data: JSON.parse(data) }));
  const before = retryEvents(project.id), after = retryEvents(restored.id);
  assert.deepEqual(after.map(({ type }) => type), ["llm/retry", "llm/retry-started"]);
  assert.equal(after[0].data.delayMs, 3);
  assert.equal(after[1].data.delayMs, undefined);
  assert.equal(after[0].data.retryId, after[1].data.retryId);
  assert.equal(after[0].data.requestId, after[1].data.previousRequestId);
  assert.notEqual(after[0].data.runId, before[0].data.runId);
});
