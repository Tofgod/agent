import { createRequire } from "node:module";
import { serializeSessionLog, streamSessionLogZip, SESSION_LOG_FILENAME } from "@deepseek-ai/dsh-session-log-export";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { HarnessError, LlmAdapter, ToolCallId, createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from "@deepseek-ai/dsh-agent-loop-testkit";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { defineContentToolFixture, executeToolFixture } from "@deepseek-ai/dsh-tool-testkit";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { ToolResultPruner } from "@deepseek-ai/dsh-compaction-tool-result-pruner";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import * as ToolJobs from "@deepseek-ai/dsh-tool-jobs";
import SubagentRuntime from "@deepseek-ai/dsh-subagent";
import { streamOutput, stderrOutput, oversizedOutput, outputTail } from "./extension-cases.mjs";
import * as SubagentSpawn from "@deepseek-ai/dsh-subagent-spawn-in-process";
import * as SubagentControl from "@deepseek-ai/dsh-tool-subagent-control";
import * as JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import TeamService from "@deepseek-ai/dsh-agent-team";
import SessionReferenceResolver from "@deepseek-ai/dsh-session-reference";
import { DeepSeekFileStore, DeepSeekUploadIndex } from "@deepseek-ai/dsh-llm-deepseek";
import { LocalSpillStore } from "@deepseek-ai/dsh-spill-local";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import * as ToolFs from "@deepseek-ai/dsh-tool-fs";
import { delegationParityProbe, innerFlowProbe, probeJobCapacity } from "./recovery-cases.mjs";
import {
  authorizationCases, childPrompt, childTool, currentPrompt, earlierPrompt, earlierReply, firstDelta,
  imageTransportFixture, messagesHistory, messagesResponse, mixedArguments, overflowCases, peerMessage, peerReply, prunableReceipt, recentReceipt, requestReplay, secondDelta, shortenedHistory,
  decodeReferenceTranscript, expectedReferenceMessages, longReferenceCases, referenceBudget, referencePageSize, referenceUpdate,
  nativeAddedTool, nativeReplayTrace, nativeReply, nativeScenarios, nativeThinking, nativeUpdateTrace,
  compactHistory, compactLatest, compactMarkerTrace, compactMemo, compactOutputTokens, compactRouteCases, compactRoutes,
  childExecutionCases, childExecutionProbe, crossTurnProbe, childNoticeProbe, largeBatchCalls, largeToolBatches, backgroundHistoryProbe,
} from "./recovery-cases.mjs";

const options = { provider: "mock", model: "mock" };
const plain = (message) => message?.content?.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
const blocks = (text) => [{ type: "text", text }];
const user = (text) => createUserMessage({ source: { kind: "user" }, content: blocks(text) });
function* reply(text) {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: blocks(text)[0] };
  yield { type: "finish", reason: { kind: "stop" } };
}
function* toolCall(id, name, index = 0) {
  yield { type: "block-start", index, blockType: "tool-call" };
  yield { type: "block-end", index, block: { type: "tool-call", id: ToolCallId(id), name, arguments: "{}" } };
  yield { type: "finish", reason: { kind: "tool-calls" } };
}
const failure = (code) => ({ type: "finish", reason: { kind: "error", failure: { code, message: code } } });
function* childCalls(calls) {
  for (const [index, { id, name, args }] of calls.entries()) {
    yield { type: "block-start", index, blockType: "tool-call" };
    yield { type: "block-end", index, block: { type: "tool-call", id: ToolCallId(id), name, arguments: JSON.stringify(args) } };
  }
  yield { type: "finish", reason: { kind: "tool-calls" } };
}

class Adapter extends LlmAdapter {
  constructor(public response) { super(); }
  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 200000 } }; }
  async *stream(request) { yield* this.response(request); }
}

async function withLoop(setup, run, maxParallelToolCalls?) {
  const ctx = new Context();
  try {
    await mountAgentLoopTestDependencies(ctx);
    await setup(ctx);
    const loop = maxParallelToolCalls === undefined ? await mountAgentLoopTestHarness(ctx) :
      (await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls }), ctx.agentLoop);
    return await run(ctx, loop);
  } finally { await ctx.fiber.dispose(); }
}

async function mountSubagents(ctx, root) {
  await ctx.plugin(JsonlSessionPersistence, { root });
  const load = (path) => import(pathToFileURL(join(process.cwd(), "packages/subagent/subagent/tests", path)).href);
  const { TestSessionQuery } = await load("test-session-query.ts");
  const { mountWorkingDirectoryFixture } = await load("working-directory-fixture.ts");
  await ctx.plugin(TestSessionQuery);
  await mountWorkingDirectoryFixture(ctx);
  await ctx.plugin(SubagentRuntime);
  await ctx.plugin(SubagentSpawn, { providerName: "spawn" });
}

function authorization(enabled) {
  return withLoop(async () => {}, async (ctx, loop) => {
    let offered = false, invoked = 0, requests = 0;
    const register = () => ctx.tools.register(defineContentToolFixture({
      name: "web_search", description: "test registration", parameters: {},
      async execute() { invoked++; return blocks("web"); },
    }));
    const remove = enabled ? register() : undefined;
    ctx.llm.registerAdapter(["mock"], new Adapter(async function* (request) {
      if (requests++ === 0) {
        offered = request.tools?.some((tool) => tool.name === "web_search") ?? false;
        if (remove) remove();
        else register();
        yield* toolCall("web", "web_search");
      } else yield* reply("settled");
    }));
    const agent = await loop.create(SessionId("authorization"), options);
    agent.followup(user("test"));
    await agent.whenIdle();
    const events = agent.session.snapshotEvents();
    return { offered, invoked, outcome: events.find(({ type }) => type === "tool/result")?.data.error?.code };
  });
}

function liveRevocation() {
  return withLoop(async () => {}, async (ctx, loop) => {
    const invoked = [];
    let requests = 0;
    const retract = ctx.tools.register(defineContentToolFixture({ name: "second", description: "test second tool",
      parameters: {}, isConcurrencySafe: () => true, async execute() { invoked.push("second"); return blocks("second"); } }));
    ctx.tools.register(defineContentToolFixture({ name: "first", description: "test first tool", parameters: {},
      isConcurrencySafe: () => true, async execute() { invoked.push("first"); retract(); return blocks("first"); } }));
    ctx.llm.registerAdapter(["mock"], new Adapter(async function* () {
      if (requests++ > 0) { yield* reply("settled"); return; }
      for (const [index, name] of ["first", "second"].entries()) {
        yield { type: "block-start", index, blockType: "tool-call" };
        yield { type: "block-end", index, block: { type: "tool-call", id: ToolCallId(name), name, arguments: "{}" } };
      }
      yield { type: "finish", reason: { kind: "tool-calls" } };
    }));
    const agent = await loop.create(SessionId("revoke-in-batch"), options);
    agent.followup(user("test")); await agent.whenIdle();
    const receipts = agent.session.snapshotEvents().filter(({ type }) => type === "tool/result")
      .map(({ data }) => data.error?.code ?? "ok");
    return { invoked, receipts };
  }, 1);
}

function overflow(scenario) {
  return withLoop(async (ctx) => {
    await ctx.plugin(TokenMeter);
    await ctx.plugin(ToolResultPruner, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });
    await ctx.plugin(BasicCompactionEngine, { headroomTokens: 0, thresholdRatio: 1, retainTokens: 100,
      maxTokens: 4096, compactionRetries: 0, maxOverflowRetries: 1 });
  }, async (ctx, loop) => {
    const requests = [];
    let reads = 0, creation = 0;
    ctx.tools.register(defineContentToolFixture({
      name: "read_probe", description: "test read", parameters: {},
      async execute() { return blocks(JSON.stringify({ content: reads++ === 0 && scenario.oldReceipt ? prunableReceipt : recentReceipt })); },
    }));
    ctx.llm.registerAdapter(["mock"], new Adapter(async function* (request) {
      const latest = plain(request.messages.at(-1));
      if (latest === earlierPrompt) { yield* reply(earlierReply); return; }
      if (latest.includes("acting as a compaction engine")) {
        requests.push("summary");
        if (scenario.summarySucceeds) yield* reply(shortenedHistory);
        else yield failure("AUTH");
        return;
      }
      const summarized = request.messages.some((message) => plain(message).includes(shortenedHistory));
      requests.push(summarized ? "creation with summary" : "creation");
      creation++;
      if (creation <= 2) yield* toolCall(creation === 1 ? "old" : "recent", "read_probe");
      else if (creation === 3 || (scenario.summarySucceeds && !summarized)) yield failure("CONTEXT_WINDOW_EXCEEDED");
      else yield* reply("recovered");
    }));
    const agent = await loop.create(SessionId("overflow"), options);
    if (!scenario.firstTurn) {
      agent.followup(user(earlierPrompt));
      await agent.whenIdle();
    }
    const offset = agent.session.snapshotEvents().length;
    agent.followup(user(currentPrompt));
    await agent.whenIdle();
    const events = agent.session.snapshotEvents().slice(offset);
    const end = events.at(-1).data.reason;
    return { requests, end: end.error?.code ?? end.kind,
      steps: events.filter(({ type }) => type === "step/start").map(({ data }) => data.step),
      summaries: events.filter(({ type }) => type === "compaction/summary").length };
  });
}

async function peerDelivery(withTool) {
  const db = await mkdtemp(join(tmpdir(), "harness-peer-"));
  const streamed = Promise.withResolvers<void>(), admitted = Promise.withResolvers<void>();
  const signal = AbortSignal.timeout(3000);
  try {
    return await withLoop((ctx) => mountSubagents(ctx, db), async (ctx, loop) => {
      const history = [], sideEffects = [];
      ctx.tools.register(defineContentToolFixture({
        name: "child_probe", description: "test child", parameters: {},
        async execute() { sideEffects.push(childTool); return blocks(childTool); },
      }));
      ctx.llm.registerAdapter(["mock"], new Adapter(async function* (request) {
        history.push({ peer: request.messages.some((m) => m.source?.kind === "agent-message" && plain(m).includes(peerMessage)),
          receipt: request.messages.some((m) => m.role === "tool" && plain(m) === childTool) });
        if (history.length > 1) { yield* reply(peerReply); return; }
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: firstDelta };
        streamed.resolve();
        await admitted.promise;
        request.signal.throwIfAborted();
        yield { type: "text-delta", index: 0, text: secondDelta };
        yield { type: "block-end", index: 0, block: blocks(firstDelta + secondDelta)[0] };
        if (withTool) yield* toolCall("peer-tool", "child_probe", 1);
        else yield { type: "finish", reason: { kind: "stop" } };
      }));
      const parent = await loop.create(SessionId("parent"), options);
      const child = await ctx.subagents.startActivation({ provider: "spawn", label: "child fixture",
        prompt: blocks(childPrompt), parent, signal, delivery: "caller" });
      try {
        await Promise.race([streamed.promise, delay(2000, undefined, { signal }).then(() => { throw Error("Child stream did not start"); })]);
        const agent = ctx.agents.get(child.childId);
        await ctx.subagents.sendMessage(parent, child.childId, blocks(peerMessage), { signal });
        admitted.resolve();
        assert.equal((await child.result).stopReason, "completed");
        const text = agent.session.snapshotEvents().filter(({ type }) => type === "assistant/message").map(({ data }) => plain(data.message));
        return { history, sideEffects, text };
      } finally { admitted.resolve(); }
    });
  } finally { await rm(db, { recursive: true, force: true }); }
}

function providerFinish(empty) {
  return withLoop(async () => {}, async (ctx, loop) => {
    const bodies = [];
    let requests = 0;
    ctx.tools.register(defineContentToolFixture({
      name: "probe", description: "test arguments", parameters: { value: { type: "integer" } },
      async execute(args) { bodies.push(args.value); return blocks("accepted"); },
    }));
    ctx.llm.registerAdapter(["mock"], new Adapter(async function* () {
      requests++;
      if (empty) { yield { type: "finish", reason: { kind: "stop" } }; return; }
      if (requests > 1) { yield* reply("received receipts"); return; }
      for (const [index, input] of mixedArguments.entries()) {
        yield { type: "block-start", index, blockType: "tool-call" };
        yield { type: "block-end", index, block: { type: "tool-call", id: ToolCallId(input.id), name: "probe", arguments: input.arguments } };
      }
      yield { type: "finish", reason: { kind: "tool-calls" } };
    }));
    const agent = await loop.create(SessionId("finish"), options);
    agent.followup(user("start"));
    await agent.whenIdle();
    const events = agent.session.snapshotEvents();
    const receipts = events.filter(({ type }) => type === "tool/result").map(({ data }) => [data.message.toolCallId, data.error?.code ?? "ok"]);
    return { requests, bodies, receipts, end: events.at(-1).data.reason.kind };
  });
}

async function lateChildResult() {
  const root = await mkdtemp(join(tmpdir(), "harness-late-child-"));
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  try {
    return await withLoop((ctx) => mountSubagents(ctx, root), async (ctx, loop) => {
      let requests = 0, child;
      ctx.tools.register(defineContentToolFixture({ name: "delegate_probe", description: "test child delivery", parameters: {},
        async execute(_args, exec) {
          child = await ctx.subagents.startActivation({ provider: "spawn", label: "child fixture", prompt: blocks(childPrompt),
            parent: exec.agent, signal: exec.signal, delivery: "parent" });
          return blocks(child.name);
        } }));
      ctx.llm.registerAdapter(["mock"], new Adapter(async function* (request) {
        if (request.messages.some((message) => plain(message) === "parent request")) {
          if (++requests === 1) yield* toolCall("delegate", "delegate_probe");
          else yield* reply("parent reply " + requests);
        } else {
          entered.resolve();
          await release.promise;
          yield* reply(childTool);
        }
      }));
      const parent = await loop.create(SessionId("late-child"), options);
      const turns = () => parent.session.snapshotEvents().filter(({ type }) => type === "turn/end").length;
      try {
        parent.followup(user("parent request"));
        await Promise.race([entered.promise, delay(1000).then(() => assert.fail("child did not start"))]);
        await Promise.race([parent.whenIdle(), delay(1000).then(() => assert.fail("parent did not finish before the child"))]);
        const before = turns();
        release.resolve();
        assert.equal((await child.result).stopReason, "completed");
        await parent.whenIdle();
        const notices = parent.session.snapshotEvents().filter(({ type, data }) => type === "user/message" && data.source.kind === "subagent-settled").length;
        return { before, after: turns(), requests, notices };
      } finally { release.resolve(); }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function background() {
  const root = await mkdtemp(join(tmpdir(), "harness-notification-"));
  const journal = join(root, "journal"), coldSnapshot = join(root, "cold");
  const id = SessionId("background");
  const setup = (directory) => async (ctx) => {
    await ctx.plugin(JsonlSessionPersistence, { root: directory });
    await ctx.plugin(LocalJobRegistry);
    await ctx.plugin(ToolJobs, { completionDelivery: "quiet" });
  };
  let jobId, pendingBefore;
  let extraRequests = 0;
  try {
    await withLoop(setup(journal), async (ctx, loop) => {
      let requests = 0;
      ctx.llm.registerAdapter(["mock"], new Adapter(async function* () { requests++; yield* reply("finished"); }));
      const owner = await loop.create(id, options);
      owner.followup(user("initial"));
      await owner.whenIdle();
      const done = Promise.withResolvers();
      jobId = ctx.jobs.start({ kind: "test", label: "job fixture", owner: id, run: () => ({ cancel() {}, done: done.promise }) });
      done.resolve({ status: "completed", result: "probe result" });
      for (let attempt = 0; attempt < 50 && !owner.inbox.nextStep.length; attempt++) await delay(2);
      pendingBefore = owner.inbox.nextStep.filter((m) => m.source.kind === "tool-jobs").length;
      extraRequests = requests - 1;
      await ctx.sessions.flush(owner.session);
      // Preserve the flushed files before shutdown clears the live agent's inbox.
      await cp(journal, coldSnapshot, { recursive: true });
    });
    await withLoop(setup(journal), async (ctx) => {
      const { agent } = await ctx.agentLoop.resume(ctx, { resumeSessionId: id, agentOptions: options });
      assert.equal(agent.inbox.nextStep.filter((m) => m.source.kind === "tool-jobs").length, 0);
    });
    return await withLoop(setup(coldSnapshot), async (ctx) => {
      const notices = [];
      ctx.llm.registerAdapter(["mock"], new Adapter(async function* (request) {
        notices.push(request.messages.filter((m) => m.source?.kind === "tool-jobs").length);
        yield* reply("finished");
      }));
      const { agent } = await ctx.agentLoop.resume(ctx, { resumeSessionId: id, agentOptions: options });
      const pendingRecovered = agent.inbox.nextStep.filter((m) => m.source.kind === "tool-jobs").length;
      for (const prompt of ["first after restart", "second after restart"]) {
        agent.followup(user(prompt));
        await agent.whenIdle();
      }
      const deliveries = agent.session.snapshotEvents().filter(({ type, data }) => type === "user/message" && data.source.kind === "tool-jobs").length;
      assert.throws(() => ctx.jobs.get(jobId, id), { code: "JOB_NOT_FOUND" });
      return { pendingBefore, pendingRecovered, notices, deliveries, extraRequests };
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function stopQueue() {
  return withLoop(async () => {}, async (ctx, loop) => {
    const started = Promise.withResolvers();
    ctx.llm.registerAdapter(["mock"], new Adapter(async function* (request) {
      started.resolve();
      request.signal.throwIfAborted();
      await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
      request.signal.throwIfAborted();
    }));
    const agent = await loop.create(SessionId("stop-queue"), options);
    agent.followup(user("start"));
    await started.promise;
    agent.steer(user("supplement"));
    agent.followup(user("next turn"));
    const before = agent.inbox.nextStep.length + agent.inbox.nextTurn.length;
    agent.cancel({ kind: "user" });
    await agent.whenIdle();
    return { before, pending: agent.inbox.nextStep.length + agent.inbox.nextTurn.length,
      turns: agent.session.snapshotEvents().filter(({ type }) => type === "turn/end").length };
  });
}

function wakeupJob() {
  return withLoop(async (ctx) => {
    await ctx.plugin(LocalJobRegistry);
    await ctx.plugin(ToolJobs);
  }, async (ctx, loop) => {
    let requests = 0, notices = 0;
    ctx.llm.registerAdapter(["mock"], new Adapter(async function* (request) {
      requests++;
      notices += request.messages.filter((message) => message.source?.kind === "tool-jobs").length;
      yield* reply("finished");
    }));
    const id = SessionId("job-wake"), owner = await loop.create(id, options);
    owner.followup(user("initial"));
    await owner.whenIdle();
    const done = Promise.withResolvers();
    ctx.jobs.start({ kind: "test", label: "job fixture", owner: id, run: () => ({ cancel() {}, done: done.promise }) });
    done.resolve({ status: "completed", result: "job result" });
    for (let poll = 0; poll < 50 && requests < 2; poll++) await delay(2);
    await owner.whenIdle();
    return { requests, notices };
  });
}

async function jobDeltas() {
  return withLoop(async (ctx) => {
    await ctx.plugin(LocalJobRegistry);
    await ctx.plugin(ToolJobs, { completionDelivery: "quiet" });
  }, async (ctx, loop) => {
    const owner = await loop.create(SessionId("job-deltas"), options);
    const done = Promise.withResolvers();
    let handle, calls = 0;
    const id = ctx.jobs.start({ kind: "test", label: "probe", owner: owner.id, run(job) {
      handle = job; return { cancel() { done.resolve({ status: "killed" }); }, done: done.promise };
    } });
    const read = (args = {}) => executeToolFixture(ctx, { agent: owner, signal: AbortSignal.timeout(3000),
      callId: ToolCallId("job-" + ++calls), name: "job_output", arguments: { job_id: id, ...args } });
    handle.append("segment-a\n");
    for (const part of streamOutput) handle.append(part + "\n", { channel: "stdout" });
    handle.append(stderrOutput + "\n", { channel: "stderr" });
    handle.append("private progress\n", { channel: "log" });
    const first = await read();
    const empty = await read({ timeout_ms: 20 });
    const deadline = await read({ wait: true, timeout_ms: 10 });
    handle.append("segment-");
    handle.append("b");
    const second = await read();
    handle.append(oversizedOutput);
    const oversized = (await read()).value.text;
    done.resolve({ status: "completed", result: "artifact-ready" });
    await delay(5);
    const final = await read(), again = await read();
    const delta = first.value.text;
    assert.ok(delta.includes(streamOutput.at(-1)) && delta.indexOf("[stderr]") > delta.indexOf(streamOutput.at(-1)));
    return { first: delta.includes("segment-a"), completeDelta: delta.trimEnd().split("\n").length === streamOutput.length + 3,
      stderr: delta.includes("[stderr]\n" + stderrOutput), progressExcluded: !delta.includes("private progress"),
      oversized: oversized.includes(outputTail) && oversized.includes("output was dropped") && !oversized.includes("\uFFFD"),
      empty: empty.value.text === "", timed: deadline.value.job.status === "running",
      second: second.value.text.includes("segment-b") && !second.value.text.includes("segment-a"),
      final: final.value.text.includes("artifact-ready"), once: !again.value.text.includes("artifact-ready") };
  });
}

async function backgroundHistoryTraces() {
  const probe = backgroundHistoryProbe;
  const noticeTrace = (large: boolean, archive: boolean) => withLoop(async (ctx) => {
    await ctx.plugin(LocalJobRegistry);
    await ctx.plugin(ToolJobs);
  }, async (ctx, loop) => {
    const owner = await loop.create(SessionId("history-notice"), options);
    const finished = Promise.withResolvers();
    const done = Promise.withResolvers();
    let id, noticeResult = false, noticeOutput = false, toolResult = false, toolOutput = false;
    const contents = large ? [...Array.from({ length: 4 }, () => "x".repeat(800)), ...probe.output] : probe.output;
    ctx.llm.registerAdapter(["mock"], new Adapter(async function* (request) {
      const receipt = request.messages.findLast((message) => message.role === "tool");
      if (receipt) {
        toolResult = plain(receipt).includes(probe.result);
        toolOutput = probe.output.every((line) => plain(receipt).includes(line));
        yield* reply("done");
        finished.resolve();
      } else {
        const notice = request.messages.findLast((message) => message.source?.kind === "tool-jobs");
        noticeResult = plain(notice).includes(probe.result);
        noticeOutput = probe.output.every((line) => plain(notice).includes(line));
        yield* childCalls([{ id: "read-background", name: "job_output", args: { job_id: id } }]);
      }
    }));
    id = ctx.jobs.start({ kind: "test", label: probe.label, owner: owner.id, run(job) {
      for (const line of contents) job.append(line + "\n");
      return { cancel() { done.resolve({ status: "killed" }); }, done: done.promise };
    } });
    done.resolve({ status: "completed", result: probe.result });
    await Promise.race([finished.promise, delay(1500, null, { ref: false }).then(() => assert.fail("Harness did not receive the completion"))]);
    await owner.whenIdle();
    const trace = { noticeResult, noticeOutput, toolResult, toolOutput };
    const expected = large ? { noticeResult:false, noticeOutput:false, toolResult:true, toolOutput:true }
      : { noticeResult:true, noticeOutput:true, toolResult:false, toolOutput:false };
    assert.deepEqual(trace, expected);
    if (!archive) return trace;
    const content = serializeSessionLog(owner.session.header, owner.session.snapshotEvents());
    // Use the native ZIP writer on the committed log. These fixtures have no attachments or descendants.
    const zip = streamSessionLogZip({}, content, owner.id, false, 6, AbortSignal.timeout(3000));
    const { strFromU8, unzipSync } = createRequire(import.meta.resolve("@deepseek-ai/dsh-session-log-export"))("fflate");
    const entries = unzipSync(new Uint8Array(await new Response(zip).arrayBuffer()));
    const log = strFromU8(entries[SESSION_LOG_FILENAME]);
    const events = log.trimEnd().split("\n").map((line) => JSON.parse(line));
    const registered = events.find((event) => event.type === "job/registered" && event.data.jobId === id);
    const final = events.find((event) => event.type === "job/settled" && event.data.jobId === id);
    const from = log.indexOf(probe.output[0]);
    return { background: Boolean(registered), settled: final?.data.status === "completed",
      orderedOutput: from >= 0 && log.indexOf(probe.output[1], from) > from, resultRetained: log.includes(probe.result) };
  });

  const loss = await withLoop(async (ctx) => {
    await ctx.plugin(LocalJobRegistry, { retainBytes: 511 * Buffer.byteLength(probe.largeOutput[0] + "\n") });
    await ctx.plugin(ToolJobs, { completionDelivery: "quiet" });
  }, async (ctx, loop) => {
    const owner = await loop.create(SessionId("history-loss"), options);
    const done = Promise.withResolvers();
    let handle;
    const id = ctx.jobs.start({ kind: "test", label: probe.label, owner: owner.id, run(job) {
      handle = job;
      return { cancel() { done.resolve({ status: "killed" }); }, done: done.promise };
    } });
    for (const line of probe.largeOutput) handle.append(line + "\n");
    const read = await executeToolFixture(ctx, { agent: owner, signal: AbortSignal.timeout(3000),
      callId: ToolCallId("read-loss"), name: "job_output", arguments: { job_id: id } });
    const text = read.value.text;
    return { reportsLoss: text.includes("output was dropped"), oldestMissing: !text.includes(probe.largeOutput[0]),
      tailKept: text.includes(probe.largeOutput.at(-1)) };
  });
  assert.deepEqual(loss, { reportsLoss:true, oldestMissing:true, tailKept:true });
  const archive = await noticeTrace(false, true);
  assert.deepEqual(archive, { background:true, settled:true, orderedOutput:true, resultRetained:true });
  return [await noticeTrace(false, false), await noticeTrace(true, false), loss, archive];
}

async function limitedWakeups() {
  return withLoop(async (ctx) => {
    await ctx.plugin(LocalJobRegistry);
    await ctx.plugin(ToolJobs, { maxConsecutiveWakes: 1 });
  }, async (ctx, loop) => {
    let calls = 0;
    ctx.llm.registerAdapter(["mock"], new Adapter(async function* () { calls++; yield* reply("reported"); }));
    const owner = await loop.create(SessionId("job-wake-budget"), options);
    async function prepare(text) { owner.followup(user(text)); await owner.whenIdle(); }
    async function settle(label) {
      const done = Promise.withResolvers();
      ctx.jobs.start({ kind: "test", label, owner: owner.id, run() { return { cancel() { done.resolve({ status: "killed" }); }, done: done.promise }; } });
      done.resolve({ status: "completed", result: label });
      await delay(10);
      await owner.whenIdle();
    }
    await prepare("begin");
    await settle("first");
    const first = calls;
    await settle("second");
    const quiet = calls === first;
    await prepare("continue");
    await settle("third");
    return { first, quiet, afterUser: calls };
  });
}

async function teamBoard() {
  const root = await mkdtemp(join(tmpdir(), "harness-team-parity-"));
  try {
    return await withLoop((ctx) => mountSubagents(ctx, root), async (ctx, loop) => {
      await ctx.plugin(TeamService);
      const lead = await loop.create(SessionId("team-board"), options);
      const initial = ctx.agentTeams.isEnabled(lead);
      await ctx.agentTeams.setEnabled(lead, true);
      const statuses = [];
      let task = await ctx.agentTeams.createTask(lead, { subject: "draft", description: "draft scene" });
      statuses.push([task.status, task.ready, task.revision]);
      for (const action of ["claim", "release", "claim", "complete", "reopen", "delete"]) {
        task = await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action });
        statuses.push([task.status, task.ready, task.revision]);
      }
      const listed = ctx.agentTeams.listTasks(lead).length;
      await ctx.agentTeams.setEnabled(lead, false);
      return { initial, statuses, listed, disabled: !ctx.agentTeams.isEnabled(lead) };
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function namedChild() {
  const root = await mkdtemp(join(tmpdir(), "harness-named-child-"));
  try {
    return await withLoop((ctx) => mountSubagents(ctx, root), async (ctx, loop) => {
      ctx.llm.registerAdapter(["mock"], new Adapter(async function* () { yield* reply("done"); }));
      const parent = await loop.create(SessionId("named-child"), options), signal = AbortSignal.timeout(3000);
      const spec = { provider: "spawn", label: "child", name: "reviewer", prompt: blocks(childPrompt), parent, signal, delivery: "caller" };
      const child = await ctx.subagents.startActivation(spec);
      let duplicate;
      try { await ctx.subagents.startActivation(spec); } catch (error) { duplicate = error.code; }
      return { name: child.name, duplicate, resolves: await ctx.subagents.resolveName(parent, "reviewer", signal) === child.childId };
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function nestedDelegation() {
  const root = await mkdtemp(join(tmpdir(), "harness-nested-parity-"));
  const release = Promise.withResolvers();
  try {
    return await withLoop((ctx) => mountSubagents(ctx, root), async (ctx, loop) => {
      ctx.llm.registerAdapter(["mock"], new Adapter(async function* () { await release.promise; yield* reply("done"); }));
      const lead = await loop.create(SessionId("nested"), options), signal = AbortSignal.timeout(5000);
      const spawn = (parent, maxDepth, name) => ctx.subagents.startActivation({
        provider: "spawn", label: name, name, prompt: blocks(name), parent, signal, delivery: "caller", maxDepth,
      });
      try {
        const [a, b] = await Promise.all([spawn(lead, 2, "draft-a"), spawn(lead, 2, "draft-b")]);
        const child = ctx.agents.get(a.childId);
        assert.ok(child);
        const denied = (parent, cap, name) => spawn(parent, cap, name).then(() => false, (error) => /depth/i.test(error.message));
        const blockedByDefault = await denied(child, ctx.subagents.resolveMaxDepth(), "blocked-child");
        const nested = await spawn(child, 2, "nested-child");
        const grandchild = ctx.agents.get(nested.childId);
        assert.ok(grandchild);
        return { distinct: a.childId !== b.childId, blockedByDefault,
          nested: nested.childId !== a.childId, blockedAtCap: await denied(grandchild, 2, "too-deep") };
      } finally { release.resolve(); }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function nestedNames() {
  const { names, leaf } = delegationParityProbe;
  const root = await mkdtemp(join(tmpdir(), "harness-nested-names-"));
  const release = Promise.withResolvers();
  try {
    return await withLoop((ctx) => mountSubagents(ctx, root), async (ctx, loop) => {
      ctx.llm.registerAdapter(["mock"], new Adapter(async function* () { await release.promise; yield* reply("done"); }));
      const lead = await loop.create(SessionId("nested-names"), options), signal = AbortSignal.timeout(5_000);
      const spawn = (parent, name) => ctx.subagents.startActivation({
        provider: "spawn", label: name, name, prompt: blocks(name), parent, signal, delivery: "caller", maxDepth: 2,
      });
      try {
        const branches = await Promise.all(names.map((name) => spawn(lead, name)));
        const parents = branches.map(({ childId }) => ctx.agents.get(childId));
        const children = await Promise.all(parents.map((parent) => spawn(parent, leaf)));
        const addresses = names.map((name) => name + "/" + leaf);
        const resolves = await Promise.all(addresses.map(async (address, i) =>
          await ctx.subagents.resolveName(lead, address, signal) === children[i].childId));
        const siblingDuplicate = await spawn(parents[0], leaf).then(() => false, (error) => error.code);
        const invalidPath = await ctx.subagents.resolveName(lead, "missing/" + leaf, signal).then(() => false, (error) => error.code);
        const [sender, recipient] = children.map(({ childId }) => ctx.agents.get(childId));
        await ctx.subagents.sendMessage(sender, recipient.id, blocks(peerMessage), { signal });
        const senderIdentified = recipient.inbox.nextStep.some((message) => plain(message).includes("Agent " + addresses[0] + " sent a message: " + peerMessage));
        assert.ok(senderIdentified);
        return { addresses, resolves, siblingDuplicate, invalidPath,
          senderIdentified, parentIdentified: ctx.subagents.namesOf(recipient).parent === names[1],
          bareLeafIsNotAChild: await ctx.subagents.resolveName(lead, leaf, signal) === leaf };
      } finally { release.resolve(); }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function consecutiveInputWaits() {
  const { message, invalid, timeout, calls } = innerFlowProbe.wait;
  const signal = AbortSignal.timeout(3_000);
  const root = await mkdtemp(join(tmpdir(), "harness-input-waits-"));
  try { return await withLoop(async (ctx) => {
    await mountSubagents(ctx, root);
    await ctx.plugin(SubagentControl);
  }, async (ctx, loop) => {
    let steps = 0, nextInput;
    ctx.llm.registerAdapter(["mock"], new Adapter(async function* (request) {
      if (!steps++) {
        yield* childCalls([{ id: "invalid", name: "wait_agent", args: { timeout_ms: invalid } },
          ...calls.map((id) => ({ id, name: "wait_agent", args: { timeout_ms: timeout } }))]);
        return;
      }
      nextInput = request.messages.filter((entry) => plain(entry) === message).length;
      yield* reply("settled");
    }));
    const agent = await loop.create(SessionId("two-waits"), options);
    const events = () => agent.session.snapshotEvents();
    const admitted = (id) => events().some((event) => event.type === "tool/call" && event.data.callId === id);
    const settled = () => events().filter((event) => event.type === "tool/result");
    const waitUntil = async (predicate) => {
      while (!predicate()) await delay(5, undefined, { signal });
    };
    agent.followup(user("wait twice"));
    await waitUntil(() => admitted(calls[0]));
    agent.inject(user(message));
    await waitUntil(() => settled().length === 3);
    await agent.whenIdle();
    const [rejected, ...receipts] = settled();
    return { invalid: rejected.data.error?.code, receipts: receipts.map(({ data }) => JSON.parse(plain(data.message)).timedOut), nextInput };
  }); } finally { await rm(root, { recursive: true, force: true }); }
}

async function isolatedToolFailure() {
  const probe = innerFlowProbe.tool;
  return withLoop(async () => {}, async (ctx, loop) => {
    let steps = 0, written = "";
    ctx.tools.register(defineContentToolFixture({ name: "media_fixture", description: "test authorization", parameters: {},
      async execute() { throw new HarnessError("missing media credentials", probe.code); } }));
    ctx.tools.register(defineContentToolFixture({ name: "write_fixture", description: "write draft", parameters: {},
      async execute() { written = probe.text; return blocks(written); } }));
    ctx.llm.registerAdapter(["mock"], new Adapter(async function* () {
      if (!steps++) yield* childCalls([{ id: probe.unavailable, name: "media_fixture", args: {} }, { id: probe.write, name: "write_fixture", args: {} }]);
      else yield* reply("draft ready");
    }));
    const agent = await loop.create(SessionId("media-failure"), options);
    agent.followup(user("write the draft and try the optional media"));
    await agent.whenIdle();
    const events = agent.session.snapshotEvents(), receipts = events.filter(({ type }) => type === "tool/result");
    return { failure: receipts[0]?.data.error?.code, written, replied: events.some(({ type, data }) => type === "assistant/message" && plain(data.message) === "draft ready") };
  });
}

async function interruptDescendant() {
  const probe = innerFlowProbe.control, root = await mkdtemp(join(tmpdir(), "harness-interrupt-path-"));
  const release = Promise.withResolvers(), signal = AbortSignal.timeout(5_000);
  try {
    return await withLoop(async (ctx) => {
      await mountSubagents(ctx, root);
      await ctx.plugin(SubagentControl);
    }, async (ctx, loop) => {
      const continued = Promise.withResolvers();
      ctx.llm.registerAdapter(["mock"], new Adapter(async function* (request) {
        if (request.messages.some((message) => plain(message).includes(probe.resume))) {
          continued.resolve();
          yield* reply(probe.done);
          return;
        }
        await Promise.race([release.promise, delay(5_000, undefined, { signal: request.signal, ref: false })]);
        yield* reply("fixture settled");
      }));
      const lead = await loop.create(SessionId("interrupt-lead"), options);
      const spawn = (parent, name) => ctx.subagents.startActivation({
        provider: "spawn", label: name, name, prompt: blocks(name), parent, signal, delivery: "caller", maxDepth: 2,
      });
      try {
        const a = await spawn(lead, probe.a), b = await spawn(lead, probe.b);
        const aAgent = ctx.agents.get(a.childId), bAgent = ctx.agents.get(b.childId);
        const leaf = await spawn(aAgent, probe.leaf);
        const stop = (agent, target) => executeToolFixture(ctx, { agent, signal, callId: ToolCallId(crypto.randomUUID()),
          name: "interrupt_agent", arguments: { agent: target } });
        const siblingDenied = (await stop(bAgent, probe.a + "/" + probe.leaf)).isError;
        const interrupted = await stop(lead, probe.a);
        const stopped = (await a.result).stopReason === "aborted";
        const descendant = ctx.agents.get(leaf.childId);
        const deeperKeptRunning = Boolean(descendant && descendant.status !== "idle");
        await ctx.subagents.sendMessage(lead, await ctx.subagents.resolveName(lead, probe.a, signal), blocks(probe.resume), { signal });
        await Promise.race([continued.promise, delay(3_000, undefined, { signal, ref: false }).then(() => assert.fail("Child did not continue"))]);
        const sameChild = await ctx.subagents.resolveName(lead, probe.a, signal) === a.childId;
        const trace = { siblingDenied, stopped: stopped && !interrupted.isError, deeperKeptRunning, sameChild };
        assert.ok(Object.values(trace).every(Boolean));
        return trace;
      } finally { release.resolve(); }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function childReasoning() {
  const { route, parentEffort, explicitEffort, configuredEffort } = delegationParityProbe;
  const { requestedAgentOptions, preflightChildLlmRoute } = await import(pathToFileURL(join(process.cwd(),
    "packages/subagent/tool-subagent/src/model-selection.ts")).href);
  const parent = { ...route, reasoningEffort: parentEffort }, config = { ...route, reasoningEffort: configuredEffort };
  return withLoop(async () => {}, async (ctx) => {
    class ReasoningAdapter extends Adapter {
      async resolveModel(provider, model) {
        return { ...await super.resolveModel(provider, model), reasoning: {
          efforts: ["off", parentEffort, explicitEffort].map((id) => ({ id, name: id })), defaultEffort: parentEffort,
        } };
      }
    }
    ctx.llm.registerAdapter([route.provider], new ReasoningAdapter(reply));
    assert.deepEqual(await ctx.llm.listModels(route.provider), []);
    const resolved = [];
    const llm = { async resolveCallConfig(request, signal) {
      resolved.push(request.reasoningEffort ?? null);
      return ctx.llm.resolveCallConfig(request, signal);
    } };
    const run = async (request, configured?) => {
      const selected = requestedAgentOptions(configured, request, true, undefined, parent);
      await preflightChildLlmRoute(llm, parent, selected, AbortSignal.timeout(3_000), !request.provider);
    };
    await assert.rejects(run({ reasoning_effort: explicitEffort }), /requires both/);
    await run({});
    await run(route);
    await run({ ...route, reasoning_effort: explicitEffort });
    await run({}, config);
    await run(route, config);
    await run({ ...route, reasoning_effort: "off" });
    return { effortOnlyRejected: true, resolved };
  });
}

async function jobOwners() {
  const { log, limit, names } = delegationParityProbe;
  return withLoop(async (ctx) => {
    await ctx.plugin(LocalJobRegistry);
    await ctx.plugin(ToolJobs, { completionDelivery: "quiet" });
  }, async (ctx, loop) => {
    const lead = await loop.create(SessionId("jobs-lead"), options);
    const actors = new Map(await Promise.all(names.map(async (name) => [name, await loop.create(SessionId("jobs-" + name), options)])));
    const active = new Map();
    const start = async (owner, label) => {
      const done = Promise.withResolvers();
      const id = ctx.jobs.start({ kind: "test", label: String(label), owner: actors.get(owner).id, run(job) {
        job.append(log + "\n");
        return { cancel() {}, done: done.promise };
      } });
      active.set(id, { done, owner: actors.get(owner) });
      return id;
    };
    const finish = async (id) => {
      const { done, owner } = active.get(id);
      done.resolve({ status: "completed", result: "ready" });
      await ctx.jobs.wait(id, 3_000, owner.id);
      active.delete(id);
    };
    try {
      const id = await start("a", "owned");
      const read = (actor, wait = false) => executeToolFixture(ctx, { agent: actor, signal: AbortSignal.timeout(3_000),
        callId: ToolCallId(crypto.randomUUID()), name: "job_output", arguments: { job_id: id, wait, timeout_ms: 10 } });
      const trace = { owner: (await read(actors.get("a"))).value.text.includes(log),
        lead: (await read(lead)).error?.info?.code, peerWait: (await read(actors.get("b"), true)).error?.info?.code };
      await finish(id);
      return { trace, capacity: await probeJobCapacity(start, (job) => {
        assert.equal(ctx.jobs.kill(job, active.get(job).owner.id), "requested");
      }, finish, limit) };
    } finally { for (const id of active.keys()) await finish(id); }
  });
}

async function crossTurnCollaboration() {
  const root = await mkdtemp(join(tmpdir(), "harness-cross-turn-"));
  const startedChild = Promise.withResolvers(), releaseChild = Promise.withResolvers();
  const startedSecond = Promise.withResolvers(), releaseSecond = Promise.withResolvers();
  const probe = crossTurnProbe;
  try {
    return await withLoop((ctx) => mountSubagents(ctx, root), async (ctx, loop) => {
      await ctx.plugin(TeamService);
      ctx.llm.registerAdapter(["mock"], new Adapter(async function* (request) {
        const history = request.messages.map(plain);
        if (history.some((text) => text.includes(probe.child))) {
          startedChild.resolve();
          await releaseChild.promise;
        }
        if (history.includes(probe.second) && !history.some((text) => text.includes(probe.finding))) {
          startedSecond.resolve();
          await releaseSecond.promise;
        }
        yield* reply("Finished this step");
      }));
      const lead = await loop.create(SessionId("cross-turn"), options), signal = AbortSignal.timeout(5000);
      try {
        await ctx.agentTeams.setEnabled(lead, true);
        const created = await ctx.agentTeams.createTask(lead, probe.task);
        await ctx.agentTeams.updateTask(lead, { taskId: created.id, expectedRevision: created.revision, action: "claim" });
        const spec = { provider: "spawn", label: "review scene", name: probe.name, prompt: blocks(probe.child), parent: lead, signal, delivery: "caller" };
        const child = await ctx.subagents.startActivation(spec);
        await startedChild.promise;
        lead.followup(user(probe.first));
        await lead.whenIdle();
        lead.followup(user(probe.second));
        await startedSecond.promise;
        const original = await ctx.subagents.resolveName(lead, probe.name, signal) === child.childId;
        let duplicate;
        try { await ctx.subagents.startActivation(spec); } catch (error) { duplicate = error.code; }
        const owned = ctx.agentTeams.listTasks(lead).filter(({ ownerId }) => ownerId === lead.id).length;
        await ctx.subagents.sendMessage(ctx.agents.get(child.childId), lead.id, blocks(probe.finding), { signal });
        releaseSecond.resolve();
        await lead.whenIdle();
        const events = lead.session.snapshotEvents(), settled = events.filter(({ type }) => type === "turn/end");
        const messages = events.filter(({ type, data }) => type === "user/message" && data.source.kind === "agent-message" && plain(data).includes(probe.finding));
        return { message: messages.length === 1 && messages[0].seq > settled[0].seq && messages[0].seq < settled[1].seq,
          names: { original, duplicate }, owner: owned };
      } finally { releaseSecond.resolve(); releaseChild.resolve(); }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function childCompletionNotice(scenario) {
  const root = await mkdtemp(join(tmpdir(), "harness-child-notice-")), probe = childNoticeProbe;
  const afterSend = Promise.withResolvers(), resume = Promise.withResolvers();
  try {
    return await withLoop((ctx) => mountSubagents(ctx, root), async (ctx, loop) => {
      await ctx.plugin(SubagentControl);
      ctx.tools.register(defineContentToolFixture({ name: "list_files", description: "show project files", parameters: {},
        async execute() { return blocks("project files"); } }));
      let steps = 0;
      ctx.llm.registerAdapter(["mock"], new Adapter(async function* (request) {
        const history = request.messages.map(plain);
        if (!history.some((text) => text.includes(probe.prompt))) { yield* reply("Received"); return; }
        if (++steps === 1) {
          const send = { id: "report", name: "send_message", args: { agent: "lead", message: probe.finding } };
          yield* childCalls(scenario.next === "tool" ? [send, { id: "later", name: "list_files", args: {} }] : [send]);
          return;
        }
        if (scenario.next === "input" && !history.some((text) => text.includes(probe.revision))) {
          afterSend.resolve();
          await resume.promise;
        }
        if (scenario.next === "structured") {
          yield* childCalls([{ id: "submit", name: "structured_output", args: probe.structured }]);
          return;
        }
        yield* reply(history.some((text) => text.includes(probe.revision)) ? probe.finalRevision : probe.finding);
      }));
      const parent = await loop.create(SessionId("child-notice"), options), signal = AbortSignal.timeout(6000);
      const started = await ctx.subagents.startActivation({ provider: "spawn", label: "continuity review", parent, signal,
        prompt: blocks(probe.prompt), delivery: "parent", ...(scenario.next === "structured" ? { outputSchema: probe.schema } : {}) });
      try {
        if (scenario.next === "input") {
          await afterSend.promise;
          await ctx.subagents.sendMessage(parent, started.childId, blocks(probe.revision), { signal });
          resume.resolve();
        }
        const child = await started.result;
        assert.equal(child.stopReason, "completed");
        if (scenario.next === "structured") {
          const { createSettlementMessage } = await import(pathToFileURL(join(process.cwd(), "packages/subagent/subagent/src/continuation-messages.ts")).href);
          const projected = createSettlementMessage(started.childId, started.name, { ...child, output: blocks(probe.finding) }, true, true);
          assert.ok(projected.content.some(({ text }) => text === "Structured result: " + JSON.stringify(probe.structured)));
          assert.ok(!projected.content.some(({ text }) => text === probe.finding));
        }
        await parent.whenIdle();
        const messages = parent.session.snapshotEvents().filter(({ type }) => type === "user/message");
        const notice = messages.find(({ data }) => data.source.kind === "subagent-settled");
        assert.ok(notice);
        const notices = notice.data.content.map(({ text }) => text);
        const structured = notices.find((text) => text?.startsWith("Structured result: "));
        return { reported: messages.filter(({ data }) => data.source.kind === "agent-message" && plain(data).includes(probe.finding)).length,
          closing: notices.includes(probe.finding) ? probe.finding : notices.includes(probe.finalRevision) ? probe.finalRevision : "",
          omitted: notices.some((text) => text?.includes("closing message is omitted")), structured: structured ? JSON.parse(structured.slice(19)) : null };
      } finally { resume.resolve(); }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function largeTools(scenario) {
  return withLoop(async () => {}, async (ctx, loop) => {
    const calls = largeBatchCalls(scenario.size), invoked = [];
    for (const name of ["probe_read", "probe_write"]) ctx.tools.register(defineContentToolFixture({
      name, description: "record a fixture operation", parameters: { value: { type: "number", required: true } },
      isConcurrencySafe: () => name === "probe_read",
      async execute({ value }) {
        if (value === 12) assert.deepEqual([...invoked].sort((a, b) => a - b), calls.slice(0, value).map(({ args }) => args.value));
        invoked.push(value);
        return blocks(String(value));
      },
    }));
    let received;
    ctx.llm.registerAdapter(["mock"], new Adapter(async function* (request) {
      const receipts = request.messages.filter(({ role }) => role === "tool");
      if (!receipts.length) { yield* childCalls(calls); return; }
      received = receipts.map((receipt) => [receipt.toolCallId, Number(plain(receipt))]);
      yield* reply("Finished the batch");
    }));
    const agent = await loop.create(SessionId("large-batch"), options);
    agent.followup(user("Run the whole batch"));
    await agent.whenIdle();
    assert.equal(agent.session.snapshotEvents().findLast(({ type }) => type === "turn/end").data.reason.kind, "completed");
    return { invoked: invoked.sort((a, b) => a - b), received };
  }, 3);
}

async function configuredChild(scenario) {
  const probe = childExecutionProbe;
  const root = await mkdtemp(join(tmpdir(), "harness-child-config-"));
  try {
    const cwd = join(root, probe.folder);
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, probe.file), probe.content);
    await writeFile(join(root, probe.file), "wrong directory");
    return await withLoop(async (ctx) => {
      await mountSubagents(ctx, join(root, "sessions"));
      await ctx.plugin(LocalFileSystem, { cwd: root });
      await ctx.plugin(ToolFs, { readImage: false, write: false, edit: false });
    }, async (ctx, loop) => {
      const trace = { model: "", scoped: false, read: false, requests: 0, ignored: 0 };
      ctx.tools.register(defineContentToolFixture({ name: "late_tool", description: "should not run", parameters: {},
        async execute() { trace.ignored++; return blocks("late"); } }));
      ctx.llm.registerAdapter(["mock"], new Adapter(async function* () { yield* reply("parent stays on mock"); }));
      ctx.llm.registerAdapter([probe.provider], new Adapter(async function* (request) {
        trace.model = request.model;
        trace.scoped = request.tools?.some(({ name }) => name === "structured_output") ?? false;
        const step = trace.requests++;
        if (step === 0) {
          yield* childCalls([{ id: "read-notes", name: "read", args: { file_path: probe.file } }]);
          return;
        }
        if (step === 1) {
          trace.read = plain(request.messages.findLast(({ role }) => role === "tool")).includes(probe.content);
          if (scenario.output !== "structured") { yield* reply(probe.plain); return; }
          yield* childCalls([{ id: "invalid", name: "structured_output", args: probe.invalid }]);
          return;
        }
        assert.equal(step, 2);
        assert.match(plain(request.messages.findLast(({ role }) => role === "tool")), /number/i);
        yield* childCalls([{ id: "valid", name: "structured_output", args: probe.output },
          { id: "late", name: "late_tool", args: {} }]);
      }));
      const parent = await loop.create(SessionId("child-config"), options);
      const before = ctx.workingDirectory.get(parent.session);
      const child = await ctx.subagents.startActivation({ provider: "spawn", label: "configured child", parent,
        prompt: blocks(childPrompt), cwd, agentOptions: { provider: probe.provider, model: probe.model },
        ...(scenario.output !== "text" ? { outputSchema: probe.schema } : {}), signal: AbortSignal.timeout(5000), delivery: "caller" });
      const result = await child.result;
      if (scenario.output !== "structured") assert.equal(result.output.map(({ text }) => text ?? "").join(""), probe.plain);
      return { ...trace, parentUnchanged: ctx.workingDirectory.get(parent.session) === before && parent.options.model === options.model,
        success: result.stopReason === "completed", structured: result.structured ?? null };
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function wireMessages() {
  const helpers = await import(pathToFileURL(join(process.cwd(), "packages/llm/llm-deepseek/tests/helpers.ts")).href);
  const restore = globalThis.fetch;
  let endpoint, receiptOrder;
  try {
    globalThis.fetch = async (url, init) => {
      endpoint = new URL(String(url)).pathname;
      receiptOrder = JSON.parse(init.body).messages.at(-1).content.map(({ type }) => type);
      return messagesResponse();
    };
    const history = messagesHistory;
    const assistant = createAssistantMessage({ source: { provider: "deepseek-official", model: "deepseek-flash" },
      content: [{ type: "tool-call", id: ToolCallId(history.callId), name: history.tool, arguments: "{}" }] });
    const result = await helpers.assemble(helpers.adapter({ baseURL: "https://api.deepseek.com/anthropic" }).stream(helpers.options({ model: "deepseek-flash", messages: [
      user(history.user), assistant, user(history.update), { role: "tool", toolCallId: ToolCallId(history.callId), content: blocks(history.result) },
    ] })), "deepseek-flash");
    const call = result.message.content.find((part) => part.type === "tool-call");
    return { endpoint, receiptOrder, text: plain(result.message), call: [call.id, call.name, JSON.parse(call.arguments)], finish: result.assembler.finish.kind };
  } finally { globalThis.fetch = restore; }
}

async function nativeHistory(thinking = false) {
  const helpers = await import(pathToFileURL(join(process.cwd(), "packages/llm/llm-deepseek/tests/helpers.ts")).href);
  const restore = globalThis.fetch, requests = [];
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(String(url)).pathname, "/anthropic/v1/messages");
      requests.push(JSON.parse(init.body));
      if (!thinking && requests.length === 2) return nativeAddedTool();
      return thinking && requests.length === 1 ? nativeThinking() : nativeReply();
    };
    return await withLoop(async () => {}, async (ctx, loop) => {
      const adapter = helpers.adapter({ baseURL: "https://api.deepseek.com/anthropic", thinking: thinking ? "enabled" : "disabled" });
      ctx.llm.registerAdapter(["deepseek-official"], adapter);
      let invoked = 0;
      const register = (name) => ctx.tools.register(defineContentToolFixture({ name, description: "Native probe", parameters: {},
        async execute() { invoked++; return blocks("Tool done"); } }));
      const remove = register("native_a");
      const agent = await loop.create(SessionId("native-history"), { provider: "deepseek-official", model: "deepseek-flash" });
      const send = async (text) => { agent.followup(user(text)); await agent.whenIdle(); };
      if (thinking) {
        await send(nativeScenarios[0]);
        assert.equal(invoked, 1);
        assert.equal(requests.length, 2);
        return nativeReplayTrace(requests);
      }
      await send(nativeScenarios[0]);
      register("native_b");
      ctx.systemPrompt.section({ name: "native-history-fixture", order: 100, text: "Report the result and wait for the next instruction." });
      await send(nativeScenarios[1]);
      await send(nativeScenarios[2]);
      remove();
      await send(nativeScenarios[3]);
      assert.equal(invoked, 1);
      assert.equal(requests.length, 5);
      assert.match(JSON.stringify(requests[1].messages.filter(({ role }) => role === "system")), /Report the result and wait/);
      return nativeUpdateTrace(requests);
    });
  } finally { globalThis.fetch = restore; }
}

async function filesReuse() {
  const helpers = await import(pathToFileURL(join(process.cwd(), "packages/llm/llm-deepseek/tests/helpers.ts")).href);
  const transport = imageTransportFixture(), restore = globalThis.fetch;
  const root = await mkdtemp(join(tmpdir(), "harness-provider-files-"));
  const attachment = { attachmentId: "sha256:" + "a".repeat(64), mediaType: "image/png", width: 1, height: 1, bytes: 3 };
  try {
    globalThis.fetch = transport.fetch;
    const attachments = helpers.requestImageStore(async () => ({ attachment, variantId: "sha256:" + "b".repeat(64),
      data: Uint8Array.of(1, 2, 3), bytes: 3, mediaType: "image/png", width: 1, height: 1, depth: "uchar", space: "srgb", hasAlpha: false }));
    for (let pass = 0; pass < 2; pass++) {
      const files = new DeepSeekFileStore({ index: new DeepSeekUploadIndex(join(root, "uploads.json")) });
      const model = helpers.adapter({ baseURL: "https://api.deepseek.com/anthropic" }, { resolveAttachments: () => attachments, resolveFiles: () => files,
        resolveImageAccess: () => ({ readonlyPath: "/fixture.png" }) });
      await helpers.assemble(model.stream(helpers.options({ model: "deepseek-flash",
        messages: [{ ...helpers.user(), content: [{ type: "image", attachment }] }] })), "deepseek-flash");
    }
    return transport.trace;
  } finally { globalThis.fetch = restore; await rm(root, { recursive: true, force: true }); }
}

async function referenceSnapshot() {
  const root = await mkdtemp(join(tmpdir(), "harness-session-reference-"));
  try {
    return await withLoop((ctx) => mountSubagents(ctx, root), async (ctx, loop) => {
      await ctx.plugin(SessionReferenceResolver);
      let captured = "";
      ctx.llm.registerAdapter(["mock"], new Adapter(async function* (request) {
        const notice = request.messages.find((message) => plain(message).includes("## Referenced sessions"));
        if (notice) captured = plain(notice);
        yield* reply("source reply");
      }));
      const sourceId = SessionId("source"), source = await loop.create(sourceId, options);
      source.followup(user("source original")); await source.whenIdle(); await ctx.sessions.flush(source.session);
      const target = await loop.create(SessionId("target"), options);
      const uri = Buffer.from(JSON.stringify(sourceId)).toString("base64url");
      target.followup(user(`read @[source](dsh-session:${uri})`)); await target.whenIdle();
      source.followup(user("later source edit")); await source.whenIdle(); await ctx.sessions.flush(source.session);
      target.followup(user("again")); await target.whenIdle();
      return { quoted: captured.includes("source original") && captured.includes("source reply"), frozen: !captured.includes("later source edit"), present: Boolean(captured) };
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function longReference(scenario) {
  const { buildWindow } = await import(pathToFileURL(join(process.cwd(), "packages/fs/tool-fs/src/read-render.ts")).href);
  const root = await mkdtemp(join(tmpdir(), "harness-long-reference-"));
  try {
    return await withLoop(async (ctx) => {
      await mountSubagents(ctx, join(root, "sessions"));
      await ctx.plugin(LocalFileSystem, { cwd: root });
      await ctx.plugin(ToolFs, { readImage: false, write: false, edit: false });
      await ctx.plugin(LocalSpillStore, { root: join(root, "spill"), cleanupPeriodDays: 0 });
      await ctx.plugin(SessionReferenceResolver, { maxReferenceBytes: referenceBudget });
    }, async (ctx, loop) => {
      let answer = "", phase = "source", capture = "", notices, pages = 0;
      ctx.llm.registerAdapter(["mock"], new Adapter(async function* (request) {
        if (phase === "capture") {
          capture = plain(request.messages.find(({ source }) => source?.kind === "session-reference"));
          yield* reply("Reference captured");
        } else if (phase === "read") {
          const context = plain(request.messages.find(({ source }) => source?.kind === "session-reference"));
          assert.equal(context, capture);
          const receipt = plain(request.messages.findLast(({ role }) => role === "tool"));
          const locator = notices[0].fullSnapshot.locator;
          const offset = pages ? Number(/Use offset=(\d+) to continue/.exec(receipt)?.[1]) : 1;
          if (pages) assert.ok(receipt.includes("<content>"));
          if (pages === 2) { yield* reply("Read both pages"); return; }
          assert.equal(offset, 1 + pages * referencePageSize);
          pages++;
          yield { type: "block-start", index: 0, blockType: "tool-call" };
          yield { type: "block-end", index: 0, block: { type: "tool-call", id: ToolCallId("page-" + pages), name: "read",
            arguments: JSON.stringify({ file_path: locator, offset, limit: referencePageSize }) } };
          yield { type: "finish", reason: { kind: "tool-calls" } };
        } else yield* reply(answer);
      }));
      const source = await loop.create(SessionId("source"), options), target = await loop.create(SessionId("target"), options);
      for (const [text, response] of scenario.turns) { answer = response; source.followup(user(text)); await source.whenIdle(); }
      await ctx.sessions.flush(source.session);
      phase = "capture";
      const uri = Buffer.from(JSON.stringify(source.id)).toString("base64url");
      target.followup(user(`Use @[source](dsh-session:${uri})`)); await target.whenIdle();
      assert.ok(capture.includes("## Reference omissions"));
      notices = JSON.parse(capture.split("\n").at(-1));
      assert.equal(notices.length, 1);
      assert.equal(notices[0].fullSnapshot.status, "saved");
      assert.equal(notices[0].omittedMessages, scenario.dropped);
      assert.ok(notices[0].omittedBytes > 0);
      assert.ok(!capture.includes(scenario.missing));
      phase = "source"; answer = "updated"; source.followup(user(referenceUpdate)); await source.whenIdle();
      await ctx.sessions.flush(source.session);
      phase = "read"; target.followup(user("Read the omitted setup")); await target.whenIdle();
      assert.equal(plain(target.session.deriveMessages().at(-1)), "Read both pages");
      const { locator } = notices[0].fullSnapshot, saved = await readFile(locator, "utf8"), lines = [];
      for (let offset = 1; ;) {
        const page = await buildWindow([saved], { offset, limit: 64, maxLineLength: 2000, maxBytes: 50 * 1024 }, locator);
        assert.equal(page.lines[0].number, offset);
        lines.push(...page.lines.map(({ text }) => text));
        offset += page.lines.length;
        if (offset > page.totalLines) break;
      }
      assert.deepEqual(decodeReferenceTranscript(lines), expectedReferenceMessages(scenario));
      return { omitted: !capture.includes(scenario.missing), frozen: !saved.includes(referenceUpdate), exact: true, pages, dropped: notices[0].omittedMessages };
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function sessionMetrics() {
  return withLoop(async () => {}, async (ctx, loop) => {
    const { sessionStatsProjectionDefinition: projection } = await import(pathToFileURL(join(process.cwd(), "packages/session/session-stats/src/projection.ts")).href);
    ctx.llm.registerAdapter(["mock"], new Adapter(async function* () {
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
      yield* reply("answer");
    }));
    const agent = await loop.create(SessionId("metrics"), options);
    for (const text of ["first", "second"]) { agent.followup(user(text)); await agent.whenIdle(); }
    const result = agent.session.snapshotEvents().reduce((state, event) => projection.apply(state, event), projection.init());
    return { turns: result.turns, steps: result.steps, ttftSteps: result.ttftSteps, output: result.decodeTokens };
  });
}

function requestRecords() {
  return withLoop(async () => {}, async (ctx, loop) => {
    const history = [], values = Object.values(requestReplay);
    ctx.llm.registerAdapter(["mock"], new Adapter(async function* (request) {
      history.push(request.messages.map(plain).filter((value) => values.includes(value)));
      yield* reply(requestReplay.answer);
    }));
    const agent = await loop.create(SessionId("request-records"), options);
    for (const text of [requestReplay.first, requestReplay.second]) { agent.followup(user(text)); await agent.whenIdle(); }
    const headers = agent.session.snapshotEvents().filter(({ type }) => type === "request/header").length;
    return { history, headers };
  });
}

async function routedCompaction(scenario) {
  const { resolveConfig, resolveTargetPolicy, resolveCompactSpec } = await import(pathToFileURL(join(process.cwd(), "packages/compaction/compaction-basic/src/config.ts")).href);
  const routes = compactRoutes(scenario);
  const modelPolicies = Object.entries(routes).map(([provider, { baseUrl, contextWindow, ...policy }]) => ({ provider, ...policy }));
  const config = { modelPolicies };
  const { thresholdTokens, retainTokens } = resolveCompactSpec(resolveTargetPolicy(resolveConfig(config), {
    provider: scenario.final, model: "deepseek-flash",
  }), routes[scenario.final].contextWindow, compactOutputTokens);
  const trace = [];
  return withLoop(async (ctx) => {
    await ctx.plugin(TokenMeter);
    await ctx.plugin(BasicCompactionEngine, config);
  }, async (ctx, loop) => {
    let seeded = false, response = "";
    class RoutedAdapter extends Adapter {
      async resolveModel(provider, model) { return { provider, id: model, name: model, defaultMaxTokens: compactOutputTokens,
        context: { contextWindow: routes[provider].contextWindow } }; }
    }
    ctx.llm.registerAdapter(Object.keys(routes), new RoutedAdapter(async function* (request) {
      const summary = request.purpose === "compaction";
      if (!seeded) { assert.equal(summary, false, "history pressure must wait for the intended step"); yield* reply(response); return; }
      trace.push({ summary, route: request.provider, maxTokens: request.maxTokens ?? compactOutputTokens,
        markers: compactMarkerTrace(request.messages.map(plain).join("\n")) });
      if (summary && scenario.state === "rejected") { yield failure("AUTH"); return; }
      yield* reply(summary ? compactMemo : "Completed");
    }));
    const agent = await loop.create(SessionId("routed-compaction"), { provider: scenario.start, model: "deepseek-flash", maxTokens: compactOutputTokens });
    for (const [text, answer] of compactHistory) {
      response = answer; agent.followup(user(text)); await agent.whenIdle();
    }
    seeded = true;
    if (scenario.final !== scenario.start) agent.model.select({ provider: scenario.final, model: "deepseek-flash", maxTokens: compactOutputTokens });
    agent.followup(user(compactLatest)); await agent.whenIdle();
    const events = agent.session.snapshotEvents(), end = events.findLast(({ type }) => type === "turn/end")?.data.reason;
    return { thresholdTokens, retainTokens, trace, code: end?.error?.code ?? end?.kind,
      summaries: events.filter(({ type }) => type === "compaction/summary").length,
      oldRetained: agent.session.deriveMessages().some((message) => plain(message).includes("[OLD-ANSWER]")) };
  });
}

export async function referenceRecoveryScenarios() {
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
