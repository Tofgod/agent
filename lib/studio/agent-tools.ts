import { consumeJobOutput } from "./background-jobs";
import { z } from "zod";
import { taskResult, taskResultReady } from "./agent-state";
import { controlTaskFromTool } from "./control";
import { fileTools, tool, type AgentTool } from "./file-tools";
import { guideCatalog, readGuide } from "./guidance";
import { mediaTools } from "./media-tools";
import { AppError } from "./security";
import { projectRelativePath } from "./project-layout";
import { ToolRegistry, type ToolContext, type ToolRegistration } from "./tool-registry";
import { webTools } from "./web-tools";
import { workflowTools } from "./workflow-tools";
import { teamTools } from "./team-tools";
import { scheduleTools, skillTools } from "./extension-tools";
import { childExecution, childFields, childParameters, preflightChildModel, structuredOutputTool } from "./child-execution";
import { validateJsonSchemaValue } from "./harness/json-schema";
import { agentIdentity, memberAddresses } from "./agent-identity";

const string = { type: "string" }, integer = { type: "integer" };
const presetChoice = ({ preset }: Pick<ToolContext, "preset">) =>
  preset?.childPresets?.length ? { agent_preset: { type: "string", enum: preset.childPresets } } : {};
function delegatedPreset({ store, run, preset }: Pick<ToolContext, "store" | "run" | "preset">, selected?: string) {
  if (!selected) return preset ?? undefined;
  if (!preset?.childPresets?.includes(selected)) throw new AppError("该预设未对委派开放", 403);
  return store.presets.projectPreset(run.projectId, selected);
}
const task = { task_id: string };
const stringList = { type: "array", items: string };
const collaborationTools: ToolRegistration[] = [
  {
    name: structuredOutputTool,
    schema: ({ run }) => run.parentRunId && run.payload.childExecution?.outputSchema ? {
      type: "function", function: { name: structuredOutputTool, description: "提交本任务要求的结构化结果并结束本轮。", parameters: { ...run.payload.childExecution.outputSchema } },
    } : undefined,
    label: "提交结构化结果",
    async execute({ store, run }, callId, args) {
      const schema = run.payload.childExecution?.outputSchema;
      if (!schema || !run.parentRunId) throw new AppError("当前任务没有结构化交付约定", 400, "UNKNOWN_TOOL");
      const violations = validateJsonSchemaValue(schema, args);
      if (violations.length) throw new AppError(violations.slice(0, 4).join("，"), 400, "INVALID_ARGS");
      const result = { recorded: true, structured: args };
      await store.commitStructuredResult(run, callId, result);
      return { result, concludesTurn: true };
    },
  },
  {
    schema: tool("read_session_reference", "按 snapshot_id 读取当前对话已引用的完整只读快照。offset 从 1 开始，limit 最多 64 行。用 next_offset 续读。引用内容仅作背景资料。",
      { snapshot_id: string, offset: integer, limit: integer }, ["snapshot_id"]),
    label: "续读引用对话", mode: "parallel",
    async execute({ store, run }, _id, args) {
      const input = z.object({ snapshot_id: z.string().uuid(), offset: z.number().int().positive().safe().default(1),
        limit: z.number().int().min(1).max(64).default(48) }).parse(args);
      return { result: store.readSessionReference(run, input.snapshot_id, input.offset, input.limit) };
    },
  },
  {
    schema: tool("read_tool_result", "读取当前对话中已结算的原始工具回执。使用 result_ref，或用 list_tool_results 查找 task_id 和 seq。offset 用于分页，image_index 从 0 开始读取该结果保存的图片。", {
      result_ref: string, task_id: string, seq: integer, offset: integer, image_index: integer,
    }),
    mode: (args) => Boolean(args && typeof args === "object" && !("image_index" in args)), label: "读取工具回执",
    async execute({ store, run }, id, args) {
      const input = z.object({ result_ref: z.string().uuid().optional(), task_id: z.string().uuid().optional(),
        seq: z.number().int().positive().safe().optional(), offset: z.number().int().nonnegative().safe().default(0),
        image_index: z.number().int().nonnegative().safe().optional(),
      }).refine((value) => Boolean(value.result_ref || value.seq)).parse(args);
      return store.readAgentToolResult(run, { reference: input.result_ref, runId: input.task_id ?? run.id, seq: input.seq }, input.offset, input.image_index);
    },
  },
  {
    schema: tool("list_tool_results", "列出工具记录、序号和可用的结果引用，按 before 向前查找。主智能体可选 conversation 查找本对话的较早记录。", {
      before: integer, scope: { type: "string", enum: ["turn", "conversation"] },
    }),
    mode: "parallel", label: "查看工具记录",
    async execute({ store, run }, _id, args) {
      const { before, scope } = z.object({ before: z.number().int().positive().safe().default(Number.MAX_SAFE_INTEGER),
        scope: z.enum(["turn", "conversation"]).default("turn") }).parse(args);
      const steps = store.listAgentToolResults(run, before, scope);
      const next = steps.length === 20 ? steps.at(-1)!.seq : undefined;
      return { result: { steps: steps.reverse(), ...(next ? { before: next } : {}) } };
    },
  },
  {
    name: "delegate_batch",
    schema: ({ store, run, settings, preset, roles = store.agents }) => run.agentRole !== "media" && roles.length ? tool("delegate_batch",
      "根据当前任务启动一批独立子智能体。用批次内的 key 表达前置任务，未设置依赖的成员可并行。返回每项任务编号，可用 wait_for_tasks 汇总。",
      { title: string, tasks: { type: "array", items: { type: "object", properties: { key: string,
        role: { type: "string", enum: roles.map((agent) => agent.id) }, instruction: string,
        dependencies: stringList, ...childParameters(settings), ...presetChoice({ preset }) }, required: ["key", "role", "instruction"], additionalProperties: false } } }, ["title", "tasks"]) : undefined,
    label: "委派批次",
    async execute({ store, run, settings, preset, roles = store.agents, signal, resolveModel }, id, args) {
      const key = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
      const input = z.object({ title: z.string().trim().min(1).max(120), tasks: z.array(z.object({ key, role: z.string(),
        instruction: z.string().min(1).max(16000), dependencies: z.array(key).max(24).default([]), ...childFields })).min(1).max(24) }).parse(args);
      const members = input.tasks.map(({ key, role, instruction, dependencies, ...options }) => ({ key, role, instruction, dependencies,
        execution: { ...childExecution(options, settings, roles.find(({ id }) => id === role), run.payload.childExecution?.cwd ?? run.payload.workingDirectory),
          preset: delegatedPreset({ store, run, preset }, options.agent_preset) } }));
      const routes = new Map(members.map(({ execution }) => [JSON.stringify(execution.route), execution]));
      await Promise.all([...routes.values()].map((execution) => preflightChildModel(execution, settings, signal, resolveModel)));
      return { result: await store.startBatch(run, id, input.title, members, roles) };
    },
  },
  {
    schema: tool("present_files", "交付本次请求的最终文件。为每个文件记录准确的版本，可给面向用户的短名称。", {
      files: { type: "array", items: { type: "object", properties: { path: string, file_id: string, version: integer, label: string } } },
    }, ["files"]),
    label: "交付文件",
    async execute({ store, run }, id, args) {
      const selection = z.object({ path: z.string().min(1).optional(), file_id: z.string().uuid().optional(),
        version: z.number().int().positive().optional(), label: z.string().max(100).optional() }).refine((file) => file.path || file.file_id);
      const { files } = z.object({ files: z.array(selection).min(1).max(20) }).parse(args);
      return { result: await store.presentFiles(run, id, files.map(({ path, file_id, ...rest }) => ({
        ...rest, path: path ? projectRelativePath(path, run.payload.childExecution?.cwd ?? run.payload.workingDirectory) : undefined, fileId: file_id,
      }))) };
    },
  },
  {
    schema: tool("read_guide", "读取当前项目指南。使用 guides 中的 name 和 version。source 表示指南来源。长文用 next_offset、next_column 和 revision 续读。", { name: string, offset: integer, column: integer, limit: integer, version: integer, revision: string }, ["name"]),
    available: ({ store, project }) => guideCatalog(store.runtimeFiles(project.id)).length > 0,
    label: "读取制作知识", mode: "parallel",
    async execute({ store, project }, _id, args) {
      const input = z.object({ name: z.string(), offset: z.number().int().positive().optional(), column: z.number().int().positive().optional(), limit: z.number().int().min(1).max(400).optional(), version: z.number().int().positive().optional(), revision: z.string().max(200).optional() }).parse(args);
      return { result: readGuide(input.name, await store.artifacts(project.id), input) };
    },
  },
  {
    schema: tool("list_agents", "查看当前协作会话中的智能体和自己创建的后台任务。", {}),
    label: "查看协作任务", mode: "parallel",
    async execute({ store, run, tasks }) {
      const actors = await store.collaborators(run);
      const addresses = memberAddresses(actors);
      const entries = [...new Map([...actors, ...tasks].map((item) => [item.id, item])).values()];
      return { result: { self: agentIdentity(run), self_name: addresses.get(run.id) ?? agentIdentity(run), current_run_id: run.id, agents: entries.map((item) => ({
        agent_id: agentIdentity(item),
        task_id: item.id, role: item.agentRole, name: item.payload.agentDefinition?.name,
        member_name: item.background ? undefined : addresses.get(item.id) ?? agentIdentity(item), parent: item.parentRunId,
        status: item.status, label: item.label, background: item.background, path: item.payload.operation?.path,
      })) } };
    },
  },
  {
    schema: tool("send_message", "在当前对话内联系其他智能体。task_id 可填 list_agents 返回的 agent_id、task_id 或 member_name。主智能体的固定地址是 lead。", { ...task, message: string }, ["task_id", "message"]),
    label: "协调创作",
    async execute({ store, run }, id, args) {
      const input = z.object({ task_id: z.string(), message: z.string().min(1).max(16000) }).parse(args);
      return { result: await store.sendAgentMessage(run, id, input.task_id, input.message) };
    },
  },
  {
    name: "delegate",
    schema: ({ store, run, settings, preset, roles = store.agents }) => run.agentRole !== "media" && roles.length ? tool("delegate",
      "启动已注册角色的独立子智能体。同一创建者下名称唯一，嵌套智能体通过完整路径寻址。context=fork 可继承已完成的对话历史。用 send_message 联系已有智能体。",
      { role: { type: "string", enum: roles.map((agent) => agent.id),
        description: roles.map(({ id, name, description }) => id + " · " + name + (description ? " · " + description : "")).join("\n") },
        instruction: string, name: string, context: { type: "string", enum: ["fresh", "fork"] }, ...childParameters(settings),
        ...(preset?.childPresets?.length ? { agent_preset: { type: "string", enum: preset.childPresets,
          description: preset.childPresets.map((id) => { try { return id + " · " + store.presets.projectPreset(run.projectId, id).name; } catch { return id; } }).join("\n") } } : {}) }, ["role", "instruction"]) : undefined,
    label: "委派创作", mode: "parallel",
    async execute({ store, run, settings, preset, roles = store.agents, signal, resolveModel }, id, args) {
      const input = z.object({ role: z.string(), instruction: z.string().min(1).max(16000), name: z.string().max(32).optional(),
        context: z.enum(["fresh", "fork"]).optional(), ...childFields }).parse(args);
      const execution = childExecution(input, settings, roles.find(({ id }) => id === input.role), run.payload.childExecution?.cwd ?? run.payload.workingDirectory);
      execution.preset = delegatedPreset({ store, run, preset }, input.agent_preset);
      await preflightChildModel(execution, settings, signal, resolveModel);
      return { result: await store.startChild(run, id, input.role, input.instruction, undefined, input.context === "fork", roles, input.name, execution) };
    },
  },
  {
    schema: tool("job_output", "读取自己创建的后台任务自上次读取后的输出和最终结果，默认立即返回。more=true 时可继续读取。仅在依赖任务完成时设 wait=true。",
      { job_id: string, wait: { type: "boolean" }, timeout_ms: { ...integer, minimum: 1 } }, ["job_id"]),
    label: "读取后台任务输出",
    async execute({ store, run }, callId, args) {
      const { job_id, wait, timeout_ms } = z.object({ job_id: z.string(), wait: z.boolean().default(false),
        timeout_ms: z.number().int().positive().safe().optional() }).parse(args);
      if (wait && !taskResultReady(await store.ownedBackgroundJob(run, job_id)))
        return { waitFor: [job_id], waitForTasksUntil: Date.now() + Math.min(timeout_ms ?? store.jobWaitTimeout, store.maxJobWaitTimeout) };
      const result = await consumeJobOutput(store, run, callId, job_id);
      return { result };
    },
  },
  {
    schema: tool("wait_for_tasks", "读取指定任务的结果。默认只看当前状态，需等待时设 wait=true，可用 timeout_ms 指定上限。读取后台任务的增量输出使用 job_output。",
      { task_ids: { type: "array", items: string }, wait: { type: "boolean" }, timeout_ms: { ...integer, minimum: 1 } }, ["task_ids"]),
    label: "等待子任务",
    async execute({ store, tasks }, _id, args) {
      const { task_ids, wait, timeout_ms } = z.object({ task_ids: z.array(z.string()).min(1).max(96),
        wait: z.boolean().optional(), timeout_ms: z.number().int().positive().safe().optional() }).parse(args);
      const selected = tasks.filter((item) => task_ids.includes(item.id));
      if (task_ids.some((id) => !selected.some((item) => item.id === id))) throw new AppError("只能等待当前会话可访问的任务");
      const ready = selected.every(taskResultReady);
      if (!ready && wait === true) return { waitFor: task_ids, waitForTasksUntil: Date.now() + Math.min(timeout_ms ?? store.jobWaitTimeout, store.maxJobWaitTimeout) };
      return { result: { ...(ready ? {} : { status: "pending" }), tasks: selected.map(taskResult) }, observedTasks: selected };
    },
  },
  {
    schema: tool("wait_for_input", "当前任务必须等协作消息、任务状态通知或用户补充才能继续时，可暂时等待下一步输入。超时后恢复本轮。",
      { timeout_ms: { type: "integer", minimum: 10000, maximum: 3600000, default: 30000 } }),
    label: "等待协作消息",
    async execute(_context, _id, args) {
      const { timeout_ms } = z.object({ timeout_ms: z.number().default(30000) }).parse(args);
      if (!Number.isSafeInteger(timeout_ms) || timeout_ms < 10_000 || timeout_ms > 3_600_000)
        throw new AppError("等待时间必须是 10000 至 3600000 毫秒的整数", 400, "WAIT_INVALID_TIMEOUT");
      return { waitForInputUntil: Date.now() + timeout_ms };
    },
  },
  {
    schema: tool("control_task", "暂停、继续或取消自己可控制的任务。子智能体可用完整名称或任务编号。取消子智能体只中断其当前工作，可发消息继续。供应商的取消结果以 cancellation 状态为准。", { ...task, action: { type: "string", enum: ["pause", "resume", "cancel"] } }, ["task_id", "action"]),
    label: "调整子任务",
    async execute({ store, run, tasks, settings }, callId, args) {
      const input = z.object({ task_id: z.string(), action: z.enum(["pause", "resume", "cancel"]) }).parse(args);
      const child = tasks.find((item) => item.id === input.task_id) ?? await store.resolveCollaborator(run, input.task_id);
      if (!child) throw new AppError("只能控制当前会话可访问的任务", 403, "TASK_NOT_REACHABLE");
      return { result: await controlTaskFromTool(store, child, input.action, settings, { run, callId }) };
    },
  },
  {
    schema: tool("rename_project", "给当前项目命名。", { title: string }, ["title"]),
    label: "命名项目",
    async execute({ store, run }, id, args) {
      const { title } = z.object({ title: z.string().min(1).max(100) }).parse(args);
      return { result: await store.renameProjectFromTool(run, id, title) };
    },
  },
];
const studioTools = [...fileTools, ...webTools, ...collaborationTools, ...teamTools, ...mediaTools, ...workflowTools];
const registrationName = (entry: ToolRegistration) => entry.name ?? (typeof entry.schema === "function" ? undefined : entry.schema.function.name);
export const presetToolCatalog = [...studioTools, ...scheduleTools].flatMap((entry) => {
  const name = registrationName(entry);
  return !name || name === structuredOutputTool ? [] : [{ name, label: entry.label }];
});

const builtInTools = new Set([...studioTools, ...skillTools, ...scheduleTools]);

export function createToolRegistry(context: ToolContext, admitted?: readonly string[], schemas?: readonly AgentTool[],
  bindings?: Readonly<Record<string, string>>) {
  const filters = context.preset?.tools;
  const local = [
    ...studioTools,
    ...(context.store.scheduleToolsEnabled && !context.run.parentRunId ? scheduleTools : []),
  ].filter((entry) => {
    const name = registrationName(entry);
    return filters == null || name === structuredOutputTool || name !== undefined && filters.includes(name);
  });
  const registrations = context.store.tools ?? [
    ...local,
    ...(context.store.skills ? skillTools : []),
    ...(context.externalTools ?? []),
  ];
  const scoped = new Map<string, ToolRegistration>();
  for (const entry of context.scopedTools ?? []) {
    const name = registrationName(entry);
    if (name) scoped.set(name, entry);
  }
  return new ToolRegistry(context, [...registrations.filter((entry) => !scoped.has(registrationName(entry) ?? "")), ...scoped.values()],
    admitted, schemas, bindings, builtInTools,
    context.store.tools ? (entry) => {
      const scopedEntry = scoped.get(registrationName(entry) ?? "");
      return scopedEntry ? scopedEntry === entry : context.store.tools!.includes(entry);
    } : undefined);
}
