import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { advanceRun } from "../lib/studio/engine";
import { tool } from "../lib/studio/file-tools";
import type { AgentFunction } from "../lib/studio/providers";
import { projectArchive, restoreProjectArchive } from "../lib/studio/project-archive";
import { Store } from "../lib/studio/store";
import { DEFAULT_SETTINGS, type AgentMessage, type Project } from "../lib/studio/types";
import { SQLiteDatabase } from "../server/storage";
import { POST } from "../app/api/studio/[...path]/route";
import { configureRuntime } from "../server/runtime";
import { fixture } from "./support";

const settings = { ...DEFAULT_SETTINGS, textApiKey: "fixture" };
const reply = (content: string): AgentMessage => ({ role: "assistant", content });
const call = (id: string, name: string, args: unknown): AgentMessage => ({
  role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const user = (text: string) => ({ text, requestId: crypto.randomUUID(), attachmentIds: [] });
const view = (store: Store, project: Project) => store.workflow.view({ projectId: project.id });
const plan = "# 交付验证\n\n- 核查素材版本\n- 交付已验证的结果";

async function drive(store: Store, project: Project, model: AgentFunction) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const jobs = (await store.dueRuns()).filter(({ projectId }) => projectId === project.id);
    if (!jobs.length) return;
    for (const job of jobs) {
      const run = await advanceRun(store, project, job.id, settings, undefined, model);
      assert.notEqual(run.status, "failed", run.error ?? undefined);
    }
  }
  assert.fail("agent did not become idle");
}

test("goal admits rounds 1 and 2 in the same session, preserves history and records the round cap", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const scope = { projectId: project.id };
  const goal = await store.workflow.createGoal(scope, "finish twice", 2);
  const rounds: number[] = [];
  await drive(store, project, async (_system, messages) => {
    const current = messages.findLast(({ source }) => source?.kind === "goal-round");
    assert.ok(current?.source?.kind === "goal-round");
    assert.equal(current.source.goalId, goal.id);
    rounds.push(current.source.round);
    if (rounds.length === 2) assert.ok(messages.some(({ content }) => content === "round 1 done"));
    return reply("round " + current.source.round + " done");
  });
  assert.deepEqual(rounds, [1, 2]);
  const final = view(store, project).goal!;
  assert.equal(final.phase, "blocked");
  assert.equal(final.blockedReason?.code, "round-limit");
  assert.equal(final.armed, false);
  assert.equal(final.roundsStarted, 2);
});

test("goals yield to new human input, reject stale edits and require explicit rearm after reopen or fork", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "doman-goal-"));
  const filename = join(folder, "studio.sqlite");
  const db = new SQLiteDatabase(filename); db.initialize("drizzle");
  const reopened = new SQLiteDatabase(filename);
  t.after(async () => { reopened.close(); db.close(); await rm(folder, { recursive: true, force: true }); });
  const store = new Store(db), project = await store.createProject("alice", {}), scope = { projectId: project.id };
  const goal = await store.workflow.createGoal(scope, "original", 4);
  const [reserved] = await store.dueRuns();
  assert.ok(reserved);
  await store.acceptChatAtStep(project.id, user("human joined the pending batch"));
  const received: string[] = [];
  await drive(store, project, async (_system, messages) => {
    const text = messages.findLast(({ source }) => source?.kind !== "runtime-context")?.content ?? "";
    received.push(text);
    if (text.includes("<goal_round>")) return call("stop", "update_goal", {
      goal_id: goal.id, revision: 1, action: "complete",
    });
    if (text.includes("<goal_complete>")) return reply("verified");
    assert.ok(messages.some(({ content }) => content === "human joined the pending batch"));
    assert.ok(!messages.some(({ content }) => content?.includes("<goal_round>")));
    return reply("human batch");
  });
  assert.equal(received.length, 3, JSON.stringify({ received, goal: view(store, project).goal }));
  assert.equal(view(store, project).goal?.roundsStarted, 1);
  assert.equal(view(store, project).goal?.phase, "complete");
  await assert.rejects(store.workflow.updateGoal(scope, { goal_id: goal.id, revision: goal.revision, action: "pause" }), /已经变化/);
  const next = await store.workflow.createGoal(scope, "resume explicitly", 2);
  const reopenedStore = new Store(reopened);
  assert.deepEqual(view(reopenedStore, project).goal, { ...next, armed: false });
  assert.deepEqual(await reopenedStore.dueRuns(), []);
  await reopenedStore.workflow.updateGoal(scope, { goal_id: next.id, revision: next.revision, action: "resume" });
  assert.equal((await reopenedStore.dueRuns()).length, 1);

  const [entry] = store.db.prepare("SELECT run_id FROM studio_workflow_events WHERE kind='goal/round' AND project_id=?")
    .bind(project.id).rows<{ run_id: string }>();
  const earlier = await store.run(entry.run_id, project.id);
  assert.ok(earlier);
  const branch = await store.forkSession(project.id, "", earlier.id, "branch");
  const inherited = store.workflow.view({ ...scope, sessionId: branch.id }).goal;
  assert.equal(inherited?.id, goal.id);
  assert.equal(inherited?.armed, false);
});

test("todo_write trims and replaces the calling turn checklist, publishes cursor updates and resets next turn", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  await store.acceptChatAtStep(project.id, user("多步清单"));
  const initial = await store.snapshot(project.id, "alice");
  const desired = [{ content: "plan", status: "completed" }, { content: "build", status: "in_progress" }];
  let stage = 0;
  await drive(store, project, async (_system, messages) => {
    switch (stage++) {
      case 0: return call("first", "todo_write", { todos: [{ content: "  plan  ", status: "in_progress" }] });
      case 1:
        assert.equal(view(store, project).todos?.[0]?.content, "plan");
        return call("second", "todo_write", { todos: desired });
      default:
        assert.deepEqual(JSON.parse(messages.at(-1)!.content!), { todos: desired, counts: { pending: 0, inProgress: 1, completed: 1 } });
        return reply("done");
    }
  });
  assert.deepEqual(view(store, project).todos, desired);
  const frame = store.workspaceFrame(project.id, "alice", initial.cursor).frame;
  assert.ok(frame?.type === "delta");
  assert.deepEqual(frame.workflow?.todos, desired);
  await store.acceptChatAtStep(project.id, user("下一轮"));
  assert.deepEqual(view(store, project).todos, desired);
  await drive(store, project, async () => {
    assert.equal(view(store, project).todos, null);
    return reply("下一轮完成");
  });
});

const questions = [{
  id: "style", header: "画风", question: "选哪些效果？", multi_select: true, options: [{ label: "线稿" }, { label: "柔光" }],
}, { id: "optional", question: "还有备注吗？" }];
const answer = { action: "answer" as const, answers: [{ id: "style", selected: ["线稿", "柔光"], custom: "保留留白" }, { id: "optional", selected: [] }] };

test("blocking question parks without a lease, then passes selected labels, free text and explicit skip once", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), scope = { projectId: project.id };
  await store.acceptChatAtStep(project.id, user("请先问我选择"));
  await drive(store, project, async (_system, _messages, tools) => {
    assert.ok(!Object.hasOwn(tools.find(({ function: fn }) => fn.name === "ask_user_question")!.function.parameters.properties as object, "timeout"));
    return call("question", "ask_user_question", { questions });
  });
  const [item] = view(store, project).interactions;
  assert.equal(item.state, "waiting");
  assert.equal((await store.run(item.runId, project.id)).leaseUntil, 0);
  await assert.rejects(store.workflow.decide(scope, item.id, { action: "answer", answers: [{ id: "style", selected: ["无效"] }] }), /不匹配/);
  const other = await store.createSession(project.id, "另一对话");
  await assert.rejects(store.workflow.decide({ ...scope, sessionId: other.id }, item.id, answer), /不存在/);
  await store.workflow.decide(scope, item.id, answer);
  await store.workflow.decide(scope, item.id, answer);
  let responses = 0;
  await drive(store, project, async (_system, messages) => {
    assert.deepEqual(JSON.parse(messages.at(-1)!.content!), { answers: answer.answers });
    responses++; return reply("收到");
  });
  assert.equal(responses, 1);
  assert.deepEqual(view(store, project).interactions, []);
});

test("timed question returns pending and late answers are admitted as one tagged user message", async () => {
  const store = new Store(fixture().db, { questionTimeout: 120 }), project = await store.createProject("alice", {}), scope = { projectId: project.id };
  await store.acceptChatAtStep(project.id, user("先问，再做独立的工作"));
  await drive(store, project, async () => call("timed", "ask_user_question", { questions }));
  const [item] = view(store, project).interactions;
  await store.db.prepare("UPDATE studio_interactions SET deadline=? WHERE id=?").bind(Date.now() - 10, item.id).run();
  await drive(store, project, async (_system, messages) => {
    assert.equal(JSON.parse(messages.at(-1)!.content!).pending, true);
    return reply("独立工作完成");
  });
  assert.equal(view(store, project).interactions[0]?.state, "pending");
  await store.workflow.decide(scope, item.id, answer);
  await store.workflow.decide(scope, item.id, answer);
  await drive(store, project, async (_system, messages) => {
    const message = messages.at(-1)!;
    assert.equal(message.source?.kind, "answer_to_pending_question");
    assert.deepEqual(JSON.parse(message.content!).answers, answer.answers);
    return reply("已收到迟到回答");
  });
});

test("plan remains active while reviewing, receives rejection feedback and exits on the next step after approval", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), scope = { projectId: project.id };
  await store.workflow.setPlan(scope, true);
  assert.deepEqual(view(store, project).plan, { active: true, pending: false });
  await store.acceptChatAtStep(project.id, user("准备一个计划"));
  await drive(store, project, async (system) => {
    assert.ok(system.includes("当前处于计划模式"));
    return call("review1", "exit_plan_mode", { plan });
  });
  const [first] = view(store, project).interactions;
  assert.equal(first.plan, plan);
  await store.workflow.decide(scope, first.id, { action: "answer", answers: [{ id: "plan-review", selected: ["继续规划"], custom: "加上交付时间" }] });
  await drive(store, project, async (system, messages) => {
    assert.ok(system.includes("当前处于计划模式"));
    assert.match(messages.at(-1)!.content!, /加上交付时间/);
    return call("review2", "exit_plan_mode", { plan: plan + "\n- 今天交付" });
  });
  const [second] = view(store, project).interactions;
  await store.workflow.decide(scope, second.id, { action: "answer", answers: [{ id: "plan-review", selected: ["批准"] }] });
  assert.equal(view(store, project).plan.active, true);
  await drive(store, project, async (system, messages, tools) => {
    assert.ok(!system.includes("当前处于计划模式"));
    assert.deepEqual(JSON.parse(messages.at(-1)!.content!), { approved: true });
    assert.ok(tools.some(({ function: fn }) => fn.name === "exit_plan_mode"));
    return reply("按计划开始");
  });
  assert.deepEqual(view(store, project).plan, { active: false, pending: false });
});

test("a tool requiring approval waits before dispatch, rejects under the never policy and logs decisions", async () => {
  let executed = 0;
  const store = new Store(fixture().db, { tools: [{
    schema: tool("protected_call", "fixture", {}), label: "请求批准", approval: () => "允许执行这次测试操作？",
    async execute() { executed++; return { result: { ok: true } }; },
  }] });
  const project = await store.createProject("alice", {}), scope = { projectId: project.id };
  await store.acceptChatAtStep(project.id, user("执行受保护操作"));
  await drive(store, project, async () => call("consent", "protected_call", {}));
  const [request] = view(store, project).interactions;
  assert.equal(executed, 0);
  assert.equal(request.kind, "approval");
  assert.equal(store.toolStepDispatched(request.runId, request.callId), false);
  await store.workflow.decide(scope, request.id, { action: "answer", answers: [{ id: "approval", selected: ["允许一次"] }] });
  await drive(store, project, async (_system, messages) => {
    assert.match(messages.at(-1)!.content!, /"ok":true/); return reply("done");
  });
  assert.equal(executed, 1);
  const audit = store.db.prepare("SELECT type FROM events WHERE project_id=? AND type GLOB 'approval/*' ORDER BY id")
    .bind(project.id).rows<{ type: string }>().map(({ type }) => type);
  assert.deepEqual(audit, ["approval/asked", "approval/decided"]);
  await store.workflow.setApprovalPolicy(scope, "never");
  await store.acceptChatAtStep(project.id, user("再次执行"));
  let requests = 0;
  await drive(store, project, async (_system, messages) => requests++ === 0 ? call("consent2", "protected_call", {}) :
    (assert.match(messages.at(-1)!.content!, /APPROVAL_REJECTED/), reply("denied")));
  assert.equal(executed, 1);
  assert.deepEqual(view(store, project).interactions, []);
});

test("a local restart drops automatic reservations without advancing or rearming the goal", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), scope = { projectId: project.id };
  const goal = await store.workflow.createGoal(scope, "持续检查", 4);
  const [reserved] = await store.dueRuns();
  await store.workflow.recoverInterruption();
  assert.equal((await store.run(reserved.id, project.id)).errorCode, "GOAL_STALE");
  assert.equal(store.workflow.goal(scope)?.roundsStarted, 0);
  assert.equal(store.workflow.goal(scope)?.id, goal.id);
});

test("available timed answers can hold the foreground wait until reply", async () => {
  const store = new Store(fixture().db, { questionTimeout: 120 }), project = await store.createProject("alice", {}), scope = { projectId: project.id };
  await store.acceptChatAtStep(project.id, user("询问风格"));
  await drive(store, project, async () => call("timed-edit", "ask_user_question", { questions }));
  const [item] = view(store, project).interactions;
  await store.workflow.holdQuestion(scope, item.id);
  await store.db.prepare("UPDATE studio_interactions SET deadline=? WHERE id=?").bind(Date.now() - 10, item.id).run();
  assert.deepEqual(await store.dueRuns(), []);
  await store.workflow.decide(scope, item.id, answer);
  await drive(store, project, async (_system, messages) => {
    assert.deepEqual(JSON.parse(messages.at(-1)!.content!), { answers: answer.answers });
    return reply("风格已确认");
  });
});

test("normal chat and interaction endpoints support /plan, /goal and JSON answer receipts", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const encryptionSecret = "test-encryption-secret-32characters";
  await store.saveSettings("alice", { textApiKey: "fixture" }, encryptionSecret);
  configureRuntime({ database: store.db, media: { async get() { return null; }, async put() { assert.fail("unexpected media write"); } },
    userId: "alice", workerSecret: "fixture", encryptionSecret });
  const post = (suffix: string[], body: unknown) => {
    const path = ["projects", project.id, ...suffix];
    return POST(new Request("http://127.0.0.1/api/studio/" + path.join("/"), {
      method: "POST", body: JSON.stringify(body), headers: { Prefer: "return=minimal" },
    }), { params: Promise.resolve({ path }) });
  };
  const goal = user("/goal 一次性验证目标"), command = await post(["chat"], goal);
  assert.equal(command.status, 200, await command.clone().text());
  const id = view(store, project).goal?.id;
  assert.ok(id);
  assert.equal((await post(["chat"], goal)).status, 200);
  assert.equal(view(store, project).goal?.id, id);
  assert.equal((await post(["chat"], user("/goal pause"))).status, 200);
  const inline = await post(["chat"], user("/plan 规划独立验证"));
  assert.equal(inline.status, 200, await inline.clone().text());
  await drive(store, project, async (system, messages) => {
    assert.match(system, /当前处于计划模式/);
    assert.ok(messages.some(({ content }) => content === "规划独立验证"));
    return call("http-question", "ask_user_question", { questions });
  });
  const [request] = view(store, project).interactions;
  const sent = await post(["workflow", "interactions", request.id], answer);
  assert.equal(sent.status, 200);
  assert.deepEqual(await sent.json(), { ok: true });
  await drive(store, project, async (_system, messages) => {
    assert.deepEqual(JSON.parse(messages.at(-1)!.content!), { answers: answer.answers });
    return reply("已收到");
  });
});

test("project archives restore workflow history with a disarmed goal and independently mapped scope", async () => {
  const store = fixture(), project = await store.createProject("alice", {}), scope = { projectId: project.id };
  await store.workflow.setPlan(scope, true);
  await store.workflow.setApprovalPolicy(scope, "never");
  const activeGoal = await store.workflow.createGoal(scope, "keep this goal", 3);
  const [reserved] = await store.dueRuns();
  const model: AgentFunction = async () => reply("reserve and accept");
  await advanceRun(store, project, reserved.id, settings, undefined, model);
  assert.equal(view(store, project).goal?.roundsStarted, 1);
  const blob = await new Response(projectArchive(store, project.id, undefined)).arrayBuffer();
  const restored = await restoreProjectArchive(store, "alice", blob, undefined, AbortSignal.timeout(3000));
  assert.notEqual(restored.id, project.id);
  assert.equal(view(store, restored).goal?.id, activeGoal.id);
  assert.equal(view(store, restored).goal?.roundsStarted, 1);
  assert.equal(view(store, restored).goal?.armed, false);
  assert.equal(view(store, restored).plan.active, true);
  assert.equal(store.workflow.approvalPolicy({ projectId: restored.id }), "never");
});

test("persisted approval audit cannot authorize an undispatched tool after reopening", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "doman-approval-"));
  const filename = join(folder, "studio.sqlite");
  const original = new SQLiteDatabase(filename); original.initialize("drizzle");
  const restored = new SQLiteDatabase(filename);
  t.after(async () => { restored.close(); original.close(); await rm(folder, { recursive: true, force: true }); });
  const tools = [{
    schema: tool("protected_probe", "fixture", {}), label: "测试审批",
    approval: () => "开启这一次受保护操作？",
    async execute() { assert.fail("an approval must not survive restart"); },
  }];
  const store = new Store(original, { tools }), project = await store.createProject("alice", {});
  await store.acceptChatAtStep(project.id, user("执行测试操作"));
  await drive(store, project, async () => call("probe", "protected_probe", {}));
  const [item] = view(store, project).interactions;
  await store.workflow.decide({ projectId: project.id }, item.id, { action: "answer", answers: [{ id: "approval", selected: ["允许一次"] }] });
  const reopened = new Store(restored, { tools });
  await reopened.workflow.recoverInterruption();
  await drive(reopened, project, async (_system, messages) => {
    assert.match(messages.at(-1)!.content!, /APPROVAL_CANCELLED/);
    return reply("需重新审批");
  });
  assert.equal(reopened.toolStepDispatched(item.runId, item.callId), false);
});

test("a late question answer queued during manual compaction keeps its tagged payload", async () => {
  const store = new Store(fixture().db, { questionTimeout: 120 }), project = await store.createProject("alice", {});
  await store.acceptChatAtStep(project.id, user("先问我风格"));
  await drive(store, project, async () => call("queued-answer", "ask_user_question", { questions }));
  const [item] = view(store, project).interactions;
  await store.db.prepare("UPDATE studio_interactions SET deadline=? WHERE id=?").bind(Date.now() - 10, item.id).run();
  await drive(store, project, async () => reply("先处理其他文字任务"));
  await store.requestCompaction(project.id, crypto.randomUUID());
  await store.workflow.decide({ projectId: project.id }, item.id, answer);
  assert.deepEqual((await store.snapshot(project.id, "alice")).chatQueue, []);
  let received = 0;
  await drive(store, project, async (_system, messages, tools) => {
    if (!tools.length) return reply("整理已完成");
    const last = messages.findLast(({ source }) => source?.kind === "answer_to_pending_question");
    assert.ok(last);
    assert.deepEqual(JSON.parse(last.content!).answers, answer.answers);
    received++;
    return reply("已读取用户回答");
  });
  assert.equal(received, 1);
});
