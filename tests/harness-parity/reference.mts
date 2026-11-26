import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { LlmAdapter, ToolCallId, createUserMessage, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { SessionId, interruptedTurnClosers } from "@deepseek-ai/dsh-session";
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from "@deepseek-ai/dsh-agent-loop-testkit";
import { defineContentToolFixture } from "@deepseek-ai/dsh-tool-testkit";
import { boundaryTypes, cases, compactionCases, receiptCode, retentionMatrix, toolResult, tools } from "./scenarios.mjs";
import { referenceRecoveryScenarios } from "./recovery-reference.mts";

const source = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href);
const [timeout, repeat, { retainContent }, retry, fork, wait, { selectCompactableRange }] = await Promise.all([
  source("packages/guard/timeout-policy/src/index.ts"),
  source("packages/guard/repeat-tool-reminder/src/index.ts"),
  source("packages/spill/spill-policy/src/retention.ts"),
  source("packages/llm/llm-retry/src/index.ts"),
  source("packages/subagent/subagent-fork-in-process/src/index.ts"),
  source("packages/subagent/tool-subagent-control/src/wait-agent.ts"),
  source("packages/compaction/compaction-basic/src/region.ts"),
]);
const user = (text: string) => createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] });
const text = (blocks) => blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
const receipt = (data) => [data.message.toolCallId, data.message.isError
  ? { code: receiptCode(data.error?.code) } : JSON.parse(text(data.message.content))];

async function run(scenario) {
  const ctx = new Context();
  const requests = [], invoked = [], resolved = [];
  const secondRead = Promise.withResolvers();
  let agent, crashPrefix;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    providerRetryPolicy() { return resolveRetryPolicy(undefined, "parity"); }
    async *stream(options) {
      const response = scenario.responses[requests.length];
      assert.ok(response, `unexpected model request in ${scenario.name}`);
      requests.push({
        users: options.messages.filter((m) => m.role === "user" && m.source.kind === "user").map((m) => text(m.content)),
        receipts: options.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId),
        reminders: options.messages.filter((m) => m.role === "user" && m.source.kind === "repeat-tool-reminder").map((m) =>
          Number(m.source.summary.split("×").at(-1).trim())),
        ...(scenario.order ? { tools: options.tools.map(({ name }) => name) } : {}),
        ...(scenario.deferred ? { contextOrder: options.messages.flatMap((m) => m.role === "tool" ? ["tool:" + m.toolCallId] :
          m.role === "user" && m.source.kind === "tool-context" ? ["note:" + text(m.content)] : []) } : {}),
      });
      if (scenario.steer && requests.length === 1) agent.steer(user("corrected input"));
      if (scenario.followup && requests.length === 1) agent.followup(user("second input"));
      if (response.failure) {
        yield { type: "finish", reason: { kind: "error", failure: { code: response.failure,
          message: "test provider failure", ...(response.retryAfter ? { providerRetryAfterMs: response.retryAfter } : {}) } } };
        return;
      }
      let index = 0;
      if (response.text !== null) {
        yield { type: "block-start", index, blockType: "text" };
        yield { type: "text-delta", index, text: response.text };
        yield { type: "block-end", index, block: { type: "text", text: response.text } };
        index++;
      }
      for (const call of response.calls ?? []) {
        const id = ToolCallId(call.id), args = JSON.stringify(call.args);
        yield { type: "block-start", index, blockType: "tool-call" };
        yield { type: "tool-call-delta", index, id, name: call.name, argumentsDelta: args };
        yield { type: "block-end", index, block: { type: "tool-call", id, name: call.name, arguments: args } };
        index++;
      }
      yield { type: "finish", reason: { kind: response.maxTokens ? "max-tokens" : response.calls?.length ? "tool-calls" : "stop" } };
    }
  }
  try {
    await mountAgentLoopTestDependencies(ctx);
    await ctx.plugin(timeout);
    await ctx.plugin(repeat, { thresholds: [3, 5, 8] });
    const loop = await mountAgentLoopTestHarness(ctx);
    await ctx.plugin(retry);
    if (scenario.wait) {
      wait.registerWaitAgent(ctx);
      ctx.on("tools/execute", (exec, next) => {
        if (exec.name === "wait_agent") setImmediate(() => agent.steer(user("delivered during wait")));
        return next();
      });
    }
    ctx.llm.registerAdapter(["mock"], new Adapter());
    for (const definition of tools) {
      ctx.tools.register(defineContentToolFixture({
        name: definition.name, description: definition.name,
        parameters: { value: { type: "number" } },
        ...(definition.parallel ? { isConcurrencySafe: () => true } : {}),
        ...(definition.timeoutMs ? { timeoutMs: definition.timeoutMs } : {}),
        async execute(args, exec) {
          invoked.push(exec.callId);
          if (scenario.barrier && exec.callId === "z") await secondRead.promise;
          const result = await toolResult(definition, args, exec.signal, async () => {
            if (scenario.crash) crashPrefix = agent.session.snapshotEvents();
            agent.cancel({ kind: "user" }, { keepInbox: true });
          });
          resolved.push(exec.callId);
          if (scenario.barrier && exec.callId === "a") secondRead.resolve();
          if (definition.concludes) exec.concludeTurn();
          if (definition.deferred) exec.deferContext(createUserMessage({ source: { kind: "tool-context", form: "notice", summary: "test note" },
            content: [{ type: "text", text: "read-only note" }] }));
          return [{ type: "text", text: JSON.stringify(result) }];
        },
      }));
    }
    agent = await loop.create(SessionId("parity"), { provider: "mock", model: "mock" });
    agent.followup(user("start"));
    await agent.whenIdle();
    assert.equal(requests.length, scenario.responses.length, scenario.name);
    const events = crashPrefix ? [...crashPrefix, ...interruptedTurnClosers(crashPrefix)] : agent.session.snapshotEvents();
    let inherited;
    if (scenario.fork) {
      let provider;
      fork.apply({ subagents: { registerProvider(value) { provider = value; } } }, { providerName: "fork" });
      const { seed } = await provider.prepareContinuable({ parent: agent });
      inherited = seed.filter(({ type }) => type === "tool/result").map(({ data }) => receipt(data));
    }
    return {
      requests, invoked, resolved, ...(scenario.fork ? { inherited } : {}),
      timeline: events.filter(({ type }) => [...boundaryTypes, "tool/result"].includes(type)).map(({ type, data }) =>
        type === "turn/end" ? type + ":" + data.reason.kind : type === "tool/result" ? type + ":" + data.message.toolCallId : type),
      receipts: events.filter(({ type }) => type === "tool/result").map(({ data }) => receipt(data)),
      answers: events.filter(({ type }) => type === "assistant/message").map(({ data }) => text(data.message.content)).filter(Boolean),
    };
  } finally { await ctx.fiber.dispose(); }
}

const compaction = compactionCases.map(({ nodes, retain }) => {
  const surface = nodes.map((_, index) => index);
  const events = nodes.map(([role, , calls], seq) => ({ seq,
    type: role === "tool" ? "tool/result" : role + "/message",
    data: { message: { content: Array.isArray(calls) ? calls.map(() => ({ type: "tool-call" })) : [] } },
  }));
  const range = selectCompactableRange({ surface: { nodes: surface, replaceGeneration: 0 }, eventAt: (seq) => events[seq] },
    { nodes: nodes.map(([, tokens], seq) => ({ seq, tokens })) }, retain);
  return range ? Number(range.end) + 1 : 0;
});
const result = { scenarios: {}, retention: retentionMatrix(retainContent), compaction };
for (const scenario of cases) result.scenarios[scenario.name] = await run(scenario);
Object.assign(result.scenarios, await referenceRecoveryScenarios());
const { referenceExtensions } = await import("./extensions-reference.mts");
Object.assign(result.scenarios, await referenceExtensions());
process.stdout.write(JSON.stringify(result));
