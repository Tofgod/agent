import { z } from "zod";
import { tool } from "./file-tools";
import { AppError } from "./security";
import { agentIdentity } from "./agent-identity";
import type { ToolContext, ToolRegistration, ToolOutcome } from "./tool-registry";
import { goalEdit, goalObjective, goalRoundLimit, goalToolValue, questionList, questionWaitSeconds, todoList, type Interaction } from "./workflow-types";

const string = { type: "string" };
const integer = { type: "integer" };
const denied = () => new AppError("此目标操作需要主智能体当前轮次的直接用户授权", 403, "GOAL_TOOL_AUTHORITY");
async function humanAuthority({ store, run }: ToolContext) {
  if (run.parentRunId || !(await store.inputs(run)).some((input) => !input.scheduled && !input.source)) throw denied();
}
function root({ run }: ToolContext) { return !run.parentRunId && run.intent === "agent"; }

const questions = { type: "array", items: { type: "object", required: ["id", "question"], properties: {
  id: string, question: string, header: string, options: { type: "array", items: {
    type: "object", required: ["label"], properties: { label: string, description: string },
  } }, multi_select: { type: "boolean" },
} } };

export const planPolicy = "当前处于计划模式。先了解需求、查看现有资料并比较方案。保持工作区现状，暂停实际制作、修改和外部操作。"
  + "只用 ask_user_question 询问无法从文件和上下文确定、需要用户决定的事项。对话中的口头同意可以写进计划，评审仍由 exit_plan_mode 完成。"
  + "个人待办用于批准后的执行。将目标、交付、关键决定和验证方式写成以 # 标题开头的完整 Markdown 计划，"
  + "把 exit_plan_mode 作为本步最后且唯一的工具调用。收到反馈应修订后重提，获得批准后从下一步执行。";

export async function settleInteraction({ store, run }: Pick<ToolContext, "store" | "run">, item: Interaction, newInput = false): Promise<ToolOutcome> {
  if (item.state === "waiting") {
    if (newInput) {
      await store.workflow.transitionInteraction(item.id, "waiting", "dismissed");
      const current = store.workflow.findInteraction(run.id, item.callId);
      if (current) return settleInteraction({ store, run }, current);
    }
    if (item.deadline && Math.max(item.deadline, item.holdUntil ?? 0) <= Date.now()) {
      await store.workflow.transitionInteraction(item.id, "waiting", "pending");
      const current = store.workflow.findInteraction(run.id, item.callId);
      if (current) return settleInteraction({ store, run }, current);
    }
    return { waitForInteraction: item.id };
  }
  if (item.state === "pending") return { result: { pending: true, callId: item.callId,
    message: "前台等待已到期。用户仍可以回答，稍后用用户消息交付回答。可以先推进独立工作，超时不构成批准。" } };
  if (item.state === "cancelled") return { result: { error: "等待已中止", code: "ASK_CANCELLED" } };
  if (item.state === "dismissed") return item.kind === "plan" ? { result: { approved: false }, concludesTurn: true }
    : { result: { error: "用户关闭了问题，可在聊天中补充", code: "ASK_CANCELLED" } };
  const selected = item.decision?.action === "answer" ? item.decision.answers : [];
  if (item.kind === "question") {
    const answers = item.questions.map(({ id }) => selected.find((answer) => answer.id === id) ?? { id, selected: [] });
    return { result: { answers } };
  }
  const answer = selected[0];
  if (item.kind === "approval") return { result: { outcome: answer?.selected[0] === "允许一次" ? "allowed-once" : "denied" } };
  if (answer?.selected[0] !== "批准" || answer.custom !== undefined) return { result: { error: "用户选择继续规划，请修订后重新提交。" +
    (answer?.custom ? "\n用户反馈：" + answer.custom : ""), code: "PLAN_KEEP_PLANNING" } };
  await store.workflow.setPlan(run, false, run);
  return { result: { approved: true } };
}

export const workflowTools: ToolRegistration[] = [
  {
    schema: tool("get_goal", "读取当前会话的持久目标、修订和续轮状态。", {}), label: "读取目标", available: root, mode: "parallel",
    async execute({ store, run }) {
      const goal = store.workflow.goal(run);
      return { result: goalToolValue(goal, Boolean(goal && store.workflow.isArmed(run, goal))) };
    },
  },
  {
    schema: tool("create_goal", "仅在用户明确要求创建持续自主目标时调用。目标会在同会话空闲后自动续轮。一般聊天和单次创作不创建持久目标。",
      { objective: string, max_goal_rounds: integer }, ["objective"]), label: "创建目标", available: root,
    async execute(context, id, args) {
      await humanAuthority(context);
      const { objective, max_goal_rounds } = z.strictObject({ objective: goalObjective, max_goal_rounds: goalRoundLimit.optional() }).parse(args);
      const goal = await context.store.workflow.createGoal(context.run, objective, max_goal_rounds, context.run, { id });
      return { result: goalToolValue(goal, true) };
    },
  },
  {
    name: "update_goal", label: "更新目标", available: root,
    schema: ({ store }) => tool("update_goal",
      "按目标 ID 和修订更新。edit、pause、resume 需要当前轮直接用户指示。自主轮可 complete；相同障碍持续至少 " +
      store.workflow.blockedAfterRounds + " 轮才可 blocked。完成前验证成果。",
      { goal_id: string, revision: integer, action: { type: "string", enum: ["edit","pause","resume","complete","blocked"] },
        objective: string, max_goal_rounds: integer, blocked_reason: string },
      ["goal_id","revision","action"]),
    async execute(context, id, args) {
      const { store, run } = context;
      const input = goalEdit.extend({ blocked_reason: goalObjective.optional() }).parse(args);
      const edit = { ...input, blocked_reason: input.blocked_reason ? { code: "model-reported", message: input.blocked_reason } : undefined };
      if (edit.action === "clear") throw denied();
      const autonomous = ["complete", "blocked"].includes(edit.action) && store.workflow.isGoalRoundAdmitted(run) &&
        run.payload.goalRound?.goalId === edit.goal_id && run.payload.goalRound?.revision === edit.revision;
      const human = (await store.inputs(run)).some((input) => !input.scheduled && !input.source);
      if (!autonomous && !human) throw denied();
      if (edit.action === "resume" && store.workflow.goal(run)?.phase === "paused")
        throw new AppError("已暂停的目标须由用户恢复", 409, "GOAL_TOOL_RESUME_PAUSED");
      if (autonomous && !human && edit.action === "blocked" && run.payload.goalRound!.round < store.workflow.blockedAfterRounds)
        throw new AppError("当前目标尚未达到自主报告阻塞的轮数", 409, "GOAL_TOOL_BLOCK_THRESHOLD");
      const continuation = autonomous && !human ? { additionalContexts: [{ role: "user" as const,
        source: { kind: "tool-context" as const }, content: edit.action === "complete"
          ? "<goal_complete>目标已完成。向用户交代成果及验证，结束本轮。</goal_complete>"
          : "<goal_blocked>目标已停止续轮。向用户交代障碍，结束本轮。</goal_blocked>" }] } : undefined;
      const goal = await store.workflow.updateGoal(run, edit, run, { id, continuation });
      return { result: goalToolValue(goal, Boolean(goal && store.workflow.isArmed(run, goal))), ...continuation };
    },
  },
  {
    name: "todo_write", label: "更新个人待办",
    schema: ({ store }) => tool("todo_write", "用完整列表替换自己当前轮的执行清单。待办是个人进度，与共享任务分开。" +
      (store.workflow.parallelTodos ? "独立工作可同时进行。" : "最多一项进行中。"),
    { todos: { type: "array", items: { type: "object", required: ["content","status"], additionalProperties: false,
      properties: { content: string, status: { type: "string", enum: ["pending","in_progress","completed"] } } } } }, ["todos"]),
    async execute({ store, run }, callId, args) {
      const { todos } = z.strictObject({ todos: todoList }).parse(args);
      if (!store.workflow.parallelTodos && todos.filter(({ status }) => status === "in_progress").length > 1)
        throw new AppError("最多一项待办可以进行中", 400, "INVALID_ARGS");
      return { result: await store.workflow.writeTodos(run, callId, todos) };
    },
  },
  {
    name: "ask_user_question", label: "询问用户",
    schema: ({ store }) => tool("ask_user_question",
      "用户的决定会影响当前工作时，提出一个或多个简明问题。每题 id 唯一，支持选项和自由文字。空答案表示用户跳过，使用现有信息继续即可。跳过不构成批准。" +
      (store.workflow.questionTimeout === undefined ? "" : "timeout 为秒数，-1 持续等待。前台等待到期后允许用户稍后回答。"),
      { questions, ...(store.workflow.questionTimeout === undefined ? {} : { timeout: integer }) }, ["questions"]),
    async execute(context, callId, args) {
      const { store, run } = context;
      const defaultTimeout = store.workflow.questionTimeout;
      const value = z.object({ questions: questionList, ...(defaultTimeout === undefined ? {} : {
        timeout: questionWaitSeconds.optional(),
      }) }).parse(args) as { questions: z.infer<typeof questionList>; timeout?: number };
      const timeout = value.timeout ?? defaultTimeout;
      const entry = await store.workflow.requestInteraction(run, callId, "question", { questions: value.questions },
        timeout && timeout > 0 ? Date.now() + timeout * 1000 : undefined);
      return settleInteraction(context, entry);
    },
  },
  {
    name: "exit_plan_mode", label: "提交计划评审",
    schema: ({ store, run }) => store.workflow.plan(run, agentIdentity(run)).entered || store.workflow.selectedPlan(run, agentIdentity(run))
      ? tool("exit_plan_mode", "提交完整计划供用户评审。批准后才从下一步进入执行。计划使用 Markdown，以 # 标题开头。",
        { plan: string }, ["plan"]) : undefined,
    async execute(context, callId, args) {
      const { store, run } = context;
      if (!store.workflow.plan(run, agentIdentity(run)).active) throw new AppError("当前未处于计划模式", 409, "PLAN_NOT_ACTIVE");
      const { plan } = z.object({ plan: z.string().trim().max(64000).regex(/^#\s+\S/) }).parse(args);
      const entry = await store.workflow.requestInteraction(run, callId, "plan", { plan, questions: [{
        id: "plan-review", header: "计划评审", question: "批准这个计划并开始执行？", options: [
          { label: "批准", description: "下一个步骤离开计划模式并执行。" },
          { label: "继续规划", description: "保留计划模式，可以附上修改意见。" },
        ],
      }] });
      return settleInteraction(context, entry);
    },
  },
];
