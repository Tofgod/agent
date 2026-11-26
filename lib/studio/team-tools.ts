import { z } from "zod";
import { tool } from "./file-tools";
import { AppError } from "./security";
import { agentIdentity } from "./agent-identity";
import type { ToolRegistration } from "./tool-registry";
import type { TeamTask } from "./types";

const enabled: NonNullable<ToolRegistration["available"]> = ({ store, run }) => store.teamEnabled(run.projectId, run.sessionId ?? "");
const scopeSchema = z.string().trim().max(260).transform((scope) => scope.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, ""))
  .refine((scope) => scope.split("/").every((part) => part && part !== "." && part !== "..") && !/^[a-z]:/i.test(scope), "请输入项目相对路径");
const fields = {
  subject: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(16384),
  blocked_by: z.array(z.string().uuid()).max(64), write_scopes: z.array(scopeSchema).max(64),
};
const string = { type: "string" }, list = { type: "array", items: string };
const parameters = { subject: string, description: string, blocked_by: list, write_scopes: list };
const actions = ["claim", "release", "edit", "set_dependencies", "complete", "reopen", "reassign", "delete"] as const;
const dto = ({ id, title, detail, status, revision, dependencies, ready, ownerId, writeScopes, writeScopeWarnings }: TeamTask) => ({
  id, subject: title, description: detail, status: status === "done" ? "completed" : status, revision,
  blocked_by: dependencies, ready, ...(ownerId ? { owner: ownerId } : {}), write_scopes: writeScopes ?? [], write_scope_warnings: writeScopeWarnings ?? [],
});

export const teamTools: ToolRegistration[] = [
  {
    schema: tool("team_task_create", "创建共享任务，可填写依赖和计划修改的路径。", parameters, ["subject", "description"]),
    available: enabled, label: "创建共享任务",
    async execute({ store, run }, id, args) {
      const input = z.object({ subject: fields.subject, description: fields.description, blocked_by: fields.blocked_by.optional(), write_scopes: fields.write_scopes.optional() }).parse(args);
      return { result: dto(await store.changeTeamTask(run, id, { title: input.subject, detail: input.description,
        dependencies: input.blocked_by, writeScopes: input.write_scopes }, undefined, true) as unknown as TeamTask) };
    },
  },
  {
    schema: tool("team_task_list", "列出共享任务的修订、负责人和依赖。", { owner: string, unowned: { type: "boolean" } }),
    available: enabled, label: "查看协作清单", mode: "parallel",
    async execute({ store, run }, _id, args) {
      const { owner, unowned } = z.object({ owner: z.string().min(1).max(64).optional(), unowned: z.boolean().optional() })
        .refine((filter) => filter.owner === undefined || filter.unowned === undefined).parse(args);
      const member = owner === undefined ? undefined : await store.resolveCollaborator(run, owner);
      return { result: { tasks: store.teamTasks(run.projectId, run.sessionId ?? "").filter((task) =>
        (owner === undefined || task.ownerId === (member ? agentIdentity(member) : owner)) && (unowned === undefined || (task.ownerId === null) === unowned)).map(dto) } };
    },
  },
  {
    schema: tool("team_task_get", "读取共享任务，包括已删除任务的最后修订。", { task_id: string }, ["task_id"]),
    available: enabled, label: "读取共享任务", mode: "parallel",
    async execute({ store, run }, _id, args) {
      const { task_id } = z.object({ task_id: z.string().uuid() }).parse(args);
      const task = store.teamTasks(run.projectId, run.sessionId ?? "", true).find(({ id }) => id === task_id);
      if (!task) throw new AppError("共享任务不存在", 404, "TEAM_TASK_NOT_FOUND");
      return { result: dto(task) };
    },
  },
  {
    schema: tool("team_task_update", "按任务 ID 和当前修订更新共享任务。用 claim 认领到自己，后台确定负责人；reassign 才使用 owner。任务 ID 和修订从创建或读取结果取得。", {
      ...parameters, task_id: string, expected_revision: { type: "integer" }, action: { type: "string", enum: actions }, owner: string,
    }, ["task_id", "expected_revision", "action"]),
    available: enabled, label: "更新共享任务",
    async execute({ store, run }, id, args) {
      const input = z.object({ subject: fields.subject.optional(), description: fields.description.optional(),
        blocked_by: fields.blocked_by.optional(), write_scopes: fields.write_scopes.optional(), task_id: z.string().uuid(),
        expected_revision: z.number().int().positive(), action: z.enum(actions), owner: z.string().min(1).max(64).optional() }).parse(args);
      const tasks = store.teamTasks(run.projectId, run.sessionId ?? "", true);
      const task = tasks.find(({ id }) => id === input.task_id);
      if (!task) throw new AppError("共享任务不存在", 404, "TEAM_TASK_NOT_FOUND");
      if (task.revision !== input.expected_revision) throw new AppError("任务修订已变化", 409, "TEAM_TASK_STALE_REVISION");
      if (task.status === "deleted") throw new AppError("共享任务已删除", 409, "TEAM_TASK_DELETED");
      const lead = !run.parentRunId, self = agentIdentity(run), action = input.action;
      if (action !== "claim" && action !== "reassign" && !lead && task.ownerId !== self)
        throw new AppError("只有负责人或主智能体可以更新任务", 403, "TEAM_TASK_UNAUTHORIZED");
      if (action === "reassign" && !lead) throw new AppError("只有主智能体可以重新分配任务", 403, "TEAM_LEAD_REQUIRED");
      const transitionError = () => new AppError("任务当前状态不支持此操作", 409, "TEAM_TASK_INVALID_TRANSITION");
      let changes: Partial<TeamTask>;
      switch (action) {
        case "claim":
          if (task.ownerId && task.ownerId !== self) throw new AppError("任务已被认领", 409, "TEAM_TASK_ALREADY_CLAIMED");
          if (!task.ready) throw new AppError("任务尚不能认领", 409, "TEAM_TASK_BLOCKED");
          changes = { ownerId: self, status: "in_progress" }; break;
        case "release":
        case "complete":
          if (task.status !== "in_progress") throw transitionError();
          changes = action === "release" ? { status: "pending", ownerId: null } : { status: "done" }; break;
        case "reopen":
          if (task.status !== "done") throw transitionError();
          changes = { status: "pending", ownerId: null }; break;
        case "reassign": {
          if (task.status !== "pending" && task.status !== "in_progress") throw transitionError();
          if (input.owner && task.dependencies.some((id) => !tasks.some((other) => other.id === id && other.status === "done")))
            throw new AppError("任务前置依赖未完成", 409, "TEAM_TASK_BLOCKED");
          const member = input.owner === undefined ? undefined : await store.resolveCollaborator(run, input.owner);
          if (input.owner !== undefined && !member) throw new AppError("负责人必须是当前协作中的智能体", 400, "TEAM_TASK_UNAUTHORIZED");
          changes = member ? { ownerId: agentIdentity(member), status: "in_progress" } : { ownerId: null, status: "pending" }; break;
        }
        case "delete":
          if (tasks.some((other) => other.status !== "deleted" && other.dependencies.includes(task.id)))
            throw new AppError("仍有任务依赖此项", 409, "TEAM_TASK_HAS_DEPENDENTS");
          changes = { status: "deleted" }; break;
        case "set_dependencies":
          if (!input.blocked_by) throw new AppError("请输入依赖列表", 400, "TEAM_INVALID_ARGUMENT");
          changes = { dependencies: input.blocked_by }; break;
        case "edit":
          if (input.subject === undefined && input.description === undefined && input.write_scopes === undefined)
            throw new AppError("请输入要更新的内容", 400, "TEAM_INVALID_ARGUMENT");
          changes = { title: input.subject, detail: input.description, writeScopes: input.write_scopes }; break;
      }
      const result = await store.changeTeamTask(run, id, changes, task, true);
      return { result: dto(result as unknown as TeamTask) };
    },
  },
];
