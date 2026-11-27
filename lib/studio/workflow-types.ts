import { z } from "zod";

export interface SessionGoal {
  id: string;
  revision: number;
  objective: string;
  phase: "active" | "paused" | "blocked" | "complete";
  roundsStarted: number;
  maxGoalRounds: number;
  blockedReason?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
}
export function goalToolValue(goal: SessionGoal | null, armed = false) {
  if (!goal) return { goal: null };
  const { id, revision, objective, phase, roundsStarted, maxGoalRounds, blockedReason } = goal;
  return { goal: { id, revision, objective, phase, roundsStarted, maxGoalRounds, ...(blockedReason ? { blockedReason } : {}) },
    activation: armed ? "armed" : "disarmed" };
}
export interface GoalRound { goalId: string; revision: number; round: number }
export const goalObjective = z.string().trim().min(1).max(16000);
export const goalRoundLimit = z.number().int().positive().safe();
export const goalEdit = z.strictObject({
  action: z.enum(["edit", "pause", "resume", "complete", "blocked", "clear"]),
  goal_id: z.string().uuid(), revision: z.number().int().positive(),
  objective: goalObjective.optional(), max_goal_rounds: goalRoundLimit.optional(),
  blocked_reason: z.strictObject({ code: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80), message: goalObjective }).optional(),
});
export type GoalEdit = z.infer<typeof goalEdit>;

const todo = z.strictObject({ content: z.string().trim().min(1), status: z.enum(["pending", "in_progress", "completed"]) });
export const todoList = z.array(todo).superRefine((items, ctx) => {
  if (new Set(items.map(({ content }) => content)).size !== items.length)
    ctx.addIssue({ code: "custom", message: "待办内容应当唯一" });
});
export type Todo = z.infer<typeof todo>;

const option = z.object({ label: z.string().trim().min(1).max(240), description: z.string().max(800).optional() });
export const questionWaitMaxSeconds = 2_147_483;
export const questionWaitSeconds = z.union([z.literal(-1), z.number().int().min(1).max(questionWaitMaxSeconds)]);
export const questionList = z.array(z.object({
  id: z.string().trim().min(1).max(120), question: z.string().trim().min(1).max(2400),
  header: z.string().max(120).optional(), options: z.array(option).min(1).max(16).optional(), multi_select: z.boolean().optional(),
})).min(1).max(12).superRefine((questions, ctx) => {
  if (new Set(questions.map(({ id }) => id)).size !== questions.length)
    ctx.addIssue({ code: "custom", message: "问题 ID 应当唯一" });
  for (const [index, question] of questions.entries()) {
    if (question.options && new Set(question.options.map(({ label }) => label)).size !== question.options.length)
      ctx.addIssue({ code: "custom", message: "选项应当唯一", path: [index, "options"] });
  }
});
export type Question = z.infer<typeof questionList>[number];
export const interactionDecision = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("answer"), answers: z.array(z.strictObject({
    id: z.string(), selected: z.array(z.string()), custom: z.string().trim().max(16000).optional(),
  })).max(12) }),
  z.strictObject({ action: z.literal("dismiss") }),
]);
export type InteractionDecision = z.infer<typeof interactionDecision>;
export interface Interaction {
  id: string;
  runId: string;
  callId: string;
  generation: number;
  kind: "question" | "plan" | "approval";
  state: "waiting" | "pending" | "answered" | "dismissed" | "cancelled";
  questions: Question[];
  plan?: string;
  toolName?: string;
  deadline?: number;
  holdUntil?: number;
  decision?: InteractionDecision;
}
export interface WorkflowView {
  goal: (SessionGoal & { armed: boolean }) | null;
  plan: { active: boolean; pending: boolean };
  todos: Todo[] | null;
  interactions: Interaction[];
}

export function workflowCommand(text: string) {
  const match = /^\/(goal|plan)(?:\s|$)/.exec(text);
  return match ? { name: match[1] as "goal" | "plan", input: text.slice(match[0].length).trim() } : null;
}
