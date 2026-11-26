import { openStudioZip, streamZip } from "../../lib/studio/zip";
import { projectArchive, restoreProjectArchive } from "../../lib/studio/project-archive";
import { configureRuntime } from "../../server/runtime";
import { GET as getStudio, PATCH as patchStudio } from "../../app/api/studio/[...path]/route";
import { backgroundOutput, consumeJobOutput } from "../../lib/studio/background-jobs";
import assert from "node:assert/strict";
import { streamOutput, stderrOutput, oversizedOutput, outputTail } from "./extension-cases.mjs";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SQLiteDatabase } from "../../server/storage";
import { advanceRun } from "../../lib/studio/engine";
import { tool } from "../../lib/studio/file-tools";
import { AppError } from "../../lib/studio/security";
import { Store } from "../../lib/studio/store";
import { DEFAULT_SETTINGS } from "../../lib/studio/types";
import { createToolRegistry } from "../../lib/studio/agent-tools";
import { createAgentModel } from "../../lib/studio/providers";
import { taskNotice, taskResult } from "../../lib/studio/agent-state";
import { childExecution, preflightChildModel } from "../../lib/studio/child-execution";
import { delegationParityProbe, innerFlowProbe, probeJobCapacity } from "./recovery-cases.mjs";
import {
  authorizationCases, childPrompt, childTool, currentPrompt, earlierPrompt, earlierReply, firstDelta,
  imageTransportFixture, messagesHistory, messagesResponse, mixedArguments, overflowCases, peerMessage, peerReply, prunableReceipt, recentReceipt, requestReplay, secondDelta, shortenedHistory,
  decodeReferenceTranscript, expectedReferenceMessages, longReferenceCases, referenceBudget, referencePageSize, referenceUpdate,
  nativeAddedTool, nativeReplayTrace, nativeReply, nativeScenarios, nativeThinking, nativeUpdateTrace, nativeCapabilitiesFixture,
  compactHistory, compactLatest, compactMarkerTrace, compactMemo, compactOutputTokens, compactRouteCases, compactRoutes,
  childExecutionCases, childExecutionProbe, nativeToolCalls, crossTurnProbe, childNoticeProbe, largeBatchCalls, largeToolBatches, backgroundHistoryProbe,
} from "./recovery-cases.mjs";

const settings = { ...DEFAULT_SETTINGS, textApiKey: "fixture" };
const reply = (content) => ({ role: "assistant", content });
const toolCall = (id, name, content = null) => ({ ...reply(content), tool_calls: [
  { id, type: "function", function: { name, arguments: "{}" } },
] });
const unexpectedModel = async () => assert.fail("Unexpected model request");

function database(path = ":memory:") {
  const db = new SQLiteDatabase(path);
  db.initialize("drizzle");
  return db;
}

async function send(store, project, text) {
  const requestId = crypto.randomUUID();
  await store.acceptChat(project.id, { requestId, text, attachmentIds: [] });
  const message = store.db.prepare("SELECT run_id FROM messages WHERE project_id=? AND request_id=?").bind(project.id, requestId).rows()[0];
  assert.ok(message?.run_id);
  return message.run_id;
}

async function finish(store, project, id, model) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const run = await advanceRun(store, project, id, settings, undefined, model);
    if (["done", "failed", "cancelled"].includes(run.status)) return run;
  }
  assert.fail("Agent did not settle");
}

async function authorization(enabled) {
  const db = database(), restoreFetch = globalThis.fetch;
  try {
    let offered = false;
    globalThis.fetch = async () => assert.fail("Unadmitted web request");
    const store = new Store(db);
    const project = await store.createProject("local", {});
    const id = await send(store, project, "test");
    await advanceRun(store, project, id, { ...settings, webSearchEnabled: enabled }, undefined, async (_, __, tools) => {
      offered = tools.some(({ function: definition }) => definition.name === "web_search");
      return toolCall("web", "web_search");
    });
    await advanceRun(store, project, id, { ...settings, webSearchEnabled: !enabled }, undefined, unexpectedModel);
    const receipt = db.prepare("SELECT result,dispatched_at FROM execution_steps WHERE run_id=? AND call_id='web'").bind(id).rows()[0];
    return { offered, invoked: Number(Boolean(receipt.dispatched_at)), outcome: JSON.parse(receipt.result).code };
  } finally { globalThis.fetch = restoreFetch; db.close(); }
}

async function liveRevocation() {
  const db = database();
  try {
    const invoked = [];
    const initial = { ...settings, webSearchEnabled: true };
    let live = initial, requests = 0;
    const store = new Store(db, { maxParallelTools: 1, tools: ["first", "second"].map((name) => ({
      schema: tool(name, name, {}), label: name, mode: "parallel", available: name === "second" ?
        ({ settings }) => settings.webSearchEnabled : undefined,
      async execute() { invoked.push(name); if (name === "first") live = { ...initial, webSearchEnabled: false }; return { result: { ok: true } }; },
    })) });
    const project = await store.createProject("local", {}), id = await send(store, project, "test");
    const model = async () => requests++ > 0 ? reply("settled") : { role: "assistant", content: null,
      tool_calls: ["first", "second"].flatMap((name) => toolCall(name, name).tool_calls) };
    for (let index = 0; index < 5; index++) {
      const run = await advanceRun(store, project, id, initial, undefined, model, async () => live);
      if (run.status === "done") break;
    }
    const receipts = db.prepare("SELECT result FROM execution_steps WHERE run_id=? ORDER BY seq").bind(id).rows()
      .map(({ result }) => JSON.parse(result).code ?? "ok");
    assert.equal(requests, 2);
    return { invoked, receipts };
  } finally { db.close(); }
}

async function overflow(scenario) {
  const db = database();
  try {
    const requests = [];
    let reads = 0, creation = 0;
    const store = new Store(db, { tools: [{
      schema: tool("read_probe", "test read", {}), label: "Test read",
      async execute() { return { result: { content: reads++ === 0 && scenario.oldReceipt ? prunableReceipt : recentReceipt } }; },
    }] });
    const project = await store.createProject("local", {});
    if (!scenario.firstTurn) {
      const prior = await send(store, project, earlierPrompt);
      await finish(store, project, prior, async () => reply(earlierReply));
    }
    const id = await send(store, project, currentPrompt);
    await finish(store, project, id, async (system, messages) => {
      if (system.startsWith("总结此前工作")) {
        requests.push("summary");
        if (scenario.summarySucceeds) return reply(shortenedHistory);
        throw new AppError("Fixture summary is unavailable", 401, "MODEL_AUTH");
      }
      const summarized = messages.some((message) => message.content?.includes(shortenedHistory));
      requests.push(summarized ? "creation with summary" : "creation");
      creation++;
      if (creation <= 2) return toolCall(creation === 1 ? "old" : "recent", "read_probe");
      if (creation === 3 || (scenario.summarySucceeds && !summarized))
        throw new AppError("Original overflow", 400, "CONTEXT_WINDOW_EXCEEDED");
      return reply("recovered");
    });
    const events = db.prepare("SELECT type,data FROM events WHERE project_id=? AND json_extract(data,'$.runId')=? ORDER BY id")
      .bind(project.id, id).rows().map(({ type, data }) => ({ type, data: JSON.parse(data) }));
    const end = events.findLast(({ type }) => type === "turn/end").data.reason;
    if (end.kind === "error") assert.equal(end.message, "Original overflow");
    const attempts = store.executionMetrics(project.id, id).models;
    const rejected = attempts.find(({ errorCode }) => errorCode === "CONTEXT_WINDOW_EXCEEDED");
    const summary = attempts.find(({ purpose }) => purpose === "compaction");
    assert.equal(summary.step, rejected.step);
    if (end.kind === "completed") {
      const creationRetry = attempts.at(-1);
      assert.equal(creationRetry.step, rejected.step);
      assert.ok(creationRetry.attempt > rejected.attempt);
      const replySettled = events.findIndex(({ type, data }) => type === "reply" && data.requestId === creationRetry.id);
      const stepEnded = events.findIndex(({ type, data }) => type === "step/end" && data.step === rejected.step);
      assert.ok(replySettled >= 0 && stepEnded > replySettled);
    }
    return { requests, end: end.code ?? end.kind,
      steps: events.filter(({ type }) => type === "step/start").map(({ data }) => data.step),
      summaries: store.sessionEntries(id, project.id).filter(({ kind }) => kind === "context/compacted").length };
  } finally { db.close(); }
}

async function peerDelivery(withTool) {
  const db = database(), streamed = Promise.withResolvers<void>(), admitted = Promise.withResolvers<void>();
  const sideEffects = [], history = [];
  const store = new Store(db, { tools: [{
    schema: tool("child_probe", "test child", {}), label: "Test child",
    async execute() { sideEffects.push(childTool); return { result: { content: childTool } }; },
  }] });
  const project = await store.createProject("local", {});
  const parentId = await send(store, project, "parent");
  assert.ok(await store.claimRun(parentId, project.id));
  const parent = await store.run(parentId, project.id);
  const { task_id: id } = await store.startChild(parent, "spawn", "writer", childPrompt);
  const model = async (_system, messages, _, options) => {
    history.push({ peer: messages.some((m) => m.source?.kind === "agent-message" && m.content?.includes(peerMessage)),
      receipt: messages.some((m) => m.role === "tool" && JSON.parse(m.content).content === childTool) });
    if (history.length > 1) return reply(peerReply);
    await options.onText(firstDelta);
    streamed.resolve();
    await admitted.promise;
    options.signal.throwIfAborted();
    const text = firstDelta + secondDelta;
    await options.onText(text);
    return withTool ? toolCall("peer-tool", "child_probe", text) : reply(text);
  };
  try {
    const active = advanceRun(store, project, id, settings, undefined, model);
    try {
      await Promise.race([active.then(() => assert.fail("Child finished before peer delivery")), streamed.promise,
        delay(2000).then(() => assert.fail("Child stream did not start"))]);
      const receipt = await store.sendAgentMessage(parent, "send", id, peerMessage);
      assert.deepEqual(await store.sendAgentMessage(parent, "send", id, peerMessage), receipt);
    } finally { admitted.resolve(); await active; }
    assert.equal((await finish(new Store(db, { tools: store.tools }), project, id, model)).status, "done");
    const attempts = (await store.modelCalls(project.id)).filter(({ run_id }) => run_id === id);
    assert.ok(attempts.every(({ status }) => status === "completed"));
    return { history, sideEffects, text: attempts.map(({ response }) => JSON.parse(response).content) };
  } finally { await store.releaseLease(parent); db.close(); }
}

async function background() {
  const root = await mkdtemp(join(tmpdir(), "doman-notification-"));
  const file = join(root, "studio.sqlite");
  let db = database(file);
  let store = new Store(db, { completionDelivery: "quiet" });
  try {
    const project = await store.createProject("local", {});
    const ownerId = await send(store, project, "initial");
    assert.ok(await store.claimRun(ownerId, project.id));
    const owner = await store.run(ownerId, project.id);
    const { task_id: jobId } = await store.startChild(owner, "job", "media", "job fixture", {
      stage: "composing", background: true, payload: {
        instruction: "job fixture", sourceVersions: {}, operation: { name: "compose_video", path: "/07_成片/probe.mp4" },
      },
    });
    await store.releaseLease(owner);
    await finish(store, project, ownerId, async () => reply("finished"));
    assert.ok(await store.claimRun(jobId, project.id));
    const job = await store.run(jobId, project.id);
    await store.finishComposition(job, "fake-final", 0);
    await store.releaseLease(job);
    const extraRequests = (await store.dueRuns()).length;
    const pending = () => db.prepare("SELECT count(*) AS count FROM agent_inbox WHERE project_id=? AND kind='task-result' AND content=?")
      .bind(project.id, jobId).rows()[0].count;
    const pendingBefore = pending();
    db.close();
    db = database(file);
    store = new Store(db, { completionDelivery: "quiet" });
    const pendingRecovered = pending();
    assert.equal((await store.run(jobId, project.id)).status, "done");
    const notices = [];
    let deliveries = 0;
    for (const prompt of ["first after restart", "second after restart"]) {
      const id = await send(store, project, prompt);
      await finish(store, project, id, async (_, messages) => {
        notices.push(messages.filter((m) => m.source?.kind === "task-result").length);
        return reply("finished");
      });
      deliveries += store.sessionEntries(id, project.id).filter(({ kind }) => kind === "model/request")
        .flatMap(({ patch }) => patch.messages?.insert ?? []).filter((m) => m.source?.kind === "task-result").length;
    }
    return { pendingBefore, pendingRecovered, notices, deliveries, extraRequests };
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

async function jobDeltas() {
  const db = database();
  try {
    const store = new Store(db, { completionDelivery: "quiet" });
    const project = await store.createProject("local", {}), root = await send(store, project, "start");
    assert.ok(await store.claimRun(root, project.id));
    const owner = await store.run(root, project.id);
    const id = await newProbeJob(store, owner, "a");
    assert.ok(await store.claimRun(id, project.id));
    const job = await store.run(id, project.id);
    await store.appendBackgroundOutput(job, ["segment-a", ...streamOutput,
      { line: stderrOutput, channel: "stderr" }, { line: "private progress", channel: "log" }], "lines");
    const registry = createToolRegistry({ store, run: owner, project, settings, tasks: [job] });
    const output = registry.get("job_output");
    const ctx = { store, run: owner, tasks: [job] };
    const first = (await output.execute(ctx, "first", { job_id: id })).result;
    const empty = (await output.execute(ctx, "empty", { job_id: id, timeout_ms: 20 })).result;
    const wait = await output.execute(ctx, "wait", { job_id: id, wait: true, timeout_ms: 10 });
    assert.equal(wait.waitFor[0], id);
    const deadline = await consumeJobOutput(store, owner, "wait", id, "timed_out");
    await store.appendBackgroundOutput(job, ["segment-", "b"]);
    const second = await consumeJobOutput(store, owner, "second", id);
    await store.appendBackgroundOutput(job, [oversizedOutput]);
    const oversized = await consumeJobOutput(store, owner, "oversized", id);
    await store.updateRun(job, { status: "done", label: "completed", resultText: "artifact-ready" });
    const final = await consumeJobOutput(store, owner, "final", id), again = await consumeJobOutput(store, owner, "again", id);
    assert.ok(first.text.includes(streamOutput.at(-1)) && first.text.indexOf("[stderr]") > first.text.indexOf(streamOutput.at(-1)));
    return { first: first.text.includes("segment-a"), completeDelta: first.text.trimEnd().split("\n").length === streamOutput.length + 3,
      stderr: first.text.includes("[stderr]\n" + stderrOutput), progressExcluded: !first.text.includes("private progress"),
      oversized: oversized.text.includes(outputTail) && oversized.dropped === true && !oversized.text.includes("\uFFFD"),
      empty: empty.text === "", timed: deadline.status === "running",
      second: second.text.includes("segment-b") && !second.text.includes("segment-a"), final: final.result.result === "artifact-ready", once: again.result === undefined };
  } finally { db.close(); }
}

async function newProbeJob(store, owner, name) {
  return (await store.startChild(owner, "job-" + name, "media", name, { stage: "composing", background: true,
    payload: { instruction: "", sourceVersions: {}, operation: { name: "compose_video", path: "/07_成片/" + name + ".mp4" } } })).task_id;
}

async function backgroundHistoryTraces() {
  const probe = backgroundHistoryProbe;
  const withJob = async (processJob) => {
    const db = database();
    try {
      const store = new Store(db);
      const project = await store.createProject("local", {});
      const root = await send(store, project, "start");
      assert.ok(await store.claimRun(root, project.id));
      const owner = await store.run(root, project.id), id = await newProbeJob(store, owner, "history");
      await store.releaseLease(owner);
      assert.equal((await finish(store, project, root, async () => reply("started"))).status, "done");
      assert.ok(await store.claimRun(id, project.id));
      const job = await store.run(id, project.id);
      return await processJob(store, project, job);
    } finally { db.close(); }
  };
  const noticeTrace = (large: boolean, archive: boolean) => withJob(async (store, project, job) => {
    const contents = large ? [...Array.from({ length: 4 }, () => "x".repeat(800)), ...probe.output] : probe.output;
    await store.appendBackgroundOutput(job, contents);
    await store.updateRun(job, { status: "done", stage: "done", label: probe.label, resultText: probe.result });
    await store.releaseLease(job);
    const followup = (await store.dueRuns()).find((run) => run.interactive);
    assert.ok(followup);
    let noticeResult = false, noticeOutput = false, toolResult = false, toolOutput = false;
    const state = await finish(store, project, followup.id, async (_, messages) => {
      const receipt = messages.findLast((message) => message.role === "tool");
      if (receipt) {
        toolResult = receipt.content.includes(probe.result);
        toolOutput = probe.output.every((line) => receipt.content.includes(line));
        return reply("done");
      }
      const notice = messages.findLast((message) => message.source?.kind === "task-result");
      noticeResult = notice.content.includes(probe.result);
      noticeOutput = probe.output.every((line) => notice.content.includes(line));
      return { role: "assistant", content: null, tool_calls: [{ id: "read-background", type: "function",
        function: { name: "job_output", arguments: JSON.stringify({ job_id: job.id }) } }] };
    });
    assert.equal(state.status, "done");
    const trace = { noticeResult, noticeOutput, toolResult, toolOutput };
    if (!archive) return trace;
    const zip = await new Response(projectArchive(store, project.id, undefined)).arrayBuffer();
    const imported = await restoreProjectArchive(store, "local", zip, undefined, AbortSignal.timeout(3000));
    const snapshot = await store.snapshot(imported.id, "local");
    const restored = snapshot.runs.find((run) => run.background && run.label === probe.label);
    assert.ok(restored?.payload.imported && restored.id !== job.id);
    assert.equal(restored.payload.archivedOutputPath, "/07_成片/history.mp4");
    assert.equal((await store.dueRuns()).some((run) => run.projectId === imported.id), false);
    assert.equal((await store.agentTasks(restored)).some((run) => run.payload.imported), false);
    configureRuntime({ database: store.db, userId: "local" } as never);
    const get = (targetProject) => getStudio(new Request("http://127.0.0.1/output"),
      { params: Promise.resolve({ path: ["projects", targetProject, "runs", restored.id, "output"] }) });
    const response = await get(imported.id);
    assert.equal(response.status, 200);
    assert.equal((await get(project.id)).status, 404);
    const control = await patchStudio(new Request("http://127.0.0.1/control", { method: "PATCH", body: JSON.stringify({ action: "resume" }) }),
      { params: Promise.resolve({ path: ["projects", imported.id, "runs", restored.id] }) });
    assert.equal(control.status, 409);
    assert.equal((await control.json()).code, "ARCHIVED_RUN");
    const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    const lines = events.flatMap((event) => event.lines.map(({ line }) => line));
    const from = lines.indexOf(probe.output[0]);
    assert.deepEqual(lines, backgroundOutput(store, await store.run(job.id, project.id), 0).lines.map(({ line }) => line));

    const oldRecord = JSON.parse(new TextDecoder().decode(openStudioZip(zip).read("项目记录.json")));
    for (const task of oldRecord.tasks) {
      delete task.background;
      delete task.progress;
      delete task.background_path;
      delete task.output_truncated;
    }
    const oldZip = streamZip([{ name: "项目记录.json", open: async () => new TextEncoder().encode(JSON.stringify(oldRecord)) }]);
    const oldProject = await restoreProjectArchive(store, "local", await new Response(oldZip).arrayBuffer(), undefined, AbortSignal.timeout(3000));
    const oldRestored = (await store.snapshot(oldProject.id, "local")).runs.find((run) => run.label === probe.label);
    assert.equal(oldRestored.resultText, probe.result);
    return { background: restored.background, settled: events.at(-1).status === "done",
      orderedOutput: from >= 0 && lines.indexOf(probe.output[1], from) > from, resultRetained: events.at(-1).result.result === probe.result };
  });
  const loss = await withJob(async (store, project, job) => {
    const reopened = new Store(store.db);
    for (let index = 0; index < probe.largeOutput.length; index += 32)
      await reopened.appendBackgroundOutput(job, probe.largeOutput.slice(index, index + 32));
    const observer = backgroundOutput(reopened, job, 0);
    const ownerRunId = await send(reopened, project, "read logs");
    assert.ok(await reopened.claimRun(ownerRunId, project.id));
    const owner = await reopened.run(ownerRunId, project.id);
    let cursor = 0, text = "", reportsLoss = false;
    for (let index = 0; index < 24; index++) {
      const page = await consumeJobOutput(reopened, owner, "read-" + index, job.id);
      if (index === 0) reportsLoss = page.dropped === true && observer.dropped;
      else assert.equal(page.dropped, undefined);
      text += page.text;
      if (!page.more) break;
      assert.ok(page.cursor > cursor);
      cursor = page.cursor;
    }
    await reopened.updateRun(job, { status: "done", stage: "done", label: probe.label, resultText: probe.result });
    await reopened.releaseLease(job);
    const zip = await new Response(projectArchive(reopened, project.id, undefined)).arrayBuffer();
    const restored = await restoreProjectArchive(reopened, "local", zip, undefined, AbortSignal.timeout(3000));
    const restoredJob = (await reopened.snapshot(restored.id,"local")).runs.find((run) => run.background);
    assert.equal(backgroundOutput(reopened, restoredJob, 0).dropped, true);
    return { reportsLoss, oldestMissing: !text.includes(probe.largeOutput[0]), tailKept: text.includes(probe.largeOutput.at(-1)) };
  });
  return [await noticeTrace(false, false), await noticeTrace(true, false), loss, await noticeTrace(false, true)];
}

async function limitedWakeups() {
  const db = database();
  try {
    const store = new Store(db, { maxConsecutiveWakes: 1 });
    const project = await store.createProject("local", {}), root = await send(store, project, "begin");
    assert.ok(await store.claimRun(root, project.id));
    const owner = await store.run(root, project.id);
    const jobs = [];
    for (const name of ["first", "second", "third"]) jobs.push(await newProbeJob(store, owner, name));
    await store.releaseLease(owner);
    let calls = 0;
    const model = async () => { calls++; return reply("reported"); };
    assert.equal((await finish(store, project, root, model)).status, "done");
    const settle = async (id) => {
      assert.ok(await store.claimRun(id, project.id));
      const job = await store.run(id, project.id);
      await store.updateRun(job, { status: "done", label: "completed", resultText: "artifact-ready" });
      await store.releaseLease(job);
      const report = (await store.dueRuns()).find((run) => run.interactive);
      if (report) assert.equal((await finish(store, project, report.id, model)).status, "done");
    };
    await settle(jobs[0]);
    const first = calls;
    await settle(jobs[1]);
    const quiet = calls === first;
    assert.equal((await finish(store, project, await send(store, project, "continue"), model)).status, "done");
    await settle(jobs[2]);
    return { first, quiet, afterUser: calls };
  } finally { db.close(); }
}

async function nestedDelegation() {
  const db = database();
  try {
    const initial = new Store(db), store = new Store(db, { maxDelegationDepth: 2 });
    const project = await store.createProject("local", {}), rootId = await send(store, project, "start");
    assert.ok(await store.claimRun(rootId, project.id));
    const lead = await store.run(rootId, project.id);
    const [a, b] = await Promise.all(["draft-a", "draft-b"].map((name) =>
      store.startChild(lead, name, "writer", name, undefined, false, store.agents, name)));
    assert.ok(await store.claimRun(a.task_id, project.id));
    const child = await store.run(a.task_id, project.id);
    const grand = await store.startChild(child, "nested-child", "director", "review");
    assert.ok(await store.claimRun(grand.task_id, project.id));
    const grandchild = await store.run(grand.task_id, project.id);
    return { distinct: a.task_id !== b.task_id, blockedByDefault: !initial.canDelegate(child),
      nested: grandchild.parentRunId === a.task_id, blockedAtCap: !store.canDelegate(grandchild) };
  } finally { db.close(); }
}

async function delegationFixture(db, names = delegationParityProbe.names) {
  const store = new Store(db, { maxDelegationDepth: 2, completionDelivery: "quiet" });
  const project = await store.createProject("local", {}), root = await send(store, project, "start");
  const claim = async (id) => {
    assert.ok(await store.claimRun(id, project.id));
    return store.run(id, project.id);
  };
  const lead = await claim(root);
  const spawn = (parent, name) => store.startChild(parent, crypto.randomUUID(), "writer", name, undefined, false, store.agents, name);
  const branches = await Promise.all(names.map(async (name) => [name, await claim((await spawn(lead, name)).task_id)]));
  return { store, project, lead, claim, spawn, actors: new Map(branches) };
}

async function nestedNames() {
  const db = database(), { names, leaf } = delegationParityProbe;
  try {
    const { store, project, lead, spawn, actors } = await delegationFixture(db);
    const children = await Promise.all(names.map((name) => spawn(actors.get(name), leaf)));
    const addresses = children.map((child) => child.member_name);
    assert.deepEqual(addresses, names.map((name) => name + "/" + leaf));
    const registry = createToolRegistry({ store, run: lead, project, settings, tasks: [], ensureCurrent: async () => {} });
    const execute = (name, args) => registry.execute(registry.prepare({ id: crypto.randomUUID(), type: "function",
      function: { name, arguments: JSON.stringify(args) } }), AbortSignal.timeout(3_000));
    const { result: catalog } = await execute("list_agents", {});
    for (const address of addresses) assert.ok(catalog.agents.some(({ member_name }) => member_name === address));
    const resolves = await Promise.all(addresses.map(async (address, i) =>
      (await execute("send_message", { task_id: address, message: "choose this editor" })).result.task_id === children[i].task_id));
    const siblingDuplicate = await spawn(actors.get(names[0]), leaf).then(() => false, (error) => error.code);
    const invalidPath = await store.resolveCollaborator(lead, "missing/" + leaf).then(() => false, (error) => error.code);
    assert.ok(await store.claimRun(children[0].task_id, project.id));
    const sender = await store.run(children[0].task_id, project.id);
    await store.sendAgentMessage(sender, "reply-to-peer", addresses[1], peerMessage);
    let senderIdentified = false, parentIdentified = false;
    await finish(store, project, children[1].task_id, async (_system, messages) => {
      senderIdentified = messages.some(({ content, source }) => source?.kind === "agent-message" &&
        source.senderName === addresses[0] && content.includes(addresses[0]) && content.endsWith(peerMessage));
      parentIdentified = messages.some(({ source }) => source?.kind === "runtime-context" &&
        source.sections.some(({ name, text }) => name === "identity" && JSON.parse(text).self.parent_name === names[1]));
      return reply("settled");
    });
    return { addresses, resolves, siblingDuplicate, invalidPath, senderIdentified, parentIdentified,
      bareLeafIsNotAChild: await store.resolveCollaborator(lead, leaf) === undefined };
  } finally { db.close(); }
}

async function consecutiveInputWaits() {
  const db = database(), probe = innerFlowProbe.wait;
  try {
    const { store, project, lead, actors } = await delegationFixture(db);
    const actor = actors.get(delegationParityProbe.names[0]);
    // Release the fixture's lease before the real execution loop takes over.
    await store.releaseLease(actor);
    await advanceRun(store, project, actor.id, settings, undefined, async () => assistantTools([
      { id: "invalid", name: "wait_for_input", args: { timeout_ms: probe.invalid } },
      ...probe.calls.map((id) => ({ id, name: "wait_for_input", args: { timeout_ms: probe.timeout } })),
    ]));
    await advanceRun(store, project, actor.id, settings, undefined, unexpectedModel);
    assert.equal((await advanceRun(store, project, actor.id, settings, undefined, unexpectedModel)).status, "waiting");
    await store.sendAgentMessage(lead, "fresh-input", actor.id, probe.message);
    let result;
    const settled = await finish(store, project, actor.id, async (_system, messages) => {
      const receipt = (id) => JSON.parse(messages.find(({ tool_call_id }) => tool_call_id === id).content);
      result = { invalid: receipt("invalid").code, receipts: probe.calls.map((id) => receipt(id).timedOut),
        nextInput: messages.filter(({ content, source }) => source?.kind === "agent-message" && content.endsWith(probe.message)).length };
      return reply("settled");
    });
    assert.equal(settled.status, "done");
    return result;
  } finally { db.close(); }
}

async function isolatedToolFailure() {
  const db = database(), probe = innerFlowProbe.tool;
  try {
    const store = new Store(db), project = await store.createProject("local", {});
    const id = await send(store, project, "write the draft and try the optional media"), path = "/01_创作/draft.md";
    let step = 0, failure;
    const run = await finish(store, project, id, async (_system, messages) => {
      if (!step++) return assistantTools([
        { id: probe.unavailable, name: "generate_image", args: { file_path: "/03_图片/test.png", prompt: "unused" } },
        { id: probe.write, name: "write_file", args: { file_path: path, content: probe.text } },
      ]);
      failure = JSON.parse(messages.find(({ tool_call_id }) => tool_call_id === probe.unavailable).content).code;
      return reply("draft ready");
    });
    return { failure, written: (await store.artifacts(project.id)).find((file) => file.path === path)?.content ?? "", replied: run.resultText === "draft ready" };
  } finally { db.close(); }
}

async function interruptDescendant() {
  const db = database(), probe = innerFlowProbe.control;
  try {
    const { store, project, lead, actors, spawn, claim } = await delegationFixture(db, [probe.a, probe.b]);
    const a = actors.get(probe.a), b = actors.get(probe.b);
    const leaf = await claim((await spawn(a, probe.leaf)).task_id);
    const control = async (run, task_id) => {
      const registry = createToolRegistry({ store, run, project, settings, tasks: await store.agentTasks(run), ensureCurrent: async () => {} });
      return registry.execute(registry.prepare({ id: crypto.randomUUID(), type: "function",
        function: { name: "control_task", arguments: JSON.stringify({ task_id, action: "cancel" }) } }), AbortSignal.timeout(3_000));
    };
    const siblingDenied = await control(b, probe.a + "/" + probe.leaf).then(() => false, (error) => error.code === "TASK_NOT_REACHABLE");
    const { result } = await control(lead, probe.a);
    const deeperKeptRunning = (await store.run(leaf.id, project.id)).status === "running";
    await store.releaseLease(a);
    const sent = await store.sendAgentMessage(lead, "continue-child", probe.a, probe.resume);
    assert.equal(sent.task_id, a.id);
    assert.equal((await store.run(a.id, project.id)).generation, a.generation + 1);
    const done = await finish(store, project, a.id, async (_system, messages) => {
      assert.ok(messages.some(({ content }) => content?.includes(probe.resume)));
      return reply(probe.done);
    });
    return { siblingDenied, stopped: result.status === "cancelled", deeperKeptRunning, sameChild: done.id === a.id && done.resultText === probe.done };
  } finally { db.close(); }
}

async function childReasoning() {
  const { route, parentEffort, explicitEffort, configuredEffort } = delegationParityProbe;
  const parent = { ...settings, textBaseUrl: "https://api.deepseek.com/anthropic", textThinking: true, textReasoningEffort: parentEffort };
  const config = { textRoute: { ...route, reasoning_effort: configuredEffort } };
  const resolved = [];
  const run = async (request, definition?) => {
    const execution = childExecution(request, parent, definition);
    await preflightChildModel(execution, parent, AbortSignal.timeout(3_000), async (selected) => {
      resolved.push(selected.textThinking ? selected.textReasoningEffort ?? null : "off");
      return { id: selected.textModel, inputModalities: ["text"], thinking: [false, true], efforts: [parentEffort, explicitEffort] };
    });
  };
  await assert.rejects(run({ reasoning_effort: explicitEffort }), { code: "INVALID_ARGS" });
  await run({});
  await run(route);
  await run({ ...route, reasoning_effort: explicitEffort });
  await run({}, config);
  await run(route, config);
  await run({ ...route, reasoning_effort: "off" });
  return { effortOnlyRejected: true, resolved };
}

async function jobOwners() {
  const db = database(), { log, limit } = delegationParityProbe;
  try {
    const { store, project, lead, claim, actors } = await delegationFixture(db);
    const start = (owner, label) => newProbeJob(store, actors.get(owner), owner + "-" + label);
    let stopping;
    const stop = async (id) => {
      stopping = await claim(id);
      await store.controlTree(stopping, "cancel");
    };
    const id = await start("a", "owned"), job = await claim(id);
    await store.appendBackgroundOutput(job, [log], "lines");
    const read = async (run, wait = false) => {
      const registry = createToolRegistry({ store, run, project, settings, tasks: await store.agentTasks(run), ensureCurrent: async () => {} });
      return registry.execute(registry.prepare({ id: crypto.randomUUID(), type: "function", function: { name: "job_output",
        arguments: JSON.stringify({ job_id: id, wait, timeout_ms: 10 }) } }), AbortSignal.timeout(3_000));
    };
    const trace = { owner: (await read(actors.get("a"))).result.text.includes(log),
      lead: await read(lead).then(() => false, (error) => error.code),
      peerWait: await read(actors.get("b"), true).then(() => false, (error) => error.code) };
    assert.ok(!(await store.agentTasks(lead)).some(({ id: taskId }) => id === taskId));
    await store.updateRun(job, { status: "done", resultText: "ready" });
    return { trace, capacity: await probeJobCapacity(start, stop, async () => store.releaseLease(stopping), limit) };
  } finally { db.close(); }
}

async function providerFinish(empty) {
  const db = database(), restoreFetch = globalThis.fetch;
  const bodies = [];
  let requests = 0;
  try {
    const store = new Store(db, { tools: [{ schema: tool("probe", "test arguments", { value: { type: "integer" } }), label: "Test tool",
      async execute(_context, _id, args) { bodies.push(args.value); return { result: { ok: true } }; } }] });
    const project = await store.createProject("local", {}), id = await send(store, project, "start");
    globalThis.fetch = async () => {
      const content = empty ? "" : "received receipts";
      const toolCalls = !empty && requests === 0 ? mixedArguments.map(({ id, arguments: args }) => ({
        id, type: "function", function: { name: "probe", arguments: args },
      })) : undefined;
      requests++;
      return Response.json({ choices: [{ finish_reason: toolCalls ? "tool_calls" : "stop",
        message: { content: toolCalls ? null : content, tool_calls: toolCalls } }] });
    };
    assert.equal((await finish(store, project, id)).status, "done");
    if (empty) assert.equal((await store.messages(project.id)).find(({ role }) => role === "assistant").content, "");
    const receipts = db.prepare("SELECT call_id,result FROM execution_steps WHERE run_id=? ORDER BY seq").bind(id).rows()
      .map(({ call_id, result }) => [call_id, JSON.parse(result).code ?? "ok"]);
    const end = db.prepare("SELECT json_extract(data,'$.reason.kind') AS kind FROM events WHERE type='turn/end' AND json_extract(data,'$.runId')=?")
      .bind(id).rows()[0].kind;
    return { requests, bodies, receipts, end };
  } finally { globalThis.fetch = restoreFetch; db.close(); }
}

async function lateChildResult() {
  const root = await mkdtemp(join(tmpdir(), "doman-late-child-"));
  const file = join(root, "studio.sqlite");
  let db = database(file);
  try {
    let store = new Store(db), requests = 0, notices = 0;
    const project = await store.createProject("local", {}), parentId = await send(store, project, "parent request");
    const parentModel = async (_system, messages) => {
      notices += messages.filter((message) => message.source?.kind === "task-result").length;
      if (++requests !== 1) return reply("parent reply " + requests);
      return { role: "assistant", content: null, tool_calls: [{ id: "delegate", type: "function",
        function: { name: "delegate", arguments: JSON.stringify({ role: "writer", instruction: childPrompt }) } }] };
    };
    assert.equal((await finish(store, project, parentId, parentModel)).status, "done");
    const [child] = await store.children(await store.run(parentId, project.id));
    assert.equal(child.status, "queued");
    const turns = () => db.prepare("SELECT COUNT(*) AS count FROM events e JOIN runs r ON r.id=json_extract(e.data,'$.runId') WHERE e.type='turn/end' AND r.project_id=? AND r.parent_run_id IS NULL")
      .bind(project.id).rows()[0].count;
    const before = turns();
    assert.equal((await finish(store, project, child.id, async () => reply(childTool))).status, "done");
    db.close();
    db = database(file);
    store = new Store(db);
    const scans = await Promise.all([store.dueRuns(), new Store(db).dueRuns()]);
    const recipients = scans.map((jobs) => jobs.filter(({ interactive }) => interactive).map(({ id }) => id));
    assert.equal(recipients[0].length, 1);
    assert.deepEqual(recipients[0], recipients[1]);
    assert.notEqual(recipients[0][0], parentId);
    assert.equal((await finish(store, project, recipients[0][0], parentModel)).status, "done");
    assert.equal((await store.dueRuns()).length, 0);
    assert.equal((await store.messages(project.id)).filter(({ role }) => role === "user").length, 1);
    assert.equal((await store.messages(project.id)).filter(({ role }) => role === "assistant").length, 2);
    return { before, after: turns(), requests, notices };
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

export async function studioRecoveryScenarios() {
  const result = {};
  for (const { name, enabled } of authorizationCases) result[name] = await authorization(enabled);
  result["a later call sees mid-batch capability revocation"] = await liveRevocation();
  for (const scenario of overflowCases) result[scenario.name] = await overflow(scenario);
  for (const scenario of compactRouteCases) result[scenario.name] = await routedCompaction(scenario);
  result["peer messages preserve active child streaming"] = await peerDelivery(false);
  result["peer messages wait for the admitted tool batch"] = await peerDelivery(true);
  result["quiet job notices survive reopening and are consumed once"] = await background();
  result["malformed arguments only fail their own tool call"] = await providerFinish(false);
  result["a clean empty model finish closes without retry"] = await providerFinish(true);
  result["a late child result opens one follow-up turn"] = await lateChildResult();
  result["stopping clears both input queues"] = await stopQueue();
  result["a default background result wakes an idle conversation once"] = await wakeupJob();
  result["job output reads incremental text, waits explicitly and returns the final result once"] = await jobDeltas();
  const jobHistory = await backgroundHistoryTraces();
  backgroundHistoryProbe.cases.forEach((name, index) => { result[name] = jobHistory[index]; });
  result["consecutive job wakeups stop at the cap and reset on user input"] = await limitedWakeups();
  result["team mode and task transitions match the reference"] = await teamBoard();
  result["parallel delegation keeps distinct children and honors the nesting cap"] = await nestedDelegation();
  result["named child addresses reject duplicate sibling names"] = await namedChild();
  const delegation = delegationParityProbe.cases, jobs = await jobOwners();
  result[delegation.reasoning] = await childReasoning();
  result[delegation.names] = await nestedNames();
  result[delegation.output] = jobs.trace;
  result[delegation.capacity] = jobs.capacity;
  result[innerFlowProbe.wait.case] = await consecutiveInputWaits();
  result[innerFlowProbe.tool.case] = await isolatedToolFailure();
  result[innerFlowProbe.control.case] = await interruptDescendant();
  const crossTurn = await crossTurnCollaboration();
  for (const [key, name] of Object.entries(crossTurnProbe.cases)) result[name] = crossTurn[key];
  for (const scenario of childNoticeProbe.cases) result[scenario.name] = await childCompletionNotice(scenario);
  for (const scenario of largeToolBatches) result[scenario.name] = await largeTools(scenario);
  for (const scenario of childExecutionCases) result[scenario.name] = await configuredChild(scenario);
  result["Messages transports decode identical streaming calls"] = await wireMessages();
  const native = await nativeHistory();
  result["Messages retains the original prompt and appends one prompt update"] = native.map(({ stable, inHistory }) => ({ stable, updated: inHistory.filter(({ kind }) => kind === "text") }));
  result["Messages activates an added tool and rebases declarations on removal"] = native.map(({ tools, inHistory }) => ({ tools, updated: inHistory.filter(({ kind }) => kind !== "text") }));
  result["Messages replays ordered thinking, signature and tool results"] = await nativeHistory(true);
  result["provider Files uploads are reused for identical image bytes"] = await filesReuse();
  result["cross-session text is frozen when first quoted"] = await referenceSnapshot();
  for (const scenario of longReferenceCases) result[scenario.name] = await longReference(scenario);
  result["session metrics fold the same closed steps and output usage"] = await sessionMetrics();
  result["unchanged headers and earlier messages are reused across model requests"] = await requestRecords();
  return result;
}

async function requestRecords() {
  const root = await mkdtemp(join(tmpdir(), "doman-request-records-")), file = join(root, "records.sqlite");
  let db = database(file);
  try {
    let store = new Store(db);
    const project = await store.createProject("local", {}), sent = [];
    const model = async (system, messages, tools) => { sent.push({ system, messages, tools }); return reply(requestReplay.answer); };
    await finish(store, project, await send(store, project, requestReplay.first), model);
    db.close(); db = database(file); store = new Store(db);
    await finish(store, project, await send(store, project, requestReplay.second), model);
    const history = (await store.modelCalls(project.id)).map(({ request }, index) => {
      const { messages, system, tools } = JSON.parse(String(request));
      const expected = JSON.parse(JSON.stringify(sent[index]));
      assert.deepEqual({ messages, system, tools }, expected);
      return messages.map(({ content }) => content).filter((value) => Object.values(requestReplay).includes(value));
    });
    const [{ headers }] = db.prepare("SELECT COUNT(DISTINCT request_header_id) AS headers FROM model_calls").rows();
    const originals = db.prepare("SELECT id FROM model_request_parts WHERE json_extract(content,'$.content')=?").bind(requestReplay.first).rows();
    assert.equal(originals.length, 1);
    return { history, headers };
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

async function routedCompaction(scenario) {
  const routes = compactRoutes(scenario), trace = [], restore = globalThis.fetch;
  const root = await mkdtemp(join(tmpdir(), "doman-route-compaction-")), location = join(root, "studio.sqlite");
  let db = database(location);
  try {
    const config = { modelPolicies: Object.values(routes) };
    const open = () => new Store(db, { compaction: config, tools: [] });
    let store = open(), seeded = false, response = "";
    const project = await store.createProject("local", {});
    globalThis.fetch = async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/models") return Response.json(nativeCapabilitiesFixture());
      const body = JSON.parse(init.body), route = pathname.startsWith("/anthropic/") ? "tight" : "wide";
      const text = body.messages.flatMap(({ content }) => typeof content === "string" ? [content] : content?.flatMap(({ text }) => text ? [text] : []) ?? []).join("\n");
      const summary = text.includes("总结此前工作");
      if (!seeded) assert.equal(summary, false, "history pressure must wait for the intended step");
      else trace.push({ summary, route, maxTokens: body.max_tokens, markers: compactMarkerTrace(text) });
      if (summary && scenario.state === "rejected") return Response.json({ error: { message: "fixture summary unavailable" } }, { status: 401 });
      const answer = !seeded ? response : summary ? compactMemo : "Completed";
      return route === "tight" ? nativeReply(answer, false) : Response.json({ choices: [{ finish_reason: "stop", message: reply(answer) }] });
    };
    const finish = async (text, route) => {
      const id = await send(store, project, text);
      const routed = { ...settings, textApiKey: "compaction-fixture", textBaseUrl: routes[route].baseUrl };
      for (let step = 0; step < 12; step++) {
        const run = await advanceRun(store, project, id, routed);
        if (["done", "failed"].includes(run.status)) return run;
      }
      assert.fail("Compaction route did not settle");
    };
    for (const [text, answer] of compactHistory) { response = answer; assert.equal((await finish(text, scenario.start)).status, "done"); }
    db.close(); db = database(location); store = open(); seeded = true;
    const final = await finish(compactLatest, scenario.final);
    const { thresholdTokens, retainTokens } = store.compaction.forRoute(routes[scenario.final], compactOutputTokens);
    if (scenario.state === "rejected") assert.equal(final.payload.agent.contextRoute.baseUrl, routes[scenario.start].baseUrl);
    return { thresholdTokens, retainTokens, trace, code: final.errorCode ?? (final.status === "done" ? "completed" : final.status),
      summaries: store.sessionEntries(final.id, project.id).filter(({ kind }) => kind === "context/compacted").length,
      oldRetained: final.payload.agent.messages.some(({ content }) => content?.includes("[OLD-ANSWER]")) };
  } finally { globalThis.fetch = restore; db.close(); await rm(root, { recursive: true, force: true }); }
}

async function stopQueue() {
  const db = database();
  const release = Promise.withResolvers();
  try {
    const store = new Store(db), project = await store.createProject("local", {}), id = await send(store, project, "start");
    const active = advanceRun(store, project, id, settings, undefined, async (_system, _messages, _tools, { signal }) => {
      release.resolve();
      signal.throwIfAborted();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      signal.throwIfAborted();
    });
    await release.promise;
    await store.acceptChatAtStep(project.id, { requestId: crypto.randomUUID(), text: "supplement", attachmentIds: [] });
    await store.enqueueChat(project.id, { requestId: crypto.randomUUID(), text: "next turn", attachmentIds: [] });
    const count = () => db.prepare("SELECT count(*) AS count FROM chat_queue WHERE project_id=? AND status='pending'").bind(project.id).rows()[0].count;
    const before = count();
    await store.controlTree(await store.run(id, project.id), "cancel");
    await active;
    const turns = db.prepare("SELECT count(*) AS count FROM events WHERE project_id=? AND type='turn/end'").bind(project.id).rows()[0].count;
    return { before, pending: count(), turns };
  } finally { db.close(); }
}

async function wakeupJob() {
  const db = database();
  try {
    const store = new Store(db), project = await store.createProject("local", {}), ownerId = await send(store, project, "initial");
    const modelRequests = [];
    const model = async (system, messages) => { modelRequests.push({ system, messages }); return reply("finished"); };
    assert.ok(await store.claimRun(ownerId, project.id));
    const owner = await store.run(ownerId, project.id);
    const { task_id: id } = await store.startChild(owner, "job", "media", "job fixture", { stage: "composing", background: true,
      payload: { instruction: "job fixture", sourceVersions: {}, operation: { name: "compose_video", path: "/07_成片/test.mp4" } } });
    await store.releaseLease(owner);
    await finish(store, project, ownerId, model);
    assert.ok(await store.claimRun(id, project.id));
    const job = await store.run(id, project.id);
    await store.finishComposition(job, "fake-final", 0);
    await store.releaseLease(job);
    const [followup] = await store.dueRuns();
    assert.ok(followup?.interactive);
    await finish(store, project, followup.id, model);
    assert.equal((await store.dueRuns()).length, 0);
    assert.doesNotMatch(modelRequests[0].system, /本轮由后台任务结果触发/);
    assert.match(modelRequests[1].system, /本轮由后台任务结果触发.*等待用户下一条消息/);
    return { requests: modelRequests.length, notices: modelRequests.flatMap(({ messages }) => messages).filter((message) => message.source?.kind === "task-result").length };
  } finally { db.close(); }
}

async function teamBoard() {
  const db = database();
  try {
    const store = new Store(db), project = await store.createProject("local", {}), id = await send(store, project, "start");
    assert.ok(await store.claimRun(id, project.id));
    const run = await store.run(id, project.id);
    const registry = () => createToolRegistry({ store, project, run, settings, tasks: [], ensureCurrent: async () => {} });
    const initial = registry().schemas().some(({ function: schema }) => schema.name === "team_task_create");
    await store.setTeamEnabled(project.id, "", true);
    const initialRegistry = registry();
    const execute = async (name, args) => (await initialRegistry.execute(initialRegistry.prepare({ id: crypto.randomUUID(), type: "function",
      function: { name, arguments: JSON.stringify(args) } }), AbortSignal.timeout(1000))).result;
    let task = await execute("team_task_create", { subject: "draft", description: "draft scene" });
    const statuses = [[task.status, task.ready, task.revision]];
    for (const action of ["claim", "release", "claim", "complete", "reopen", "delete"]) {
      task = await execute("team_task_update", { task_id: task.id, expected_revision: task.revision, action });
      statuses.push([task.status, task.ready, task.revision]);
    }
    const listed = (await execute("team_task_list", {})).tasks.length;
    await store.setTeamEnabled(project.id, "", false);
    await assert.rejects(execute("team_task_list", {}), { code: "UNKNOWN_TOOL" });
    return { initial, statuses, listed, disabled: !registry().schemas().some(({ function: schema }) => schema.name === "team_task_create") };
  } finally { db.close(); }
}

async function crossTurnCollaboration() {
  const db = database(), store = new Store(db), probe = crossTurnProbe;
  const startedSecond = Promise.withResolvers(), releaseSecond = Promise.withResolvers();
  let liveSecond;
  try {
    const project = await store.createProject("local", {}), first = await send(store, project, probe.first);
    const registry = (run) => createToolRegistry({ store, project, run, settings, tasks: [], ensureCurrent: async () => {} });
    const execute = (run, name, args) => {
      const tools = registry(run);
      return tools.execute(tools.prepare({ id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }), AbortSignal.timeout(5000));
    };
    await store.setTeamEnabled(project.id, "", true);
    assert.ok(await store.claimRun(first, project.id));
    const firstRun = await store.run(first, project.id);
    const { result: task } = await execute(firstRun, "team_task_create", probe.task);
    const claimed = await execute(firstRun, "team_task_update", { task_id: task.id, expected_revision: task.revision, action: "claim" });
    assert.equal(claimed.result.owner, "lead");
    const spec = { role: "writer", instruction: probe.child, name: probe.name };
    const { result: child } = await execute(firstRun, "delegate", spec);
    await store.releaseLease(firstRun);
    assert.equal((await finish(store, project, first, async () => reply("Finished this step"))).status, "done");

    const second = await send(store, project, probe.second);
    liveSecond = advanceRun(store, project, second, settings, undefined, async () => {
      startedSecond.resolve();
      await releaseSecond.promise;
      return reply("Finished this step");
    });
    await startedSecond.promise;
    const secondRun = await store.run(second, project.id);
    const { result: catalog } = await execute(secondRun, "list_agents", {});
    assert.equal(catalog.self, "lead");
    assert.equal(catalog.current_run_id, second);
    const original = catalog.agents.find(({ member_name }) => member_name === probe.name)?.task_id === child.task_id;
    let duplicate;
    try { await execute(secondRun, "delegate", spec); } catch (error) { duplicate = error.code; }
    const { result: owned } = await execute(secondRun, "team_task_list", { owner: "lead" });
    assert.ok(await store.claimRun(child.task_id, project.id));
    const writer = await store.run(child.task_id, project.id);
    const { result: sent } = await execute(writer, "send_message", { task_id: "lead", message: probe.finding });
    assert.equal(sent.task_id, second);
    assert.equal(sent.agent_id, "lead");
    await store.releaseLease(writer);
    releaseSecond.resolve();
    await liveSecond;
    let delivered = 0;
    const done = await finish(store, project, second, async (_system, messages) => {
      delivered = messages.filter(({ source, content }) => source?.kind === "agent-message" && content?.includes(probe.finding)).length;
      return reply("Finished this step");
    });
    const old = await store.run(first, project.id);
    assert.equal(old.status, "done");
    assert.equal(old.generation, firstRun.generation);
    assert.equal(done.status, "done");
    return { message: delivered === 1, names: { original, duplicate }, owner: owned.tasks.length };
  } finally { releaseSecond.resolve(); await liveSecond; db.close(); }
}

const assistantTools = (calls) => ({ ...reply(null), tool_calls: calls.map(({ id, name, args }) => ({
  id, type: "function", function: { name, arguments: JSON.stringify(args) },
})) });

async function childCompletionNotice(scenario) {
  const root = await mkdtemp(join(tmpdir(), "doman-child-notice-")), file = join(root, "studio.sqlite"), probe = childNoticeProbe;
  let db = database(file), store = new Store(db);
  try {
    const project = await store.createProject("local", {}), id = await send(store, project, "Review the opening");
    assert.ok(await store.claimRun(id, project.id));
    const parent = await store.run(id, project.id);
    const execution = scenario.next === "structured"
      ? { route: { baseUrl: settings.textBaseUrl, model: settings.textModel, thinking: false }, outputSchema: probe.schema } : undefined;
    const { task_id: child } = await store.startChild(parent, "delegate", "writer", probe.prompt, undefined, false, undefined, undefined, execution);
    await store.releaseLease(parent);
    const report = { id: "report", name: "send_message", args: { task_id: "lead", message: probe.finding } };
    const initial = scenario.next === "tool" ? [report, { id: "later", name: "list_files", args: {} }] : [report];
    await advanceRun(store, project, child, settings, undefined, async () => assistantTools(initial));
    await advanceRun(store, project, child, settings, undefined, unexpectedModel);
    if (scenario.next === "tool") await advanceRun(store, project, child, settings, undefined, unexpectedModel);

    db.close(); db = database(file); store = new Store(db);
    if (scenario.next === "input") {
      assert.ok(await store.claimRun(id, project.id));
      const sender = await store.run(id, project.id);
      await store.sendAgentMessage(sender, "new-input", child, probe.revision);
      await store.releaseLease(sender);
    }
    let steps = 0;
    const completed = await finish(store, project, child, async (_system, messages) => {
      assert.equal(++steps, 1);
      if (scenario.next === "structured") return assistantTools([{ id: "submit", name: "structured_output", args: probe.structured }]);
      const revised = messages.some(({ content }) => content?.includes(probe.revision));
      assert.equal(revised, scenario.next === "input");
      return reply(revised ? probe.finalRevision : probe.finding);
    });
    assert.equal(completed.status, "done");
    if (scenario.next === "none") assert.equal(taskResult(completed).result, probe.finding);
    if (scenario.next === "structured") {
      const projected = taskNotice({ ...completed, resultText: probe.finding }, true);
      assert.deepEqual(projected.structured, probe.structured);
      assert.equal(projected.result, "");
    }

    let trace;
    await finish(store, project, id, async (_system, messages) => {
      const item = messages.find(({ source }) => source?.kind === "task-result");
      assert.ok(item);
      const notice = JSON.parse(item.content.slice(item.content.indexOf("{")));
      trace = { reported: messages.filter(({ source, content }) => source?.kind === "agent-message" && content?.includes(probe.finding)).length,
        closing: notice.result, omitted: notice.closing_text_omitted === true, structured: notice.structured ?? null };
      return reply("Received");
    });
    return trace;
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

async function largeTools(scenario) {
  const db = database(), calls = largeBatchCalls(scenario.size), invoked = [];
  const restoreFetch = globalThis.fetch;
  try {
    const store = new Store(db, { maxParallelTools: 3, tools: ["probe_read", "probe_write"].map((name) => ({
      schema: tool(name, "record a fixture operation", { value: { type: "number" } }, ["value"]), label: name,
      mode: name === "probe_read" ? "parallel" : undefined, async execute(_ctx, _id, { value }) {
        if (value === 12) assert.deepEqual([...invoked].sort((a, b) => a - b), calls.slice(0, value).map(({ args }) => args.value));
        invoked.push(value);
        return { result: { value } };
      },
    })) });
    const project = await store.createProject("local", {}), id = await send(store, project, "Run the whole batch");
    const native = scenario.transport === "messages", first = assistantTools(calls);
    const route = native ? { ...settings, textBaseUrl: "https://api.deepseek.com/anthropic" } : settings;
    let requests = 0, received;
    globalThis.fetch = async (url, init) => {
      const endpoint = new URL(String(url)).pathname;
      if (endpoint.endsWith("/models")) return Response.json(nativeCapabilitiesFixture());
      const body = JSON.parse(init.body);
      assert.equal(endpoint, native ? "/anthropic/v1/messages" : "/v1/chat/completions");
      if (requests++ === 0) {
        if (native) return nativeToolCalls(calls);
        if (scenario.transport === "chat-json") return Response.json({ choices: [{ finish_reason: "tool_calls", message: first }] });
        const frames = [
          { choices: [{ delta: { tool_calls: first.tool_calls.map((item, index) => ({ ...item, index, function: { ...item.function, arguments: "" } })) } }] },
          { choices: [{ delta: { tool_calls: first.tool_calls.map(({ function: { arguments: args } }, index) => ({ index, function: { arguments: args } })) }, finish_reason: "tool_calls" }] },
        ];
        return new Response(frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } });
      }
      received = native ? body.messages.flatMap(({ content }) => content).filter(({ type }) => type === "tool_result")
        .map(({ tool_use_id, content }) => [tool_use_id, JSON.parse(typeof content === "string" ? content : content[0].text).value]) :
        body.messages.filter(({ role }) => role === "tool").map(({ tool_call_id, content }) => [tool_call_id, JSON.parse(content).value]);
      if (native) return nativeReply("Finished the batch");
      return Response.json({ choices: [{ finish_reason: "stop", message: reply("Finished the batch") }] });
    };
    let settled;
    for (let step = 0; step < 12; step++) {
      settled = await advanceRun(store, project, id, route);
      if (["done", "failed"].includes(settled.status)) break;
    }
    assert.equal(settled?.status, "done", settled?.error ?? "");
    assert.equal(requests, 2);
    assert.deepEqual(db.prepare("SELECT call_id,status FROM execution_steps WHERE run_id=? ORDER BY call_index").bind(id).rows()
      .map(({ call_id, status }) => [call_id, status]), calls.map(({ id }) => [id, "done"]));
    return { invoked: invoked.sort((a, b) => a - b), received };
  } finally { globalThis.fetch = restoreFetch; db.close(); }
}

async function configuredChild(scenario) {
  const probe = childExecutionProbe;
  const root = await mkdtemp(join(tmpdir(), "doman-child-config-")), dbPath = join(root, "state.sqlite");
  const restoreFetch = globalThis.fetch, secret = "isolated-fixture-encryption-secret";
  let db = database(dbPath);
  const trace = { model: "", scoped: false, read: false, requests: 0 };
  const reopen = () => { db.close(); db = database(dbPath); return new Store(db); };
  try {
    let store = new Store(db);
    const project = await store.createProject("local", {}), id = await send(store, project, "delegate");
    await store.saveSettings("local", settings, secret);
    const before = await store.getSettings("local", secret);
    await store.putArtifact(project.id, { path: "/" + probe.folder + "/" + probe.file, kind: "document", content: probe.content });
    await store.putArtifact(project.id, { path: "/01_创作/" + probe.file, kind: "document", content: "wrong directory" });
    const other = await store.createProject("local", {});
    await store.putArtifact(other.id, { path: "/" + probe.folder + "/" + probe.file, kind: "document", content: "wrong project" });
    const delegated = { role: probe.role, instruction: childPrompt, provider: probe.provider, model: probe.model, cwd: "/" + probe.folder,
      ...(scenario.output !== "text" ? { output_schema: probe.schema } : {}) };
    await advanceRun(store, project, id, before, undefined, async (_system, _messages, tools) => {
      assert.ok(tools.some(({ function: { name } }) => name === "delegate"));
      return { ...reply(null), tool_calls: [{ id: "configured-delegate", type: "function", function: { name: "delegate", arguments: JSON.stringify(delegated) } }] };
    });
    await advanceRun(store, project, id, before, undefined, unexpectedModel);
    const parent = await store.run(id, project.id), [child] = await store.children(parent);
    assert.ok(child, JSON.stringify({ status: parent.status, error: parent.error,
      receipt: await store.toolHistoryResult(id, "configured-delegate") }));
    assert.equal(parent.payload.childExecution, undefined);
    assert.equal(parent.payload.agent?.contextRoute?.baseUrl, before.textBaseUrl);
    store = reopen();
    globalThis.fetch = async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/models")) return Response.json(nativeCapabilitiesFixture());
      assert.equal(pathname, "/anthropic/v1/messages");
      const body = JSON.parse(init.body);
      trace.model = body.model;
      trace.scoped = body.tools.some(({ name }) => name === "structured_output");
      const step = trace.requests++;
      if (step === 0) return nativeToolCalls([{ id: "read-notes", name: "read_file", args: { file_path: probe.file } }]);
      if (step === 1) {
        const receipt = JSON.stringify(body.messages.at(-1));
        trace.read = receipt.includes(probe.content) && !receipt.includes("wrong");
        if (scenario.output !== "structured") return nativeReply(probe.plain);
        return nativeToolCalls([{ id: "invalid", name: "structured_output", args: probe.invalid }]);
      }
      assert.equal(step, 2);
      assert.match(JSON.stringify(body.messages.at(-1)), /INVALID_ARGS/);
      return nativeToolCalls([{ id: "valid", name: "structured_output", args: probe.output },
        { id: "late", name: "write_file", args: { file_path: "late.md", content: "should not execute" } }]);
    };
    if (scenario.output === "structured") {
      const commit = store.commitReadReceipt.bind(store);
      store.commitReadReceipt = async (run, callId, ...args) => {
        if (callId === "valid") throw new AppError("fixture interrupted after durable result", 409, "RUN_STOPPED");
        return commit(run, callId, ...args);
      };
    }
    let finished;
    for (let attempt = 0; attempt < 14; attempt++) {
      finished = await advanceRun(store, project, child.id, before);
      if (scenario.output === "structured" && (await store.toolReceipt(child.id, "valid")) && !finished.payload.agent?.structuredResult) {
        const dead = spawnSync(process.execPath, ["-e", ""]);
        assert.equal(dead.status, 0);
        await db.prepare("UPDATE runs SET lease_owner=?,lease_until=? WHERE id=?")
          .bind(dead.pid, Date.now() + 60000, child.id).run();
        store = reopen();
        db.releaseAbandonedLeases({ interruptAgentTurns: true });
        await store.recoverStoppedExecutions();
        await store.resumeInterruptedAgentRuns();
        const recovered = await store.run(child.id, project.id);
        assert.equal(recovered.status, "queued");
        assert.equal(recovered.generation, finished.generation + 1);
        assert.equal((await store.toolReceipt(child.id, "valid")).concludesTurn, true);
      }
      if (["done", "failed"].includes(finished.status)) break;
    }
    assert.ok(["done", "failed"].includes(finished.status), JSON.stringify({ status: finished.status, error: finished.error, trace }));
    if (scenario.output !== "structured") assert.equal(finished.resultText, probe.plain);
    if (scenario.output === "missing") assert.equal(finished.errorCode, "STRUCTURED_OUTPUT_MISSING");
    if (scenario.output === "structured") {
      assert.equal((await store.toolHistoryResult(child.id, "late")).code, "TOOL_NOT_STARTED");
      const [request] = db.prepare("SELECT COUNT(*) AS count FROM tool_receipts WHERE run_id=? AND call_id='valid'").bind(child.id).rows();
      assert.equal(request.count, 1);
      assert.ok(await store.claimRun(parent.id, project.id));
      const caller = await store.run(parent.id, project.id);
      await assert.rejects(store.sendAgentMessage(caller, "late-input", child.id, "再改一版"), { code: "INPUT_CLOSED" });
      const registry = createToolRegistry({ store, project, run: caller, settings: before, tasks: await store.agentTasks(caller),
        ensureCurrent: async () => {} });
      const receipt = await registry.get("wait_for_tasks").execute({ tasks: await store.agentTasks(caller) }, "fetch-child", { task_ids: [child.id] });
      assert.deepEqual(receipt.result.tasks[0].structured, probe.output);
    }
    const result = taskResult(finished);
    assert.deepEqual(await store.getSettings("local", secret), before);
    const ignored = Number((await store.artifacts(project.id)).some(({ path }) => path.endsWith("/late.md")));
    return { ...trace, ignored, parentUnchanged: true, success: finished.status === "done", structured: result.structured ?? null };
  } finally { globalThis.fetch = restoreFetch; db.close(); await rm(root, { recursive: true, force: true }); }
}

async function namedChild() {
  const db = database();
  try {
    const store = new Store(db), project = await store.createProject("local", {}), id = await send(store, project, "start");
    assert.ok(await store.claimRun(id, project.id));
    const run = await store.run(id, project.id);
    const child = await store.startChild(run, "first", "writer", childPrompt, undefined, false, undefined, "reviewer");
    let duplicate;
    try { await store.startChild(run, "second", "writer", childPrompt, undefined, false, undefined, "reviewer"); }
    catch (error) { duplicate = error.code; }
    const delivery = await store.sendAgentMessage(run, "send", "reviewer", "a named message");
    return { name: child.member_name, duplicate, resolves: delivery.task_id === child.task_id };
  } finally { db.close(); }
}

async function wireMessages() {
  const restore = globalThis.fetch;
  let endpoint, receiptOrder;
  try {
    globalThis.fetch = async (url, init) => {
      endpoint = new URL(String(url)).pathname;
      assert.equal(JSON.parse(init.body).tools[0].input_schema.type, "object");
      receiptOrder = JSON.parse(init.body).messages.at(-1).content.map(({ type }) => type);
      return messagesResponse();
    };
    const model = createAgentModel({ ...settings, textBaseUrl: "https://api.deepseek.com/anthropic" });
    const history = messagesHistory;
    const result = await model("system", [
      { role: "user", content: history.user }, toolCall(history.callId, history.tool), { role: "user", content: history.update },
      { role: "tool", tool_call_id: history.callId, content: history.result },
    ], [tool("probe", "test", {})]);
    const [call] = result.tool_calls;
    return { endpoint, receiptOrder, text: result.content, call: [call.id, call.function.name, JSON.parse(call.function.arguments)], finish: "tool-calls" };
  } finally { globalThis.fetch = restore; }
}

async function nativeHistory(thinking = false) {
  const root = await mkdtemp(join(tmpdir(), "doman-messages-history-")), location = join(root, "studio.sqlite");
  const requests = [], restore = globalThis.fetch, active = new Set(["native_a"]);
  const settings = { ...DEFAULT_SETTINGS, textBaseUrl: "https://api.deepseek.com/anthropic", textApiKey: "fixture-native-" + thinking, textThinking: thinking };
  let db = database(location), invoked = 0, catalogReads = 0;
  try {
    const registrations = ["native_a", "native_b"].map((name) => ({ schema: tool(name, "Native probe", {}), label: "Probe", available: () => active.has(name),
      async execute() { invoked++; return { result: { text: "Tool done" } }; } }));
    const open = () => new Store(db, { tools: registrations });
    let store = open();
    const project = await store.createProject("local", {});
    globalThis.fetch = async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/models") { catalogReads++; assert.equal(init.method, "GET"); return Response.json(nativeCapabilitiesFixture()); }
      assert.equal(pathname, "/anthropic/v1/messages");
      requests.push(JSON.parse(init.body));
      if (!thinking && requests.length === 2) return nativeAddedTool();
      return thinking && requests.length === 1 ? nativeThinking() : nativeReply();
    };
    const finish = async (id) => {
      for (let index = 0; index < 15; index++) {
        const run = await advanceRun(store, project, id, settings);
        if (run.status === "done") return run;
        if (run.status === "failed") assert.fail(run.error);
      }
      assert.fail("Native Messages agent did not settle");
    };
    if (thinking) {
      const id = await send(store, project, nativeScenarios[0]);
      assert.equal((await advanceRun(store, project, id, settings)).status, "queued");
      db.close(); db = database(location); store = open();
      await finish(id);
      assert.equal(invoked, 1);
      assert.equal(requests.length, 2);
      assert.equal(catalogReads, 1);
      const replies = db.prepare("SELECT visible_text FROM model_calls WHERE run_id=? ORDER BY rowid").bind(id).rows().map(({ visible_text }) => visible_text);
      assert.deepEqual(replies, ["先读再改", "Done"]);
      return nativeReplayTrace(requests);
    }
    for (const [index, text] of nativeScenarios.entries()) {
      if (index === 1) active.add("native_b");
      if (index === 3) active.delete("native_a");
      const id = await send(store, project, text);
      if (index >= 1) await db.prepare("UPDATE runs SET payload=json_set(payload,'$.resultFollowup',json('true')) WHERE id=?").bind(id).run();
      await finish(id);
      if (index === 1) { db.close(); db = database(location); store = open(); }
    }
    assert.equal(invoked, 1);
    assert.equal(requests.length, 5);
    assert.equal(catalogReads, 1);
    assert.match(JSON.stringify(requests[1].messages.filter(({ role }) => role === "system")), /本轮由后台任务结果触发/);
    return nativeUpdateTrace(requests);
  } finally { globalThis.fetch = restore; db.close(); await rm(root, { recursive: true, force: true }); }
}

async function filesReuse() {
  const root = await mkdtemp(join(tmpdir(), "doman-provider-files-")), file = join(root, "cache.sqlite");
  const transport = imageTransportFixture(), restore = globalThis.fetch;
  let db = database(file);
  try {
    globalThis.fetch = transport.fetch;
    const model = createAgentModel({ ...settings, textBaseUrl: "https://api.deepseek.com/anthropic" });
    const image = { id: "ref", version: 1, path: "/fixture.png", objectKey: "fixture", mediaType: "image/png", bytes: 3, width: 1, height: 1 };
    const request = () => model("system", [{ role: "user", content: "image", images: [image] }], [],
      { resolveImage: async () => "data:image/png;base64,AQID", providerFiles: db });
    await request();
    db.close(); db = database(file);
    await request();
    return transport.trace;
  } finally { globalThis.fetch = restore; db.close(); await rm(root, { recursive: true, force: true }); }
}

async function referenceSnapshot() {
  const db = database();
  try {
    const store = new Store(db), project = await store.createProject("local", {});
    const source = await store.createSession(project.id, "source");
    const submit = async (session, text, model) => {
      const requestId = crypto.randomUUID();
      await store.acceptChatAtStep(project.id, { requestId, text, attachmentIds: [] }, session);
      const { run_id } = db.prepare("SELECT run_id FROM messages WHERE request_id=?").bind(requestId).rows()[0];
      assert.equal((await finish(store, project, run_id, model)).status, "done");
    };
    await submit(source.id, "source original", async () => reply("source reply"));
    let captured = "";
    const read = async (_system, messages) => {
      const context = messages.find(({ source }) => source?.kind === "session-reference");
      if (context) captured = context.content;
      return reply("reply");
    };
    const uri = Buffer.from(JSON.stringify(source.id)).toString("base64url");
    await submit("", `read @[source](dsh-session:${uri})`, read);
    await submit(source.id, "later source edit", async () => reply("updated"));
    await submit("", "again", read);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM session_reference_snapshots").rows()[0].count, 0);
    return { quoted: captured.includes("source original") && captured.includes("source reply"), frozen: !captured.includes("later source edit"), present: Boolean(captured) };
  } finally { db.close(); }
}

async function longReference(scenario) {
  const root = await mkdtemp(join(tmpdir(), "doman-long-reference-")), location = join(root, "studio.sqlite");
  let db = database(location);
  try {
    const open = () => new Store(db, { contextWindow: referenceBudget / .8 });
    let store = open();
    const project = await store.createProject("local", {}), source = await store.createSession(project.id, "source");
    const submit = async (session, text, model) => {
      const requestId = crypto.randomUUID();
      await store.acceptChatAtStep(project.id, { requestId, text, attachmentIds: [] }, session);
      const [{ run_id, id }] = db.prepare("SELECT run_id,id FROM messages WHERE request_id=?").bind(requestId).rows();
      const run = await finish(store, project, run_id, model);
      assert.equal(run.status, "done", run.error);
      return { run, id };
    };
    for (const [text, answer] of scenario.turns) await submit(source.id, text, async () => reply(answer));
    let capture = "", notices;
    const uri = Buffer.from(JSON.stringify(source.id)).toString("base64url");
    const original = await submit("", `Use @[source](dsh-session:${uri})`, async (_system, messages) => {
      capture = messages.find(({ source }) => source?.kind === "session-reference")?.content ?? "";
      return reply("Reference captured");
    });
    assert.ok(capture.includes("引用省略记录"));
    notices = JSON.parse(capture.split("\n").at(-1));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].fullSnapshot.status, "saved");
    assert.equal(notices[0].omittedMessages, scenario.dropped);
    assert.ok(notices[0].omittedBytes > 0);
    assert.ok(!capture.includes(scenario.missing));
    assert.ok(Buffer.byteLength(capture.split("\n")[2].slice(1, -1)) <= referenceBudget);
    const id = notices[0].fullSnapshot.snapshot_id;
    await submit(source.id, referenceUpdate, async () => reply("updated"));
    db.close(); db = database(location); store = open();
    assert.deepEqual((await store.referenceSession(original.run, original.id, source.id, "source")).omission, notices[0]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM session_reference_snapshots").rows()[0].count, 1);
    let pages = 0;
    const scoped = (await submit("", "Read the omitted setup", async (_system, messages, tools) => {
      const context = messages.find(({ source }) => source?.kind === "session-reference");
      assert.equal(context?.content, capture);
      const receipt = messages.findLast(({ role }) => role === "tool");
      const page = receipt ? JSON.parse(receipt.content) : null;
      if (pages) {
        assert.equal(page.snapshot_id, id);
        assert.equal(page.offset, 1 + (pages - 1) * referencePageSize);
        assert.equal(page.content.split("\n").length, referencePageSize);
      }
      if (pages === 2) return reply("Read both pages");
      assert.ok(tools.some(({ function: entry }) => entry.name === "read_session_reference"));
      const offset = page?.next_offset ?? 1;
      assert.equal(offset, 1 + pages * referencePageSize);
      return { ...reply(null), tool_calls: [{ id: "page-" + ++pages, type: "function", function: { name: "read_session_reference",
        arguments: JSON.stringify({ snapshot_id: id, offset, limit: referencePageSize }) } }] };
    })).run;
    const lines = [];
    for (let offset: number | null = 1; offset !== null;) {
      const page = store.readSessionReference(scoped, id, offset, 64);
      lines.push(...page.content.split("\n"));
      assert.equal(page.next_offset ?? page.total_lines + 1, offset + page.content.split("\n").length);
      offset = page.next_offset;
    }
    assert.deepEqual(decodeReferenceTranscript(lines), expectedReferenceMessages(scenario));
    const other = await store.createProject("local", {});
    for (const scope of [{ ...scoped, projectId: other.id }, { ...scoped, sessionId: source.id }])
      assert.throws(() => store.readSessionReference(scope, id, 1, 32), { code: "SESSION_REFERENCE_UNAVAILABLE" });
    const branch = await store.forkSession(project.id, "", scoped.id, "Inherited reference");
    assert.deepEqual(store.readSessionReference({ ...scoped, sessionId: branch.id }, id, 1, 32), store.readSessionReference(scoped, id, 1, 32));
    return { omitted: !capture.includes(scenario.missing), frozen: !lines.join("\n").includes(referenceUpdate), exact: true, pages, dropped: notices[0].omittedMessages };
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

async function sessionMetrics() {
  const db = database();
  try {
    const store = new Store(db), project = await store.createProject("local", {});
    for (const text of ["first", "second"]) {
      const id = await send(store, project, text);
      await finish(store, project, id, async (_system, _messages, _tools, options) => {
        await options.onText("answer");
        await options.onUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
        return reply("answer");
      });
    }
    const result = store.sessionExecutionMetrics(project.id, "");
    return { turns: result.turns, steps: result.steps, ttftSteps: result.ttftSteps, output: result.decodeTokens };
  } finally { db.close(); }
}
