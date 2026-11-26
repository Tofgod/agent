import { z } from "zod";
import { tool } from "./file-tools";
import { AppError } from "./security";
import { scheduleInput, Schedules } from "./schedules";
import { skillName } from "./session-presets";
import type { ToolRegistration } from "./tool-registry";
import { canInvokeSkill, explicitlyLoadedSkill, renderSkillContent } from "./skills";

const string = { type: "string" }, id = z.string().uuid();
const targetInput = z.union([scheduleInput.shape.target.removeDefault(), z.enum(["this_session", "new_once", "new"])]);
const scheduleSelectors = { timing: scheduleInput.shape.timing.optional(), target: targetInput.optional(), rrule: z.string().optional() };
const scheduleFields = { title: string, prompt: string, rrule: { ...string, description: "带 DTSTART 的 RRULE" },
  timing: { type: "object", description: "可选结构化规则。kind 可用 after、at、every、daily、weekly、cron 或 rrule。" },
  target: { description: "this_session、new_once、new，或带 kind、id、cwd、presetId 的配置。",
    anyOf: [{ type: "string", enum: ["this_session", "new_once", "new"] }, { type: "object" }] } };
const activeFlag = { type: "boolean" };
const scheduleSummary = (record: Awaited<ReturnType<Schedules["save"]>>) =>
  ({ id: record.id, status: record.status, version: record.version, nextAt: record.nextAt, updatedAt: record.updatedAt });
const scheduleTarget = (value: z.infer<typeof targetInput> | undefined, sessionId: string, cwd?: string, presetId?: string) =>
  value === undefined || value === "this_session" ? { kind: "session" as const, id: sessionId } :
    typeof value === "string" ? { kind: value, cwd, presetId } : value;
const skillsAvailable: NonNullable<ToolRegistration["available"]> = ({ store, run, preset, skillDiscovery }) =>
  skillDiscovery ? skillDiscovery.complete === false || skillDiscovery.entries.some(({ entry }) => canInvokeSkill(entry, preset?.skills, "model"))
    : Boolean(store.skills?.catalog(run.projectId, preset?.skills, "model").length);
const skillTool: ToolRegistration = {
  schema: tool("skill", "在任务点名或明显匹配目录条目时，先按名称加载技能正文。用户 /名称 已注入的正文直接使用。需要参考文本时传 resource 相对路径。", { name: string, resource: string }, ["name"]),
  available: skillsAvailable,
  label: "读取技能", mode: "parallel",
  async execute({ store, run, preset, skillDiscovery, signal }, _id, args) {
    const { name, resource } = z.strictObject({ name: skillName, resource: z.string().max(500).optional() }).parse(args);
    if (resource === undefined && explicitlyLoadedSkill(run.payload.agent?.messages ?? [], name))
      return { result: { name, already_loaded: true, message: "用户已加载此技能。请使用当前对话中的技能正文。" } };
    const available = skillDiscovery ?? await store.skills!.discover(run.projectId, [], run.payload.childExecution?.cwd ?? run.payload.workingDirectory, [], signal);
    const skill = available.entries.find(({ entry }) => entry.name === name && canInvokeSkill(entry, preset?.skills, "model"));
    if (!skill) throw new AppError("当前对话不能调用该技能", 403, "SKILL_UNAVAILABLE");
    const content = await skill.read(resource, "model", signal);
    return { result: { name, provider: skill.provider, ...(resource ? { resource, content } : {
      resourceBase: skill.resourceBase, content: renderSkillContent(name, content, skill.provider, skill.resourceBase),
    }) } };
  },
};
export const skillTools: ToolRegistration[] = [skillTool, {
  schema: tool("list_skills", "分页列出当前会话可用的技能名称与描述；正文使用 skill 读取。", { offset: { type: "integer" } }),
  available: skillsAvailable, label: "查看技能", mode: "parallel",
  async execute({ store, run, preset, skillDiscovery }, _call, args) {
    const { offset } = z.object({ offset: z.number().int().nonnegative().safe().default(0) }).parse(args);
    const all = skillDiscovery?.entries.map(({ entry }) => entry).filter((entry) => canInvokeSkill(entry, preset?.skills, "model")) ??
      store.skills!.catalog(run.projectId, preset?.skills, "model");
    const entries = all.slice(offset, offset + 30);
    return { result: { skills: entries, next_offset: offset + entries.length < all.length ? offset + entries.length : null,
      ...(skillDiscovery?.complete === false ? { incomplete: true } : {}) } };
  },
}];
export const scheduleTools: ToolRegistration[] = [
  { schema: tool("schedule_create", "按用户要求创建定时任务。使用 rrule 或 timing，并明确指定投递目标。", scheduleFields,
      ["title", "prompt", "target"]), label: "创建定时任务",
    async execute({ store, run }, callId, args) {
      const { title, prompt, timing, target, rrule } = z.strictObject({ title: scheduleInput.shape.title,
        prompt: scheduleInput.shape.prompt, ...scheduleSelectors, target: targetInput }).parse(args);
      const preset = store.presets.get(run.projectId, run.sessionId ?? "");
      const input = scheduleInput.parse({ title, prompt, timing: timing ?? (rrule ? { kind: "rrule", rrule } : undefined),
        target: scheduleTarget(target, run.sessionId ?? "", run.payload.workingDirectory, preset?.id) });
      const record = await new Schedules(store).save(run.projectId, input, undefined, { run, toolId: callId });
      return { result: scheduleSummary(record) };
    } },
  { schema: tool("schedule_list", "分页列出当前用户的定时任务及下一次投递时间。",
    { active: activeFlag, limit: { type: "integer", minimum: 1, maximum: 500 }, offset: { type: "integer", minimum: 0 } }),
    label: "查看定时任务", mode: "parallel",
    async execute({ store, run }, _call, args) {
      const options = z.object({ active: z.boolean().optional(), limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().nonnegative().safe().default(0) }).parse(args);
      const rows = new Schedules(store).listOwned((await store.jobContext(run.id)).userId, options);
      return { result: { now: new Date().toISOString(), schedules: rows.map(({ prompt: _prompt, ...row }) => row),
        next_offset: rows.length === options.limit ? options.offset + rows.length : null } };
    } },
  { schema: tool("schedule_view", "按任务 ID 读取定时任务和最近一次投递回执。", { id: string }, ["id"]), label: "读取定时任务", mode: "parallel",
    async execute({ store, run }, _call, args) {
      return { result: { task: new Schedules(store).owned((await store.jobContext(run.id)).userId, z.object({ id }).parse(args).id) } };
    } },
  { schema: tool("schedule_edit", "按 ID 和当前 version 修改、暂停、恢复或删除项目定时任务。更新时提供要修改的字段。", {
    ...scheduleFields, active: activeFlag, id: string, version: { type: "integer" }, expectedUpdatedAt: { type: ["string", "null"] },
    action: { type: "string", enum: ["update", "pause", "resume", "delete"] },
  }, ["id", "action"]), label: "更新定时任务",
    async execute({ store, run }, callId, args) {
      const { id: taskId, version, action, active, expectedUpdatedAt, ...changes } = z.strictObject({ ...scheduleSelectors,
        title: scheduleInput.shape.title.optional(), prompt: scheduleInput.shape.prompt.optional(), active: z.boolean().optional(), id, version: z.number().int().optional(),
        expectedUpdatedAt: z.string().datetime({ offset: true }).nullable().optional(),
        action: z.enum(["update", "pause", "resume", "delete"]) }).parse(args);
      const userId = (await store.jobContext(run.id)).userId, service = new Schedules(store), prior = service.owned(userId, taskId);
      if (version !== undefined && version !== prior.version || expectedUpdatedAt !== undefined && expectedUpdatedAt !== (prior.updatedAt ?? null))
        throw new AppError("定时任务修订已变化", 409, "SCHEDULE_CONFLICT");
      const caller = { run, toolId: callId };
      const sameProject = prior.projectId === run.projectId;
      if (changes.target === "this_session" && !sameProject) throw new AppError("请选择定时任务所在项目的对话", 409);
      const modified = Object.values(changes).some((value) => value !== undefined);
      if (action === "delete" && (modified || active !== undefined)) throw new AppError("删除任务时请只传任务标识和修订");
      if (action === "update" && !modified && active === undefined) throw new AppError("请提供需要修改的字段");
      const preset = sameProject ? store.presets.get(run.projectId, run.sessionId ?? "") : null;
      const task = action === "update" ? await service.save(prior.projectId, {
        title: changes.title ?? prior.title, prompt: changes.prompt ?? prior.prompt,
        timing: changes.timing ?? (changes.rrule ? { kind: "rrule", rrule: changes.rrule } : prior.timing),
        target: changes.target === undefined ? prior.target : scheduleTarget(changes.target, run.sessionId ?? "", sameProject ? run.payload.workingDirectory : undefined, preset?.id),
      }, prior, caller, undefined, active, changes.target !== undefined) : await service.change(prior, action, caller);
      return { result: task ? scheduleSummary(task) : { id: taskId, status: "deleted", version: prior.version + 1, nextAt: null } };
    } },
];
