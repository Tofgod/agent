import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { SQLiteDatabase } from "../../server/storage";
import { Store } from "../../lib/studio/store";
import { advanceRun } from "../../lib/studio/engine";
import { tool } from "../../lib/studio/file-tools";
import { DEFAULT_SETTINGS, type AgentMessage } from "../../lib/studio/types";
import { approvalCall, planCall, questionCall, textReply, todoCall, workflowCases as cases } from "./workflow-cases.mjs";

const settings = { ...DEFAULT_SETTINGS, textApiKey: "fixture" };

async function run(name, script, options, action) {
  const db = new SQLiteDatabase(":memory:"); db.initialize("drizzle");
  const store = new Store(db, options), project = await store.createProject("local", {}), scope = { projectId: project.id };
  const requests = [];
  const send = (text) => store.acceptChatAtStep(project.id, { requestId: crypto.randomUUID(), text, attachmentIds: [] });
  const view = () => store.workflow.view(scope);
  const step = async () => {
    const jobs = await store.dueRuns();
    for (const { id } of jobs) {
      const run = await advanceRun(store, project, id, settings, undefined, async (system, messages, tools) => {
        const index = requests.push({ system, messages, tools }) - 1;
        const answer = typeof script[index] === "function" ? script[index]({ system, messages, tools }) : script[index];
        assert.ok(answer, "unexpected model request: " + name + " " + index);
        return { role: "assistant", content: answer.text, ...(answer.maxTokens ? { finishReason: "max-tokens" } : {}),
          tool_calls: answer.calls?.map(({ id, name, args }) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } })) } as AgentMessage;
      });
      assert.notEqual(run.status, "failed", run.error);
    }
    return jobs.length;
  };
  const drive = async () => {
    for (let i = 0; i < 50; i++) if (!await step()) return;
    assert.fail("workflow did not settle: " + name);
  };
  try { return await action({ store, scope, send, view, step, drive, requests }); }
  finally { db.close(); }
}

const attempt = async (action) => { try { return await action(); } catch { return null; } };
const update = (store, scope, goal, action, extra = {}) =>
  store.workflow.updateGoal(scope, { goal_id: goal.id, revision: goal.revision, action, ...extra });
const lastTool = (requests) => requests.at(-1).messages.findLast(({ role }) => role === "tool");
export async function studioWorkflowScenarios() {
  const result = {};
  const { goal, goalTruncated, todos, question, timed, longWait, plan, planQueued, dismiss, approval } = cases;
  result[goal.name] = await run("goal", [textReply(), textReply()], {}, async ({ store, scope, view, drive }) => {
    await store.workflow.createGoal(scope, goal.objective, goal.rounds);
    await drive();
    const capped = view().goal;
    const reduced = await attempt(() => update(store, scope, capped, "edit", { max_goal_rounds: 1 }));
    const completed = await update(store, scope, reduced ?? capped, "complete");
    const renamed = await attempt(() => update(store, scope, completed, "edit", { objective: "verified delivery" }));
    const rounds = store.db.prepare("SELECT value FROM studio_workflow_events WHERE kind='goal/round' ORDER BY seq")
      .rows().map(({ value }) => JSON.parse(value).round);
    return { rounds, blocked: capped.blockedReason?.code, reduced: reduced && [reduced.maxGoalRounds, reduced.roundsStarted],
      completed: renamed && [renamed.phase, renamed.objective] };
  });
  result[goalTruncated.name] = await run("truncated", [textReply("partial", true)], {}, async ({ store, scope, view, drive, requests }) => {
    await store.workflow.createGoal(scope, goalTruncated.objective, goalTruncated.rounds);
    await drive();
    const stopped = view().goal;
    return { requests: requests.length, rounds: stopped.roundsStarted, phase: stopped.phase, armed: stopped.armed };
  });
  result[todos.name] = await run("todos", [todoCall(0), todoCall(1), textReply(), textReply()], {}, async ({ send, view, drive, requests }) => {
    await send(todos.input); await drive();
    const after = view().todos;
    await send(todos.next);
    const beforeSecondTurn = view().todos;
    await drive();
    return { beforeSecondTurn, after, next: view().todos, requests: requests.length };
  });
  result[question.name] = await run("question", [questionCall(), textReply()], {}, async ({ store, scope, send, view, drive, requests }) => {
    await send(question.input); await drive();
    const [asked] = view().interactions, before = requests.length;
    await store.workflow.decide(scope, asked.id, { action: "answer", answers: question.answers });
    await drive();
    return { before, receipt: JSON.parse(lastTool(requests).content), requests: requests.length };
  });
  result[timed.name] = await run("timed", [questionCall(), textReply("independent"), textReply("late")], { questionTimeout: timed.timeout },
    async ({ store, scope, send, view, drive, requests }) => {
      await send(timed.input); await drive();
      const [waiting] = view().interactions;
      await delay(Math.max(0, waiting.deadline - Date.now() + 8));
      await drive();
      const pending = JSON.parse(lastTool(requests).content);
      await store.workflow.decide(scope, waiting.id, { action: "answer", answers: question.answers });
      await drive();
      const message = requests.at(-1).messages.findLast(({ source }) => source?.kind === "answer_to_pending_question");
      return { pending: pending.pending, call: pending.callId, late: JSON.parse(message.content).answers, requests: requests.length };
    });
  result[longWait.name] = await run("long-wait", [
    questionCall({ timeout: longWait.timeout }), textReply(),
  ], { questionTimeout: timed.timeout }, async ({ store, scope, send, view, drive }) => {
    await send(question.input); await drive();
    const [request] = view().interactions;
    if (request) {
      await store.workflow.decide(scope, request.id, { action: "answer", answers: question.answers });
      await drive();
    }
    return { offered: Boolean(request) };
  });
  result[planQueued.name] = await run("plan-queued", [textReply()], {}, async ({ store, scope, send, view, drive, requests }) => {
    await send(planQueued.input);
    await store.workflow.setPlan(scope, true);
    const selected = view().plan;
    await drive();
    return { active: selected.active, committed: !selected.pending, firstRequestActive: requests[0].system.includes("当前处于计划模式") };
  });
  result[plan.name] = await run("plan", [planCall(0), planCall(1), textReply()], {}, async ({ store, scope, send, view, drive, requests }) => {
    const presented = [];
    await store.workflow.setPlan(scope, true);
    await send(plan.input); await drive();
    for (let i = 0; i < 2; i++) {
      const [asked] = view().interactions;
      if (!asked) break;
      presented.push(asked.plan);
      const [question] = asked.questions;
      await store.workflow.decide(scope, asked.id, { action: "answer", answers: [{ id: question.id,
        selected: [question.options[0].label], ...(i === 0 ? { custom: plan.feedback } : {}) }] });
      await drive();
    }
    const [exit] = store.db.prepare("SELECT event_seq FROM studio_workflow_events WHERE kind='plan/mode' ORDER BY seq DESC LIMIT 1").rows();
    const [request] = store.db.prepare("SELECT id FROM events WHERE type='request' ORDER BY id DESC LIMIT 1").rows();
    return { ordered: exit.event_seq < request.id, presented, firstFeedback: requests[1].messages.findLast(({ role }) => role === "tool").content.includes(plan.feedback),
      requestModes: requests.map(({ system }) => system.includes("当前处于计划模式")),
      offersExit: requests.map(({ tools }) => tools.some(({ function: fn }) => fn.name === "exit_plan_mode")), finalActive: view().plan.active };
  });
  result[dismiss.name] = await run("dismiss-plan", [planCall(0), textReply()], {}, async ({ store, scope, send, view, drive, requests }) => {
    await store.workflow.setPlan(scope, true);
    await send(plan.input); await drive();
    const [item] = view().interactions;
    await store.workflow.decide(scope, item.id, { action: "dismiss" });
    await send(dismiss.next); await drive();
    const [{ count }] = store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='turn/start'").rows();
    return { turns: count, requests: requests.length, next: requests.at(-1).messages.some(({ content }) => content === dismiss.next),
      active: view().plan.active };
  });
  result[approval.name] = await run("approval", [approvalCall(0), approvalCall(1), textReply()], { tools: [{
    schema: tool("approval_probe", "probe", {}), label: "probe", approval: () => approval.reason,
    async execute() { return { result: { outcome: "allowed-once" } }; },
  }] }, async ({ store, scope, send, view, drive, requests }) => {
    await send(approval.input); await drive();
    const [asked] = view().interactions, before = requests.length;
    await store.workflow.setApprovalPolicy(scope, "never");
    const [question] = asked.questions;
    await attempt(() => store.workflow.decide(scope, asked.id, { action: "answer", answers: [{ id: question.id, selected: [question.options[0].label] }] }));
    await drive();
    const outcomes = store.db.prepare("SELECT json_extract(data,'$.outcome') AS outcome FROM events WHERE type='approval/decided' ORDER BY id")
      .rows().map(({ outcome }) => outcome);
    return { before, outcomes, requests: requests.length };
  });
  return result;
}
