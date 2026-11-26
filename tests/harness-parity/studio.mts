import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteDatabase } from "../../server/storage";
import { Store } from "../../lib/studio/store";
import { advanceRun } from "../../lib/studio/engine";
import { tool } from "../../lib/studio/file-tools";
import { retainContent } from "../../lib/studio/harness/retention";
import { DEFAULT_SETTINGS } from "../../lib/studio/types";
import { ModelRequestError } from "../../lib/studio/providers";
import { settleModelMessage } from "../../lib/studio/model-stream";
import { AppError } from "../../lib/studio/security";
import { estimateMessageTokens, retainedContextBoundary } from "../../lib/studio/context-tokens";
import { boundaryTypes, cases, compactionCases, receiptCode, retentionMatrix, toolResult, tools } from "./scenarios.mjs";
import { studioRecoveryScenarios } from "./recovery-studio.mts";

const settings = { ...DEFAULT_SETTINGS, textApiKey: "fixture" };
const receipt = (id, content) => {
  const data = JSON.parse(content);
  return [id, data.code ? { code: receiptCode(data.code) } : data];
};
async function run(scenario) {
  const folder = scenario.crash ? await mkdtemp(join(tmpdir(), "doman-harness-recovery-")) : undefined;
  const filename = folder ? join(folder, "studio.sqlite") : ":memory:";
  let db = new SQLiteDatabase(filename);
  db.initialize("drizzle");
  try {
    const requests = [], invoked = [], resolved = [];
    const secondRead = Promise.withResolvers();
    let store = new Store(db, { tools: scenario.wait ? undefined : tools.map((definition) => ({
      schema: tool(definition.name, definition.name, { value: { type: "number" } }),
      label: definition.name, mode: definition.parallel ? "parallel" : undefined, timeoutMs: definition.timeoutMs,
      async execute({ run, store, signal }, id, args) {
        invoked.push(id);
        if (scenario.barrier && id === "z") await secondRead.promise;
        const result = await toolResult(definition, args, signal, () => {
          if (scenario.crash) throw new AppError("fixture crash", 409, "RUN_STOPPED");
          return store.controlTree(run, "cancel");
        });
        resolved.push(id);
        if (scenario.barrier && id === "a") secondRead.resolve();
        return { result, concludesTurn: definition.concludes, additionalContexts: definition.deferred
          ? [{ role: "user", source: { kind: "tool-context" }, content: "read-only note" }] : undefined };
      },
    })) });
    const project = await store.createProject("local", {});
    const input = (text) => ({ requestId: crypto.randomUUID(), text, attachmentIds: [] });
    await store.acceptChat(project.id, input("start"));
    let turn = (await store.snapshot(project.id, "local")).runs.find((run) => !run.parentRunId);
    assert.ok(turn);
    for (let i = 0; i < scenario.responses.length * 5 + 6; i++) {
      const run = await advanceRun(store, project, turn.id, settings, undefined, async (_system, messages, offered) => {
        const response = scenario.responses[requests.length];
        assert.ok(response, `unexpected model request in ${scenario.name}`);
        requests.push({
          users: messages.filter((m) => m.role === "user" && !m.source).map((m) => m.content),
          receipts: messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
          reminders: messages.filter((m) => m.role === "user" && m.source?.kind === "repeat-tool-reminder").map((m) => m.source.count),
          ...(scenario.order ? { tools: offered.map(({ function: schema }) => schema.name) } : {}),
          ...(scenario.deferred ? { contextOrder: messages.flatMap((m) => m.role === "tool" ? ["tool:" + m.tool_call_id] :
            m.role === "user" && m.source?.kind === "tool-context" ? ["note:" + m.content] : []) } : {}),
        });
        if (scenario.steer && requests.length === 1) {
          const queued = input("corrected input");
          await store.acceptChatAtStep(project.id, queued);
          await store.acceptChatAtStep(project.id, queued);
        }
        if (scenario.followup && requests.length === 1) await store.enqueueChat(project.id, input("second input"));
        if (response.failure) {
          const code = { SERVER: "MODEL_UNAVAILABLE", RATE_LIMIT: "MODEL_RATE_LIMIT", AUTH: "MODEL_AUTH" }[response.failure];
          throw new ModelRequestError("test provider failure", { SERVER: 502, RATE_LIMIT: 429, AUTH: 401 }[response.failure], code, response.retryAfter);
        }
        if (response.maxTokens) return settleModelMessage(response.text, [], "length");
        return { role: "assistant", content: response.text,
          tool_calls: response.calls?.map((call) => ({ id: call.id, type: "function", function: {
            name: call.name === "wait_agent" ? "wait_for_input" : call.name, arguments: JSON.stringify(call.args) } })),
        };
      });
      if (scenario.crash && invoked.includes("lost")) {
        assert.equal(run.status, "running");
        db.prepare("UPDATE runs SET lease_until=?,lease_owner=? WHERE id=?").bind(Date.now() + 60000, 2147483647, run.id).rows();
        db.close();
        db = new SQLiteDatabase(filename);
        db.initialize("drizzle");
        db.releaseAbandonedLeases({ interruptAgentTurns: true });
        store = new Store(db);
        await store.recoverStoppedExecutions();
        break;
      }
      if (run.status === "waiting" && run.nextAttemptAt) {
        await db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=?").bind(run.id).run();
      }
      if (scenario.wait && run.status === "waiting" && run.payload.agent.waitingForInputUntil && requests.length === 1)
        await store.acceptChatAtStep(project.id, input("delivered during wait"));
      if (run.status === "done" && scenario.followup && requests.length < scenario.responses.length) {
        await store.promoteQueuedChats(1);
        turn = (await store.snapshot(project.id, "local")).runs.find((entry) => entry.status === "queued");
        assert.ok(turn);
        continue;
      }
      if (["done", "cancelled", "failed"].includes(run.status)) break;
    }
    assert.equal(requests.length, scenario.responses.length, scenario.name);
    const events = db.prepare(`SELECT type,data FROM events WHERE project_id=? AND
      type IN ('turn/start','step/start','step/end','turn/end','step') ORDER BY id`).bind(project.id).rows();
    const timeline = events.flatMap(({ type, data }) => {
      const event = JSON.parse(data);
      if (type === "step" && event.status && event.status !== "running") return ["tool/result:" + event.callId];
      if (!boundaryTypes.includes(type)) return [];
      return [type === "turn/end" ? type + ":" + event.reason.kind : type];
    });
    let inherited;
    if (scenario.fork) {
      await store.acceptChat(project.id, input("fork from the parent"));
      const parent = (await store.snapshot(project.id, "local")).runs.find(({ status }) => status === "queued");
      assert.ok(parent && await store.claimRun(parent.id, project.id));
      const { task_id } = await store.startChild(await store.run(parent.id, project.id), "fork", "writer", "Continue", undefined, true);
      const child = await store.run(task_id, project.id);
      inherited = child.payload.agent?.messages.filter(({ role }) => role === "tool").map(({ tool_call_id, content }) => receipt(tool_call_id, content));
      await store.releaseLease(await store.run(parent.id, project.id));
    }
    const answers = (await store.modelCalls(project.id)).filter(({ status }) => status === "completed")
      .map(({ response }) => JSON.parse(response).content).filter(Boolean);
    if (scenario.crash) {
      const stopped = await store.run(turn.id, project.id);
      assert.equal(stopped.errorCode, "SESSION_INTERRUPTED");
      await store.resumeInterruptedAgentRuns();
      const resumed = await store.run(turn.id, project.id);
      assert.equal(resumed.status, "queued");
      assert.equal(resumed.generation, stopped.generation + 1);
      const continued = await advanceRun(store, project, turn.id, settings, undefined, async (_system, messages) => {
        const recovered = messages.filter(({ role }) => role === "tool").map(({ tool_call_id, content }) => receipt(tool_call_id, content));
        assert.deepEqual(recovered, [["committed", { value: 0 }], ["lost", { code: "TOOL_OUTCOME_UNKNOWN" }], ["never", { code: "TOOL_NOT_STARTED" }]]);
        return { role: "assistant", content: "cold resume complete" };
      });
      assert.equal(continued.resultText, "cold resume complete");
    }
    return {
      requests, invoked, resolved, timeline, ...(scenario.fork ? { inherited } : {}),
      receipts: db.prepare("SELECT call_id,result FROM execution_steps WHERE run_id=? AND finished_at IS NOT NULL ORDER BY seq")
        .bind(turn.id).rows().map(({ call_id, result }) => receipt(call_id, result)),
      answers,
    };
  } finally {
    db.close();
    if (folder) await rm(folder, { recursive: true, force: true });
  }
}

const compaction = compactionCases.map(({ nodes, retain }) => {
  const messages = nodes.map(([role, tokens, calls]) => {
    const message = { role, content: "", tool_calls: Array.isArray(calls) ? calls.map((id) => ({ id, type: "function", function: { name: "probe", arguments: "{}" } })) : undefined,
      tool_call_id: typeof calls === "string" ? calls : undefined };
    message.content = "a".repeat(4 * (tokens - estimateMessageTokens(message)));
    assert.equal(estimateMessageTokens(message), tokens);
    return message;
  });
  return retainedContextBoundary(messages, retain);
});
const result = { scenarios: {}, retention: retentionMatrix(retainContent), compaction };
for (const scenario of cases) result.scenarios[scenario.name] = await run(scenario);
Object.assign(result.scenarios, await studioRecoveryScenarios());
const { studioExtensions } = await import("./extensions-studio.mts");
Object.assign(result.scenarios, await studioExtensions());
process.stdout.write(JSON.stringify(result));
