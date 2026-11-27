import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import { LlmAdapter, ToolCallId, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from "@deepseek-ai/dsh-agent-loop-testkit";
import { defineContentToolFixture } from "@deepseek-ai/dsh-tool-testkit";
import Goal from "@deepseek-ai/dsh-goal";
import * as GoalDriver from "@deepseek-ai/dsh-goal-round-driver";
import * as Todo from "@deepseek-ai/dsh-tool-todo";
import * as Ask from "@deepseek-ai/dsh-tool-ask-user";
import Questions, { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
import Approval from "@deepseek-ai/dsh-user-approval";
import Plan from "@deepseek-ai/dsh-plan-mode";
import { approvalCall, planCall, questionCall, textReply, todoCall, workflowCases as cases } from "./workflow-cases.mjs";

const text = (blocks) => blocks.filter(({ type }) => type === "text").map(({ text }) => text).join("");
const user = (value) => createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: value }] });
const waitFor = async (probe) => {
  for (let i = 0; i < 500; i++) {
    const value = await probe(); if (value) return value;
    await delay(5);
  }
  throw new Error("workflow fixture did not settle");
};

async function run(name, script, plugins, action) {
  const ctx = new Context();
  const requests = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(options) {
      const index = requests.push(options) - 1;
      const answer = typeof script[index] === "function" ? script[index](options) : script[index];
      assert.ok(answer, "unexpected model request: " + name + " " + index);
      let block = 0;
      if (answer.text !== null) {
        yield { type: "block-start", index: block, blockType: "text" };
        yield { type: "block-end", index: block++, block: { type: "text", text: answer.text } };
      }
      for (const call of answer.calls ?? []) {
        const id = ToolCallId(call.id), args = JSON.stringify(call.args);
        yield { type: "block-start", index: block, blockType: "tool-call" };
        yield { type: "tool-call-delta", index: block, id, name: call.name, argumentsDelta: args };
        yield { type: "block-end", index: block++, block: { type: "tool-call", id, name: call.name, arguments: args } };
      }
      yield { type: "finish", reason: { kind: answer.maxTokens ? "max-tokens" : answer.calls?.length ? "tool-calls" : "stop" } };
    }
  }
  try {
    await mountAgentLoopTestDependencies(ctx);
    await plugins(ctx);
    const loop = await mountAgentLoopTestHarness(ctx);
    ctx.llm.registerAdapter(["mock"], new Adapter());
    const agent = await loop.create(SessionId("workflow-" + name), { provider: "mock", model: "mock" });
    return await action(ctx, agent, requests);
  } finally { await ctx.fiber.dispose(); }
}

export async function referenceWorkflowScenarios() {
  const result = {};
  const goalPlugins = async (ctx) => { await ctx.plugin(Goal); await ctx.plugin(GoalDriver); };
  const { goal, goalTruncated, todos, question, timed, longWait, plan, planQueued, dismiss, approval } = cases;
  result[goal.name] = await run("goal", [textReply(), textReply()], goalPlugins, async (ctx, agent) => {
    ctx.goals.create(agent, { objective: goal.objective, maxGoalRounds: goal.rounds });
    const capped = await waitFor(() => { const value = ctx.goals.get(agent); return value?.phase === "blocked" && value; });
    const reduced = ctx.goals.edit(agent, capped, { maxGoalRounds: 1 });
    const completed = ctx.goals.complete(agent, reduced);
    const renamed = ctx.goals.edit(agent, completed, { objective: "verified delivery" });
    const rounds = agent.session.snapshotEvents().flatMap(({ type, data }) =>
      type === "user/message" && data.source.kind === "goal" && data.source.round > 0 ? [data.source.round] : []);
    return { rounds, blocked: capped.blockedReason?.code, reduced: [reduced.maxGoalRounds, reduced.roundsStarted],
      completed: [renamed.phase, renamed.objective] };
  });
  result[goalTruncated.name] = await run("truncated", [textReply("partial", true)], goalPlugins, async (ctx, agent, requests) => {
    ctx.goals.create(agent, { objective: goalTruncated.objective, maxGoalRounds: goalTruncated.rounds });
    const stopped = await waitFor(() => { const value = ctx.goals.get(agent); return value?.activation === "disarmed" && value; });
    return { requests: requests.length, rounds: stopped.roundsStarted, phase: stopped.phase, armed: false };
  });
  result[todos.name] = await run("todos", [todoCall(0), todoCall(1), textReply(), textReply()], async (ctx) => {
    await ctx.plugin(Todo, { allowParallelInProgress: true });
  }, async (ctx, agent, requests) => {
    const projected = () => ctx.sessionProjections.snapshot(agent.session).values.todos;
    agent.followup(user(todos.input)); await agent.whenIdle();
    const after = await projected();
    let observed;
    const remove = ctx.on("agent/inbox/inserted", ({ agent: sender }) => {
      if (sender === agent) observed = projected();
    });
    agent.followup(user(todos.next)); await agent.whenIdle(); remove();
    return { beforeSecondTurn: await observed, after, next: await projected(), requests: requests.length };
  });
  result[question.name] = await run("question", [questionCall(), textReply()], async (ctx) => {
    await ctx.plugin(Questions); await ctx.plugin(Ask);
  }, async (ctx, agent, requests) => {
    const asked = Promise.withResolvers(), answer = Promise.withResolvers();
    ctx.on("user-questions/request", (request) => { asked.resolve(request); return answer.promise; });
    agent.followup(user(question.input));
    await waitFor(async () => Promise.race([asked.promise, delay(1)]));
    const before = requests.length;
    answer.resolve({ answers: question.answers });
    await agent.whenIdle();
    const receipt = agent.session.snapshotEvents().find((event) => event.type === "tool/result");
    return { before, receipt: JSON.parse(text(receipt.data.message.content)), requests: requests.length };
  });
  result[timed.name] = await run("timed", [questionCall(), textReply("independent"), textReply("late")], async (ctx) => {
    await ctx.plugin(Questions); await ctx.plugin(Ask, { mode: "timed", timeout: timed.timeout });
  }, async (ctx, agent, requests) => {
    agent.followup(user(timed.input)); await agent.whenIdle();
    const receipt = agent.session.snapshotEvents().find((event) => event.type === "tool/result");
    const pending = JSON.parse(text(receipt.data.message.content));
    assert.equal(ctx.userQuestions.answer(agent, ToolCallId("question"), { answers: question.answers }), true);
    await agent.whenIdle();
    const reply = requests.at(-1).messages.findLast((message) => message.role === "user" && message.source.kind === "user-question-reply");
    return { pending: pending.pending, call: pending.callId, late: JSON.parse(text(reply.content)).answers, requests: requests.length };
  });
  result[longWait.name] = await run("long-wait", [
    questionCall({ timeout: longWait.timeout }), textReply(),
  ], async (ctx) => {
    await ctx.plugin(Questions); await ctx.plugin(Ask, { mode: "timed", timeout: timed.timeout });
  }, async (ctx, agent) => {
    let offered = false;
    ctx.on("user-questions/request", () => { offered = true; return Promise.resolve({ answers: question.answers }); });
    agent.followup(user(question.input)); await agent.whenIdle();
    return { offered };
  });
  result[planQueued.name] = await run("plan-queued", [textReply()], async (ctx) => {
    await ctx.plugin(Plan, { section: "Plan fixture policy." });
  }, async (ctx, agent, requests) => {
    let selected;
    ctx.on("agent/inbox/inserted", ({ agent: sender }) => {
      if (sender === agent) {
        const outcome = ctx.planMode.set(agent, true);
        selected = { active: ctx.planMode.get(agent).active, committed: outcome === "committed" };
      }
    });
    agent.followup(user(planQueued.input)); await agent.whenIdle();
    return { ...selected, firstRequestActive: text(requests[0].messages[0].content).includes("Plan fixture policy.") };
  });
  result[plan.name] = await run("plan", [planCall(0), planCall(1), textReply()], async (ctx) => {
    await ctx.plugin(Questions); await ctx.plugin(Plan, { section: "Plan fixture policy." });
  }, async (ctx, agent, requests) => {
    const authored = [];
    ctx.on("user-questions/request", ({ questions }) => {
      const [request] = questions; authored.push(request.detail);
      return Promise.resolve({ answers: [{ id: request.id, selected: [request.options[0].label],
        ...(authored.length === 1 ? { custom: plan.feedback } : {}) }] });
    });
    ctx.planMode.set(agent, true);
    agent.followup(user(plan.input)); await agent.whenIdle();
    const events = agent.session.snapshotEvents();
    const receipts = events.filter((event) => event.type === "tool/result");
    const exit = events.findLast((event) => event.type === "plan/mode" && !event.data.active);
    const ordered = exit.seq < events.findLast((event) => event.type === "request/header").seq;
    return { ordered, presented: authored, firstFeedback: text(receipts[0].data.message.content).includes(plan.feedback),
      requestModes: requests.map(({ messages }) => text(messages[0].content).includes("Plan fixture policy.")),
      offersExit: requests.map(({ tools }) => tools.some(({ name }) => name === "exit_plan_mode")), finalActive: ctx.planMode.get(agent).active };
  });
  result[dismiss.name] = await run("dismiss-plan", [planCall(0), textReply()], async (ctx) => {
    await ctx.plugin(Questions); await ctx.plugin(Plan, { section: "Plan fixture policy." });
  }, async (ctx, agent, requests) => {
    const asked = Promise.withResolvers(), decision = Promise.withResolvers();
    ctx.on("user-questions/request", (request) => { asked.resolve(request); return decision.promise; });
    ctx.planMode.set(agent, true);
    agent.followup(user(plan.input));
    await waitFor(() => Promise.race([asked.promise, delay(1)]));
    decision.reject(new UserQuestionError("user dismissed the review", "ASK_CANCELLED"));
    agent.followup(user(dismiss.next)); await agent.whenIdle();
    const turns = agent.session.snapshotEvents().filter(({ type }) => type === "turn/start").length;
    const last = requests.at(-1);
    return { turns, requests: requests.length, next: last.messages.some((message) => text(message.content) === dismiss.next),
      active: ctx.planMode.get(agent).active };
  });
  result[approval.name] = await run("approval", [approvalCall(0), approvalCall(1), textReply()], async (ctx) => {
    await ctx.plugin(Approval);
    ctx.tools.register(defineContentToolFixture({ name: "approval_probe", description: "probe", parameters: {},
      async execute(_args, exec) {
        const outcome = await ctx.approval.request({ agent: exec.agent, callId: exec.callId, toolName: "approval_probe", reason: approval.reason, signal: exec.signal });
        return [{ type: "text", text: outcome }];
      } }));
  }, async (ctx, agent, requests) => {
    const asked = Promise.withResolvers(), decision = Promise.withResolvers();
    ctx.on("approval/request", (request) => { asked.resolve(request); return decision.promise; });
    agent.followup(user(approval.input));
    await waitFor(() => Promise.race([asked.promise, delay(1)]));
    ctx.approval.setPolicy(agent, "never");
    const before = requests.length;
    decision.resolve("allowed-once");
    await agent.whenIdle();
    return { before, outcomes: agent.session.snapshotEvents().flatMap(({ type, data }) => type === "approval/decided" ? [data.outcome] : []), requests: requests.length };
  });
  return result;
}
