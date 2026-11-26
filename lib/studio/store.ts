import type { Database } from "./storage";
import { DEFAULT_SETTINGS, STUDIO_NAME, type ActiveBackgroundTask, type AgentDefinition, type AgentState, type AgentToolCall, type ChatSubmission, type ExecutionStep, type AgentImage, type AgentMessage, type AgentRole, type Artifact, type ArtifactKind, type ArtifactStatus, type FileComparison, type Message, type ModelUsage, type Project, type ProviderSettings, type Run, type RunIntent, type RunPayload, type Stage, type TurnFileChange, type WorkspaceDelta, type WorkspaceFrame, type WorkspaceSnapshot } from "./types";
import { mergeSettings, savedSettings } from "./settings";
import { videoTaskOutput, type MediaResult, type MediaTask } from "./providers";
import { compositionOutput } from "./media-specs";
import { productionFinished } from "./agent-state";
import { agentIdentity, joinMemberPath, leadAgentId, memberAddresses } from "./agent-identity";
import { AppError, decryptSecrets, encryptSecrets } from "./security";
import { webReceiptSources } from "./web-tools";
import { PROJECT_MEMORY, PROJECT_TRASH, projectOutputPath, projectTrashPath } from "./project-layout";
import type { RuntimeFile } from "./runtime-context";
import { projectConversation, projectReply, toolKey } from "./conversation";
import { compareText } from "./file-diff";
import { repairToolHistory, toolNotStarted, toolOutcomeUnknown, type ToolResultPruning } from "./tool-history";
import { inheritConversation } from "./agent-history";
import type { ToolOutputRecord } from "./tool-output";
import type { ToolContinuation, ToolRegistration } from "./tool-registry";
import type { TextModelResolver } from "./providers";
import { JOB_OUTPUT_RETAIN_BYTES, type JobOutputChannel } from "./background-jobs";
import type { ExecutionProjection } from "./execution-hooks";
import { replaySession, sessionPatch, type SessionChange, type SessionEntry, type SessionPatch } from "./session-journal";
import { builtinAgents } from "./agent-roles";
import { committedRunEvent, copyForkHistory } from "./session-fork";
import { notifyExecutions } from "./run-execution";
import { sessionReferenceSnapshot, sessionReferenceTranscript, type PreparedSessionReference } from "./session-reference";
import { hydratedModelRequest, recordModelRequest, restoreModelRequest } from "./model-request-record";
import { structuredOutputTool, type ChildExecution } from "./child-execution";
import { ModelRetryPolicies, type ModelRetryConfig } from "./model-retry-policy";
import { CompactionPolicies, DEFAULT_CONTEXT_WINDOW, type CompactionConfig } from "./compaction-policy";
import { SessionPresets, type SessionPreset } from "./session-presets";
import type { SchedulePolicy } from "./schedules";
import type { PresetPlugins } from "./preset-plugins";
import type { SkillLibrary } from "./skills";
import type { McpManager } from "./mcp";
import type { AgentInput, AgentInputSource, BatchMember, Delivery, ExecutionDetail, ExecutionPart, HistoryMatch, HistoryPage, MessageAttachment, ProjectSession, QueuedChat, QueuedChatEdit, QueuedChatVersion, TeamTask } from "./types";
type Row = Record<string, unknown>;
const sessionProjections = new WeakMap<Database, Map<string, { state: AgentState; revision: number }>>();
const stepColumns = "seq,run_id,call_id,name,status,summary,started_at,finished_at,dispatched_at";
const callColumns = "c.id,c.run_id,c.status,c.visible_text,c.response,c.created_at,json_extract(c.request,'$.purpose') AS purpose";
const jsonIds = "SELECT value FROM json_each(?)";
const activeArtifactPath = "path NOT LIKE '/08_记录/.do漫回收站/%'";
const selectedChatArtifacts = `SELECT a.id,a.path,a.kind,a.version,CAST(selection.key AS INTEGER) AS position
  FROM json_each(?) selection JOIN artifacts a ON a.id=selection.value WHERE a.project_id=? AND a.status='ready' AND a.${activeArtifactPath}`;
const chatArtifactRefs = "SELECT json_group_array(json_object('id',id,'path',path,'kind',kind,'version',version) ORDER BY position) FROM selected";
const queueBlocked = "parent_run_id IS NULL AND status IN ('queued','running','waiting','paused')";
const steeringRun = "parent_run_id IS NULL AND stage='agent' AND agent_role='main' AND status IN ('queued','running','waiting')";
const currentAgent = (alias: string) => `json_extract(${alias}.payload,'$.inherited') IS NOT 1 AND json_extract(${alias}.payload,'$.imported') IS NOT 1`;
export const sessionActive = (project: string, session: string) => `NOT EXISTS(SELECT 1 FROM session_management sm
  WHERE sm.project_id=${project} AND sm.session_id=${session} AND sm.archived=1)`;
export const activeRunStatus = "status IN ('queued','running','waiting')";
export const cancelledRunPayload = `json_remove(json_set(payload,'$.cancellation',CASE
  WHEN json_extract(payload,'$.providerTaskId') IS NOT NULL THEN json('{"state":"checking","detail":"本地已停止，正在核对供应商状态","attempts":0}')
  WHEN json_extract(payload,'$.submissionUnknown')=1 THEN json('{"state":"unknown","detail":"本地已停止，提交结果尚未确认","attempts":0}')
  ELSE NULL END),'$.agentInterrupted')`;
const creativeChild = (alias: string) => `${alias}.parent_run_id IS NOT NULL AND ${alias}.agent_role<>'media' AND ${currentAgent(alias)}`;
// Every turn of the lead shares one identity. A delegated agent keeps its own run id across turns.
const madeByAgent = (task: string, ownerId: string) => `EXISTS(
  SELECT 1 FROM runs creator JOIN runs actor ON actor.id=${ownerId}
  WHERE creator.id=${task}.parent_run_id AND creator.project_id=actor.project_id AND creator.session_id=actor.session_id
    AND ${currentAgent("creator")} AND (creator.id=actor.id OR (creator.parent_run_id IS NULL AND actor.parent_run_id IS NULL)))`;
const ownerJobs = (ownerId: string, except = "NULL") => `SELECT COUNT(*) AS count FROM runs job WHERE job.project_id=? AND job.session_id=?
  AND job.id IS NOT ${except} AND job.background=1 AND ${currentAgent("job")} AND ${madeByAgent("job", ownerId)}
  AND (job.${activeRunStatus} OR (job.status IN ('paused','cancelled') AND job.lease_until>CAST(unixepoch('subsec')*1000 AS INTEGER)))`;
const toolCallerGuard = `EXISTS(SELECT 1 FROM runs WHERE id=? AND project_id=? AND lease_token=? AND input_version=? AND status='running')
  AND NOT EXISTS(SELECT 1 FROM tool_receipts WHERE run_id=? AND call_id=?)`;
const sealedStructuredResult = (runId: string) => `SELECT 1 FROM tool_receipts t JOIN execution_steps e ON e.run_id=t.run_id AND e.call_id=t.call_id
  WHERE t.run_id=${runId} AND t.concludes_turn=1 AND e.name='${structuredOutputTool}'`;
const dependencyPending = `EXISTS(SELECT 1 FROM json_each(runs.payload,'$.batch.dependencies') dep
  LEFT JOIN runs prerequisite ON prerequisite.id=dep.value WHERE prerequisite.status IS NOT 'done')`;
const hasUnfinishedAgentExecution = (run: string) => `(${run}.agent_role<>'media' AND (
  EXISTS(SELECT 1 FROM model_calls c WHERE c.run_id=${run}.id AND c.status='started')
  OR EXISTS(SELECT 1 FROM execution_steps s WHERE s.run_id=${run}.id AND s.status='running')
  OR (EXISTS(SELECT 1 FROM pending_agent_tools p WHERE p.run_id=${run}.id)
    AND NOT EXISTS(SELECT 1 FROM events e WHERE e.project_id=${run}.project_id AND e.type='turn/end'
      AND json_extract(e.data,'$.runId')=${run}.id AND json_extract(e.data,'$.turn')=${run}.generation))))`;
const unfinishedAgentExecution = hasUnfinishedAgentExecution("runs");
const taskNoticeToken = (alias: string) => `CAST(${alias}.generation AS TEXT)||':'||${alias}.status||
  COALESCE(':'||json_extract(${alias}.payload,'$.cancellation.state'),'')`;
const routedChildResult = (task: string, owner: string) => `EXISTS(SELECT 1 FROM agent_inbox routed
  WHERE routed.project_id=${owner}.project_id AND routed.session_id=${owner}.session_id AND routed.run_id=${owner}.id
    AND routed.id='task:'||${task}.id||':'||${taskNoticeToken(task)} AND routed.wake=1)`;
const unclaimedTaskResults = (wakeBackground: boolean) => `FROM agent_inbox i JOIN runs child ON child.id=i.content AND child.parent_run_id=i.run_id
  JOIN runs parent ON parent.id=child.parent_run_id JOIN projects project ON project.id=i.project_id
  WHERE i.kind='task-result' AND i.state='ready' AND i.wake=0 AND project.status<>'archived'
    AND ${sessionActive("i.project_id", "i.session_id")}
    AND json_extract(child.payload,'$.stoppedBySessionArchive') IS NOT 1
    AND NOT EXISTS(SELECT 1 FROM background_job_reads read
      WHERE read.job_id=child.id AND read.owner='lead' AND read.observed_terminal=${taskNoticeToken("child")})
    AND json_extract(parent.payload,'$.inherited') IS NOT 1 AND json_extract(parent.payload,'$.imported') IS NOT 1
    AND child.status IN ('done','failed','cancelled')
    AND child.lease_until<=CAST(unixepoch('subsec')*1000 AS INTEGER)
    AND NOT ${hasUnfinishedAgentExecution("child")}
    AND i.id='task:'||child.id||':'||${taskNoticeToken("child")}
    AND ((child.background=0 AND child.agent_role<>'media' AND parent.parent_run_id IS NULL AND parent.status='done' AND parent.intent='agent'
      AND NOT EXISTS(SELECT 1 FROM runs received WHERE received.project_id=i.project_id AND received.session_id=i.session_id
        AND received.parent_run_id IS NULL AND json_extract(received.payload,'$.agent.childNotices."'||child.id||'"')=${taskNoticeToken("child")}))${wakeBackground ? `
      OR (child.background=1 AND parent.parent_run_id IS NULL AND COALESCE(json_extract(child.payload,'$.cancellation.state'),'') NOT IN ('checking','running','unknown')
        AND NOT EXISTS(SELECT 1 FROM runs received WHERE received.project_id=i.project_id AND received.session_id=i.session_id
          AND received.parent_run_id IS NULL AND json_extract(received.payload,'$.agent.backgroundNotices."'||child.id||'"')=${taskNoticeToken("child")}))` : ""})`;
// Recheck the selected tasks at claim time, including when a job settles before its waiter parks.
const agentWaitBlocked = `(runs.status='waiting'
  AND json_extract(runs.payload,'$.agent.waitingInputVersion') IS runs.input_version
  AND NOT EXISTS(SELECT 1 FROM agent_inbox i WHERE i.project_id=runs.project_id AND i.run_id=runs.id AND i.target='next-step' AND i.state='pending')
  AND (json_extract(runs.payload,'$.agent.waitingForJob') IS 1 OR (NOT EXISTS(SELECT 1 FROM agent_inbox i WHERE i.project_id=runs.project_id AND i.run_id=runs.id
    AND i.target='next-step' AND i.kind='agent' AND i.state='ready'
    AND i.id NOT IN (SELECT value FROM json_each(runs.payload,'$.agent.seenUserIds')))
  AND NOT EXISTS(SELECT 1 FROM runs notice WHERE notice.project_id=runs.project_id AND notice.session_id=runs.session_id
    AND ${currentAgent("notice")}
    AND ((notice.background=1 AND ${madeByAgent("notice", "runs.id")})
      OR (notice.background=0 AND (notice.parent_run_id=runs.id OR ${routedChildResult("notice", "runs")})))
    AND notice.status IN ('done','failed','cancelled','paused')
    AND notice.id NOT IN (SELECT value FROM json_each(runs.payload,'$.agent.waitingFor'))
    AND COALESCE(json_extract(runs.payload,CASE WHEN notice.background=1 THEN '$.agent.backgroundNotices' ELSE '$.agent.childNotices' END
      || '."' || notice.id || '"'),'')<>${taskNoticeToken("notice")})))
  AND (COALESCE(json_extract(runs.payload,'$.agent.waitingForInputUntil'),0)>CAST(unixepoch('subsec')*1000 AS INTEGER)
    OR ((json_extract(runs.payload,'$.agent.waitingForTasksUntil') IS NULL
      OR json_extract(runs.payload,'$.agent.waitingForTasksUntil')>CAST(unixepoch('subsec')*1000 AS INTEGER))
      AND EXISTS(SELECT 1 FROM json_each(runs.payload,'$.agent.waitingFor') awaited JOIN runs task ON task.id=awaited.value
        WHERE task.project_id=runs.project_id AND task.session_id=runs.session_id AND task.status IN ('queued','running','waiting')
          AND (task.background=0 OR ${madeByAgent("task", "runs.id")})))))`;
export type ToolCaller = { run: Run; callId: string };
export type SkippedToolCall = { call: AgentToolCall; index: number; requestId?: string };
const toolCallerBindings = (projectId: string, { run, callId }: ToolCaller) =>
  [run.id, projectId, run.leaseToken, run.inputVersion, run.id, callId];
type VersionWrite = Pick<Artifact, "id" | "version" | "content" | "url" | "path" | "kind"> & {
  metadata: string; createdAt: string; runId?: string; previousPath?: string;
};
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
const json = (v: unknown) => JSON.stringify(v);
function allocateMemberName(used: Set<string>, requested?: string) {
  if (requested !== undefined && (!/^[a-z][a-z0-9-]{0,31}$/.test(requested) || requested === "lead"))
    throw new AppError("子智能体名称无效", 400, "INVALID_AGENT_NAME");
  if (requested && used.has(requested)) throw duplicateAgentName();
  let number = 1;
  while (!requested && used.has("agent-" + number)) number++;
  const name = requested ?? "agent-" + number;
  used.add(name);
  return name;
}
const duplicateAgentName = () => new AppError("当前智能体已创建同名子智能体", 409, "DUPLICATE_AGENT_NAME");
function validateDependencies(entries: { id: string; dependencies: string[] }[]) {
  const graph = new Map(entries.map(({ id, dependencies }) => [id, dependencies]));
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new AppError("任务依赖不能形成循环", 409, "DEPENDENCY_CYCLE");
    if (visited.has(id)) return;
    const deps = graph.get(id);
    if (!deps) throw new AppError("依赖任务不存在", 409, "DEPENDENCY_NOT_FOUND");
    visiting.add(id);
    for (const dep of deps) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}
function projectRow(r: Row): Project {
  return { id: String(r.id), title: String(r.title), brief: String(r.brief), style: String(r.style),
    ratio: r.ratio as Project["ratio"], duration: Number(r.duration), status: String(r.status),
    isExample: Boolean(r.is_example), createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
}
function artifactRow(r: Row): Artifact {
  return { id: String(r.id), projectId: String(r.project_id), path: String(r.path), kind: r.kind as ArtifactKind,
    content: String(r.content), version: Number(r.version), status: r.status as ArtifactStatus, locked: Boolean(r.locked),
    url: r.url ? String(r.url) : null, metadata: JSON.parse(String(r.metadata)), createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
}
function messageRow(r: Row): Message {
  return { id: String(r.id), projectId: String(r.project_id), role: r.role as Message["role"],
    agent: r.agent as Message["agent"], content: String(r.content), runId: r.role === "assistant" && r.run_id ? String(r.run_id) : null,
    artifactIds: JSON.parse(String(r.artifact_ids)), createdAt: String(r.created_at),
    ...(r.request_id ? { requestId: String(r.request_id), attachments: JSON.parse(String(r.attachments)) } : {}) };
}
function runRow(r: Row): Run {
  return { id: String(r.id), projectId: String(r.project_id), intent: r.intent as RunIntent, status: r.status as Run["status"],
    stage: r.stage as Stage, progress: Number(r.progress), label: String(r.label), error: r.error ? String(r.error) : null,
    payload: JSON.parse(String(r.payload)), leaseUntil: Number(r.lease_until), leaseToken: String(r.lease_token || ""), attempts: Number(r.attempts || 0), nextAttemptAt: Number(r.next_attempt_at || 0), errorCode: r.error_code ? String(r.error_code) : null, createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    ...(r.background ? { background: true as const } : {}), ...(r.agent_revision ? { agentRevision: Number(r.agent_revision) } : {}),
    ...(r.session_id ? { sessionId: String(r.session_id) } : {}),
    parentRunId: r.parent_run_id ? String(r.parent_run_id) : null, agentRole: (r.agent_role || "main") as AgentRole,
    generation: Number(r.generation || 1), inputVersion: Number(r.input_version || 0), streamText: String(r.stream_text || ""), resultText: String(r.result_text || "") };
}
function workspaceRun(row: Row) {
  const run = runRow(row);
  if (!run.parentRunId && run.intent === "agent" && run.status === "done" &&
      (run.payload.archivedFork || run.payload.forkSource || !run.payload.imported && (run.agentRevision || run.payload.agent))) run.canFork = true;
  delete run.payload.agent;
  delete run.payload.forkSource;
  delete run.payload.forkChanges;
  delete run.payload.agentRevision;
  delete run.agentRevision;
  return run;
}
function stepRow(row: Row, eventSeq?: number): ExecutionStep {
  return { seq: Number(row.seq), runId: String(row.run_id), callId: String(row.call_id), name: String(row.name),
    status: row.status as ExecutionStep["status"], summary: String(row.summary), startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null, eventSeq,
    ...(row.status === "interrupted" && row.finished_at && row.dispatched_at === null ? { notDispatched: true } : {}) };
}
export class Store {
  readonly presets: SessionPresets;
  readonly presetPlugins?: PresetPlugins;
  readonly skills?: SkillLibrary;
  readonly mcp?: McpManager;
  readonly scheduleToolsEnabled: boolean;
  readonly schedulePolicy?: SchedulePolicy;
  readonly agents: readonly AgentDefinition[];
  readonly contextWindow: number;
  readonly compaction: CompactionPolicies;
  readonly tools?: readonly ToolRegistration[];
  readonly resolveModel?: TextModelResolver;
  readonly modelRetry: ModelRetryPolicies;
  readonly completionDelivery: "quiet" | "wakeup";
  readonly maxParallelTools: number;
  readonly maxDelegationDepth: number;
  readonly maxConsecutiveWakes?: number;
  readonly maxConcurrentJobsPerOwner: number;
  readonly jobWaitTimeout: number;
  readonly maxJobWaitTimeout: number;
  constructor(public db: Database, options: { agents?: readonly AgentDefinition[]; contextWindow?: number; tools?: readonly ToolRegistration[]; compaction?: CompactionConfig;
    resolveModel?: TextModelResolver; modelRetry?: ModelRetryConfig;
    skills?: SkillLibrary; mcp?: McpManager; presetPlugins?: PresetPlugins; scheduleToolsEnabled?: boolean; schedulePolicy?: SchedulePolicy;
    completionDelivery?: "quiet" | "wakeup"; maxParallelTools?: number; maxDelegationDepth?: number; maxConsecutiveWakes?: number; maxConcurrentJobsPerOwner?: number; jobWaitTimeout?: number; maxJobWaitTimeout?: number } = {}) {
    this.completionDelivery = options.completionDelivery ?? "wakeup";
    this.maxParallelTools = options.maxParallelTools ?? 10;
    this.maxDelegationDepth = options.maxDelegationDepth ?? 1;
    this.maxConsecutiveWakes = options.maxConsecutiveWakes;
    this.maxConcurrentJobsPerOwner = options.maxConcurrentJobsPerOwner ?? 10;
    if (!Number.isSafeInteger(this.maxConcurrentJobsPerOwner) || this.maxConcurrentJobsPerOwner < 1)
      throw new TypeError("每个智能体的后台任务上限必须是正整数");
    this.jobWaitTimeout = options.jobWaitTimeout ?? 30_000;
    this.maxJobWaitTimeout = options.maxJobWaitTimeout ?? 600_000;
    if (!Number.isSafeInteger(this.jobWaitTimeout) || !Number.isSafeInteger(this.maxJobWaitTimeout) ||
        this.jobWaitTimeout < 1 || this.maxJobWaitTimeout < this.jobWaitTimeout)
      throw new TypeError("后台任务等待时限配置无效");
    if (!Number.isSafeInteger(this.maxDelegationDepth) || this.maxDelegationDepth < 0)
      throw new TypeError("委派深度必须是非负整数");
    if (this.maxConsecutiveWakes !== undefined && (!Number.isSafeInteger(this.maxConsecutiveWakes) || this.maxConsecutiveWakes < 1))
      throw new TypeError("自动唤醒上限必须是正整数");
    if (!Number.isSafeInteger(this.maxParallelTools) || this.maxParallelTools < 1) throw new Error("工具并行数必须是正整数");
    this.agents = options.agents ?? builtinAgents;
    this.tools = options.tools;
    this.resolveModel = options.resolveModel;
    this.modelRetry = new ModelRetryPolicies(options.modelRetry);
    this.contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    if (!Number.isSafeInteger(this.contextWindow) || this.contextWindow < 16000) throw new Error("STUDIO_CONTEXT_WINDOW 至少为 16000 个 token");
    this.compaction = new CompactionPolicies(options.compaction, options.contextWindow);
    this.presetPlugins = options.presetPlugins;
    this.presets = new SessionPresets(db, options.presetPlugins);
    this.skills = options.skills;
    this.mcp = options.mcp;
    this.scheduleToolsEnabled = options.scheduleToolsEnabled ?? false;
    this.schedulePolicy = options.schedulePolicy;
  }
  sessionEntries(runId: string, projectId: string, after = 0): SessionEntry[] {
    return this.db.prepare(`SELECT e.revision,e.kind,e.reference,e.patch FROM agent_session_events e
      JOIN runs r ON r.id=e.run_id WHERE r.id=? AND r.project_id=? AND e.revision>? ORDER BY e.revision`)
      .bind(runId, projectId, after).rows<{ revision: number; kind: SessionChange; reference: string | null; patch: string }>()
      .map(({ patch, ...entry }) => ({ ...entry, patch: JSON.parse(patch) as SessionPatch }));
  }
  private restoreRun(row: Row): Run {
    const run = runRow(row);
    if (run.agentRevision) {
      const projections = sessionProjections.get(this.db) ?? new Map<string, { state: AgentState; revision: number }>();
      sessionProjections.set(this.db, projections);
      const snapshot = projections.get(run.id);
      const previous = snapshot && snapshot.revision <= run.agentRevision ? snapshot : undefined;
      const suffix = previous?.revision === run.agentRevision ? [] : this.sessionEntries(run.id, run.projectId, previous?.revision);
      if ((suffix.at(-1)?.revision ?? previous?.revision) !== run.agentRevision) throw new Error("任务的会话日志不完整");
      const state = suffix.length ? replaySession(suffix, previous)! : previous!.state;
      projections.delete(run.id);
      projections.set(run.id, { state, revision: run.agentRevision });
      if (projections.size > 8) projections.delete(projections.keys().next().value!);
      run.payload.agent = structuredClone(state);
      run.payload.agentRevision = run.agentRevision;
    }
    return run;
  }
  private checkpoint(run: Run, payload: RunPayload | undefined, kind: SessionChange, reference?: string) {
    const before = run.agentRevision ?? 0;
    if (!payload?.agent) return { payload, before, revision: before, statements: [] };
    const [row] = this.db.prepare("SELECT * FROM runs WHERE id=? AND project_id=?").bind(run.id, run.projectId).rows<Row>();
    const previous = row ? this.restoreRun(row) : undefined;
    const patch = sessionPatch(before ? previous?.payload.agent : undefined, payload.agent);
    if (!patch) return { payload, before, revision: before, statements: [] };
    const revision = before + 1;
    return { payload: { ...payload, agentRevision: revision }, before, revision, statements: [
      this.db.prepare(`INSERT INTO agent_session_events(run_id,revision,kind,reference,patch,created_at)
        SELECT ?,?,?,?,?,? WHERE changes()=1`).bind(run.id, revision, kind, reference ?? null, json(patch), now()),
    ] };
  }
  private saveVersion(version: VersionWrite) {
    return this.db.prepare(`INSERT INTO artifact_versions(id,artifact_id,version,content,url,metadata,created_at,run_id,path,previous_path,kind)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1`).bind(
      uid(), version.id, version.version, version.content, version.url, version.metadata, version.createdAt,
      version.runId ?? null, version.path, version.previousPath ?? null, version.kind,
    );
  }
  event(projectId: string, type: string, data: unknown) {
    return this.db.prepare("INSERT INTO events(project_id,type,data,created_at) VALUES(?,?,?,?)").bind(projectId, type, json(data), now());
  }
  async listProjects(userId: string): Promise<Project[]> {
    const r = await this.db.prepare("SELECT * FROM projects WHERE user_id=? ORDER BY updated_at DESC").bind(userId).all<Row>();
    return r.results.map(projectRow);
  }
  async project(id: string, userId: string): Promise<Project> { return this.readProject(id, userId); }
  private readProject(id: string, userId: string) {
    const [r] = this.db.prepare("SELECT * FROM projects WHERE id=? AND user_id=?").bind(id, userId).rows();
    if (!r) throw new AppError("项目不存在", 404);
    return projectRow(r);
  }
  async createProject(userId: string, data: Partial<Project>): Promise<Project> {
    const p: Project = { id: uid(), title: data.title || "未命名项目", brief: data.brief || "",
      style: data.style ?? "", ratio: data.ratio || "16:9",
      duration: data.duration || 90, status: "draft", isExample: data.isExample || false, createdAt: now(), updatedAt: now() };
    await this.db.batch([this.db.prepare("INSERT INTO projects(id,user_id,title,brief,style,ratio,duration,status,is_example,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .bind(p.id, userId, p.title, p.brief, p.style, p.ratio, p.duration, p.status, p.isExample ? 1 : 0, p.createdAt, p.updatedAt),
      this.presets.bindNew(p.id, "")]);
    return p;
  }
  async updateProject(id: string, userId: string, data: Partial<Project>) {
    const p = await this.project(id, userId);
    await this.db.prepare("UPDATE projects SET title=?,brief=?,style=?,ratio=?,duration=?,updated_at=? WHERE id=? AND user_id=?")
      .bind(data.title ?? p.title, data.brief ?? p.brief, data.style ?? p.style, data.ratio ?? p.ratio, data.duration ?? p.duration, now(), id, userId).run();
    return this.project(id, userId);
  }
  async archiveProject(projectId: string, userId: string, archived: boolean, stopSchedules = false) {
    const stamp = now();
    const activeSchedules = "EXISTS(SELECT 1 FROM studio_schedules WHERE project_id=projects.id AND status='active')";
    const changed = this.db.prepare(`UPDATE projects SET status=?,updated_at=? WHERE id=? AND user_id=? AND
      (?=0 OR (NOT EXISTS(SELECT 1 FROM runs WHERE project_id=projects.id AND status IN ('queued','running','waiting')) AND
      NOT EXISTS(SELECT 1 FROM chat_queue WHERE project_id=projects.id AND status='pending') AND (?=1 OR NOT ${activeSchedules})))`)
      .bind(archived ? "archived" : "draft", stamp, projectId, userId, Number(archived), Number(stopSchedules));
    const pause = (guard: string, ...args: unknown[]) => this.db.prepare(`UPDATE studio_schedules SET status='paused',version=version+1,updated_at=?
      WHERE project_id=? AND status='active' AND (${guard})`).bind(stamp, projectId, ...args);
    const results = await this.db.batch(archived
      ? [changed, ...(stopSchedules ? [pause("changes()=1")] : [])]
      : [pause("EXISTS(SELECT 1 FROM projects WHERE id=? AND user_id=? AND status='archived')", projectId, userId), changed]);
    if (!results[archived ? 0 : 1].meta.changes) {
      if (archived && !stopSchedules && this.db.prepare(`SELECT 1 FROM projects WHERE id=? AND user_id=? AND ${activeSchedules}`)
        .bind(projectId, userId).rows().length) throw new AppError("请先暂停项目的活动定时任务", 409, "PROJECT_SCHEDULES_ACTIVE");
      throw new AppError("项目仍有运行中的任务或待发消息", 409, "PROJECT_BUSY");
    }
    return this.project(projectId, userId);
  }
  async deleteArchivedProject(projectId: string, userId: string) {
    const removed = await this.db.prepare(`DELETE FROM projects WHERE id=? AND user_id=? AND status='archived'
      AND NOT EXISTS(SELECT 1 FROM runs WHERE project_id=projects.id AND (status IN ('queued','running','waiting') OR lease_until>?))
      AND NOT EXISTS(SELECT 1 FROM chat_queue WHERE project_id=projects.id AND status='pending')`)
      .bind(projectId, userId, Date.now()).run();
    if (removed.meta.changes || this.db.prepare("SELECT 1 FROM project_deletions WHERE project_id=? AND user_id=?").bind(projectId, userId).rows().length) return;
    const [project] = this.db.prepare("SELECT status FROM projects WHERE id=? AND user_id=?").bind(projectId, userId).rows<{ status: string }>();
    if (!project) throw new AppError("项目不存在", 404, "PROJECT_NOT_FOUND");
    if (project.status !== "archived") throw new AppError("请先归档项目", 409, "PROJECT_NOT_ARCHIVED");
    throw new AppError("项目仍有运行中的任务或待发消息，请稍后重试", 409, "PROJECT_BUSY");
  }
  async renameSession(projectId: string, sessionId: string, title: string) {
    const update = sessionId
      ? this.db.prepare("UPDATE project_sessions SET title=? WHERE project_id=? AND id=?").bind(title, projectId, sessionId)
      : this.db.prepare("UPDATE projects SET main_session_title=? WHERE id=?").bind(title, projectId);
    const [result] = await this.db.batch([
      update,
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'feed:sessions',?,? WHERE changes()=1")
        .bind(projectId, json({ id: sessionId }), now()),
    ]);
    if (!result.meta.changes) throw new AppError("该对话不能重命名", 404);
    return this.sessions(projectId);
  }
  sessions(projectId: string): ProjectSession[] {
    const [main] = this.db.prepare("SELECT main_session_title AS title FROM projects WHERE id=?").bind(projectId).rows<{ title: string }>();
    const states = this.db.prepare("SELECT session_id,archived,pinned,position FROM session_management WHERE project_id=?")
      .bind(projectId).rows<{ session_id: string; archived: number; pinned: number; position: number | null }>();
    const stateById = new Map(states.map((state) => [state.session_id, state]));
    const sessions: ProjectSession[] = [{ id: "", title: main?.title ?? "主对话", createdAt: "", teamEnabled: this.teamEnabled(projectId, "") }, ...this.db.prepare("SELECT id,title,created_at,fork_run_id FROM project_sessions WHERE project_id=? ORDER BY rowid")
      .bind(projectId).rows<Row>().map((row) => ({ id: String(row.id), title: String(row.title), createdAt: String(row.created_at),
        teamEnabled: this.teamEnabled(projectId, String(row.id)),
        ...(row.fork_run_id ? { forkRunId: String(row.fork_run_id) } : {}) }))];
    return sessions.map((session) => {
      const state = stateById.get(session.id);
      return state ? { ...session, archived: Boolean(state.archived), pinned: Boolean(state.pinned), position: state.position ?? undefined } : session;
    }).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
      (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));
  }
  assertActiveSession(projectId: string, sessionId: string) {
    if (!this.db.prepare(`SELECT 1 WHERE ${sessionActive("?", "?")}`).bind(projectId, sessionId).rows().length)
      throw new AppError("请先恢复对话", 409, "SESSION_ARCHIVED");
  }
  assertSession(projectId: string, sessionId: string) {
    if (sessionId && !this.db.prepare("SELECT 1 FROM project_sessions WHERE id=? AND project_id=?").bind(sessionId, projectId).rows().length)
      throw new AppError("对话不存在", 404, "SESSION_NOT_FOUND");
  }
  async referenceSession(run: Run, inputId: string, sourceSessionId: string, label: string): Promise<PreparedSessionReference> {
    const { projectId } = run, targetSessionId = run.sessionId ?? "";
    const lookup = () => this.db.prepare(`SELECT preview FROM session_reference_snapshots
      WHERE project_id=? AND target_session_id=? AND input_id=? AND source_session_id=?`)
      .bind(projectId, targetSessionId, inputId, sourceSessionId).rows<{ preview: string }>().at(0);
    const existing = lookup();
    if (existing) return JSON.parse(existing.preview) as PreparedSessionReference;
    const { preview, omitted, full } = this.db.read(() => {
      const session = this.sessions(projectId).find((entry) => entry.id === sourceSessionId);
      if (!session) throw new AppError("当前项目中没有此引用对话", 404, "SESSION_REFERENCE_READ_FAILED");
      const [row] = this.db.prepare(`SELECT * FROM runs WHERE project_id=? AND session_id=? AND parent_run_id IS NULL
        AND (agent_revision>0 OR json_extract(payload,'$.archivedFork')=1) ORDER BY rowid DESC LIMIT 1`).bind(projectId, sourceSessionId).rows<Row>();
      const archived = row && !row.agent_revision ? this.archivedForkEntries(String(row.id)) : [];
      const messages = (row ? this.restoreRun(row).payload.agent?.messages ?? replaySession(archived)?.messages
        : this.sessionSeed(projectId, sourceSessionId)?.messages) ?? [];
      const through = Number(row?.agent_revision) || archived.at(-1)?.revision || 0;
      return sessionReferenceSnapshot({ id: sourceSessionId, title: session.title, label, through, messages }, Math.max(65536, Math.floor(this.contextWindow * .8)));
    });
    if (!omitted || !full) return { preview };
    const snapshotId = uid(), lines = sessionReferenceTranscript(full);
    const omission = { id: sourceSessionId, capturedThroughSeq: preview.capturedThroughSeq, ...omitted };
    const prepared: PreparedSessionReference = { preview, omission: { ...omission,
      fullSnapshot: { status: "saved", snapshot_id: snapshotId, retrievalHint: "用 read_session_reference 传入 snapshot_id。用 next_offset 继续读取。" } } };
    try {
      // Both the locator and its complete line set commit together, before publishing the preview.
      await this.db.batch([
        this.db.prepare(`INSERT INTO session_reference_snapshots(id,project_id,target_session_id,input_id,source_session_id,preview,total_lines)
          SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND project_id=? AND session_id=? AND lease_token=? AND input_version=? AND status='running')
          ON CONFLICT(project_id,target_session_id,input_id,source_session_id) DO NOTHING`)
          .bind(snapshotId, projectId, targetSessionId, inputId, sourceSessionId, json(prepared), lines.length,
            run.id, projectId, targetSessionId, run.leaseToken, run.inputVersion),
        this.db.prepare(`INSERT INTO session_reference_lines(snapshot_id,line,text)
          SELECT ?,CAST(key AS INTEGER)+1,value FROM json_each(?) WHERE changes()=1`).bind(snapshotId, json(lines)),
      ]);
    } catch {
      return { preview, omission: { ...omission, fullSnapshot: { status: "unavailable", reason: "save-failed" } } };
    }
    const record = lookup();
    if (!record) {
      const current = await this.run(run.id, projectId);
      throw new AppError("任务已停止或收到新输入", 409, current.inputVersion !== run.inputVersion ? "AGENT_STEER" : "RUN_STOPPED");
    }
    return JSON.parse(record.preview) as PreparedSessionReference;
  }
  readSessionReference(run: Run, id: string, offset: number, limit: number) {
    const sessionId = run.sessionId ?? "";
    return this.db.read(() => {
      const [snapshot] = this.db.prepare(`SELECT s.total_lines FROM session_reference_snapshots s WHERE s.id=? AND s.project_id=? AND
        (s.target_session_id=? OR EXISTS(SELECT 1 FROM project_sessions p JOIN json_each(p.seed,'$.messages') m
          JOIN json_each(m.value,'$.source.snapshotIds') inherited ON inherited.value=s.id
          WHERE p.project_id=s.project_id AND p.id=? AND json_extract(m.value,'$.source.kind')='session-reference'))`)
        .bind(id, run.projectId, sessionId, sessionId).rows<{ total_lines: number }>();
      if (!snapshot) throw new AppError("引用快照不存在或超出当前对话范围", 404, "SESSION_REFERENCE_UNAVAILABLE");
      if (offset > snapshot.total_lines) throw new AppError("读取位置超出引用范围", 400, "READ_OFFSET_RANGE");
      const lines = this.db.prepare(`SELECT text FROM session_reference_lines WHERE snapshot_id=? AND line>=? ORDER BY line LIMIT ?`)
        .bind(id, offset, limit).rows<{ text: string }>();
      const next = offset + lines.length;
      return { snapshot_id: id, offset, next_offset: next <= snapshot.total_lines ? next : null, total_lines: snapshot.total_lines,
        content: lines.map(({ text }) => text).join("\n") };
    });
  }
  async createSession(projectId: string, title: string, presetId?: string) {
    if (presetId) this.presets.projectPreset(projectId, presetId);
    const session: ProjectSession = { id: uid(), title, createdAt: now() };
    await this.db.batch([
      this.db.prepare("INSERT INTO project_sessions(id,project_id,title,created_at) VALUES(?,?,?,?)")
        .bind(session.id, projectId, session.title, session.createdAt),
      this.presets.bindNew(projectId, session.id, presetId),
      this.event(projectId, "feed:sessions", { id: session.id }),
    ]);
    return session;
  }
  sessionCwd(projectId: string, sessionId: string) {
    return this.db.prepare("SELECT working_directory FROM project_sessions WHERE project_id=? AND id=?")
      .bind(projectId, sessionId).rows<{ working_directory: string | null }>().at(0)?.working_directory ?? undefined;
  }
  async rememberTurnPreset(run: Run, preset: SessionPreset | null) {
    await this.db.prepare("UPDATE runs SET turn_preset=? WHERE id=? AND project_id=? AND turn_preset IS NULL")
      .bind(json(preset), run.id, run.projectId).run();
  }
  private stateAtForkEvent(projectId: string, source: Run, eventSeq: number) {
    const [anchor] = this.db.prepare(`SELECT e.id,e.created_at,COALESCE(a.origin_event_id,e.id) AS originSeq,COALESCE(a.root_run_id,?) AS originRun
      FROM events e LEFT JOIN fork_event_ancestry a ON a.event_id=e.id
      LEFT JOIN messages m ON e.type='message' AND m.id=json_extract(e.data,'$.id') AND m.project_id=e.project_id
      WHERE e.id=? AND e.project_id=? AND COALESCE(json_extract(e.data,'$.runId'),m.run_id)=?
      AND (${committedRunEvent})`)
      .bind(source.id, eventSeq, projectId, source.id)
      .rows<{ id: number; created_at: string; originSeq: number; originRun: string }>();
    if (!anchor) throw new AppError("所选事件不属于当前对话", 409, "FORK_UNAVAILABLE");
    const [origin] = this.db.prepare(`SELECT rowid AS position,session_id,turn_preset,parent_run_id,
      json_extract(payload,'$.archivedFork') AS archived,json_extract(payload,'$.instruction') AS instruction,
      COALESCE(json_extract(payload,'$.childExecution.cwd'),json_extract(payload,'$.workingDirectory')) AS cwd
      FROM runs WHERE id=? AND project_id=? AND (json_extract(payload,'$.imported') IS NOT 1 OR json_extract(payload,'$.archivedFork')=1)`).bind(anchor.originRun, projectId)
      .rows<{ position: number; session_id: string; turn_preset: string | null; archived: number | null;
        parent_run_id: string | null; instruction: string | null; cwd: string | null }>();
    if (!origin) throw new AppError("所选事件的源记录已不可用", 409, "FORK_UNAVAILABLE");
    const checkpoints = origin.archived ? "archived_fork_checkpoints" : "agent_session_events";
    const [checkpoint] = this.db.prepare(`SELECT j.revision,j.event_seq FROM ${checkpoints} j JOIN events e ON e.id=?
      WHERE j.run_id=? AND (j.event_seq<=e.id${origin.archived ? "" : " OR j.event_seq IS NULL AND j.created_at<e.created_at"})
      ORDER BY j.revision DESC LIMIT 1`)
      .bind(anchor.originSeq, anchor.originRun).rows<{ revision: number; event_seq: number | null }>();
    const prior = checkpoint || origin.parent_run_id ? undefined : this.db.prepare(`SELECT * FROM runs WHERE project_id=? AND session_id=? AND rowid<?
      AND parent_run_id IS NULL AND (agent_revision>0 OR json_extract(payload,'$.archivedFork')=1) ORDER BY rowid DESC LIMIT 1`)
      .bind(projectId, origin.session_id, origin.position).rows<Row>()[0];
    const state = checkpoint ? replaySession((origin.archived ? this.archivedForkEntries(anchor.originRun) : this.sessionEntries(anchor.originRun, projectId))
      .filter(({ revision }) => revision <= checkpoint.revision))
      : prior ? this.restoreRun(prior).payload.agent ?? replaySession(this.archivedForkEntries(String(prior.id))) :
        origin.parent_run_id ? undefined : this.sessionSeed(projectId, origin.session_id);
    const seed: AgentState = { ...(state ?? { step: 0, toolIndex: 0, seenUserIds: [], artifactIds: [] }), messages: [...state?.messages ?? []] };
    if (!state && origin.parent_run_id && origin.instruction) seed.messages.push({ role: "user", content: origin.instruction });
    const rejected = new Set(this.db.prepare(`SELECT ids.value AS id FROM events e,json_each(e.data,'$.messageIds') ids
      WHERE e.project_id=? AND e.type='inbox/rejected' AND json_extract(e.data,'$.runId')=?`)
      .bind(projectId, anchor.originRun).rows<{ id: string }>().map(({ id }) => id));
    if (seed.unadmittedInputStart !== undefined && seed.unadmittedInputIds?.some((id) => rejected.has(id))) {
      seed.messages = seed.messages.slice(0, seed.unadmittedInputStart);
      seed.unadmittedInputStart = undefined;
      seed.unadmittedInputIds = undefined;
    }
    const tail = this.db.prepare(`SELECT e.type,e.data,m.id AS message_id,m.content,m.attachments,c.response,COALESCE(s.result,t.result) AS result,s.output_images,s.output_ref
      FROM events e LEFT JOIN messages m ON e.type='message' AND m.id=json_extract(e.data,'$.id') AND m.role='user'
      LEFT JOIN model_calls c ON e.type='reply' AND c.id=json_extract(e.data,'$.requestId') AND json_extract(e.data,'$.status')='completed'
      LEFT JOIN execution_steps s ON e.type='step' AND s.seq=json_extract(e.data,'$.stepSeq') AND json_extract(e.data,'$.status')<>'running'
      LEFT JOIN tool_receipts t ON t.run_id=s.run_id AND t.call_id=s.call_id
      WHERE e.project_id=? AND e.id>? AND e.id<=? AND COALESCE(json_extract(e.data,'$.runId'),m.run_id)=?
      AND (m.id IS NOT NULL OR c.id IS NOT NULL OR s.seq IS NOT NULL) ORDER BY e.id`)
      .bind(projectId, checkpoint?.event_seq ?? 0, anchor.originSeq, anchor.originRun).rows<Row>();
    for (const row of tail) {
      const data = JSON.parse(String(row.data));
      if (row.type === "message" && row.content !== null) {
        if (rejected.has(String(row.message_id))) continue;
        const attachments = JSON.parse(String(row.attachments ?? "[]")) as MessageAttachment[];
        const content = String(row.content) + (attachments.length ? "\n\n引用的项目文件：\n" + json(attachments) : "");
        if (checkpoint?.event_seq || !seed.seenUserIds.includes(String(row.message_id)))
          seed.messages.push({ role: "user", content });
      } else if (row.type === "reply" && row.response) {
        const response = JSON.parse(String(row.response)) as AgentMessage;
        if ((response.content || response.tool_calls?.length || response.messagesReplay || response.chatReasoning) &&
          !seed.messages.some((message) => response.tool_calls?.some(({ id }) => message.tool_calls?.some((call) => call.id === id))))
          seed.messages.push(response);
      } else if (row.type === "step" && row.result && data.callId && !seed.messages.some((message) => message.tool_call_id === data.callId)) {
        seed.messages.push({ role: "tool", tool_call_id: data.callId, content: String(row.result),
          ...(row.output_images ? { images: JSON.parse(String(row.output_images)) } : {}),
          ...(row.output_ref ? { outputRef: String(row.output_ref) } : {}) });
      }
    }
    const dispatched = new Set(this.db.prepare(`SELECT s.call_id FROM execution_steps s WHERE s.run_id=? AND s.dispatched_at IS NOT NULL
      AND (EXISTS(SELECT 1 FROM events e WHERE e.project_id=s.project_id AND e.type='tool/dispatched' AND e.id<=?
        AND json_extract(e.data,'$.runId')=s.run_id AND json_extract(e.data,'$.callId')=s.call_id)
      OR (s.dispatched_at<? AND NOT EXISTS(SELECT 1 FROM events e WHERE e.project_id=s.project_id AND e.type='tool/dispatched'
        AND json_extract(e.data,'$.runId')=s.run_id AND json_extract(e.data,'$.callId')=s.call_id)))`)
      .bind(anchor.originRun, anchor.originSeq, anchor.created_at).rows<{ call_id: string }>().map(({ call_id }) => call_id));
    return { anchor, seed, dispatched, preset: origin.turn_preset, cwd: origin.cwd };
  }
  private archivedForkEntries(runId: string): SessionEntry[] {
    return this.db.prepare("SELECT revision,patch FROM archived_fork_checkpoints WHERE run_id=? ORDER BY revision")
      .bind(runId).rows<{ revision: number; patch: string }>().map(({ revision, patch }) =>
        ({ revision, patch: JSON.parse(patch) as SessionPatch, kind: "checkpoint", reference: null }));
  }
  async forkSession(projectId: string, sourceSessionId: string, sourceRunId: string, title: string, eventSeq?: number) {
    const session: ProjectSession = { id: uid(), title, createdAt: now(), forkRunId: sourceRunId };
    const plan = this.db.read(() => {
      const [row] = this.db.prepare(`SELECT r.*,r.rowid AS position FROM runs r
        WHERE r.id=? AND r.project_id=? AND r.session_id=? AND r.intent IN (${eventSeq === undefined ? "'agent'" : "'agent','compact'"}) AND r.background=0 AND r.agent_role<>'media'
        ${eventSeq === undefined ? " AND r.parent_run_id IS NULL AND r.status='done'" : ""}`)
        .bind(sourceRunId, projectId, sourceSessionId).rows<Row>();
      if (!row) throw new AppError("所选位置不属于可分支的对话", 409, "FORK_UNAVAILABLE");
      const source = this.restoreRun(row), inherited = source.payload.forkSource;
      let seed = source.payload.agent;
      let preset = row.turn_preset as string | null;
      let cwd = source.payload.childExecution?.cwd ?? source.payload.workingDirectory;
      let dispatched = new Set<string>();
      let exact: { id: number; created_at: string } | undefined;
      if (eventSeq !== undefined) {
        const recorded = this.stateAtForkEvent(projectId, source, eventSeq);
        exact = recorded.anchor;
        seed = recorded.seed;
        preset = recorded.preset ?? (source.payload.childExecution?.preset ? json(source.payload.childExecution.preset) : null);
        cwd = recorded.cwd ?? cwd;
        dispatched = recorded.dispatched;
      } else if (source.payload.archivedFork) {
        seed = replaySession(this.archivedForkEntries(source.id));
      } else if (inherited?.revision) {
        const entries = this.sessionEntries(inherited.runId, projectId).filter((entry) => entry.revision <= inherited.revision);
        if (entries.at(-1)?.revision === inherited.revision) seed = replaySession(entries);
      } else if (inherited) {
        const [origin] = this.db.prepare("SELECT * FROM runs WHERE id=? AND project_id=? AND status='done'")
          .bind(inherited.runId, projectId).rows<Row>();
        if (origin) seed = this.restoreRun(origin).payload.agent ?? replaySession(this.archivedForkEntries(String(origin.id)));
      }
      if (!seed)
        throw new AppError("这轮没有可继承的模型上下文", 409, "FORK_UNAVAILABLE");
      const [closed] = this.db.prepare(`SELECT id,created_at FROM events WHERE project_id=? AND type='message'
        AND json_extract(data,'$.runId')=? ORDER BY id DESC LIMIT 1`).bind(projectId, sourceRunId).rows<{ id: number; created_at: string }>();
      const [latest] = exact ? [exact] : closed ? [closed] : this.db.prepare("SELECT id,created_at FROM events WHERE project_id=? AND created_at<=? ORDER BY id DESC LIMIT 1")
        .bind(projectId, source.updatedAt).rows<{ id: number; created_at: string }>();
      if (!latest) throw new AppError("这轮的历史记录不可用", 409, "FORK_UNAVAILABLE");
      const cut = { position: Number(row.position), seq: latest.id, time: exact?.created_at ?? closed?.created_at ?? source.updatedAt,
        ...(source.parentRunId ? { childRoot: source.id } : {}),
        ...(exact ? { sourceRunId, settledCalls: seed.messages.flatMap((message) => message.tool_call_id ? [message.tool_call_id] : []) } : {}) };
      return { seed, dispatched, preset, cwd, exact: Boolean(exact), history: copyForkHistory(this.db, projectId, sourceSessionId, session, cut,
        (roots) => this.historyFileChanges(projectId, roots, cut.time)) };
    });
    const seed = plan.exact ? { ...plan.seed, messages: (await repairToolHistory(plan.seed.messages, async (id) =>
      plan.dispatched.has(id) ? toolOutcomeUnknown : toolNotStarted)).messages } : plan.seed;
    await this.db.batch([
      this.db.prepare("INSERT INTO project_sessions(id,project_id,title,created_at,fork_run_id,seed,working_directory) VALUES(?,?,?,?,?,?,?)")
        .bind(session.id, projectId, session.title, session.createdAt, sourceRunId, json(seed), plan.cwd ?? this.sessionCwd(projectId, sourceSessionId) ?? null),
      (plan.preset === null ? this.presets.inheritStatement(projectId, sourceSessionId, session.id) :
        this.db.prepare("INSERT INTO session_preset_bindings(project_id,session_id,data) SELECT ?,?,? WHERE ?<>'null'")
          .bind(projectId, session.id, plan.preset, plan.preset)),
      ...plan.history,
      this.event(projectId, "feed:sessions", { id: session.id }),
    ]);
    return session;
  }
  sessionSeed(projectId: string, sessionId: string) {
    const [row] = this.db.prepare("SELECT seed FROM project_sessions WHERE project_id=? AND id=?").bind(projectId, sessionId).rows<{ seed: string | null }>();
    return row?.seed ? JSON.parse(row.seed) as AgentState : undefined;
  }
  activeRoot(projectId: string, sessionId: string, except: string) {
    return this.db.prepare("SELECT id FROM runs WHERE project_id=? AND session_id=? AND id<>? AND parent_run_id IS NULL AND status IN ('queued','running','waiting')")
      .bind(projectId, sessionId, except).rows().length > 0;
  }
  async renameProjectFromTool(run: Run, callId: string, title: string) {
    const time = now();
    await this.db.batch([
      this.db.prepare(`UPDATE projects SET title=?,updated_at=? WHERE id=?
        AND EXISTS(SELECT 1 FROM runs WHERE id=? AND project_id=projects.id AND lease_token=? AND input_version=? AND status='running')
        AND NOT EXISTS(SELECT 1 FROM tool_receipts WHERE run_id=? AND call_id=?)`)
        .bind(title, time, run.projectId, run.id, run.leaseToken, run.inputVersion, run.id, callId),
      this.db.prepare("INSERT INTO tool_receipts(run_id,call_id,result,created_at) SELECT ?,?,?,? WHERE changes()=1")
        .bind(run.id, callId, json({ title }), time),
    ]);
    const result = await this.toolResult(run.id, callId);
    if (!result) {
      const current = await this.run(run.id, run.projectId);
      throw new AppError("任务已停止或收到新输入", 409, current.inputVersion !== run.inputVersion ? "AGENT_STEER" : "RUN_STOPPED");
    }
    return result;
  }
  async artifacts(projectId: string): Promise<Artifact[]> { return this.readArtifacts(projectId); }
  private readArtifacts(projectId: string) {
    return this.db.prepare("SELECT * FROM artifacts WHERE project_id=? AND " + activeArtifactPath + " ORDER BY path").bind(projectId).rows().map(artifactRow);
  }
  runtimeFiles(projectId: string) {
    return this.db.prepare(`SELECT id,path,kind,version,status,url,CASE WHEN path=? THEN length(content) ELSE 0 END AS characters
      FROM artifacts WHERE project_id=? AND ${activeArtifactPath} ORDER BY path`).bind(PROJECT_MEMORY, projectId).rows<RuntimeFile>();
  }
  async artifact(id: string, projectId: string): Promise<Artifact> {
    const r = await this.db.prepare("SELECT * FROM artifacts WHERE id=? AND project_id=?").bind(id, projectId).first<Row>();
    if (!r) throw new AppError("文件不存在", 404);
    return artifactRow(r);
  }
  async artifactVersion(projectId: string, id: string, version: number): Promise<Artifact> {
    const current = await this.artifact(id, projectId);
    const row = await this.db.prepare("SELECT * FROM artifact_versions WHERE artifact_id=? AND version=?").bind(id, version).first<Row>();
    if (!row) throw new AppError("文件版本不存在", 404);
    const metadata = JSON.parse(String(row.metadata));
    const media = ["image", "video", "audio", "final"].includes(String(row.kind ?? current.kind));
    const local = typeof metadata.objectKey === "string", readable = !media || local || typeof metadata.providerUrl === "string";
    return { ...current, path: String(row.path ?? current.path), kind: (row.kind ?? current.kind) as ArtifactKind,
      version, content: String(row.content), url: media && local ? "/api/studio/projects/" + projectId + "/media/" + id + "?version=" + version : null,
      metadata, status: readable ? "ready" : "failed", locked: true, updatedAt: String(row.created_at) };
  }
  async presentFiles(run: Run, callId: string, files: { path?: string; fileId?: string; label?: string; version?: number }[]) {
    const cached = await this.toolResult(run.id, callId);
    if (cached) return cached;
    const current = await this.artifacts(run.projectId);
    const pinned = await Promise.all(files.map(async ({ path, fileId, version, label }) => {
      const file = current.find((item) => (fileId ? item.id === fileId : item.path === path) && (version !== undefined || item.status === "ready"));
      if (!file) throw new AppError("找不到可交付文件：" + (path ?? fileId), 404, "DELIVERY_FILE_NOT_FOUND");
      const chosen = version === undefined ? file : await this.artifactVersion(run.projectId, file.id, version);
      if (chosen.status !== "ready" || ["image", "video", "audio", "final"].includes(chosen.kind) && typeof chosen.metadata.objectKey !== "string")
        throw new AppError("素材版本尚未生成：" + path, 409);
      return { id: chosen.id, path: chosen.path, kind: chosen.kind, version: chosen.version, ...(label ? { label } : {}) };
    }));
    const delivery = { id: uid(), runId: run.id, files: pinned };
    await this.db.batch([
      this.db.prepare("INSERT INTO deliveries(id,run_id,files) SELECT ?,?,? WHERE " + toolCallerGuard)
        .bind(delivery.id, run.id, json(pinned), ...toolCallerBindings(run.projectId, { run, callId })),
      this.db.prepare("INSERT INTO tool_receipts(run_id,call_id,result,created_at) SELECT ?,?,?,? WHERE changes()=1")
        .bind(run.id, callId, json(delivery), now()),
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'feed:delivery',?,? WHERE changes()=1")
        .bind(run.projectId, json({ id: delivery.id }), now()),
    ]);
    const result = await this.toolResult(run.id, callId);
    if (!result) throw new AppError("任务已停止或收到新输入", 409, "RUN_STOPPED");
    return result;
  }
  private deliveries(projectId: string, sessionId: string, ids: string[], byRun: boolean): Delivery[] {
    if (!ids.length) return [];
    return this.db.prepare("SELECT d.* FROM deliveries d JOIN runs r ON r.id=d.run_id WHERE r.project_id=? AND r.session_id=? AND " +
      (byRun ? "d.run_id" : "d.id") + " IN (" + jsonIds + ") ORDER BY d.rowid")
      .bind(projectId, sessionId, json(ids)).rows().map((row) => ({ id: String(row.id), runId: String(row.run_id), files: JSON.parse(String(row.files)) }));
  }
  async toolResult(runId: string, callId: string): Promise<Record<string, unknown> | null> {
    return (await this.toolReceipt(runId, callId))?.result ?? null;
  }
  async toolReceipt(runId: string, callId: string) {
    const row = await this.db.prepare("SELECT result,concludes_turn,additional_contexts FROM tool_receipts WHERE run_id=? AND call_id=?")
      .bind(runId, callId).first<{ result: string; concludes_turn: number | null; additional_contexts: string | null }>();
    return row ? { result: JSON.parse(row.result) as Record<string, unknown>, concludesTurn: row.concludes_turn === 1,
      additionalContexts: row.additional_contexts ? JSON.parse(row.additional_contexts) as AgentMessage[] : undefined } : null;
  }
  async toolHistoryResult(runId: string, callId: string) {
    return (await this.settledToolOutput(runId, callId))?.result ?? this.toolResult(runId, callId);
  }
  async settledToolOutput(runId: string, callId: string) {
    const step = await this.db.prepare(`SELECT s.result,s.output_ref,s.output_images,t.concludes_turn,t.additional_contexts FROM execution_steps s
      LEFT JOIN tool_receipts t ON t.run_id=s.run_id AND t.call_id=s.call_id WHERE s.run_id=? AND s.call_id=? AND s.finished_at IS NOT NULL`)
      .bind(runId, callId).first<{ result: string | null; output_ref: string | null; output_images: string | null; concludes_turn: number | null; additional_contexts: string | null }>();
    if (step?.result == null) return null;
    return { result: JSON.parse(step.result) as Record<string, unknown>, outputRef: step.output_ref ?? undefined,
      images: step.output_images ? JSON.parse(step.output_images) as AgentImage[] : undefined, concludesTurn: step.concludes_turn === 1,
      additionalContexts: step.additional_contexts ? JSON.parse(step.additional_contexts) as AgentMessage[] : undefined };
  }
  toolStepDispatched(runId: string, callId: string) {
    return this.db.prepare("SELECT 1 FROM execution_steps WHERE run_id=? AND call_id=? AND dispatched_at IS NOT NULL")
      .bind(runId, callId).rows().length > 0;
  }
  childReportedToParent(task: Run, recipient: Run) {
    const callId = task.payload.agent?.parentMessageCallId;
    if (!callId) return false;
    // A later dispatch ends the omission window even if its result was interrupted.
    const [last] = this.db.prepare(`SELECT s.call_id,json_extract(t.result,'$.agent_id') AS recipient
      FROM execution_steps s LEFT JOIN tool_receipts t ON t.run_id=s.run_id AND t.call_id=s.call_id
      WHERE s.run_id=? AND s.dispatched_at IS NOT NULL ORDER BY s.seq DESC LIMIT 1`).bind(task.id).rows<{call_id: string; recipient: string}>();
    return last?.call_id === callId && last.recipient === agentIdentity(recipient);
  }
  usedToolIds(runId: string, calls: readonly AgentToolCall[]) {
    const ids = json(calls.map(({ id }) => id));
    return this.db.prepare(`SELECT call_id FROM execution_steps WHERE run_id=? AND call_id IN (${jsonIds})
      UNION SELECT call_id FROM tool_receipts WHERE run_id=? AND call_id IN (${jsonIds})`)
      .bind(runId, ids, runId, ids).rows<{ call_id: string }>().map(({ call_id }) => call_id);
  }
  async recordToolRead(run: Run, callId: string, result: Record<string, unknown>, settlePending = false) {
    await this.db.prepare("INSERT INTO tool_receipts(run_id,call_id,result,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND project_id=?) ON CONFLICT(run_id,call_id) DO UPDATE SET result=excluded.result WHERE ?=1 AND json_extract(tool_receipts.result,'$.status')='pending'")
      .bind(run.id, callId, json(result), now(), run.id, run.projectId, settlePending ? 1 : 0).run();
  }
  async beginToolRead(run: Run, callId: string, result: Record<string, unknown>) {
    const inserted = await this.db.prepare(`INSERT INTO tool_receipts(run_id,call_id,result,created_at) SELECT ?,?,?,? WHERE ${toolCallerGuard}`)
      .bind(run.id, callId, json(result), now(), ...toolCallerBindings(run.projectId, { run, callId })).run();
    if (inserted.meta.changes) return;
    const current = await this.run(run.id, run.projectId);
    if (current.inputVersion !== run.inputVersion) throw new AppError("收到新的输入", 409, "AGENT_STEER");
    throw new AppError("工具调用已登记或任务已停止", 409, "RUN_STOPPED");
  }
  async commitReadReceipt(run: Run, callId: string, result: Record<string, unknown>, continuation?: ToolContinuation) {
    await this.db.prepare(`INSERT INTO tool_receipts(run_id,call_id,result,created_at,concludes_turn,additional_contexts) SELECT ?,?,?,?,?,? WHERE
      EXISTS(SELECT 1 FROM runs WHERE id=? AND project_id=? AND lease_token=? AND generation=?
        AND (status='running' OR (status IN ('paused','cancelled') AND EXISTS(
          SELECT 1 FROM execution_steps s WHERE s.run_id=runs.id AND s.call_id=? AND s.status='running'))))
      ON CONFLICT(run_id,call_id) DO UPDATE SET concludes_turn=MAX(tool_receipts.concludes_turn,excluded.concludes_turn),
        additional_contexts=COALESCE(tool_receipts.additional_contexts,excluded.additional_contexts)
      WHERE tool_receipts.result=excluded.result AND (excluded.concludes_turn=1 OR excluded.additional_contexts IS NOT NULL)`)
      .bind(run.id, callId, json(result), now(), Number(Boolean(continuation?.concludesTurn)), continuation?.additionalContexts?.length ? json(continuation.additionalContexts) : null,
        run.id, run.projectId, run.leaseToken, run.generation, callId).run();
    const receipt = await this.toolResult(run.id, callId);
    if (!receipt) throw new AppError("任务已停止", 409, "RUN_STOPPED");
    return receipt;
  }
  async commitStructuredResult(run: Run, callId: string, result: Record<string, unknown>) {
    const seen = run.payload.agent?.seenUserIds ?? [];
    const unread = "SELECT 1 FROM agent_inbox WHERE project_id=? AND run_id=? AND state='ready' AND kind IN ('user','agent') AND id NOT IN (" + jsonIds + ")";
    const insert = await this.db.prepare(`INSERT INTO tool_receipts(run_id,call_id,result,created_at,concludes_turn)
      SELECT ?,?,?,?,1 WHERE ${toolCallerGuard} AND NOT EXISTS(${unread}) AND NOT EXISTS(${sealedStructuredResult("?")})`)
      .bind(run.id, callId, json(result), now(), ...toolCallerBindings(run.projectId, { run, callId }), run.projectId, run.id, json(seen), run.id).run();
    if (insert.meta.changes) return;
    const current = await this.run(run.id, run.projectId);
    if (current.inputVersion !== run.inputVersion) throw new AppError("收到新的输入，请先处理后再提交结果", 409, "AGENT_STEER");
    if (current.leaseToken !== run.leaseToken || current.status !== "running") throw new AppError("任务已停止", 409, "RUN_STOPPED");
    if (this.db.prepare(sealedStructuredResult("?")).bind(run.id).rows().length)
      throw new AppError("本任务的结构化结果已提交", 409, "INPUT_CLOSED");
    throw new AppError("请先处理已收到的协作消息", 409, "STRUCTURED_INPUT_PENDING");
  }
  async beginStep(run: Run, call: AgentToolCall, requestId?: string, callIndex?: number) {
    let input: Record<string, unknown> = {};
    try {
      const args = JSON.parse(call.function.arguments);
      if (args && typeof args === "object" && !Array.isArray(args)) input = args;
    } catch {}
    const queries = Array.isArray(input.queries) && input.queries.every((query) => typeof query === "string") ? input.queries.join(" · ") : undefined;
    const summary = [input.file_path, call.function.name === "skill" ? input.resource : undefined, input.directory, input.query, queries, input.url, input.title, input.role, input.name].find((value) => typeof value === "string") as string | undefined;
    await this.db.batch([
      this.db.prepare("INSERT OR IGNORE INTO execution_steps(project_id,run_id,call_id,name,status,arguments,summary,started_at,request_id,call_index,provider_call_id) SELECT ?,?,?,?,'running',?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND lease_token=? AND input_version=? AND status='running')")
        .bind(run.projectId, run.id, call.id, call.function.name, call.function.arguments, Array.from(summary || "").slice(0, 300).join(""), now(),
          requestId ?? null, callIndex ?? null, call.providerId ?? call.id, run.id, run.leaseToken, run.inputVersion),
      this.toolStepEvent(run, call.id),
    ]);
  }
  async dispatchStep(run: Run, callId: string) {
    const stamp = now();
    const [result] = await this.db.batch([this.db.prepare(`UPDATE execution_steps SET dispatched_at=COALESCE(dispatched_at,?)
      WHERE run_id=? AND call_id=? AND status='running' AND EXISTS(SELECT 1 FROM runs WHERE id=? AND lease_token=?
        AND generation=? AND input_version=? AND status='running')`)
      .bind(stamp, run.id, callId, run.id, run.leaseToken, run.generation, run.inputVersion),
    this.db.prepare(`INSERT INTO events(project_id,type,data,created_at)
      SELECT project_id,'tool/dispatched',json_object('runId',run_id,'callId',call_id,'stepSeq',seq,'requestId',request_id,
        'callIndex',call_index,'status','running','dispatchedAt',dispatched_at),?
      FROM execution_steps s WHERE run_id=? AND call_id=? AND changes()=1 AND NOT EXISTS(
        SELECT 1 FROM events e WHERE e.project_id=s.project_id AND e.type='tool/dispatched'
        AND json_extract(e.data,'$.runId')=s.run_id AND json_extract(e.data,'$.callId')=s.call_id)`)
      .bind(stamp, run.id, callId)]);
    if (result.meta.changes) return;
    const current = await this.run(run.id, run.projectId);
    throw new AppError("工具已停止或收到新输入", 409, current.inputVersion !== run.inputVersion ? "AGENT_STEER" : "RUN_STOPPED");
  }
  private toolStepEvent(run: Run, callId: string) {
    return this.db.prepare(`INSERT INTO events(project_id,type,data,created_at)
      SELECT ?,'step',json_object('runId',run_id,'callId',call_id,'stepSeq',seq,'requestId',request_id,'callIndex',call_index,
        'status',status,'dispatchedAt',dispatched_at),?
      FROM execution_steps WHERE run_id=? AND call_id=? AND changes()=1`).bind(run.projectId, now(), run.id, callId);
  }
  private skippedToolSteps(run: Run, calls: readonly SkippedToolCall[], stopped: boolean, revision?: number) {
    const time = now();
    return calls.flatMap(({ call, index, requestId }) => [
      this.db.prepare(`INSERT OR IGNORE INTO execution_steps(project_id,run_id,call_id,name,status,arguments,result,started_at,finished_at,
        request_id,call_index,provider_call_id) SELECT ?,?,?,?,'interrupted',?,?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND lease_token=? AND generation=? AND
          ${stopped ? "status IN ('cancelled','failed')" : "input_version=? AND agent_revision=? AND status IN ('running','queued','waiting')"})`)
        .bind(run.projectId, run.id, call.id, call.function.name, call.function.arguments, json(toolNotStarted), time, time, requestId ?? null,
          index, call.providerId ?? call.id, run.id, run.leaseToken, run.generation, ...(stopped ? [] : [run.inputVersion, revision])),
      this.toolStepEvent(run, call.id),
    ]);
  }
  private stepSettlements(run: Run, messages: AgentMessage[], records?: ReadonlyMap<string, ToolOutputRecord>) {
    const pending = this.db.prepare(`SELECT s.seq,s.call_id FROM execution_steps s LEFT JOIN model_calls c ON c.id=s.request_id
      WHERE s.run_id=? AND s.status='running' ORDER BY COALESCE(c.rowid,0),COALESCE(s.call_index,s.seq),s.seq`)
      .bind(run.id).rows<{ seq: number; call_id: string }>();
    const statements = [];
    for (const { call_id: id } of pending) {
      const message = messages.findLast((item) => item.role === "tool" && item.tool_call_id === id);
      if (!message) continue;
      const record = records?.get(id), content = record?.content ?? message.content;
      let result: Record<string, unknown> = {};
      try { result = JSON.parse(content || "{}"); } catch {}
      const status = result.code === "TOOL_NOT_STARTED" || result.status === "interrupted" ? "interrupted" :
        result.code === "TOOL_RESULT_UNKNOWN" || result.status === "unknown" ? "unknown" : result.error ? "failed" : "done";
      statements.push(this.db.prepare(`UPDATE execution_steps SET status=?,result=?,finished_at=?,output_ref=?,output_images=?
        WHERE run_id=? AND call_id=? AND status='running' AND EXISTS(
          SELECT 1 FROM runs WHERE id=? AND lease_token=? AND input_version=? AND status IN ('queued','running','waiting')
        )`).bind(status, content, now(), record?.reference ?? null, record?.images?.length ? json(record.images) : null,
          run.id, id, run.id, run.leaseToken, run.inputVersion));
      statements.push(this.toolStepEvent(run, id));
    }
    return statements;
  }
  async settleSteps(run: Run, messages: AgentMessage[], records?: ReadonlyMap<string, ToolOutputRecord>) {
    const statements = this.stepSettlements(run, messages, records);
    if (statements.length) await this.db.batch(statements);
  }
  async settleStoppedExecution(run: Run) {
    const openCalls = this.db.prepare(`SELECT c.id FROM model_calls c JOIN runs r ON r.id=c.run_id
      WHERE r.id=? AND r.lease_token=? AND r.generation=? AND r.status IN ('cancelled','failed') AND c.status='started'
      ORDER BY c.rowid`).bind(run.id, run.leaseToken, run.generation).rows<{ id: string }>();
    for (const { id } of openCalls) await this.settleModelCall(run, id, {
      status: "interrupted", error: "模型请求结束前任务已停止", errorCode: "RUN_STOPPED",
    });
    const pending = this.db.prepare(`SELECT s.seq,s.call_id,s.dispatched_at,t.result FROM execution_steps s
      LEFT JOIN tool_receipts t ON t.run_id=s.run_id AND t.call_id=s.call_id
      WHERE s.run_id=? AND s.status='running' AND EXISTS(SELECT 1 FROM runs r WHERE r.id=s.run_id
        AND r.lease_token=? AND r.generation=? AND r.status IN ('cancelled','failed')) ORDER BY s.seq`)
      .bind(run.id, run.leaseToken, run.generation)
      .rows<{ seq: number; call_id: string; dispatched_at: string | null; result: string | null }>();
    const statements = pending.flatMap((step) => {
      const parsed = step.result ? JSON.parse(step.result) as Record<string, unknown> : undefined;
      const result: Record<string, unknown> = parsed?.status === "pending" ? toolOutcomeUnknown :
        parsed ?? (step.dispatched_at ? toolOutcomeUnknown : toolNotStarted);
      const status = result.status === "unknown" ? "unknown" : result.status === "interrupted" ? "interrupted" : result.error ? "failed" : "done";
      return [
        this.db.prepare(`UPDATE execution_steps SET status=?,result=?,finished_at=? WHERE seq=? AND status='running'
          AND EXISTS(SELECT 1 FROM runs WHERE id=? AND lease_token=? AND generation=? AND status IN ('cancelled','failed'))`)
          .bind(status, json(result), now(), step.seq, run.id, run.leaseToken, run.generation),
        this.toolStepEvent(run, step.call_id),
      ];
    });
    const missing = this.db.prepare(`SELECT p.call,p.request_id,p.call_index FROM pending_agent_tools p JOIN runs r ON r.id=p.run_id
      WHERE r.id=? AND r.lease_token=? AND r.generation=? AND r.status IN ('cancelled','failed') AND
        NOT EXISTS(SELECT 1 FROM events e WHERE e.project_id=r.project_id AND e.type='turn/end'
          AND json_extract(e.data,'$.runId')=r.id AND json_extract(e.data,'$.turn')=r.generation)
      ORDER BY p.call_index`).bind(run.id, run.leaseToken, run.generation)
      .rows<{ call: string; request_id: string; call_index: number }>()
      .map(({ call, request_id, call_index }) => ({ call: JSON.parse(call) as AgentToolCall, requestId: request_id, index: call_index }));
    const complete = [...statements, ...this.skippedToolSteps(run, missing, true)];
    if (complete.length) await this.db.batch(complete);
  }
  async recoverStoppedExecutions(projectId?: string) {
    const rows = this.db.prepare(`SELECT runs.* FROM runs WHERE status IN ('failed','cancelled') AND lease_until<=?
      AND ${unfinishedAgentExecution} ${projectId ? "AND project_id=?" : ""}`).bind(Date.now(), ...(projectId ? [projectId] : [])).rows<Row>();
    for (const row of rows) {
      const run = runRow(row);
      await this.releaseLease(run);
    }
  }
  async resumeInterruptedAgentRuns() {
    const rows = this.db.prepare(`SELECT * FROM runs WHERE status='failed' AND error_code='SESSION_INTERRUPTED'
      AND NOT ${unfinishedAgentExecution} AND EXISTS(SELECT 1 FROM projects WHERE id=runs.project_id AND status<>'archived')
      AND (parent_run_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM runs active WHERE active.project_id=runs.project_id
        AND active.session_id=runs.session_id AND active.parent_run_id IS NULL AND active.status IN ('queued','running','waiting')))`).rows<Row>();
    for (const row of rows) {
      const run = this.restoreRun(row);
      await this.resumeTree(run, run.payload);
    }
  }
  async commitToolPruning(run: Run, state: AgentState, replacements: ToolResultPruning[]) {
    const journal = this.checkpoint(run, { ...run.payload, agent: state }, "context/pruned");
    const time = now();
    const [updated] = await this.db.batch([
      this.db.prepare("UPDATE runs SET payload=?,agent_revision=?,updated_at=? WHERE id=? AND project_id=? AND lease_token=? AND status='running' AND input_version=? AND agent_revision=?")
        .bind(json(journal.payload), journal.revision, time, run.id, run.projectId, run.leaseToken, run.inputVersion, journal.before),
      ...journal.statements,
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'compaction/prune',?,? WHERE changes()=1")
        .bind(run.projectId, json({ runId: run.id, replacements }), time),
    ]);
    if (!updated.meta.changes) {
      const current = await this.run(run.id, run.projectId);
      throw new AppError("任务已停止或收到新输入", 409, current.inputVersion !== run.inputVersion ? "AGENT_STEER" : "RUN_STOPPED");
    }
    return this.run(run.id, run.projectId);
  }
  async conversation(projectId: string) { return this.readConversation(projectId); }
  private readConversation(projectId: string, runIds?: string[], messageIds?: string[]) {
    const calls = this.db.prepare(`SELECT ${callColumns} FROM model_calls c JOIN runs r ON r.id=c.run_id
      WHERE r.project_id=? AND json_extract(c.request,'$.purpose') IN ('creation','compaction')
      ${runIds ? "AND c.run_id IN (" + jsonIds + ")" : ""} ORDER BY c.rowid`).bind(projectId, ...(runIds ? [json(runIds)] : [])).rows();
    const events = runIds ? this.db.prepare(`SELECT id,type,data FROM events WHERE project_id=? AND
       ((type IN ('request','step') AND json_extract(data,'$.runId') IN (${jsonIds})) OR
        (type='message' AND json_extract(data,'$.id') IN (${jsonIds}))) ORDER BY id`)
      .bind(projectId, json(runIds), json(messageIds ?? [])).rows()
      : this.db.prepare("SELECT id,type,data FROM events WHERE project_id=? AND type IN ('request','step','message') ORDER BY id").bind(projectId).rows();
    return projectConversation(calls, events);
  }
  async executionHistory(projectId: string, runId?: string, before = Number.MAX_SAFE_INTEGER, limit = 50) {
    return this.readExecutionHistory(projectId, runId, before, limit);
  }
  async executionDetail(projectId: string, runId: string, seq: number): Promise<ExecutionDetail> {
    const limit = 8000;
    const row = await this.db.prepare(`SELECT substr(s.arguments,1,?) AS input,
        substr(COALESCE(s.result,t.result),1,?) AS output,
        length(s.arguments)>? AS input_truncated,
        length(COALESCE(s.result,t.result))>? AS output_truncated,
        s.name, CASE WHEN s.name IN ('web_search','web_fetch') AND s.status='done' THEN COALESCE(s.result,t.result) END AS web_result
      FROM execution_steps s LEFT JOIN tool_receipts t ON t.run_id=s.run_id AND t.call_id=s.call_id
      WHERE s.project_id=? AND s.run_id=? AND s.seq=?`)
      .bind(limit, limit, limit, limit, projectId, runId, seq)
      .first<{ input: string; output: string | null; input_truncated: number; output_truncated: number | null; name: string; web_result: string | null }>();
    if (!row) throw new AppError("执行记录不存在", 404);
    const web = row.web_result ? webReceiptSources(row.name, row.web_result) : undefined;
    return { input: row.input, output: row.output, inputTruncated: Boolean(row.input_truncated), outputTruncated: Boolean(row.output_truncated),
      ...(web ? { web } : {}) };
  }
  executionPart(projectId: string, runId: string, seq: number, field: "input" | "output", offset: number, limit = 8000): ExecutionPart {
    const source = field === "input" ? "s.arguments" : "COALESCE(s.result,t.result)";
    const [row] = this.db.prepare(`SELECT substr(${source},?,?) AS text,length(${source}) AS characters
      FROM execution_steps s LEFT JOIN tool_receipts t ON t.run_id=s.run_id AND t.call_id=s.call_id
      WHERE s.project_id=? AND s.run_id=? AND s.seq=?`).bind(offset + 1, limit, projectId, runId, seq).rows<{ text: string | null; characters: number | null }>();
    if (!row) throw new AppError("执行记录不存在", 404);
    return { text: row.text, ...(offset + limit < (row.characters ?? 0) ? { nextOffset: offset + limit } : {}) };
  }
  async readAgentToolResult(run: Run, target: { reference?: string; runId: string; seq?: number }, offset: number, imageIndex?: number) {
    const [row] = this.db.prepare(`SELECT s.seq,s.run_id,s.output_ref,s.output_images,
      r.parent_run_id IS NULL AND r.agent_role='main' AND ${currentAgent("r")} AS session_lead FROM execution_steps s JOIN runs r ON r.id=s.run_id
      WHERE s.project_id=? AND r.session_id=? AND s.finished_at IS NOT NULL
        AND (s.name<>'job_output' OR EXISTS(SELECT 1 FROM runs viewer WHERE viewer.id=?
          AND ${currentAgent("r")} AND (viewer.id=r.id OR (viewer.parent_run_id IS NULL AND r.parent_run_id IS NULL))))
        AND
        ${target.reference ? "s.output_ref=?" : "s.run_id=? AND s.seq=?"} ORDER BY s.seq LIMIT 1`)
      .bind(run.projectId, run.sessionId ?? "", run.id, ...(target.reference ? [target.reference] : [target.runId, target.seq]))
      .rows<{ seq: number; run_id: string; output_ref: string | null; output_images: string | null; session_lead: number }>();
    const seeded = target.reference && run.payload.agent?.messages.some((message) => message.outputRef === target.reference);
    if (!row || (run.parentRunId && row.run_id !== run.id && !row.session_lead && !seeded && !(await this.collaborators(run)).some((item) => item.id === row.run_id)))
      throw new AppError("工具回执不存在或超出当前会话范围", 404, "TOOL_RESULT_UNAVAILABLE");
    const page = this.executionPart(run.projectId, row.run_id, row.seq, "output", offset, 2400);
    const images = row.output_images ? JSON.parse(row.output_images) as AgentImage[] : [];
    const image = imageIndex === undefined ? undefined : images[imageIndex];
    return { result: { ...page, seq: row.seq, task_id: row.run_id, ...(row.output_ref ? { result_ref: row.output_ref } : {}),
      ...(images.length ? { image_count: images.length } : {}),
      ...(image ? { image: { index: imageIndex, path: image.path, version: image.version } } : {}) },
    ...(image ? { images: [image] } : {}) };
  }
  listAgentToolResults(run: Run, before: number, scope: "turn" | "conversation") {
    const scoped = scope === "conversation" && !run.parentRunId;
    const tree = `WITH RECURSIVE tree(id) AS (SELECT id FROM runs WHERE id=? AND project_id=?
      UNION ALL SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id=t.id)`;
    return this.db.prepare(`${scoped ? "" : tree} SELECT s.seq,s.run_id AS task_id,s.name,s.status,s.summary,s.output_ref AS result_ref
      FROM execution_steps s JOIN runs r ON r.id=s.run_id WHERE s.project_id=? AND r.session_id=? AND s.seq<?
      AND (s.name<>'job_output' OR (r.id=? OR (? AND r.parent_run_id IS NULL)))
      ${scoped ? "" : "AND s.run_id IN (SELECT id FROM tree)"} ORDER BY s.seq DESC LIMIT 20`)
      .bind(...(scoped ? [] : [run.id, run.projectId]), run.projectId, run.sessionId ?? "", before, run.id, run.parentRunId ? 0 : 1)
      .rows<{ seq: number; task_id: string; name: string; status: string; summary: string; result_ref: string | null }>();
  }
  private readExecutionHistory(projectId: string, runId: string | undefined, before: number, limit: number, anchors?: ReturnType<typeof projectConversation>) {
    const tree = runId ? "WITH RECURSIVE tree(id) AS (SELECT id FROM runs WHERE id=? AND project_id=? UNION ALL SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id=t.id) " : "";
    const rows = this.db.prepare(tree + "SELECT " + stepColumns + " FROM execution_steps WHERE project_id=? AND seq<?" + (runId ? " AND run_id IN (SELECT id FROM tree)" : "") + " ORDER BY seq DESC LIMIT ?")
      .bind(...(runId ? [runId, projectId] : []), projectId, before, Math.min(200, limit)).rows();
    const { tools, toolSettlements } = anchors ?? this.readConversation(projectId, [...new Set(rows.map((row) => String(row.run_id)))]);
    return rows.reverse().map((row) => {
      const key = toolKey(String(row.run_id), String(row.call_id));
      return stepRow(row, ["wait_for_tasks", "job_output"].includes(String(row.name)) && row.finished_at ? toolSettlements.get(key) ?? tools.get(key) : tools.get(key));
    });
  }
  async inputs(run: Run): Promise<AgentInput[]> {
    const rows = this.db.prepare(`SELECT i.id,i.content,i.attachments,i.source,
      (SELECT q.scheduled_frame FROM chat_queue q WHERE q.project_id=i.project_id AND q.session_id=i.session_id
        AND q.request_id=COALESCE((SELECT request_id FROM messages WHERE id=i.id),
          CASE WHEN i.id LIKE 'queue:%' THEN substr(i.id,7) END)) AS scheduled_frame,
      EXISTS(SELECT 1 FROM studio_schedule_deliveries d JOIN messages m ON m.request_id=d.request_id
        JOIN studio_schedules s ON s.id=d.schedule_id AND s.project_id=m.project_id WHERE m.id=i.id) AS scheduled
      FROM agent_inbox i WHERE i.project_id=? AND i.session_id=?
      AND i.state='ready' AND (i.kind IN ('user','agent') OR (i.kind='schedule-change' AND ?=1))
      AND (i.run_id=? OR (i.run_id IS NULL AND ?=1)) ORDER BY i.seq`)
      .bind(run.projectId, run.sessionId ?? "", Number(run.intent === "agent"), run.id, run.parentRunId ? 0 : 1)
      .rows<{ id: string; content: string; attachments: string | null; source: string | null; scheduled: number; scheduled_frame: string | null }>();
    return rows.map(({ id, content, attachments, source, scheduled, scheduled_frame }) => {
      const files = attachments ? JSON.parse(attachments) as MessageAttachment[] : [];
      return { id, content, ...(files.length ? { attachments: files } : {}), ...(source ? { source: JSON.parse(source) as AgentInputSource } : {}),
        ...(scheduled || scheduled_frame ? { scheduled: true, ...(scheduled_frame ? { scheduledFrame: scheduled_frame } : {}) } : {}) };
    });
  }
  taskInbox(run: Run, tasks: readonly Run[]) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return this.db.prepare(`SELECT content FROM agent_inbox WHERE project_id=? AND session_id=? AND kind='task-result'
      AND state='ready' AND (run_id=? OR (?=1 AND json_extract(source,'$.background')=1))
      GROUP BY content ORDER BY MAX(seq)`)
      .bind(run.projectId, run.sessionId ?? "", run.id, run.parentRunId ? 0 : 1).rows<{ content: string }>()
      .flatMap(({ content }) => byId.get(content) ?? []);
  }
  async children(run: Run) {
    return (await this.db.prepare("SELECT * FROM runs WHERE project_id=? AND parent_run_id=? ORDER BY created_at,id").bind(run.projectId, run.id).all<Row>()).results.map((row) => this.restoreRun(row));
  }
  async agentTasks(run: Run) {
    const rows = await this.db.prepare(`SELECT task.* FROM runs task JOIN runs owner ON owner.id=?
      WHERE task.project_id=owner.project_id AND task.session_id=owner.session_id AND ${currentAgent("task")}
      AND ((task.background=1 AND ${madeByAgent("task", "owner.id")})
        OR (task.background=0 AND (task.parent_run_id=owner.id OR (owner.parent_run_id IS NULL AND ${creativeChild("task")})
          OR ${routedChildResult("task", "owner")})))
      ORDER BY task.created_at,task.id`).bind(run.id).all<Row>();
    return rows.results.map((row) => this.restoreRun(row));
  }
  async ownedBackgroundJob(run: Run, jobId: string) {
    const row = await this.db.prepare(`SELECT j.*, ${madeByAgent("j", "?")} AS owned FROM runs j
      WHERE j.id=? AND j.project_id=? AND j.session_id=? AND j.background=1 AND ${currentAgent("j")}`)
      .bind(run.id, jobId, run.projectId, run.sessionId ?? "").first<Row>();
    if (!row) throw new AppError("后台任务不存在", 404, "JOB_NOT_FOUND");
    if (!row.owned) throw new AppError("后台任务属于其他智能体", 403, "JOB_FOREIGN_SESSION");
    return this.restoreRun(row);
  }
  async assertTaskControl(run: Run, target: Run) {
    if (target.background) { await this.ownedBackgroundJob(run, target.id); return; }
    const descendants = this.db.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT r.id FROM runs r WHERE r.project_id=? AND r.session_id=? AND ${creativeChild("r")} AND ${madeByAgent("r", "?")}
      UNION ALL SELECT r.id FROM runs r JOIN descendants p ON p.id=r.parent_run_id
        WHERE r.project_id=? AND r.session_id=? AND ${creativeChild("r")}
    ) SELECT 1 FROM descendants WHERE id=?`).bind(run.projectId, run.sessionId ?? "", run.id, run.projectId, run.sessionId ?? "", target.id).rows();
    if (!descendants.length) throw new AppError("只能控制自己委派的子智能体或后代", 403, "TASK_NOT_REACHABLE");
  }
  async previousAgent(run: Pick<Run, "projectId" | "id" | "agentRole" | "sessionId">, completedOnly = false) {
    const row = await this.db.prepare(`SELECT * FROM runs
      WHERE project_id=? AND session_id=? AND rowid<(SELECT rowid FROM runs WHERE id=?) AND parent_run_id IS NULL
        AND intent IN ('agent','compact') AND agent_role=? AND ${completedOnly ? "status='done'" : "status IN ('done','failed','cancelled','paused')"}
        AND (agent_revision>0 OR json_type(payload,'$.agent')='object' OR json_extract(payload,'$.archivedFork')=1)
      ORDER BY rowid DESC LIMIT 1`).bind(run.projectId, run.sessionId ?? "", run.id, run.agentRole).first<Row>();
    if (!row) return;
    const previous = this.restoreRun(row);
    if (previous.payload.archivedFork && !previous.payload.agent) {
      const [checkpoint] = this.db.prepare(`SELECT MAX(event_seq) AS seq FROM archived_fork_checkpoints WHERE run_id=?`)
        .bind(previous.id).rows<{ seq: number | null }>();
      const [tail] = checkpoint.seq === null ? [] : this.db.prepare(`SELECT e.id FROM events e
        LEFT JOIN messages m ON e.type='message' AND m.id=json_extract(e.data,'$.id') AND m.project_id=e.project_id
        WHERE e.project_id=? AND e.id>? AND COALESCE(json_extract(e.data,'$.runId'),m.run_id)=?
        AND e.type IN ('message','reply','step','turn/end') ORDER BY e.id DESC LIMIT 1`)
        .bind(previous.projectId, checkpoint.seq, previous.id).rows<{ id: number }>();
      previous.payload.agent = tail ? this.stateAtForkEvent(previous.projectId, previous, tail.id).seed :
        replaySession(this.archivedForkEntries(previous.id));
    }
    return previous;
  }
  private closedAgentTurn(parent: Run) {
    const row = this.db.prepare(`SELECT r.*,e.created_at AS ended_at,json_extract(e.data,'$.turn') AS ended_generation,
      json_extract(e.data,'$.agentRevision') AS ended_revision,json_extract(e.data,'$.reason.kind') AS ended_reason
      FROM runs r JOIN events e ON e.project_id=r.project_id AND e.type='turn/end' AND json_extract(e.data,'$.runId')=r.id
      WHERE r.project_id=? AND r.session_id=? AND r.parent_run_id IS NULL AND r.agent_role=?
        AND (r.id<>? OR json_extract(e.data,'$.turn')<r.generation) AND (r.agent_revision>0 OR json_type(r.payload,'$.agent')='object')
      ORDER BY e.id DESC LIMIT 1`).bind(parent.projectId, parent.sessionId ?? "", parent.agentRole, parent.id).rows<Row>()[0];
    if (!row) return;
    if (row.ended_generation === row.generation) return this.restoreRun(row);
    const revision = row.ended_revision ?? this.db.prepare(`SELECT MAX(revision) AS revision FROM agent_session_events WHERE run_id=? AND created_at<=?`)
      .bind(row.id, row.ended_at).rows<{ revision: number | null } | null>()[0]?.revision;
    if (!revision) return;
    return this.restoreRun({ ...row, generation: row.ended_generation, agent_revision: revision,
      status: row.ended_reason === "aborted" ? "cancelled" : row.ended_reason === "completed" ? "done" : "failed" });
  }
  async treeRuns(run: Run) {
    return (await this.db.prepare("WITH RECURSIVE tree(id) AS (SELECT id FROM runs WHERE id=? AND project_id=? UNION ALL SELECT r.id FROM runs r JOIN tree ON r.parent_run_id=tree.id) SELECT * FROM runs WHERE id IN (SELECT id FROM tree)")
      .bind(run.id, run.projectId).all<Row>()).results.map(runRow);
  }
  async collaborators(run: Run) {
    const scope = [run.projectId, run.sessionId ?? ""];
    const lead = this.db.prepare(`SELECT * FROM runs r WHERE project_id=? AND session_id=? AND parent_run_id IS NULL AND agent_role='main'
      AND intent='agent' AND ${currentAgent("r")} ORDER BY (status IN ('queued','running','waiting')) DESC,rowid DESC LIMIT 1`)
      .bind(...scope).rows<Row>();
    const children = this.db.prepare(`SELECT * FROM runs r WHERE project_id=? AND session_id=? AND ${creativeChild("r")} ORDER BY rowid`)
      .bind(...scope).rows<Row>();
    return [...lead, ...children].map(runRow);
  }
  async resolveCollaborator(run: Run, target: string) {
    const members = await this.collaborators(run);
    const lead = members.find((member) => !member.parentRunId);
    if (target === leadAgentId || target === lead?.id || this.db.prepare(`SELECT 1 FROM runs r WHERE id=? AND project_id=? AND session_id=?
      AND parent_run_id IS NULL AND agent_role='main' AND intent='agent' AND ${currentAgent("r")}`)
      .bind(target, run.projectId, run.sessionId ?? "").rows().length) return lead;
    const explicit = members.find((member) => member.id === target);
    if (explicit) return explicit;
    const addresses = memberAddresses(members);
    const named = members.filter((member) => addresses.get(member.id) === target);
    if (named.length > 1) throw new AppError("旧记录中有多个同名智能体，请使用任务编号", 409, "AMBIGUOUS_AGENT_NAME");
    if (!named.length && target.includes("/")) throw new AppError("找不到该智能体路径", 404, "AGENT_NAME_NOT_FOUND");
    return named[0];
  }
  private memberNames(parent: Run) {
    return new Set(this.db.prepare(`SELECT json_extract(payload,'$.memberName') AS name FROM runs r WHERE project_id=? AND session_id=?
      AND ${creativeChild("r")} AND ${madeByAgent("r", "?")}`)
      .bind(parent.projectId, parent.sessionId ?? "", parent.id).rows<{ name: string | null }>().flatMap(({ name }) => name ? [name] : []));
  }
  private jobLimitReached(projectId: string, sessionId: string, ownerId: string, excludeId?: string) {
    const [active] = this.db.prepare(ownerJobs("?", "?")).bind(projectId, sessionId, excludeId ?? null, ownerId).rows<{ count: number }>();
    return active.count >= this.maxConcurrentJobsPerOwner;
  }
  private jobLimitError() {
    return new AppError(`当前智能体已有 ${this.maxConcurrentJobsPerOwner} 个进行中的后台任务，请等待任务结束或停止后再试`, 409, "JOB_LIMIT_REACHED");
  }
  async sendAgentMessage(sender: Run, callId: string, targetId: string, content: string) {
    const cached = await this.toolResult(sender.id, callId); if (cached) return cached;
    const target = await this.resolveCollaborator(sender, targetId);
    if (!target || agentIdentity(target) === agentIdentity(sender))
      throw new AppError("只能向当前协作会话中的其他创作智能体发送消息", 403, "AGENT_NOT_REACHABLE");
    const senderName = sender.parentRunId ? memberAddresses(await this.collaborators(sender)).get(sender.id) ?? sender.id : leadAgentId;
    const source = json({ kind: "agent-message", senderRunId: sender.id, senderRole: sender.agentRole, senderName } satisfies AgentInputSource);
    if (!target.parentRunId) return this.sendToLead(sender, callId, content, source);
    if (target.payload.childExecution?.outputSchema && this.db.prepare(sealedStructuredResult("?")).bind(target.id).rows().length)
      throw new AppError("对方已提交结构化结果，本次委派已结束", 409, "INPUT_CLOSED");
    if (target.status === "paused" || (target.status === "cancelled" && !target.payload.agentInterrupted))
      throw new AppError("对方任务已暂停或取消，请先继续任务", 409, "AGENT_STOPPED");
    const settled = "status IN ('done','failed','cancelled')";
    const messageId = uid(), t = now(), result = { message_id: messageId, task_id: target.id, agent_id: agentIdentity(target) };
    const results = await this.db.batch([
      this.db.prepare(`UPDATE runs SET generation=generation+CASE WHEN ${settled} THEN 1 ELSE 0 END,
        status=CASE WHEN ${settled} THEN 'queued' ELSE status END,stage='agent',
        next_attempt_at=CASE WHEN ${settled} OR json_extract(payload,'$.agent.waitingInputVersion') IS NOT NULL THEN 0 ELSE next_attempt_at END,
        error=CASE WHEN ${settled} THEN NULL ELSE error END,
        error_code=CASE WHEN ${settled} THEN NULL ELSE error_code END,
        attempts=CASE WHEN ${settled} THEN 0 ELSE attempts END, result_text='', updated_at=?,
        payload=CASE WHEN status='cancelled' THEN json_remove(payload,'$.agentInterrupted','$.cancellation') ELSE payload END
        WHERE id=? AND project_id=? AND status<>'paused'
        AND (status<>'cancelled' OR (json_extract(payload,'$.agentInterrupted')=1 AND lease_until<=?))
        AND (NOT (${settled}) OR NOT ${unfinishedAgentExecution})
        AND NOT EXISTS(${sealedStructuredResult("runs.id")}) AND ${toolCallerGuard}`)
        .bind(t, target.id, sender.projectId, Date.now(), ...toolCallerBindings(sender.projectId, { run: sender, callId })),
      this.db.prepare("INSERT INTO agent_inputs(id,run_id,content,created_at,source) SELECT ?,?,?,?,? WHERE changes()=1")
        .bind(messageId, target.id, content, t, source),
      this.db.prepare("INSERT INTO tool_receipts(run_id,call_id,result,created_at) SELECT ?,?,?,? WHERE changes()=1").bind(sender.id, callId, json(result), t),
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'run',?,? WHERE changes()=1").bind(sender.projectId, json(result), t),
    ]);
    if (!results[0].meta.changes) {
      const committed = await this.toolResult(sender.id, callId); if (committed) return committed;
      const current = await this.run(sender.id, sender.projectId);
      if (current.inputVersion !== sender.inputVersion) throw new AppError("收到新的输入", 409, "AGENT_STEER");
      if (target.payload.childExecution?.outputSchema && this.db.prepare(sealedStructuredResult("?")).bind(target.id).rows().length)
        throw new AppError("对方已提交结构化结果，本次委派已结束", 409, "INPUT_CLOSED");
      throw new AppError("消息未投递，发送或接收任务已停止", 409, current.status === "running" && current.leaseToken === sender.leaseToken ? "AGENT_STOPPED" : "RUN_STOPPED");
    }
    notifyExecutions(this.db, sender.projectId);
    return result;
  }
  private async sendToLead(sender: Run, callId: string, content: string, source: string) {
    const scope = [sender.projectId, sender.sessionId ?? ""];
    const messageId = uid(), newRun = uid(), time = now();
    const guard = toolCallerBindings(sender.projectId, { run: sender, callId });
    await this.db.batch([
      // Select or create the current turn inside the same transaction as the delivery.
      this.db.prepare(`INSERT INTO runs(id,project_id,session_id,intent,status,stage,progress,label,payload,created_at,updated_at)
        SELECT ?,?,?,'agent','queued','agent',0,'处理协作消息',?,?,? WHERE ${toolCallerGuard}
        AND EXISTS(SELECT 1 FROM projects WHERE id=? AND status<>'archived')
        AND NOT EXISTS(SELECT 1 FROM runs WHERE project_id=? AND session_id=? AND ${queueBlocked})`)
        .bind(newRun, ...scope, json({ instruction: "", sourceVersions: {} }), time, time, ...guard, sender.projectId, ...scope),
      this.db.prepare(`INSERT INTO messages(id,project_id,session_id,role,agent,content,run_id,artifact_ids,created_at)
        SELECT ?,?,?,'assistant','main','',?,'[]',? WHERE changes()=1`).bind(uid(), ...scope, newRun, time),
      this.db.prepare(`INSERT INTO agent_inputs(id,run_id,content,created_at,source)
        SELECT ?,r.id,?,?,? FROM runs r WHERE r.project_id=? AND r.session_id=? AND ${steeringRun}
        AND ${currentAgent("r")} AND ${toolCallerGuard}`)
        .bind(messageId, content, time, source, ...scope, ...guard),
      this.db.prepare(`INSERT INTO tool_receipts(run_id,call_id,result,created_at)
        SELECT ?,?,json_object('message_id',id,'task_id',run_id,'agent_id',?),? FROM agent_inputs WHERE id=? AND changes()=1`)
        .bind(sender.id, callId, leadAgentId, time, messageId),
      this.db.prepare(`UPDATE runs SET next_attempt_at=0 WHERE id=(SELECT run_id FROM agent_inputs WHERE id=?)
        AND json_extract(payload,'$.agent.waitingInputVersion') IS NOT NULL AND changes()=1`).bind(messageId),
    ]);
    const receipt = await this.toolResult(sender.id, callId);
    if (!receipt) {
      const current = await this.run(sender.id, sender.projectId);
      if (current.inputVersion !== sender.inputVersion) throw new AppError("收到新的输入", 409, "AGENT_STEER");
      if (current.leaseToken !== sender.leaseToken || current.status !== "running") throw new AppError("任务已停止", 409, "RUN_STOPPED");
      throw new AppError("主智能体目前无法接收协作消息", 409, "AGENT_STOPPED");
    }
    notifyExecutions(this.db, sender.projectId);
    return receipt;
  }
  delegationDepth(run: Run) {
    return this.db.prepare(`WITH RECURSIVE parents(id,parent_run_id,depth) AS (
      SELECT id,parent_run_id,0 FROM runs WHERE id=? AND project_id=?
      UNION ALL SELECT r.id,r.parent_run_id,p.depth+1 FROM runs r JOIN parents p ON r.id=p.parent_run_id
      WHERE r.project_id=?
    ) SELECT COALESCE(MAX(depth),0) AS depth FROM parents`).bind(run.id, run.projectId, run.projectId).rows<{depth: number}>()[0].depth;
  }
  canDelegate(run: Run) {
    return run.agentRole !== "media" && this.delegationDepth(run) < this.maxDelegationDepth;
  }
  private assertDelegation(parent: Run) {
    if (!this.canDelegate(parent)) throw new AppError("已达到当前会话的子智能体委派深度上限", 409, "AGENT_DEPTH_LIMIT");
  }
  async startChild(parent: Run, callId: string, role: AgentRole, instruction: string,
    job?: { stage: Stage; payload: RunPayload; background?: true }, inherit = false, roles = this.agents, name?: string, execution?: ChildExecution) {
    const cached = await this.toolResult(parent.id, callId); if (cached) return cached;
    if (role !== "media") this.assertDelegation(parent);
    const definition = roles.find((agent) => agent.id === role);
    if (!definition && role !== "media") throw new AppError("该角色未注册", 400, "AGENT_ROLE_UNKNOWN");
    const operation = role === "media" ? job?.payload.operation : undefined;
    const outputPath = operation ? projectOutputPath(operation.path, operation.name === "generate_image" ? "/03_图片" : operation.name === "generate_video" ? "/04_视频" : "/07_成片") : undefined;
    const outputBusy = "SELECT id FROM runs WHERE project_id=? AND json_extract(payload,'$.operation.path')=? AND (status IN ('queued','running','waiting','paused') OR json_extract(payload,'$.submissionUnknown')=1 OR json_extract(payload,'$.cancellation.state') IN ('checking','running','unknown','completed'))";
    const busyOutput = async () => outputPath ? this.db.prepare(outputBusy + " LIMIT 1").bind(parent.projectId, outputPath).first<{ id: string }>() : null;
    const busy = await busyOutput();
    if (busy) throw new AppError("该文件已有制作任务或未确认的提交，请先核对该任务：" + busy.id, 409, "OUTPUT_BUSY");
    const id = uid(), t = now();
    const payload: RunPayload = job?.payload || { instruction, sourceVersions: {}, agentDefinition: definition, childExecution: execution };
    if (inherit && !job) {
      const closed = parent.parentRunId ? parent : this.closedAgentTurn(parent);
      const source = (closed ? await inheritConversation(this, closed) : undefined) ?? this.sessionSeed(parent.projectId, parent.sessionId ?? "");
      if (source) payload.agent = { messages: source.messages, step: 0, seenUserIds: [], artifactIds: [],
        toolIndex: source.messages.findLast((message) => message.role === "assistant")?.tool_calls?.length ?? 0 };
    }
    const parentPath = definition && parent.parentRunId ? memberAddresses(await this.collaborators(parent)).get(parent.id) : "";
    const memberName = definition ? allocateMemberName(this.memberNames(parent), name) : undefined;
    if (memberName) payload.memberName = memberName;
    const result = { task_id: id, role, ...(definition ? { name: definition.name, member_name: joinMemberPath(parentPath, memberName) ?? id } : {}),
      generation: 1, status: "queued", ...(job?.background ? { background: true, path: outputPath } : {}) };
    const memberGuard = memberName ? ` AND NOT EXISTS(SELECT 1 FROM runs r WHERE project_id=? AND session_id=? AND ${creativeChild("r")}
      AND ${madeByAgent("r", "?")} AND json_extract(payload,'$.memberName')=?)` : "";
    const capacityGuard = job?.background ? ` AND (${ownerJobs("?")}) < ?` : "";
    const guard = toolCallerGuard + memberGuard + (outputPath ? " AND NOT EXISTS(" + outputBusy + ")" : "") + capacityGuard;
    const guardArgs = [...toolCallerBindings(parent.projectId, { run: parent, callId }), ...(memberName ? [parent.projectId, parent.sessionId ?? "", parent.id, memberName] : []),
      ...(outputPath ? [parent.projectId, outputPath] : []),
      ...(job?.background ? [parent.projectId, parent.sessionId ?? "", parent.id, this.maxConcurrentJobsPerOwner] : [])];
    const mutation = this.db.prepare("INSERT INTO runs(id,project_id,intent,status,stage,progress,label,error,payload,lease_until,lease_token,created_at,updated_at,parent_run_id,agent_role,generation,input_version,background,session_id) SELECT ?,?,?,'queued',?,0,?,NULL,?,0,'',?,?,?,?,1,1,?,? WHERE " + guard)
        .bind(id, parent.projectId, "agent", job?.stage || "agent", definition ? "等待执行" : "准备制作", json(payload), t, t, parent.id, role, job?.background ? 1 : 0, parent.sessionId ?? "", ...guardArgs);
    const results = await this.db.batch([mutation,
      this.db.prepare("INSERT INTO agent_inputs(id,run_id,content,created_at,source) SELECT ?,?,?,?,? WHERE changes()=1")
        .bind(uid(), id, instruction, t, json({ kind: "delegation", senderRunId: parent.id, senderRole: parent.agentRole } satisfies AgentInputSource)),
      this.db.prepare("INSERT INTO tool_receipts(run_id,call_id,result,created_at) SELECT ?,?,?,? WHERE changes()=1").bind(parent.id, callId, json(result), t),
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'run',?,? WHERE changes()=1").bind(parent.projectId, json(result), t),
    ]);
    if (!results[0].meta.changes) {
      const committed = await this.toolResult(parent.id, callId); if (committed) return committed;
      if (memberName && this.memberNames(parent).has(memberName)) throw duplicateAgentName();
      const busy = await busyOutput();
      if (busy) throw new AppError("该文件已有制作任务或未确认的提交，请先核对该任务：" + busy.id, 409, "OUTPUT_BUSY");
      const current = await this.run(parent.id, parent.projectId);
      if (current.leaseToken === parent.leaseToken && current.inputVersion === parent.inputVersion && current.status === "running" &&
          job?.background && this.jobLimitReached(parent.projectId, parent.sessionId ?? "", parent.id)) throw this.jobLimitError();
      throw new AppError("任务已停止或收到新输入", 409, current.inputVersion !== parent.inputVersion ? "AGENT_STEER" : "RUN_STOPPED");
    }
    return result;
  }
  async startBatch(parent: Run, callId: string, title: string, members: BatchMember[], roles = this.agents) {
    const cached = await this.toolResult(parent.id, callId);
    if (cached) return cached;
    this.assertDelegation(parent);
    if (new Set(members.map(({ key }) => key)).size !== members.length) throw new AppError("批次任务标识应唯一", 400);
    validateDependencies(members.map(({ key, dependencies }) => ({ id: key, dependencies })));
    const id = uid(), time = now(), ids = new Map(members.map(({ key }) => [key, uid()]));
    const parentPath = parent.parentRunId ? memberAddresses(await this.collaborators(parent)).get(parent.id) : "";
    const names = this.memberNames(parent);
    const jobs = members.map((member) => {
      const agentDefinition = roles.find((agent) => agent.id === member.role);
      if (!agentDefinition) throw new AppError("该角色未注册：" + member.role, 400, "AGENT_ROLE_UNKNOWN");
      const payload: RunPayload = { instruction: member.instruction, sourceVersions: {}, agentDefinition, memberName: allocateMemberName(names), childExecution: member.execution,
        batch: { id, title, key: member.key, dependencies: member.dependencies.map((key) => ids.get(key)!) } };
      return { ...member, id: ids.get(member.key)!, inbox: uid(), payload };
    });
    const result = json({ batch_id: id, title, tasks: jobs.map(({ id, key, role, payload }) => ({ task_id: id, key, role,
      member_name: joinMemberPath(parentPath, payload.memberName) ?? id })) });
    const owned = "EXISTS(SELECT 1 FROM tool_receipts WHERE run_id=? AND call_id=? AND result=?)";
    const guard = [parent.id, callId, result];
    await this.db.batch([
      this.db.prepare(`INSERT INTO tool_receipts(run_id,call_id,result,created_at) SELECT ?,?,?,? WHERE ${toolCallerGuard}
        AND NOT EXISTS(SELECT 1 FROM runs r JOIN json_each(?) n ON json_extract(r.payload,'$.memberName')=n.value
          WHERE r.project_id=? AND r.session_id=? AND ${creativeChild("r")} AND ${madeByAgent("r", "?")})`)
        .bind(...guard, time, ...toolCallerBindings(parent.projectId, { run: parent, callId }),
          json(jobs.map(({ payload }) => payload.memberName)), parent.projectId, parent.sessionId ?? "", parent.id),
      this.db.prepare(`INSERT INTO runs(id,project_id,session_id,parent_run_id,agent_role,intent,status,stage,progress,label,payload,created_at,updated_at,input_version)
        SELECT json_extract(value,'$.id'),?,?,?,json_extract(value,'$.role'),'agent','queued','agent',0,
          CASE WHEN json_array_length(value,'$.dependencies')>0 THEN '等待依赖' ELSE '等待执行' END,json_extract(value,'$.payload'),?,?,1
        FROM json_each(?) WHERE ${owned}`).bind(parent.projectId, parent.sessionId ?? "", parent.id, time, time, json(jobs), ...guard),
      this.db.prepare(`INSERT INTO agent_inputs(id,run_id,content,created_at,source) SELECT json_extract(value,'$.inbox'),
        json_extract(value,'$.id'),json_extract(value,'$.instruction'),?,? FROM json_each(?) WHERE ${owned}`)
        .bind(time, json({ kind: "delegation", senderRunId: parent.id, senderRole: parent.agentRole } satisfies AgentInputSource), json(jobs), ...guard),
    ]);
    const receipt = await this.toolResult(parent.id, callId);
    if (!receipt) {
      const used = this.memberNames(parent);
      if (jobs.some(({ payload }) => payload.memberName && used.has(payload.memberName)))
        throw duplicateAgentName();
      throw new AppError("任务已停止或收到新输入", 409, "RUN_STOPPED");
    }
    return receipt;
  }
  batchInputs(run: Run): { task: string; key: string; result: string; structured?: Record<string, unknown>;
    structured_receipt?: { read_with: "read_tool_result"; task_id: string; seq: number } }[] {
    const deps = run.payload.batch?.dependencies;
    if (!deps?.length) return [];
    return this.db.prepare(`SELECT r.id,r.result_text,json_extract(r.payload,'$.batch.key') AS key,
      s.seq,json_extract(t.result,'$.structured') AS structured
      FROM json_each(?) dep JOIN runs r ON r.id=dep.value
      LEFT JOIN (execution_steps s JOIN tool_receipts t ON t.run_id=s.run_id AND t.call_id=s.call_id AND t.concludes_turn=1)
        ON s.run_id=r.id AND s.name=? AND s.finished_at IS NOT NULL
      WHERE r.project_id=? AND r.session_id=? AND r.parent_run_id=? AND r.status='done' ORDER BY dep.key`)
      .bind(json(deps), structuredOutputTool, run.projectId, run.sessionId ?? "", run.parentRunId)
      .rows<{ id: string; key: string; result_text: string; structured: string | null; seq: number | null }>()
      .map((row) => ({ task: row.id, key: row.key, result: row.result_text.slice(0, 3000),
        ...(row.structured && row.seq !== null && (Buffer.byteLength(row.structured, "utf8") <= 2048 ? { structured: JSON.parse(row.structured) }
          : { structured_receipt: { read_with: "read_tool_result" as const, task_id: row.id, seq: row.seq } })) }));
  }
  teamEnabled(projectId: string, sessionId: string): boolean {
    const [mode] = this.db.prepare(`SELECT COALESCE((SELECT enabled FROM team_modes WHERE project_id=? AND session_id=?),
      EXISTS(SELECT 1 FROM team_tasks WHERE project_id=? AND session_id=?)) AS enabled`)
      .bind(projectId, sessionId, projectId, sessionId).rows<{ enabled: number }>();
    return mode.enabled === 1;
  }
  async setTeamEnabled(projectId: string, sessionId: string, enabled: boolean) {
    this.assertSession(projectId, sessionId);
    await this.db.batch([
      this.db.prepare(`INSERT INTO team_modes(project_id,session_id,enabled) VALUES(?,?,?)
        ON CONFLICT(project_id,session_id) DO UPDATE SET enabled=excluded.enabled WHERE enabled<>excluded.enabled`)
        .bind(projectId, sessionId, Number(enabled)),
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'feed:sessions',?,? WHERE changes()=1")
        .bind(projectId, json({ id: sessionId }), now()),
    ]);
    return this.sessions(projectId);
  }
  teamTasks(projectId: string, sessionId: string, includeDeleted = false): TeamTask[] {
    const rows = this.db.prepare(`SELECT t.*,COALESCE(json_extract(r.payload,'$.agentDefinition.name'),r.agent_role) AS owner_name
      FROM team_tasks t LEFT JOIN runs r ON r.id=t.owner_id WHERE t.project_id=? AND t.session_id=? ORDER BY t.rowid`).bind(projectId, sessionId).rows();
    const done = new Set(rows.filter((row) => row.status === "done").map((row) => String(row.id)));
    const tasks = rows.map((row) => {
      const dependencies: string[] = JSON.parse(String(row.dependencies));
      return { id: String(row.id), title: String(row.title), detail: String(row.detail), status: row.status as TeamTask["status"],
        revision: Number(row.revision), ownerId: row.owner_is_lead ? leadAgentId : row.owner_id ? String(row.owner_id) : null,
        ...(row.owner_is_lead ? { ownerName: STUDIO_NAME } : row.owner_name ? { ownerName: String(row.owner_name) } : {}),
        dependencies, ready: row.status === "pending" && dependencies.every((id) => done.has(id)),
        writeScopes: JSON.parse(String(row.write_scopes)) as string[] };
    });
    return (includeDeleted ? tasks : tasks.filter(({ status }) => status !== "deleted")).map((task) => ({ ...task,
      writeScopeWarnings: tasks.filter((other) => other.id !== task.id && other.status === "in_progress" &&
        task.writeScopes.some((left) => other.writeScopes.some((right) => left === right || left.startsWith(right + "/") || right.startsWith(left + "/"))))
        .map(({ id }) => id),
    }));
  }
  async changeTeamTask(run: Run, callId: string, update: Partial<Pick<TeamTask, "title" | "detail" | "status" | "ownerId" | "dependencies" | "writeScopes">>,
    identity?: Pick<TeamTask, "id" | "revision">, requireEnabled = false) {
    const cached = await this.toolResult(run.id, callId);
    if (cached) return cached;
    const sessionId = run.sessionId ?? "", history = this.teamTasks(run.projectId, sessionId, true);
    const current = history.filter(({ status }) => status !== "deleted");
    const selected = identity && history.find(({ id }) => id === identity.id);
    if (identity && (!selected || selected.revision !== identity.revision))
      throw new AppError("任务已变化，请读取最新修订", 409, "TEAM_TASK_CHANGED");
    if (!selected && current.length >= 256) throw new AppError("协作任务数量已达上限", 409);
    const task = { id: selected?.id ?? uid(), title: update.title ?? selected?.title ?? "", detail: update.detail ?? selected?.detail ?? "",
      status: update.status ?? selected?.status ?? "pending", ownerId: update.ownerId === undefined ? selected?.ownerId ?? null : update.ownerId,
      dependencies: update.dependencies ?? selected?.dependencies ?? [], revision: (selected?.revision ?? 0) + 1,
      writeScopes: update.writeScopes ?? selected?.writeScopes ?? [] };
    if (!task.title) throw new AppError("缺少任务名称");
    if (task.ownerId && task.ownerId !== selected?.ownerId) {
      const member = await this.resolveCollaborator(run, task.ownerId);
      if (!member) throw new AppError("负责人必须是当前协作中的智能体");
      task.ownerId = agentIdentity(member);
    }
    if (task.status === "pending") task.ownerId = null;
    if (task.status === "in_progress") task.ownerId ??= agentIdentity(run);
    const assignment = task.ownerId === leadAgentId ? [null, 1] : [task.ownerId, 0];
    const updated = [...current.filter(({ id }) => id !== task.id), ...(task.status === "deleted" ? [] : [task])];
    validateDependencies(updated);
    const ready = task.dependencies.every((id) => current.find((item) => item.id === id)?.status === "done");
    if (task.status === "in_progress" && !ready) throw new AppError("前置任务尚未完成", 409, "DEPENDENCY_PENDING");
    // A changed revision or inserted task makes this candidate graph stale.
    const stableGraph = `(SELECT COUNT(*) FROM team_tasks WHERE project_id=? AND session_id=?)=?
      AND NOT EXISTS(SELECT 1 FROM team_tasks t WHERE t.project_id=? AND t.session_id=? AND
        json_extract(?, '$."' || t.id || '"') IS NOT t.revision)`;
    const graph = [run.projectId, sessionId, history.length, run.projectId, sessionId, json(Object.fromEntries(history.map(({ id, revision }) => [id, revision])))];
    const liveMode = requireEnabled ? " AND COALESCE((SELECT enabled FROM team_modes WHERE project_id=? AND session_id=?),? )=1" : "";
    const gate = [...toolCallerBindings(run.projectId, { run, callId }), ...graph, ...(requireEnabled ? [run.projectId, sessionId, Number(history.length > 0)] : [])];
    const time = now();
    await this.db.batch([
      selected ? this.db.prepare("UPDATE team_tasks SET title=?,detail=?,status=?,owner_id=?,owner_is_lead=?,dependencies=?,revision=?,write_scopes=? WHERE id=? AND " + toolCallerGuard + " AND " + stableGraph + liveMode)
        .bind(task.title, task.detail, task.status, ...assignment, json(task.dependencies), task.revision, json(task.writeScopes), task.id, ...gate)
        : this.db.prepare("INSERT INTO team_tasks(id,project_id,session_id,title,detail,status,owner_id,owner_is_lead,dependencies,created_at,write_scopes) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE " + toolCallerGuard + " AND " + stableGraph + liveMode)
          .bind(task.id, run.projectId, sessionId, task.title, task.detail, task.status, ...assignment, json(task.dependencies), time, json(task.writeScopes), ...gate),
      this.db.prepare("INSERT INTO tool_receipts(run_id,call_id,result,created_at) SELECT ?,?,?,? WHERE changes()=1")
        .bind(run.id, callId, json({ ...task, ready: task.status === "pending" && ready,
          writeScopeWarnings: current.filter((other) => other.id !== task.id && other.status === "in_progress" &&
            task.writeScopes.some((left) => other.writeScopes?.some((right) => left === right || left.startsWith(right + "/") || right.startsWith(left + "/"))))
            .map(({ id }) => id) }), time),
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'feed:team',?,? WHERE changes()=1")
        .bind(run.projectId, json({ id: task.id }), time),
    ]);
    const receipt = await this.toolResult(run.id, callId);
    if (!receipt) throw new AppError("任务或其依赖已变化，请重新读取", 409, "TEAM_TASK_CHANGED");
    return receipt;
  }
  async wakeRun(id: string, projectId: string) {
    await this.db.prepare("UPDATE runs SET input_version=input_version+1,next_attempt_at=0 WHERE id=? AND project_id=? AND status IN ('queued','running','waiting')")
      .bind(id, projectId).run();
    notifyExecutions(this.db, projectId);
  }
  async appendBackgroundOutput(run: Run, lines: readonly (string | { line: string; channel: JobOutputChannel })[], format: "lines" | "chunks" = "chunks") {
    const limit = Math.max(0, Math.min(JOB_OUTPUT_RETAIN_BYTES, run.payload.backgroundOutputLimitBytes ?? JOB_OUTPUT_RETAIN_BYTES) - 1);
    let trimmedAt = -1;
    const chunks = lines.map((item, index) => {
      const chunk = typeof item === "string" ? { line: item, channel: "stdout" } : item;
      const bytes = Buffer.from(chunk.line);
      if (bytes.length <= limit) return chunk;
      let offset = bytes.length - limit;
      while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
      trimmedAt = index;
      return { ...chunk, line: bytes.subarray(offset).toString("utf8") };
    });
    const insert = this.db.prepare(`INSERT INTO background_job_output(job_id,line,created_at,channel,fragment)
      SELECT r.id,json_extract(value,'$.line'),?,json_extract(value,'$.channel'),? FROM runs r,json_each(?)
      WHERE r.id=? AND r.project_id=? AND r.background=1 AND r.status='running' AND r.lease_token=?
      ORDER BY CAST(key AS INTEGER)`).bind(now(), Number(format === "chunks"), json(chunks), run.id, run.projectId, run.leaseToken);
    const [received] = await this.db.batch([insert, ...(trimmedAt < 0 ? [] : [
      this.db.prepare(`INSERT INTO background_job_truncation(job_id,through_seq) SELECT ?,last_insert_rowid()-? WHERE changes()>0
        ON CONFLICT(job_id) DO UPDATE SET through_seq=MAX(through_seq,excluded.through_seq)`)
        .bind(run.id, chunks.length - trimmedAt - 1),
    ])]);
    if (!received.meta.changes) throw new AppError("后台任务已停止", 409, "RUN_STOPPED");
  }
  async wakeForChildResult(id: string, projectId: string) {
    await this.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=? AND project_id=? AND status IN ('queued','waiting')")
      .bind(id, projectId).run();
  }
  async publishStream(run: Run, requestId: string, content: string) {
    const result = await this.db.batch([
      this.db.prepare("UPDATE runs SET stream_text=?,updated_at=? WHERE id=? AND lease_token=? AND input_version=? AND status='running' AND json_extract(payload,'$.agent.pendingRequest.id')=?")
        .bind(content, now(), run.id, run.leaseToken, run.inputVersion, requestId),
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'stream',?,? WHERE changes()=1").bind(run.projectId, json({ id: run.id }), now()),
      this.db.prepare("UPDATE model_calls SET visible_text=? WHERE id=? AND run_id=? AND status='started' AND changes()=1").bind(content, requestId, run.id),
    ]);
    return Boolean(result[0].meta.changes);
  }
  async claimHumanWakeBudget(run: Run, ids: readonly string[]) {
    if (this.maxConsecutiveWakes === undefined || !ids.length) return;
    await this.db.prepare(`INSERT INTO background_wake_budget(project_id,session_id,owner,used,user_seq)
      SELECT i.project_id,i.session_id,?,0,MAX(i.seq) FROM agent_inbox i
      WHERE i.project_id=? AND i.session_id=? AND i.kind='user' AND i.source IS NULL AND i.id IN (${jsonIds})
        AND NOT EXISTS(SELECT 1 FROM messages m JOIN studio_schedule_deliveries d ON d.request_id=m.request_id
          JOIN studio_schedules s ON s.id=d.schedule_id AND s.project_id=m.project_id WHERE m.id=i.id)
        AND NOT EXISTS(SELECT 1 FROM chat_queue q WHERE q.project_id=i.project_id AND q.session_id=i.session_id
          AND q.scheduled_frame IS NOT NULL AND q.request_id=CASE WHEN i.id LIKE 'queue:%' THEN substr(i.id,7)
            ELSE (SELECT request_id FROM messages WHERE id=i.id) END)
        AND EXISTS(SELECT 1 FROM runs WHERE id=? AND lease_token=? AND input_version=? AND status='running')
      GROUP BY i.project_id,i.session_id
      ON CONFLICT(project_id,session_id,owner) DO UPDATE SET used=0,user_seq=excluded.user_seq
      WHERE excluded.user_seq>background_wake_budget.user_seq`)
      .bind(agentIdentity(run), run.projectId, run.sessionId ?? "", json(ids), run.id, run.leaseToken, run.inputVersion).run();
  }
  async beginModelCall(run: Run, requestId: string, request: Record<string, unknown>, imageRepair?: { rejectedRequestId: string; removed: number }) {
    const { modelRetry, modelDirectRetry: _directRetry, ...payload } = run.payload;
    const resuming = modelRetry && modelRetry.turn === request.turn && modelRetry.step === request.step &&
      modelRetry.inputVersion === run.inputVersion && (modelRetry.attempt ?? modelRetry.retry) + 1 === request.attempt;
    const t = now(), journal = this.checkpoint(run, payload, "model/request", requestId);
    const record = recordModelRequest(request);
    const inlineNotices = request.purpose === "creation" ? ((request.messages as AgentMessage[] | undefined) ?? []).flatMap(({ source }) =>
      source?.kind === "task-result" && source.inlineOutput ? [source.inlineOutput] : []) : [];
    const scheduleNotices = request.purpose === "creation" && !run.parentRunId ? ((request.messages as AgentMessage[] | undefined) ?? [])
      .flatMap(({ source }) => source?.kind === "schedule-change" ? [source.id] : []) : [];
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO model_request_parts(id,content) SELECT key,value FROM json_each(?)
        WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND lease_token=? AND status IN ('queued','running') AND input_version=? AND agent_revision=?)
        ON CONFLICT(id) DO NOTHING`).bind(json(Object.fromEntries(record.parts)), run.id, run.leaseToken, run.inputVersion, journal.before),
      this.db.prepare("UPDATE runs SET status='running',label=?,stream_text='',payload=?,agent_revision=?,lease_until=?,updated_at=? WHERE id=? AND lease_token=? AND status IN ('queued','running') AND input_version=? AND agent_revision=?")
        .bind(request.purpose === "creation" ? "正在回复" : "整理上下文", json(journal.payload), journal.revision, Date.now() + 240000, t, run.id, run.leaseToken, run.inputVersion, journal.before),
      this.db.prepare("INSERT INTO model_calls(id,run_id,request,status,created_at,request_header_id) SELECT ?,?,?,'started',?,? WHERE changes()=1")
        .bind(requestId, run.id, json(record.metadata), t, record.headerId),
      ...(imageRepair ? [this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'image/offload',?,? WHERE changes()=1")
        .bind(run.projectId, json({ runId: run.id, requestId, ...imageRepair }), t)] : []),
      ...(resuming ? [this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'llm/retry-started',?,? WHERE changes()=1")
        .bind(run.projectId, json({ runId: run.id, requestId, previousRequestId: modelRetry.requestId, retryId: modelRetry.retryId,
          turn: modelRetry.turn, step: modelRetry.step, retry: modelRetry.retry }), t)] : []),
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'request',?,? WHERE changes()=1")
        .bind(run.projectId, json({ runId: run.id, requestId, turn: run.generation, step: request.step, attempt: request.attempt }), t),
      ...journal.statements,
      ...(scheduleNotices.length ? [this.db.prepare(`UPDATE agent_inbox SET state='claimed',run_id=?
        WHERE project_id=? AND session_id=? AND kind='schedule-change' AND state='ready' AND id IN (${jsonIds})
        AND EXISTS(SELECT 1 FROM model_calls WHERE id=? AND run_id=? AND status='started')`)
        .bind(run.id, run.projectId, run.sessionId ?? "", json(scheduleNotices), requestId, run.id)] : []),
      ...(inlineNotices.length ? [this.db.prepare(`
        INSERT INTO background_job_reads(job_id,owner,cursor,terminal,observed_terminal)
        SELECT j.id,?,json_extract(n.value,'$.cursor'),json_extract(n.value,'$.terminal'),json_extract(n.value,'$.terminal')
        FROM json_each(?) n JOIN runs j ON j.id=json_extract(n.value,'$.jobId')
        WHERE j.project_id=? AND j.session_id=? AND j.background=1 AND ${currentAgent("j")}
          AND ${madeByAgent("j", "?")}
          AND ${taskNoticeToken("j")}=json_extract(n.value,'$.terminal')
          AND EXISTS(SELECT 1 FROM model_calls WHERE id=? AND run_id=? AND status='started')
        ON CONFLICT(job_id,owner) DO UPDATE SET cursor=MAX(cursor,excluded.cursor),
          terminal=excluded.terminal,observed_terminal=excluded.observed_terminal
        WHERE background_job_reads.terminal IS NOT excluded.terminal OR background_job_reads.cursor<excluded.cursor`)
        .bind(agentIdentity(run), json(inlineNotices), run.projectId, run.sessionId ?? "", run.id, requestId, run.id)] : []),
    ]);
    if (!results[1].meta.changes) {
      const current = await this.run(run.id, run.projectId);
      throw new AppError("任务已停止或收到新输入", 409, current.inputVersion !== run.inputVersion ? "AGENT_STEER" : "RUN_STOPPED");
    }
    return this.run(run.id, run.projectId);
  }
  async markModelFirstOutput(run: Run, id: string) {
    await this.db.prepare(`UPDATE model_calls SET first_output_at=? WHERE id=? AND run_id=? AND status='started' AND first_output_at IS NULL
      AND EXISTS (SELECT 1 FROM runs WHERE id=? AND lease_token=? AND input_version=? AND status='running')`)
      .bind(now(), id, run.id, run.id, run.leaseToken, run.inputVersion).run();
  }
  async settleModelCall(run: Run, id: string, data: { status: "completed" | "failed" | "interrupted"; response?: AgentMessage; usage?: ModelUsage; text?: string; providerRequestId?: string; error?: string; errorCode?: string; offloadImages?: number; lastOutputAt?: string }) {
    const completed = data.status === "completed";
    const [result] = await this.db.batch([
      this.db.prepare(`UPDATE model_calls SET status=?,response=?,usage=?,visible_text=COALESCE(?,visible_text),provider_request_id=?,error=?,error_code=?,settled_at=?,offload_images=?,last_output_at=COALESCE(?,last_output_at)
        WHERE id=? AND run_id=? AND status='started' AND EXISTS (
          SELECT 1 FROM runs WHERE id=? AND lease_token=?${completed ? " AND input_version=? AND status='running'" : ""}
        )`).bind(data.status, data.response ? json(data.response) : null, data.usage ? json(data.usage) : null, data.text ?? null,
          data.providerRequestId || null, data.error || null, data.errorCode || null, now(), data.offloadImages ?? null, data.lastOutputAt ?? null, id, run.id, run.id, run.leaseToken,
          ...(completed ? [run.inputVersion] : [])),
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'reply',?,? WHERE changes()=1")
        .bind(run.projectId, json({ runId: run.id, requestId: id, status: data.status, errorCode: data.errorCode }), now()),
    ]);
    if (completed && !result.meta.changes) {
      const current = await this.run(run.id, run.projectId);
      throw new AppError("任务已停止或收到新输入", 409, current.inputVersion !== run.inputVersion ? "AGENT_STEER" : "RUN_STOPPED");
    }
  }
  async modelCalls(projectId: string) {
    return (await this.db.prepare(`SELECT c.*,r.agent_role,${hydratedModelRequest} FROM model_calls c JOIN runs r ON c.run_id=r.id
      LEFT JOIN model_request_parts h ON h.id=c.request_header_id WHERE r.project_id=? ORDER BY c.rowid`)
      .bind(projectId).all<Row>()).results.map(restoreModelRequest);
  }
  lastContextRoute(run: Pick<Run, "id" | "projectId">): AgentState["contextRoute"] {
    return this.db.prepare(`SELECT json_extract(c.request,'$.baseUrl') AS baseUrl,json_extract(c.request,'$.model') AS model
      FROM model_calls c JOIN runs r ON r.id=c.run_id WHERE c.run_id=? AND r.project_id=? AND json_extract(c.request,'$.purpose')='creation'
      AND json_extract(c.request,'$.baseUrl') IS NOT NULL AND json_extract(c.request,'$.model')='deepseek-flash' ORDER BY c.rowid DESC LIMIT 1`)
      .bind(run.id, run.projectId).rows<NonNullable<AgentState["contextRoute"]>>()[0];
  }
  executionMetrics(projectId: string, runId: string) {
    if (!this.db.prepare("SELECT 1 FROM runs WHERE id=? AND project_id=?").bind(runId, projectId).rows().length)
      throw new AppError("任务不存在", 404);
    const elapsed = (start: string | null, end: string | null) => start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : null;
    const models = this.db.prepare(`SELECT id,status,created_at,settled_at,first_output_at,usage,error_code,
      json_extract(request,'$.turn') AS turn,json_extract(request,'$.step') AS step,json_extract(request,'$.attempt') AS attempt,
      json_extract(request,'$.purpose') AS purpose,json_extract(request,'$.model') AS model FROM model_calls WHERE run_id=? ORDER BY rowid`)
      .bind(runId).rows<{ id: string; status: string; created_at: string; first_output_at: string | null; settled_at: string | null; usage: string | null;
        error_code: string | null; turn: number | null; step: number | null; attempt: number | null; purpose: string | null; model: string | null }>()
      .map(({ created_at, settled_at, first_output_at, error_code, usage, ...model }) => ({ ...model, errorCode: error_code,
        durationMs: elapsed(created_at, settled_at), firstOutputMs: elapsed(created_at, first_output_at),
        usage: usage ? JSON.parse(usage) as ModelUsage : null }));
    const tools = this.db.prepare(`SELECT seq AS stepSeq,name,status,dispatched_at,finished_at FROM execution_steps WHERE run_id=? ORDER BY seq`)
      .bind(runId).rows<{ stepSeq: number; name: string; status: string; dispatched_at: string | null; finished_at: string | null }>()
      .map(({ dispatched_at, finished_at, ...tool }) => ({ ...tool, durationMs: elapsed(dispatched_at, finished_at) }));
    return { models, tools };
  }
  sessionExecutionMetrics(projectId: string, sessionId: string) {
    this.assertSession(projectId, sessionId);
    return this.db.read(() => {
      const [steps] = this.db.prepare(`WITH roots AS (
          SELECT id FROM runs WHERE project_id=? AND session_id=? AND parent_run_id IS NULL
        ), closed AS (
          SELECT json_extract(data,'$.runId') AS run_id,json_extract(data,'$.turn') AS turn,
            json_extract(data,'$.step') AS step FROM events
          WHERE project_id=? AND type='step/end' AND json_extract(data,'$.runId') IN (SELECT id FROM roots)
        ), timings AS (
          SELECT c.run_id,json_extract(c.request,'$.turn') AS turn,json_extract(c.request,'$.step') AS step,
            MIN(unixepoch(c.created_at,'subsec')) AS opened,MIN(unixepoch(c.first_output_at,'subsec')) AS first,
            MAX(CASE WHEN c.status='completed' THEN unixepoch(c.settled_at,'subsec') END) AS settled,
            MAX(CASE WHEN c.status='completed' THEN json_extract(c.usage,'$.outputTokens') END) AS output
          FROM model_calls c JOIN roots ON roots.id=c.run_id WHERE json_extract(c.request,'$.purpose')='creation'
          GROUP BY c.run_id,turn,step
        ) SELECT COUNT(DISTINCT concat(closed.run_id,':',closed.turn)) AS turns,COUNT(*) AS steps,
          COALESCE(ROUND(SUM(MAX(0,1000*(settled-opened)))),0) AS llmMs,
          COALESCE(ROUND(SUM(CASE WHEN settled IS NOT NULL THEN MAX(0,1000*(first-opened)) END)),0) AS ttftMs,
          COUNT(CASE WHEN settled IS NOT NULL THEN first END) AS ttftSteps,
          COALESCE(ROUND(SUM(CASE WHEN output IS NOT NULL THEN MAX(0,1000*(settled-first)) END)),0) AS decodeMs,
          COALESCE(SUM(CASE WHEN first IS NOT NULL THEN output END),0) AS decodeTokens
        FROM closed LEFT JOIN timings ON timings.run_id=closed.run_id AND timings.turn=closed.turn AND timings.step=closed.step`)
        .bind(projectId, sessionId, projectId).rows<Record<string, number>>();
      const [tools] = this.db.prepare(`SELECT COALESCE(ROUND(SUM(MAX(0,1000*(unixepoch(s.finished_at,'subsec')-unixepoch(s.dispatched_at,'subsec'))))),0) AS toolMs
        FROM execution_steps s JOIN runs r ON r.id=s.run_id
        WHERE r.project_id=? AND r.session_id=? AND r.parent_run_id IS NULL`).bind(projectId, sessionId).rows<{ toolMs: number }>();
      return { ...steps, toolMs: tools.toolMs };
    });
  }
  async modelCall(run: Run, id: string) {
    const row = await this.db.prepare(`SELECT c.*,${hydratedModelRequest} FROM model_calls c
      LEFT JOIN model_request_parts h ON h.id=c.request_header_id WHERE c.id=? AND c.run_id=?`).bind(id, run.id).first<Row>();
    return row && restoreModelRequest(row);
  }
  async nextModelStep(run: Run) {
    const row = await this.db.prepare("SELECT COALESCE(MAX(json_extract(request,'$.step')),0) + 1 AS step FROM model_calls WHERE run_id=? AND json_extract(request,'$.turn')=?")
      .bind(run.id, run.generation).first<{ step: number }>();
    return row?.step ?? 1;
  }
  async toolStepRequest(run: Run, id: string) {
    return this.db.prepare(`SELECT json_extract(COALESCE(h.content,c.request),'$.tools') AS schemas,
      json_extract(COALESCE(h.content,c.request),'$.toolSettings') AS settings,
      json_extract(COALESCE(h.content,c.request),'$.toolRoles') AS roles,
      json_extract(COALESCE(h.content,c.request),'$.toolBindings') AS bindings,json_extract(c.request,'$.turn') AS turn
      FROM model_calls c LEFT JOIN model_request_parts h ON h.id=c.request_header_id WHERE c.id=? AND c.run_id=? AND c.status='completed'`)
      .bind(id, run.id).first<{ schemas: string | null; settings: string | null; roles: string | null; bindings: string | null; turn: number | null }>();
  }
  private saveControlReceipt(target: Run, action: "pause" | "cancel" | "resume", caller: ToolCaller, predicate = toolCallerGuard, args = toolCallerBindings(target.projectId, caller)) {
    return this.db.prepare(`INSERT INTO tool_receipts(run_id,call_id,result,created_at)
      SELECT ?,?,json_patch(json_object('task_id',id,'action',?,'status',status,'generation',generation),
        json_object('cancellation',json_extract(payload,'$.cancellation'))),?
      FROM runs WHERE id=? AND project_id=? AND (${predicate})`)
      .bind(caller.run.id, caller.callId, action, now(), target.id, target.projectId, ...args);
  }
  async recordCompletedControl(run: Run, caller: ToolCaller) {
    await this.saveControlReceipt(run, "resume", caller, "status='done' AND " + toolCallerGuard).run();
  }
  async controlTree(run: Run, action: "pause" | "cancel", caller?: ToolCaller) {
    const status = action === "pause" ? "paused" : "cancelled";
    const predicate = action === "cancel"
      ? "(status IN ('queued','running','waiting','paused','cancelled') OR (id=? AND status='failed'))"
      : "status IN ('queued','running','waiting','paused')";
    // Model interruption stops one creative agent's turn. User cancellation still operates on the tree.
    const single = caller && !run.background && action === "cancel";
    const cancelPatch = action !== "cancel" ? "" : ",payload=" + (single
      ? `CASE WHEN status IN ('queued','running','waiting') THEN json_set(${cancelledRunPayload},'$.agentInterrupted',json('true')) ELSE payload END`
      : cancelledRunPayload);
    const scope = "SELECT id FROM runs WHERE id=? AND project_id=?";
    const tree = single ? scope : scope + " UNION ALL SELECT r.id FROM runs r JOIN tree ON r.parent_run_id=tree.id WHERE r.background=0";
    await this.db.batch([
      ...(action === "cancel" && !run.parentRunId && !caller && run.intent === "agent" ? [this.db.prepare(`UPDATE chat_queue
        SET status='cancelled',version=version+1,updated_at=? WHERE project_id=? AND session_id=? AND status='pending'
          AND EXISTS(SELECT 1 FROM runs WHERE id=? AND project_id=? AND status IN ('queued','running','waiting','paused'))
          AND (target_run_id=? OR (target_run_id IS NULL AND NOT EXISTS(SELECT 1 FROM runs
            WHERE project_id=? AND session_id=? AND id<>? AND ${steeringRun})))`)
        .bind(now(), run.projectId, run.sessionId ?? "", run.id, run.projectId, run.id, run.projectId, run.sessionId ?? "", run.id)] : []),
      this.db.prepare("WITH RECURSIVE tree(id) AS (" + tree + ") UPDATE runs SET status=?,label=?,next_attempt_at=0,updated_at=?" + cancelPatch + " WHERE id IN (SELECT id FROM tree) AND " +
        (single ? "status IN ('queued','running','waiting','cancelled')" : predicate) + (caller ? " AND " + toolCallerGuard : ""))
        .bind(run.id, run.projectId, status, action === "pause" ? "已暂停" : single ? "已中断" : "已取消", now(), ...(action === "cancel" && !single ? [run.id] : []),
          ...(caller ? toolCallerBindings(run.projectId, caller) : [])),
      ...(caller ? [this.saveControlReceipt(run, action, caller)] : []),
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'run',?,? WHERE " + (caller ? "changes()=1" : "1"))
        .bind(run.projectId, json({ id: run.id, action }), now()),
    ]);
    notifyExecutions(this.db, run.projectId);
    if (action === "cancel") await this.recoverStoppedExecutions(run.projectId);
  }
  async resumeTree(run: Run, payload: RunPayload, caller?: ToolCaller) {
    const time = now();
    const admitBackground = run.background && run.parentRunId && !["queued", "running", "waiting"].includes(run.status);
    const [result] = await this.db.batch([
      this.db.prepare("UPDATE runs SET status='queued',generation=generation+CASE WHEN status IN ('failed','cancelled') THEN 1 ELSE 0 END,label='等待继续',error=NULL,error_code=NULL,attempts=0,next_attempt_at=0,payload=?,updated_at=? WHERE id=? AND project_id=? AND status=? AND lease_token=? AND agent_revision=? AND json_remove(payload,'$.agent','$.agentRevision')=json_remove(?,'$.agent','$.agentRevision') AND (status NOT IN ('failed','cancelled') OR NOT " + unfinishedAgentExecution + ") AND EXISTS(SELECT 1 FROM projects p WHERE p.id=runs.project_id AND p.status<>'archived') AND " + sessionActive("runs.project_id", "runs.session_id") + (caller ? " AND " + toolCallerGuard : "") +
        (admitBackground ? ` AND (${ownerJobs("?", "runs.id")}) < ?` : ""))
        .bind(json(payload), time, run.id, run.projectId, run.status, run.leaseToken, run.agentRevision ?? 0, json(run.payload),
          ...(caller ? toolCallerBindings(run.projectId, caller) : []),
          ...(admitBackground ? [run.projectId, run.sessionId ?? "", run.parentRunId, this.maxConcurrentJobsPerOwner] : [])),
      ...(caller ? [this.saveControlReceipt(run, "resume", caller, "changes()=1", [])] : []),
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'run',?,? WHERE changes()=1")
        .bind(run.projectId, json({ id: run.id, action: "resume" }), time),
      this.db.prepare("WITH RECURSIVE descendants(id) AS (SELECT id FROM runs WHERE project_id=? AND parent_run_id=? AND background=0 UNION ALL SELECT r.id FROM runs r JOIN descendants d ON r.parent_run_id=d.id WHERE r.background=0) UPDATE runs SET status='queued',label='等待继续',next_attempt_at=0,updated_at=? WHERE changes()=1 AND status='paused' AND id IN (SELECT id FROM descendants)")
        .bind(run.projectId, run.id, time),
    ]);
    if (!result.meta.changes && admitBackground && this.jobLimitReached(run.projectId, run.sessionId ?? "", run.parentRunId!, run.id))
      throw this.jobLimitError();
    if (!result.meta.changes && !caller) throw new AppError("任务已更新，请重新操作", 409, "RUN_CHANGED");
  }
  async changeProjectFile(projectId: string, file: Artifact, path?: string) {
    if (file.projectId !== projectId || file.path.startsWith(PROJECT_TRASH)) throw new AppError("文件不存在", 404);
    const destination = path === undefined ? projectTrashPath(file.id) : projectOutputPath(path);
    if (file.path === destination) return file;
    if (path !== undefined && /\.[^./]+$/.exec(file.path)?.[0].toLowerCase() !== /\.[^./]+$/.exec(destination)?.[0].toLowerCase())
      throw new AppError("重命名时请保留文件扩展名", 400, "FILE_EXTENSION");
    const time = now(), version = file.version + 1;
    const [updated] = await this.db.batch([
      this.db.prepare(`UPDATE artifacts SET path=?,version=?,updated_at=? WHERE project_id=? AND id=? AND version=?
        AND path=? AND locked=0 AND status<>'generating' AND NOT EXISTS(SELECT 1 FROM artifacts WHERE project_id=? AND path=?)`)
        .bind(destination, version, time, projectId, file.id, file.version, file.path, projectId, destination),
      this.saveVersion({ ...file, version, path: path === undefined ? file.path : destination,
        metadata: json(file.metadata), createdAt: time, previousPath: file.path }),
    ]);
    if (!updated.meta.changes) throw new AppError("文件已锁定、正在生成、版本已变化或目标名称已占用", 409, "VERSION_CONFLICT");
    return this.artifact(file.id, projectId);
  }
  async createProjectDocument(projectId: string, inputPath: string, content = "") {
    const path = projectOutputPath(inputPath);
    if (!/\.md$/i.test(path)) throw new AppError("新建文档请使用 .md 扩展名", 400, "FILE_EXTENSION");
    return this.putArtifact(projectId, { path, content, kind: "document", expectedVersion: 0, metadata: { editedByUser: true } });
  }
  async moveArtifact(run: Run, callId: string, file: Artifact, path: string) {
    const version = file.version + 1, t = now(), result = { id: file.id, path, version };
    await this.db.batch([
      this.db.prepare(`UPDATE artifacts SET path=?,version=?,updated_at=? WHERE id=? AND project_id=? AND version=? AND path=? AND locked=0 AND ${toolCallerGuard}
        AND NOT EXISTS(SELECT 1 FROM artifacts occupied WHERE occupied.project_id=? AND occupied.path=?)`)
        .bind(path, version, t, file.id, run.projectId, file.version, file.path, ...toolCallerBindings(run.projectId, { run, callId }), run.projectId, path),
      this.saveVersion({ ...file, version, path, metadata: json(file.metadata), createdAt: t, runId: run.id, previousPath: file.path }),
      this.db.prepare("INSERT INTO tool_receipts(run_id,call_id,result,created_at) SELECT ?,?,?,? WHERE changes()=1").bind(run.id, callId, json(result), t),
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'artifact',?,? WHERE changes()=1").bind(run.projectId, json(result), t),
    ]);
    const receipt = await this.toolResult(run.id, callId);
    if (!receipt) throw await this.fileMutationConflict(run);
    return receipt;
  }
  async editArtifacts(run: Run, callId: string, changes: { file: Artifact; version: number; content: string }[]) {
    const cached = await this.toolResult(run.id, callId); if (cached) return cached;
    if (!changes.length || changes.length > 24 || new Set(changes.map((c) => c.file.id)).size !== changes.length) throw new AppError("批量修改的文件列表无效");
    const t = now(), result = { files: changes.map(({ file, version }) => ({ id: file.id, path: file.path, version: version + 1 })) };
    const expected = changes.map(({ file, version }) => ({ id: file.id, version }));
    const statements = [this.db.prepare(`INSERT INTO tool_receipts(run_id,call_id,result,created_at) SELECT ?,?,?,? WHERE ${toolCallerGuard}
      AND NOT EXISTS(SELECT 1 FROM json_each(?) v LEFT JOIN artifacts a ON a.id=json_extract(v.value,'$.id') AND a.project_id=?
        WHERE a.id IS NULL OR a.locked=1 OR a.version<>CAST(json_extract(v.value,'$.version') AS INTEGER))`)
      .bind(run.id, callId, json(result), t, ...toolCallerBindings(run.projectId, { run, callId }), json(expected), run.projectId)];
    for (const { file, version, content } of changes) {
      projectOutputPath(file.path);
      if (file.projectId !== run.projectId || file.url || ["image", "video", "audio", "final"].includes(file.kind)) throw new AppError("批量修改只支持本项目文本文件");
      const metadata = json({ ...file.metadata, structuredVersion: null, agent: run.agentRole });
      statements.push(
        this.db.prepare("UPDATE artifacts SET content=?,version=?,metadata=?,updated_at=? WHERE id=? AND changes()=1").bind(content, version + 1, metadata, t, file.id),
        this.saveVersion({ ...file, version: version + 1, content, url: null, metadata, createdAt: t, runId: run.id, previousPath: file.path }),
      );
    }
    statements.push(this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'artifact',?,? WHERE changes()=1").bind(run.projectId, json(result), t));
    await this.db.batch(statements);
    const receipt = await this.toolResult(run.id, callId);
    if (!receipt) throw await this.fileMutationConflict(run);
    return receipt;
  }
  private async fileMutationConflict(run: Run) {
    const current = await this.run(run.id, run.projectId);
    if (current.inputVersion !== run.inputVersion) return new AppError("收到新的输入，未写入文件", 409, "AGENT_STEER");
    if (current.leaseToken !== run.leaseToken || current.status !== "running") return new AppError("任务已停止，未写入文件", 409, "RUN_STOPPED");
    return new AppError("文件版本、名称或锁定状态已变化，本次未写入，请重新读取", 409, "VERSION_CONFLICT");
  }
  async finishAgent(run: Run, content: string) {
    const state = run.payload.agent!;
    const truncated = state.finalReplyReason === "max-tokens";
    const missingResult = Boolean(run.parentRunId && run.payload.childExecution?.outputSchema && !state.structuredResult);
    const inputGuard = `SELECT 1 FROM agent_inbox i WHERE i.project_id=runs.project_id AND i.session_id=runs.session_id
      AND i.state='ready' AND (i.run_id=runs.id OR (runs.parent_run_id IS NULL AND i.run_id IS NULL))
      AND (i.kind IN ('user','agent') OR (i.kind='schedule-change' AND runs.intent='agent' AND runs.parent_run_id IS NULL))
      AND i.id NOT IN (SELECT value FROM json_each(?))`;
    const pendingStep = "SELECT 1 FROM agent_inbox i WHERE i.project_id=runs.project_id AND i.run_id=runs.id AND i.target='next-step' AND i.state='pending'";
    const pendingBackground = `SELECT 1 FROM runs b WHERE b.project_id=runs.project_id AND b.session_id=runs.session_id AND b.background=1
      AND ${madeByAgent("b", "runs.id")}
      AND b.status IN ('done','failed','cancelled','paused') AND ${currentAgent("b")}
      AND COALESCE(json_extract(?, '$."' || b.id || '"'),'')<>${taskNoticeToken("b")}`;
    const pendingChild = `SELECT 1 FROM runs c WHERE c.project_id=runs.project_id AND c.session_id=runs.session_id AND c.background=0
      AND c.status IN ('done','failed','cancelled','paused') AND (c.parent_run_id=runs.id OR ${routedChildResult("c", "runs")})
      AND COALESCE(json_extract(?, '$."' || c.id || '"'),'')<>${taskNoticeToken("c")}`;
    const results = await this.db.batch([
      this.db.prepare("UPDATE runs SET status=?,stage=?,progress=100,label=?,result_text=?,stream_text='',error=?,error_code=?,lease_until=0,updated_at=? WHERE id=? AND project_id=? AND lease_token=? AND status IN ('queued','running') AND NOT EXISTS(" + inputGuard + ")" +
        (!run.parentRunId ? " AND NOT EXISTS(" + pendingStep + ")" : "") + " AND NOT EXISTS(" + pendingBackground + ") AND NOT EXISTS(" + pendingChild + ")")
        .bind(missingResult ? "failed" : "done", missingResult ? run.stage : "done", missingResult ? "执行停止" : truncated ? "回复已截断" : "已完成", content,
          missingResult ? "子智能体未通过 structured_output 提交结构化结果" : null, missingResult ? "STRUCTURED_OUTPUT_MISSING" : truncated ? "MODEL_TRUNCATED" : null,
          now(), run.id, run.projectId, run.leaseToken, json(state.seenUserIds), json(state.backgroundNotices || {}), json(state.childNotices || {})),
      ...(!run.parentRunId ? [this.db.prepare("UPDATE messages SET content=?,artifact_ids=? WHERE run_id=? AND role='assistant' AND changes()=1")
        .bind(content, json(state.artifactIds), run.id)] : []),
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'message',?,? WHERE changes()=1").bind(run.projectId, json({ runId: run.id }), now()),
      ...(run.intent === "compact" ? [this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'command/done',?,? WHERE changes()=1")
        .bind(run.projectId, json({ runId: run.id, command: "compact" }), now())] : []),
      ...(run.parentRunId ? [this.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=? AND status IN ('queued','waiting')").bind(run.parentRunId)] : []),
      ...(!run.parentRunId && run.intent === "agent" && state.seenUserIds.length ? [
        this.db.prepare(`UPDATE agent_inbox SET state='claimed',run_id=? WHERE project_id=? AND session_id=? AND kind='schedule-change'
          AND state='ready' AND id IN (${jsonIds})
          AND EXISTS(SELECT 1 FROM runs WHERE id=? AND lease_token=? AND status='done')`)
          .bind(run.id, run.projectId, run.sessionId ?? "", json(state.seenUserIds), run.id, run.leaseToken),
      ] : []),
    ]);
    return Boolean(results[0].meta.changes);
  }
  async putArtifact(projectId: string, input: {
    path: string; kind: ArtifactKind; content: string; status?: ArtifactStatus; url?: string | null;
    metadata?: Record<string, unknown>; expectedVersion?: number; expectedArtifactId?: string; allowLocked?: boolean;
    serveMedia?: boolean; lease?: Run; toolReceipt?: { run: Run; callId: string };
  }): Promise<Artifact> {
    const existingRow = await this.db.prepare("SELECT * FROM artifacts WHERE project_id=? AND path=?").bind(projectId, input.path).first<Row>();
    const existing = existingRow ? artifactRow(existingRow) : null;
    if (existing?.locked && !input.allowLocked) throw new AppError("文件已锁定，请先解锁", 409, "ARTIFACT_LOCKED");
    if ((input.expectedArtifactId !== undefined && existing?.id !== input.expectedArtifactId) ||
        (input.expectedVersion !== undefined && (existing?.version ?? 0) !== input.expectedVersion))
      throw new AppError("文件已有新版本，请刷新后再保存", 409, "VERSION_CONFLICT");
    const id = existing?.id || uid(), version = (existing?.version || 0) + 1, t = now();
    const metadata = json(input.metadata ?? existing?.metadata ?? {});
    const url = input.serveMedia ? "/api/studio/projects/" + projectId + "/media/" + id
      : input.url === undefined ? existing?.url || null : input.url;
    const receipt = input.toolReceipt;
    const lease = receipt?.run ?? input.lease;
    const guard = receipt ? " AND " + toolCallerGuard : lease ? " AND EXISTS(SELECT 1 FROM runs WHERE id=? AND project_id=? AND lease_token=? AND status='running')" : "";
    const guardArgs = receipt ? toolCallerBindings(projectId, receipt) : lease ? [lease.id, projectId, lease.leaseToken] : [];
    const mutation = existing
      ? this.db.prepare("UPDATE artifacts SET content=?,kind=?,version=?,status=?,url=?,metadata=?,updated_at=? WHERE id=? AND version=?" + (input.allowLocked ? "" : " AND locked=0") + guard)
        .bind(input.content, input.kind, version, input.status || "ready", url, metadata, t, id, existing.version, ...guardArgs)
      : this.db.prepare("INSERT INTO artifacts SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM artifacts WHERE project_id=? AND path=?)" + guard)
        .bind(id, projectId, input.path, input.kind, input.content, version, input.status || "ready", 0, url, metadata, t, t, projectId, input.path, ...guardArgs);
    const result = await this.db.batch([
      mutation,
      this.saveVersion({ id, version, content: input.content, path: input.path, kind: input.kind, url, metadata, createdAt: t,
        previousPath: existing?.path, runId: (input.status ?? "ready") === "ready" ? lease?.id : undefined }),
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,?,?,? WHERE changes()=1")
        .bind(projectId, "artifact", json({ id, version }), t),
      ...(receipt ? [this.db.prepare("INSERT INTO tool_receipts(run_id,call_id,result,created_at) SELECT ?,?,?,? WHERE changes()=1")
        .bind(receipt.run.id, receipt.callId, json({ id, path: input.path, version }), t)] : []),
    ]);
    if (!result[0].meta.changes) {
      if (receipt) throw await this.fileMutationConflict(receipt.run);
      throw new AppError("文件已被其他任务修改，请刷新", 409, "VERSION_CONFLICT");
    }
    await this.db.prepare("UPDATE projects SET updated_at=? WHERE id=?").bind(t, projectId).run();
    return this.artifact(id, projectId);
  }
  async lockArtifact(id: string, projectId: string, locked: boolean) {
    await this.db.batch([this.db.prepare("UPDATE artifacts SET locked=?,updated_at=? WHERE id=? AND project_id=?").bind(locked ? 1 : 0, now(), id, projectId),
      this.event(projectId, "artifact", { id, locked })]);
  }
  async versions(id: string, projectId: string, indexOnly = false) {
    await this.artifact(id, projectId);
    const fields = indexOnly ? "version,created_at AS createdAt" : "version,content,url,metadata,created_at AS createdAt";
    return this.db.prepare("SELECT " + fields + " FROM artifact_versions WHERE artifact_id=? ORDER BY version DESC").bind(id).rows();
  }
  private fileChanges(projectId: string, runId?: string, file?: { id: string; throughVersion?: number }, runIds?: string[], until?: string) {
    return this.db.prepare(`
      WITH RECURSIVE tasks(id,root_id) AS (
        SELECT id,id FROM runs WHERE project_id=? AND parent_run_id IS NULL ${runId ? "AND id=?" : runIds ? "AND id IN (" + jsonIds + ")" : ""}
        UNION ALL
        SELECT r.id,t.root_id FROM runs r JOIN tasks t ON r.parent_run_id=t.id
      ), bounds AS (
        SELECT t.root_id,v.artifact_id,MIN(v.version) AS first_version,MAX(v.version) AS last_version
        FROM tasks t JOIN artifact_versions v ON v.run_id=t.id
        WHERE (? IS NULL OR v.created_at<=?) ${file ? "AND v.artifact_id=? AND v.version<=?" : ""}
        GROUP BY t.root_id,v.artifact_id
      )
      SELECT b.root_id AS runId, b.artifact_id AS id, last.path, first.previous_path AS previousPath,
        prior.version AS beforeVersion, last.version AS afterVersion, last.kind
      FROM bounds b
      JOIN artifact_versions first ON first.artifact_id=b.artifact_id AND first.version=b.first_version
      JOIN artifact_versions last ON last.artifact_id=b.artifact_id AND last.version=b.last_version
      LEFT JOIN artifact_versions prior ON prior.artifact_id=b.artifact_id AND prior.version=b.first_version-1
      ORDER BY last.path, b.artifact_id
    `).bind(projectId, ...(runId ? [runId] : runIds ? [json(runIds)] : []), until ?? null, until ?? null, ...(file ? [file.id, file.throughVersion ?? Number.MAX_SAFE_INTEGER] : []))
      .rows<TurnFileChange & { runId: string; kind: ArtifactKind }>();
  }
  private historyFileChanges(projectId: string, rootIds: string[], until?: string) {
    const saved = this.db.prepare(`SELECT r.id AS run_id,change.value AS data FROM runs r, json_each(r.payload,'$.forkChanges') change
      WHERE r.project_id=? AND r.id IN (${jsonIds}) AND (? IS NULL OR EXISTS(SELECT 1 FROM artifact_versions v
        WHERE v.artifact_id=json_extract(change.value,'$.id') AND v.version=json_extract(change.value,'$.afterVersion') AND v.created_at<=?))`)
      .bind(projectId, json(rootIds), until ?? null, until ?? null).rows<{ run_id: string; data: string }>();
    return [...this.fileChanges(projectId, undefined, undefined, rootIds, until), ...saved.map(({ run_id, data }) =>
      ({ ...JSON.parse(data) as TurnFileChange & { kind: ArtifactKind }, runId: run_id }))];
  }
  async compareTurnFile(projectId: string, runId: string, artifactId: string, throughVersion?: number): Promise<FileComparison> {
    const [current] = this.fileChanges(projectId, runId, { id: artifactId, throughVersion });
    const record = current ?? this.historyFileChanges(projectId, [runId]).find((change) => change.id === artifactId);
    if (!record || (throughVersion !== undefined && record.afterVersion !== throughVersion))
      throw new AppError("这一轮没有修改此文件或该版本", 404, "CHANGE_NOT_FOUND");
    const { runId: _runId, kind, ...change } = record;
    const versions = await this.db.prepare("SELECT version,content,metadata,kind FROM artifact_versions WHERE artifact_id=? AND version IN (?,?)")
      .bind(artifactId, change.beforeVersion, change.afterVersion).all<{ version: number; content: string; metadata: string; kind: ArtifactKind | null }>();
    const before = versions.results.find((row) => row.version === change.beforeVersion);
    const after = versions.results.find((row) => row.version === change.afterVersion)!;
    if (["image", "video", "audio", "final"].includes(kind)) {
      const preview = (row: typeof before) => row && typeof JSON.parse(row.metadata).objectKey === "string" ? {
        kind: row.kind || kind, url: "/api/studio/projects/" + projectId + "/media/" + artifactId + "?version=" + row.version,
      } : null;
      return { ...change, kind: "media", before: preview(before), after: preview(after) };
    }
    return { ...change, kind: "text", ...compareText(before?.content || "", after.content) };
  }
  async addMessage(projectId: string, role: Message["role"], content: string, agent: Message["agent"] = "main", runId: string | null = null, artifactIds: string[] = []) {
    const id = uid(), t = now();
    await this.db.batch([this.db.prepare("INSERT INTO messages(id,project_id,role,agent,content,run_id,artifact_ids,created_at,session_id) VALUES(?,?,?,?,?,?,?,?,COALESCE((SELECT session_id FROM runs WHERE id=?),''))").bind(id, projectId, role, agent, content, runId, json(artifactIds), t, runId),
      this.event(projectId, "message", { id })]);
    return id;
  }
  async messages(projectId: string, sessionId = "", includeInherited = true): Promise<Message[]> {
    return this.db.prepare("SELECT * FROM messages WHERE project_id=? AND session_id=? AND (? OR inherited=0) ORDER BY rowid")
      .bind(projectId, sessionId, Number(includeInherited)).rows().map(messageRow);
  }
  private readChatQueue(projectId: string, sessionId: string): QueuedChat[] {
    return this.db.prepare("SELECT request_id,content,attachments,version,target_run_id,created_at FROM chat_queue WHERE project_id=? AND session_id=? AND status='pending' ORDER BY target_run_id IS NULL,turn_order,rowid")
      .bind(projectId, sessionId).rows().map((row) => ({
        requestId: String(row.request_id), text: String(row.content), attachments: JSON.parse(String(row.attachments)) as MessageAttachment[], version: Number(row.version), createdAt: String(row.created_at),
        ...(row.target_run_id ? { targetRunId: String(row.target_run_id) } : {}),
      }));
  }
  async queuedChatAcknowledged(projectId: string, input: ChatSubmission, sessionId = "") {
    const row = await this.db.prepare("SELECT original,session_id FROM chat_queue WHERE project_id=? AND request_id=?")
      .bind(projectId, input.requestId).first<{ original: string; session_id: string }>();
    if (row && (row.session_id !== sessionId || row.original !== json([input.text, input.attachmentIds])))
      throw new AppError("发送标识已用于另一条消息，请重新发送", 409, "CHAT_REQUEST_CONFLICT");
    return Boolean(row);
  }
  queueAdmission(projectId: string, input: ChatSubmission, time: string, sessionId: string, predicate = "1", ...values: unknown[]) {
    return this.db.prepare(`WITH selected AS (${selectedChatArtifacts})
      INSERT INTO chat_queue(project_id,request_id,original,content,attachments,created_at,updated_at,session_id,scheduled_frame)
      SELECT ?,?,?,?,(${chatArtifactRefs}),?,?,?,? WHERE (SELECT COUNT(*) FROM selected)=?
      AND NOT EXISTS(SELECT 1 FROM messages WHERE project_id=? AND request_id=?)
      AND EXISTS(SELECT 1 FROM projects WHERE id=? AND status<>'archived')
      AND ${sessionActive("?", "?")}
      AND (${predicate})
      ON CONFLICT(project_id,request_id) DO NOTHING`)
      .bind(json(input.attachmentIds), projectId, projectId, input.requestId, json([input.text, input.attachmentIds]), input.text,
        time, time, sessionId, input.scheduledFrame ?? null, input.attachmentIds.length, projectId, input.requestId, projectId, projectId, sessionId, ...values);
  }
  async enqueueChat(projectId: string, input: ChatSubmission, sessionId = "") {
    const result = await this.queueAdmission(projectId, input, now(), sessionId).run();
    if (result.meta.changes || await this.queuedChatAcknowledged(projectId, input, sessionId)) return;
    if (await this.acceptedChat(projectId, input, sessionId)) throw new AppError("这条消息已经发送", 409, "CHAT_REQUEST_CONFLICT");
    this.assertActiveSession(projectId, sessionId);
    throw new AppError("有素材已不可用，请重新选择", 409, "CHAT_ATTACHMENT_UNAVAILABLE");
  }
  async acceptChatAtStep(projectId: string, input: ChatSubmission, sessionId = "") {
    const active = this.db.prepare(`SELECT id FROM runs WHERE project_id=? AND session_id=? AND ${steeringRun}`)
      .bind(projectId, sessionId).rows<{ id: string }>();
    const run = active[0];
    if (!run) return this.acceptChat(projectId, input, undefined, sessionId);
    const time = now();
    const [inserted, directed] = await this.db.batch([
      this.queueAdmission(projectId, input, time, sessionId),
      this.db.prepare(`UPDATE chat_queue SET target_run_id=?,turn_order=1+COALESCE((SELECT MAX(turn_order) FROM chat_queue WHERE target_run_id=?),0),
        updated_at=? WHERE changes()=1 AND project_id=? AND session_id=? AND request_id=? AND status='pending'
        AND EXISTS(SELECT 1 FROM runs WHERE id=? AND project_id=? AND session_id=? AND ${steeringRun})`)
        .bind(run.id, run.id, time, projectId, sessionId, input.requestId, run.id, projectId, sessionId),
      this.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=? AND project_id=? AND changes()=1").bind(run.id, projectId),
    ]);
    if (directed.meta.changes) notifyExecutions(this.db, projectId);
    if (inserted.meta.changes || await this.queuedChatAcknowledged(projectId, input, sessionId) || await this.acceptedChat(projectId, input, sessionId)) return;
    throw new AppError("有素材已不可用，请重新选择", 409, "CHAT_ATTACHMENT_UNAVAILABLE");
  }
  async editQueuedChat(projectId: string, requestId: string, edit: QueuedChatEdit, sessionId = "") {
    const guard = "project_id=? AND session_id=? AND request_id=? AND version=? AND status='pending'";
    if (edit.action === "steer") {
      if (!await this.steerQueuedChats(projectId, edit.runId, [{ requestId, version: edit.version }], sessionId))
        throw new AppError("待发消息或当前轮已变化，请刷新后重试", 409, "CHAT_QUEUE_CHANGED");
      return;
    }
    const result = edit.action === "cancel"
      ? await this.db.prepare(`UPDATE chat_queue SET status='cancelled',version=version+1,updated_at=? WHERE ${guard}`)
        .bind(now(), projectId, sessionId, requestId, edit.version).run()
      : await this.db.prepare(`WITH selected AS (${selectedChatArtifacts})
        UPDATE chat_queue SET content=?,attachments=(
          SELECT json_group_array(json(COALESCE((SELECT old.value FROM json_each(chat_queue.attachments) old
            WHERE json_extract(old.value,'$.id')=selected.id),json_object('id',id,'path',path,'kind',kind,'version',version))) ORDER BY position)
          FROM selected),version=version+1,updated_at=? WHERE ${guard} AND (SELECT COUNT(*) FROM selected)=?`)
        .bind(json(edit.attachmentIds), projectId, edit.text, now(), projectId, sessionId, requestId, edit.version, edit.attachmentIds.length).run();
    if (result.meta.changes) return;
    if (edit.action === "replace" && await this.db.prepare(`SELECT 1 FROM chat_queue WHERE ${guard}`).bind(projectId, sessionId, requestId, edit.version).first())
      throw new AppError("有素材已不可用，请重新选择", 409, "CHAT_ATTACHMENT_UNAVAILABLE");
    throw new AppError("待发消息已经发送、撤回或被修改", 409, "CHAT_QUEUE_CHANGED");
  }
  async steerQueuedChats(projectId: string, runId: string, entries: QueuedChatVersion[], sessionId = "") {
    const [moved] = await this.db.batch([
      this.db.prepare(`WITH selected AS MATERIALIZED (
        SELECT q.request_id,ROW_NUMBER() OVER (ORDER BY q.rowid) + (
          SELECT COALESCE(MAX(turn_order),0) FROM chat_queue WHERE target_run_id=?
        ) AS position
        FROM chat_queue q WHERE q.project_id=? AND q.session_id=? AND q.status='pending' AND q.target_run_id IS NULL
          AND EXISTS(SELECT 1 FROM json_each(?) input WHERE json_extract(input.value,'$.requestId')=q.request_id
            AND json_extract(input.value,'$.version')=q.version)
          AND EXISTS(SELECT 1 FROM runs WHERE project_id=? AND session_id=? AND id=? AND ${steeringRun})
      )
      UPDATE chat_queue SET target_run_id=?,turn_order=(SELECT position FROM selected WHERE selected.request_id=chat_queue.request_id),
        version=version+1,updated_at=? WHERE project_id=? AND request_id IN (SELECT request_id FROM selected)`)
        .bind(runId, projectId, sessionId, json(entries), projectId, sessionId, runId, runId, now(), projectId),
      this.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=? AND project_id=? AND changes()>0").bind(runId, projectId),
    ]);
    return moved.meta.changes;
  }
  /** Only the current worker may deliver this turn's pending messages at a model-step boundary. */
  async claimStepQueue(run: Run) {
    const pending = this.db.prepare(
      `SELECT q.request_id FROM agent_inbox i JOIN chat_queue q ON q.project_id=i.project_id AND i.id='queue:'||q.request_id
       WHERE i.project_id=? AND i.run_id=? AND i.target='next-step' AND i.state='pending' ORDER BY q.turn_order`,
    ).bind(run.projectId, run.id).rows<{ request_id: string }>();
    if (!pending.length) return false;
    const t = now(), messageIds = pending.map(({ request_id }) => ({ requestId: request_id, id: uid() }));
    const ids = json(messageIds.map((item) => item.id));
    const [claimed] = await this.db.batch([
      this.db.prepare(`INSERT INTO messages(id,project_id,role,agent,content,run_id,artifact_ids,created_at,request_id,attachments,session_id)
        SELECT json_extract(row.value,'$.id'),q.project_id,'user',NULL,q.content,q.target_run_id,'[]',?,q.request_id,q.attachments,q.session_id
        FROM json_each(?) row JOIN chat_queue q ON q.request_id=json_extract(row.value,'$.requestId')
        WHERE q.project_id=? AND q.target_run_id=? AND q.status='pending'
          AND EXISTS(SELECT 1 FROM runs WHERE id=? AND project_id=? AND lease_token=? AND status='running')
        ORDER BY q.turn_order ON CONFLICT(project_id,request_id) DO NOTHING`)
        .bind(t, json(messageIds), run.projectId, run.id, run.id, run.projectId, run.leaseToken),
      this.db.prepare(`INSERT INTO events(project_id,type,data,created_at)
        SELECT project_id,'message',json_object('id',id),? FROM messages WHERE id IN (${jsonIds}) ORDER BY rowid`).bind(t, ids),
      this.db.prepare(`UPDATE chat_queue SET status='sent',version=version+1,updated_at=?
        WHERE project_id=? AND target_run_id=? AND request_id IN (SELECT request_id FROM messages WHERE id IN (${jsonIds}))`)
        .bind(t, run.projectId, run.id, ids),
    ]);
    return Boolean(claimed.meta.changes);
  }
  async promoteQueuedChats(limit: number) {
    const rows = this.db.prepare(`SELECT q.project_id,q.request_id,q.content,q.version,q.session_id FROM chat_queue q WHERE q.status='pending'
      AND q.rowid=(SELECT MIN(p.rowid) FROM chat_queue p WHERE p.project_id=q.project_id AND p.session_id=q.session_id AND status='pending')
      AND NOT EXISTS(SELECT 1 FROM runs WHERE project_id=q.project_id AND session_id=q.session_id AND ${queueBlocked}) ORDER BY q.rowid LIMIT ?`)
      .bind(limit).rows<{ project_id: string; request_id: string; content: string; version: number; session_id: string }>();
    for (const row of rows) await this.acceptChat(row.project_id, { requestId: row.request_id, text: row.content, attachmentIds: [] }, row.version, row.session_id);
  }
  async compactionAcknowledged(projectId: string, requestId: string, sessionId = "") {
    return Boolean(await this.db.prepare("SELECT 1 FROM runs WHERE id=? AND project_id=? AND session_id=? AND intent='compact'").bind(requestId, projectId, sessionId).first());
  }
  async requestCompaction(projectId: string, requestId: string, sessionId = "") {
    const t = now(), replyId = uid();
    const [created] = await this.db.batch([
      this.db.prepare(`INSERT INTO runs(id,project_id,intent,status,stage,progress,label,payload,created_at,updated_at,session_id)
        SELECT ?,?,'compact','queued','maintenance',0,'等待整理上下文',?,?,?,?
        WHERE NOT EXISTS(SELECT 1 FROM runs WHERE project_id=? AND session_id=? AND ${queueBlocked})
          AND NOT EXISTS(SELECT 1 FROM chat_queue WHERE project_id=? AND (session_id=? AND status='pending' OR request_id=?))
          AND NOT EXISTS(SELECT 1 FROM messages WHERE project_id=? AND request_id=?)
          AND EXISTS(SELECT 1 FROM projects WHERE id=? AND status<>'archived')
          AND ${sessionActive("?", "?")}
        ON CONFLICT(id) DO NOTHING`)
        .bind(requestId, projectId, json({ instruction: "/compact", sourceVersions: {} }), t, t, sessionId, projectId, sessionId, projectId, sessionId, requestId, projectId, requestId, projectId, projectId, sessionId),
      this.db.prepare(`INSERT INTO messages(id,project_id,role,agent,content,run_id,artifact_ids,created_at,request_id,session_id)
        SELECT ?,?,'assistant','main','',?,'[]',?,?,? WHERE changes()=1`).bind(replyId, projectId, requestId, t, requestId, sessionId),
      this.db.prepare(`INSERT INTO events(project_id,type,data,created_at) SELECT ?,'message',?,? WHERE changes()=1`)
        .bind(projectId, json({ id: replyId }), t),
      this.db.prepare(`INSERT INTO events(project_id,type,data,created_at) SELECT ?,'command/run',?,? WHERE changes()=1`)
        .bind(projectId, json({ runId: requestId, command: "compact" }), t),
    ]);
    if (!created.meta.changes && !await this.compactionAcknowledged(projectId, requestId, sessionId))
      throw new AppError("对话正在执行或有待发消息，空闲时可整理上下文", 409, "COMPACTION_BUSY");
  }
  async acceptedChat(projectId: string, input: ChatSubmission, sessionId = "") {
    if (await this.db.prepare("SELECT 1 FROM chat_queue WHERE project_id=? AND request_id=?").bind(projectId, input.requestId).first())
      throw new AppError("发送标识已用于待发消息", 409, "CHAT_REQUEST_CONFLICT");
    const row = await this.db.prepare("SELECT * FROM messages WHERE project_id=? AND request_id=?").bind(projectId, input.requestId).first<Row>();
    if (!row) return undefined;
    const message = messageRow(row);
    if (row.session_id !== sessionId || message.content !== input.text || json(message.attachments?.map((file) => file.id)) !== json(input.attachmentIds))
      throw new AppError("发送标识已用于另一条消息，请重新发送", 409, "CHAT_REQUEST_CONFLICT");
    return message;
  }
  async acceptChat(projectId: string, input: ChatSubmission, queuedVersion?: number, sessionId = "") {
    const messageId = uid(), runId = uid(), replyId = uid(), t = now();
    const active = "project_id=? AND session_id=? AND parent_run_id IS NULL AND status IN ('queued','running','waiting')";
    const queueIncoming = `EXISTS(SELECT 1 FROM runs WHERE ${active} AND intent='compact')
      OR (NOT EXISTS(SELECT 1 FROM runs WHERE ${active})
        AND EXISTS(SELECT 1 FROM chat_queue WHERE project_id=? AND session_id=? AND status='pending'))`;
    // Only this transaction's new user row can wake the active task or open a new one.
    const inserted = "EXISTS (SELECT 1 FROM messages WHERE id=?)";
    const opened = "EXISTS (SELECT 1 FROM runs WHERE id=?)";
    const messageColumns = "id,project_id,role,agent,content,run_id,artifact_ids,created_at,session_id";
    const results = await this.db.batch([
      queuedVersion !== undefined ? this.db.prepare(`
        INSERT INTO messages(${messageColumns},request_id,attachments)
        SELECT ?,q.project_id,'user',NULL,q.content,?,'[]',?,q.session_id,q.request_id,q.attachments FROM chat_queue q
        WHERE q.project_id=? AND q.session_id=? AND q.request_id=? AND q.version=? AND q.status='pending'
          AND EXISTS(SELECT 1 FROM projects WHERE id=q.project_id AND status<>'archived')
          AND ${sessionActive("q.project_id", "q.session_id")}
          AND q.rowid=(SELECT MIN(p.rowid) FROM chat_queue p WHERE p.project_id=q.project_id AND p.session_id=q.session_id AND status='pending')
          AND NOT EXISTS(SELECT 1 FROM runs WHERE project_id=q.project_id AND session_id=q.session_id AND ${queueBlocked})
        ON CONFLICT(project_id,request_id) DO NOTHING
      `).bind(messageId, runId, t, projectId, sessionId, input.requestId, queuedVersion) : this.db.prepare(`
        WITH selected AS (${selectedChatArtifacts})
        INSERT INTO messages(${messageColumns},request_id,attachments)
        SELECT ?,?,'user',NULL,?,COALESCE((SELECT id FROM runs WHERE ${active}),?),'[]',?,?,?,(${chatArtifactRefs})
        WHERE (SELECT COUNT(*) FROM selected)=?
          AND NOT EXISTS (SELECT 1 FROM runs WHERE ${active} AND intent<>'agent')
          AND NOT (${queueIncoming})
          AND NOT EXISTS (SELECT 1 FROM chat_queue WHERE project_id=? AND request_id=?)
          AND EXISTS (SELECT 1 FROM projects WHERE id=? AND status<>'archived')
          AND ${sessionActive("?", "?")}
        ON CONFLICT(project_id,request_id) DO NOTHING
      `).bind(json(input.attachmentIds), projectId, messageId, projectId, input.text, projectId, sessionId, runId, t, sessionId, input.requestId, input.attachmentIds.length,
        projectId, sessionId, projectId, sessionId, projectId, sessionId, projectId, sessionId, projectId, input.requestId, projectId, projectId, sessionId),
      this.db.prepare(`INSERT INTO events(project_id,type,data,created_at) SELECT ?,'message',?,? WHERE ${inserted}`)
        .bind(projectId, json({ id: messageId }), t, messageId),
      this.db.prepare(`UPDATE runs SET input_version=input_version+1,next_attempt_at=0 WHERE ${active} AND ${inserted}`)
        .bind(projectId, sessionId, messageId),
      this.db.prepare(`
        INSERT INTO runs(id,project_id,intent,status,stage,progress,label,payload,created_at,updated_at,session_id)
        SELECT ?,?,'agent','queued','agent',0,'等待执行',?,?,?,?
        WHERE ${inserted} AND NOT EXISTS (SELECT 1 FROM runs WHERE ${active})
      `).bind(runId, projectId, json({ instruction: input.text, sourceVersions: {} }), t, t, sessionId, messageId, projectId, sessionId),
      this.db.prepare(`INSERT INTO events(project_id,type,data,created_at) SELECT ?,'run',?,? WHERE ${opened}`)
        .bind(projectId, json({ id: runId }), t, runId),
      this.db.prepare(`INSERT INTO messages(${messageColumns}) SELECT ?,?,'assistant','main','',?,'[]',?,? WHERE ${opened}`)
        .bind(replyId, projectId, runId, t, sessionId, runId),
      this.db.prepare(`INSERT INTO events(project_id,type,data,created_at) SELECT ?,'message',?,? WHERE ${opened}`)
        .bind(projectId, json({ id: replyId }), t, runId),
      ...(queuedVersion === undefined ? [this.queueAdmission(projectId, input, t, sessionId, queueIncoming, projectId, sessionId, projectId, sessionId, projectId, sessionId)] : [this.db.prepare(`UPDATE chat_queue SET status='sent',version=version+1,updated_at=?
        WHERE project_id=? AND request_id=? AND ${opened}`).bind(t, projectId, input.requestId, runId)]),
    ]);
    if (queuedVersion !== undefined) return;
    if (results[0].meta.changes) { notifyExecutions(this.db, projectId); return; }
    if (results.at(-1)?.meta.changes || await this.queuedChatAcknowledged(projectId, input, sessionId) || await this.acceptedChat(projectId, input, sessionId)) return;
    this.assertActiveSession(projectId, sessionId);
    const busy = await this.db.prepare(`SELECT id FROM runs WHERE ${active} AND intent<>'agent'`).bind(projectId, sessionId).first();
    if (busy) throw new AppError("项目制作任务正在执行，请稍后发送", 409, "PROJECT_BUSY");
    throw new AppError("有素材已不可用，请在输入框移除或重新选择", 409, "CHAT_ATTACHMENT_UNAVAILABLE");
  }
  async createRun(projectId: string, payload: RunPayload): Promise<Run> {
    const busy = await this.db.prepare("SELECT id FROM runs WHERE project_id=? AND parent_run_id IS NULL AND status IN ('queued','running','waiting') LIMIT 1").bind(projectId).first();
    if (busy) throw new AppError("项目已有任务在执行，可先暂停或等它完成", 409, "PROJECT_BUSY");
    const t = now(), id = uid();
    try {
      await this.db.batch([this.db.prepare("INSERT INTO runs(id,project_id,intent,status,stage,progress,label,error,payload,lease_until,lease_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id, projectId, "agent", "queued", "agent", 0, "等待执行", null, json(payload), 0, "", t, t), this.event(projectId, "run", { id })]);
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new AppError("项目已有任务在执行", 409, "PROJECT_BUSY");
      throw error;
    }
    return (await this.run(id, projectId))!;
  }
  async run(id: string, projectId: string): Promise<Run> {
    const r = await this.db.prepare("SELECT * FROM runs WHERE id=? AND project_id=?").bind(id, projectId).first<Row>();
    if (!r) throw new AppError("任务不存在", 404);
    return this.restoreRun(r);
  }
  async claimRun(id: string, projectId: string): Promise<boolean> {
    const r = await this.db.prepare(`UPDATE runs SET status='running',lease_until=?,lease_token=?,lease_owner=?,updated_at=?,
      background=CASE WHEN stage='inspecting' AND agent_role='media' AND json_type(payload,'$.inspection')='object' THEN 1 ELSE background END
      WHERE id=? AND project_id=? AND status IN ('queued','running','waiting') AND lease_until<? AND next_attempt_at<=?
      AND NOT ${dependencyPending} AND NOT ${agentWaitBlocked}`)
      .bind(Date.now() + 240000, uid(), process.pid, now(), id, projectId, Date.now(), Date.now()).run();
    return Boolean(r.meta.changes);
  }
  async updateRun(run: Run, patch: Partial<Run>, force = false, kind: SessionChange = "checkpoint", reference?: string,
    records?: ReadonlyMap<string, ToolOutputRecord>, skipped: readonly SkippedToolCall[] = [], projections?: ExecutionProjection[],
    rejectedInputs?: readonly string[]) {
    const n = { ...run, ...patch, updatedAt: now(), leaseUntil: patch.leaseUntil ?? 0, nextAttemptAt: patch.nextAttemptAt ?? 0 };
    const journal = this.checkpoint(run, patch.payload, kind, reference);
    const retry = patch.payload?.modelRetry;
    const retryScheduled = patch.status === "waiting" && retry && retry.requestId !== run.payload.modelRetry?.requestId;
    const guardState = Boolean(patch.payload?.agent) && !force;
    const steps = journal.payload?.agent ? this.stepSettlements(run, journal.payload.agent.messages, records) : [];
    const [result] = await this.db.batch([
      this.db.prepare("UPDATE runs SET status=?,stage=?,progress=?,label=?,error=?,payload=COALESCE(?,payload),agent_revision=COALESCE(?,agent_revision),lease_until=?,next_attempt_at=?,attempts=?,error_code=?,stream_text=?,result_text=?,updated_at=? WHERE id=? AND project_id=?" +
        (force ? "" : " AND status NOT IN ('cancelled','paused') AND lease_token=?") +
        (guardState ? " AND input_version=? AND agent_revision=?" : ""))
        .bind(n.status, n.stage, n.progress, n.label, n.error, journal.payload ? json(journal.payload) : null,
          journal.statements.length ? journal.revision : null, n.leaseUntil, n.nextAttemptAt, n.attempts, n.errorCode, n.streamText, n.resultText, n.updatedAt, n.id, n.projectId,
          ...(force ? [] : [run.leaseToken]), ...(guardState ? [run.inputVersion, journal.before] : [])),
      ...journal.statements,
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,?,?,? WHERE changes()=1")
        .bind(n.projectId, "run", json({ id: n.id, status: n.status, stage: n.stage }), n.updatedAt),
      ...(retryScheduled ? [this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'llm/retry',?,? WHERE changes()=1")
        .bind(n.projectId, json({ ...retry, runId: n.id, nextAttemptAt: n.nextAttemptAt }), n.updatedAt)] : []),
      ...(projections?.length ? [this.db.prepare(`INSERT INTO events(project_id,type,data,created_at)
        SELECT ?, 'extension/'||json_extract(value,'$.name'), json_object('runId',?,'label',json_extract(value,'$.label'),'payload',json_extract(value,'$.data')),?
        FROM json_each(?) WHERE changes()=1`).bind(n.projectId, n.id, n.updatedAt, json(projections))] : []),
      ...(rejectedInputs?.length ? [this.db.prepare(`INSERT INTO events(project_id,type,data,created_at)
        SELECT ?,'inbox/rejected',?,? WHERE changes()=1`)
        .bind(n.projectId, json({ runId: n.id, messageIds: rejectedInputs, label: "输入未通过准入" }), n.updatedAt)] : []),
      ...steps,
      ...this.skippedToolSteps(run, skipped, false, journal.revision),
    ]);
    const current = await this.run(n.id, n.projectId);
    if (guardState && !result.meta.changes) throw new AppError("任务已停止或收到新输入", 409, current.inputVersion !== run.inputVersion ? "AGENT_STEER" : "RUN_STOPPED");
    return current;
  }
  async releaseLease(run: Run) {
    const released = await this.db.prepare("UPDATE runs SET lease_until=0 WHERE id=? AND lease_token=? RETURNING status")
      .bind(run.id, run.leaseToken).first<{ status: Run["status"] }>();
    if (run.agentRole !== "media" && (released?.status === "cancelled" || released?.status === "failed")) await this.settleStoppedExecution(run);
  }
  async attachMediaResult(run: Run, submissionId: string, media: MediaResult, label: string) {
    const patch = { mediaProvider: media.provider, providerModel: media.model, providerBaseUrl: media.baseUrl,
      providerTaskId: media.taskId || null, providerRequestId: media.requestId || null, outputUrl: media.outputUrl || null, outputDuration: null, submissionUnknown: false };
    // Acknowledge even after pause/cancel, without reactivating the job or replacing another submission.
    const result = await this.db.prepare("UPDATE runs SET payload=CASE WHEN status='cancelled' THEN json_patch(json_patch(payload,?),CASE WHEN ? IS NOT NULL THEN '{\"cancellation\":{\"state\":\"checking\",\"detail\":\"本地已停止，正在核对供应商状态\",\"attempts\":0}}' ELSE '{\"cancellation\":{\"state\":\"completed\",\"detail\":\"已生成，可继续保存结果\",\"attempts\":0}}' END) ELSE json_patch(payload,?) END,status=CASE WHEN status IN ('queued','running','waiting') THEN 'waiting' ELSE status END,label=CASE WHEN status IN ('queued','running','waiting') THEN ? ELSE label END,lease_until=CASE WHEN status IN ('queued','running','waiting') THEN 0 ELSE lease_until END,next_attempt_at=CASE WHEN status='cancelled' THEN 0 WHEN status IN ('queued','running','waiting') THEN ? ELSE next_attempt_at END,updated_at=? WHERE id=? AND project_id=? AND json_extract(payload,'$.submissionId')=?")
      .bind(json(patch), media.taskId || null, json(patch), label, Date.now() + (media.outputUrl ? 0 : 10000), now(), run.id, run.projectId, submissionId).run();
    if (result.meta.changes) await this.event(run.projectId, "run", { id: run.id }).run();
    return Boolean(result.meta.changes);
  }
  async rejectMediaSubmission(run: Run, submissionId: string) {
    await this.db.prepare("UPDATE runs SET payload=json_set(payload,'$.submissionUnknown',json('false'),'$.cancellation',CASE WHEN status='cancelled' THEN json('{\"state\":\"failed\",\"detail\":\"供应商已拒绝提交\",\"attempts\":0}') ELSE json_extract(payload,'$.cancellation') END) WHERE id=? AND project_id=? AND json_extract(payload,'$.submissionId')=?")
      .bind(run.id, run.projectId, submissionId).run();
  }
  async claimCancellation(run: Run) {
    const result = await this.db.prepare("UPDATE runs SET lease_token=?,lease_until=?,lease_owner=? WHERE id=? AND project_id=? AND status='cancelled' AND lease_until<? AND next_attempt_at<=? AND json_extract(payload,'$.providerTaskId') IS NOT NULL")
      .bind(uid(), Date.now() + 240000, process.pid, run.id, run.projectId, Date.now(), Date.now()).run();
    return Boolean(result.meta.changes);
  }
  async settleCancellation(run: Run, cancellation: NonNullable<RunPayload["cancellation"]>, task?: MediaTask) {
    const result = await this.db.batch([
      this.db.prepare("UPDATE runs SET payload=json_patch(payload,?),label=?,next_attempt_at=?,updated_at=? WHERE id=? AND project_id=? AND status='cancelled' AND lease_token=? AND json_extract(payload,'$.providerTaskId')=?")
        .bind(json({ cancellation, ...(task?.outputUrl ? videoTaskOutput(task) : {}) }), cancellation.detail, Date.now() + 30000, now(), run.id, run.projectId, run.leaseToken, run.payload.providerTaskId || null),
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'run',?,? WHERE changes()=1").bind(run.projectId, json({ id: run.id, cancellation }), now()),
    ]);
    return Boolean(result[0].meta.changes);
  }
  private async promoteTaskResults(limit: number) {
    const unclaimed = unclaimedTaskResults(this.completionDelivery === "wakeup");
    const budget = this.maxConsecutiveWakes ?? Number.MAX_SAFE_INTEGER;
    const available = `COALESCE((SELECT used FROM background_wake_budget
      WHERE project_id=i.project_id AND session_id=i.session_id AND owner='lead'),0)<?`;
    const sessions = this.db.prepare(`SELECT i.project_id,i.session_id ${unclaimed}
      AND (EXISTS(SELECT 1 FROM runs WHERE project_id=i.project_id AND session_id=i.session_id AND ${steeringRun})
        OR (${available} AND NOT EXISTS(SELECT 1 FROM runs WHERE project_id=i.project_id AND session_id=i.session_id AND ${queueBlocked})))
      GROUP BY i.project_id,i.session_id ORDER BY MIN(i.seq) LIMIT ?`).bind(budget, limit).rows<{ project_id: string; session_id: string }>();
    for (const { project_id: projectId, session_id: sessionId } of sessions) {
      const id = uid(), time = now();
      const pending = `SELECT i.seq ${unclaimed} AND i.project_id=? AND i.session_id=?`;
      const recipient = `SELECT id FROM runs WHERE project_id=? AND session_id=? AND ${steeringRun}`;
      // Claim the result and create its reply anchor together when the conversation is idle.
      await this.db.batch([
        this.db.prepare(`INSERT INTO runs(id,project_id,session_id,intent,status,stage,progress,label,payload,created_at,updated_at)
          SELECT ?,?,?,'agent','queued','agent',0,'处理任务结果',?,?,?
          WHERE EXISTS(${pending} AND ${available}) AND NOT EXISTS(SELECT 1 FROM runs WHERE project_id=? AND session_id=? AND ${queueBlocked})`)
          .bind(id, projectId, sessionId, json({ instruction: "", sourceVersions: {}, resultFollowup: true }), time, time, projectId, sessionId, budget, projectId, sessionId),
        ...(this.maxConsecutiveWakes !== undefined ? [this.db.prepare(`INSERT INTO background_wake_budget(project_id,session_id,owner,used)
          SELECT ?,?,'lead',1 WHERE EXISTS(SELECT 1 FROM runs WHERE id=?)
          ON CONFLICT(project_id,session_id,owner) DO UPDATE SET used=used+1`).bind(projectId, sessionId, id)] : []),
        this.db.prepare(`UPDATE agent_inbox SET run_id=(${recipient}),target='next-step',wake=1
          WHERE seq IN (${pending}) AND EXISTS(${recipient})`)
          .bind(projectId, sessionId, projectId, sessionId, projectId, sessionId),
        this.db.prepare(`INSERT INTO messages(id,project_id,role,agent,content,run_id,artifact_ids,created_at,session_id)
          SELECT ?,?,'assistant','main','',?,'[]',?,? WHERE EXISTS(SELECT 1 FROM runs WHERE id=?)`)
          .bind(uid(), projectId, id, time, sessionId, id),
      ]);
    }
  }
  private async promoteNestedTaskResults(limit: number) {
    if (this.completionDelivery !== "wakeup") return;
    const budget = this.maxConsecutiveWakes ?? Number.MAX_SAFE_INTEGER;
    const eligible = `
      owner.parent_run_id IS NOT NULL AND owner.agent_role<>'media' AND owner.status='done'
      AND owner.lease_until<=CAST(unixepoch('subsec')*1000 AS INTEGER)
      AND ${currentAgent("owner")} AND NOT ${hasUnfinishedAgentExecution("owner")}
      AND NOT EXISTS(${sealedStructuredResult("owner.id")})
      AND EXISTS(SELECT 1 FROM projects WHERE id=owner.project_id AND status<>'archived')
      AND ${sessionActive("owner.project_id", "owner.session_id")}
      AND COALESCE((SELECT used FROM background_wake_budget WHERE project_id=owner.project_id AND session_id=owner.session_id AND owner=owner.id),0)<?
      AND EXISTS(SELECT 1 FROM agent_inbox i JOIN runs child ON child.id=i.content
        WHERE i.run_id=owner.id AND i.project_id=owner.project_id AND i.session_id=owner.session_id
        AND i.kind='task-result' AND i.state='ready' AND i.wake=0
        AND child.parent_run_id=owner.id AND child.status IN ('done','failed','cancelled')
        AND json_extract(child.payload,'$.stoppedBySessionArchive') IS NOT 1
        AND NOT ${hasUnfinishedAgentExecution("child")}
        AND COALESCE(json_extract(child.payload,'$.cancellation.state'),'') NOT IN ('checking','running','unknown')
        AND i.id='task:'||child.id||':'||${taskNoticeToken("child")}
        AND NOT EXISTS(SELECT 1 FROM background_job_reads j WHERE j.job_id=child.id AND j.owner=owner.id AND j.observed_terminal=${taskNoticeToken("child")})
        AND COALESCE(json_extract(owner.payload,CASE WHEN child.background=1 THEN '$.agent.backgroundNotices' ELSE '$.agent.childNotices' END
          || '."' || child.id || '"'),'')<>${taskNoticeToken("child")})`;
    const parents = this.db.prepare(`SELECT id,project_id,session_id FROM runs owner WHERE ${eligible} ORDER BY rowid LIMIT ?`)
      .bind(budget, limit).rows<{id: string; project_id: string; session_id: string}>();
    for (const owner of parents) {
      await this.db.batch([
        this.db.prepare(`UPDATE runs AS owner SET generation=generation+1,status='queued',stage='agent',label='处理任务结果',
          next_attempt_at=0,result_text='',payload=json_set(payload,'$.resultFollowup',json('true')),updated_at=?
          WHERE id=? AND ${eligible}`).bind(now(), owner.id, budget),
        ...(this.maxConsecutiveWakes !== undefined ? [this.db.prepare(`INSERT INTO background_wake_budget(project_id,session_id,owner,used)
          SELECT ?,?,?,1 WHERE changes()=1 ON CONFLICT(project_id,session_id,owner) DO UPDATE SET used=used+1`)
          .bind(owner.project_id, owner.session_id, owner.id)] : []),
      ]);
    }
  }
  async dueRuns(limit = 6) {
    const interactive = "parent_run_id IS NULL AND stage IN ('agent','maintenance') AND agent_role='main'";
    const time = Date.now(), size = Math.max(1, Math.min(20, limit));
    await this.promoteQueuedChats(size);
    // Failure propagates through dependent jobs without restarting work in independent branches.
    const blocked = await this.db.prepare(`UPDATE runs SET status='failed',label='依赖未完成',error='前置任务失败或取消',error_code='DEPENDENCY_BLOCKED',updated_at=?
      WHERE status='queued' AND EXISTS(SELECT 1 FROM json_each(runs.payload,'$.batch.dependencies') dep
        JOIN runs prerequisite ON prerequisite.id=dep.value WHERE prerequisite.status IN ('failed','cancelled')) RETURNING id,parent_run_id,project_id`).bind(now()).all<{ id: string; parent_run_id: string; project_id: string }>();
    for (const row of blocked.results) await this.wakeForChildResult(row.parent_run_id, row.project_id);
    await this.promoteNestedTaskResults(size);
    await this.promoteTaskResults(size);
    const queues = await Promise.all([interactive, "NOT(" + interactive + ")"].map((lane) =>
      this.db.prepare("SELECT id,project_id,stage,status FROM runs WHERE (status IN ('queued','running','waiting') OR (status='cancelled' AND json_extract(payload,'$.providerTaskId') IS NOT NULL AND (json_extract(payload,'$.cancellation.state') IN ('checking','running') OR (json_extract(payload,'$.cancellation.state')='unknown' AND COALESCE(json_extract(payload,'$.cancellation.attempts'),0)<3)))) AND lease_until<? AND next_attempt_at<=? AND NOT " + dependencyPending + " AND NOT " + agentWaitBlocked + " AND " + lane + " ORDER BY next_attempt_at,created_at LIMIT ?")
        .bind(time, time, size).all<{ id: string; project_id: string; stage: Stage; status: string }>()));
    return queues.flatMap((rows, lane) => rows.results.map((r) => ({ id: r.id, projectId: r.project_id, stage: r.stage, cancellation: r.status === "cancelled", interactive: lane === 0 })));
  }
  async jobContext(id: string) {
    const row = await this.db.prepare("SELECT p.* FROM projects p JOIN runs r ON r.project_id=p.id WHERE r.id=?").bind(id).first<Row>();
    if (!row) throw new AppError("任务不存在", 404);
    return { project: projectRow(row), userId: String(row.user_id), run: await this.run(id, String(row.id)) };
  }
  async mediaArtifact(id: string, version?: number) {
    const row = await this.db.prepare("SELECT * FROM artifacts WHERE id=? AND kind IN ('image','video','audio','final')").bind(id).first<Row>();
    if (!row) throw new AppError("素材不存在", 404);
    if (version !== undefined) {
      const previous = await this.db.prepare("SELECT * FROM artifact_versions WHERE artifact_id=? AND version=?").bind(id, version).first<Row>();
      if (!previous) throw new AppError("素材版本不存在", 404);
      return artifactRow({ ...row, ...previous, id: row.id, project_id: row.project_id, path: previous.path ?? row.path, kind: previous.kind ?? row.kind });
    }
    return artifactRow(row);
  }
  async finishInspection(run: Run, result: { frames: (AgentImage & { timestamp: number })[]; [key: string]: unknown }) {
    const t = now();
    const statements = [this.db.prepare("UPDATE runs SET status='done',stage='done',progress=100,label='视频画面已读取',result_text=?,lease_until=0,error=NULL,error_code=NULL,updated_at=? WHERE id=? AND project_id=? AND lease_token=? AND status='running' AND stage='inspecting' AND NOT EXISTS(SELECT 1 FROM json_each(payload,'$.sourceVersions') v LEFT JOIN artifacts a ON a.id=v.key AND a.project_id=runs.project_id WHERE a.id IS NULL OR a.version<>CAST(v.value AS INTEGER))")
      .bind(json(result), t, run.id, run.projectId, run.leaseToken)];
    for (const frame of result.frames) {
      projectOutputPath(frame.path, "/03_图片");
      const url = "/api/studio/projects/" + run.projectId + "/media/" + frame.id;
      const metadata = json({ objectKey: frame.objectKey, contentType: frame.mediaType, bytes: frame.bytes, width: frame.width, height: frame.height, timestamp: frame.timestamp, sourceVersions: run.payload.sourceVersions });
      statements.push(this.db.prepare("INSERT INTO artifacts(id,project_id,path,kind,content,version,status,locked,url,metadata,created_at,updated_at) SELECT ?,?,?,'image','',1,'ready',0,?,?,?,? WHERE changes()=1")
        .bind(frame.id, run.projectId, frame.path, url, metadata, t, t),
        this.saveVersion({ id: frame.id, version: 1, content: "", path: frame.path, kind: "image", url, metadata, createdAt: t, runId: run.id }));
    }
    statements.push(this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'artifact',?,? WHERE changes()=1").bind(run.projectId, json({ runId: run.id, ids: result.frames.map((f) => f.id) }), t));
    const committed = await this.db.batch(statements);
    if (!committed[0].meta.changes) throw new AppError("任务已停止或视频已有新版本，未保存抽帧结果", 409, "RUN_STOPPED");
    if (run.parentRunId) await this.wakeForChildResult(run.parentRunId, run.projectId);
    return result;
  }
  async inspectionSequence(run: Run) {
    const row = await this.db.prepare("SELECT COUNT(*) AS sequence FROM runs WHERE project_id=? AND json_extract(payload,'$.inspection.sourceId')=? AND json_extract(payload,'$.inspection.sourceVersion')=? AND rowid<=(SELECT rowid FROM runs WHERE id=?)")
      .bind(run.projectId, run.payload.inspection!.sourceId, run.payload.inspection!.sourceVersion, run.id).first<{ sequence: number }>();
    return row?.sequence || 1;
  }
  async finishComposition(run: Run, objectKey: string, expectedVersion: number, expectedArtifactId?: string) {
    const operation = run.payload.operation;
    if (operation?.name !== "compose_video") throw new AppError("缺少合成任务的输出路径", 409, "MISSING_COMPOSITION");
    const outputPath = operation.path;
    const old = (await this.artifacts(run.projectId)).find((f) => f.path === outputPath);
    if (old?.locked) throw new AppError("成片已锁定", 409, "ARTIFACT_LOCKED");
    if (old?.id !== expectedArtifactId || (old?.version ?? 0) !== expectedVersion)
      throw new AppError("成片目标文件已变化，未覆盖现有文件", 409, "VERSION_CONFLICT");
    const id = old?.id || uid(), version = expectedVersion + 1, t = now();
    const output = run.payload.composition ? compositionOutput(run.payload.composition) : undefined;
    const metadata = json({ objectKey, contentType: "video/mp4", sourceVersions: run.payload.sourceVersions, composer: "ffmpeg", ...output });
    const url = "/api/studio/projects/" + run.projectId + "/media/" + id;
    const continuing = Boolean(run.payload.agent);
    const receipt = { id, path: outputPath, version, status: "ready", ...output };
    const payload = continuing ? productionFinished(run.payload, receipt, id) : run.payload;
    const journal = this.checkpoint(run, continuing ? payload : undefined, "tools/settled", operation.toolCallId);
    const guard = "EXISTS(SELECT 1 FROM runs r WHERE r.id=? AND r.project_id=? AND r.lease_token=? AND r.agent_revision=? AND r.status='running' AND r.stage='composing') AND NOT EXISTS(SELECT 1 FROM json_each((SELECT payload FROM runs WHERE id=?),'$.sourceVersions') v LEFT JOIN artifacts a ON a.id=v.key WHERE a.id IS NULL OR a.version<>CAST(v.value AS INTEGER))";
    const guardArgs = [run.id, run.projectId, run.leaseToken, journal.before, run.id];
    const mutation = old ? this.db.prepare("UPDATE artifacts SET content='',kind='final',version=?,status='ready',url=?,metadata=?,updated_at=? WHERE id=? AND version=? AND locked=0 AND " + guard)
      .bind(version, url, metadata, t, id, expectedVersion, ...guardArgs) :
      this.db.prepare("INSERT INTO artifacts(id,project_id,path,kind,content,version,status,locked,url,metadata,created_at,updated_at) SELECT ?,?,?,'final','',?,'ready',0,?,?,?,? WHERE " + guard)
        .bind(id, run.projectId, outputPath, version, url, metadata, t, t, ...guardArgs);
    const result = await this.db.batch([mutation,
      this.saveVersion({ id, version, content: "", path: outputPath, kind: "final", url, metadata, createdAt: t,
        runId: run.id, previousPath: old?.path }),
      this.db.prepare("UPDATE runs SET status=?,stage=?,progress=?,label=?,payload=?,agent_revision=?,result_text=?,error=NULL,error_code=NULL,attempts=0,next_attempt_at=0,lease_until=0,updated_at=? WHERE id=? AND changes()=1")
        .bind(continuing ? "queued" : "done", continuing ? "agent" : "done", continuing ? 0 : 100, continuing ? "继续整理" : "成片完成", json(journal.payload ?? payload), journal.revision, json(receipt), t, run.id),
      ...journal.statements,
      ...(continuing || run.parentRunId ? [] : [this.db.prepare("INSERT INTO messages(id,project_id,role,agent,content,run_id,artifact_ids,created_at) SELECT ?,?,'assistant','director','成片已保存。',NULL,?,? WHERE changes()=1").bind(uid(), run.projectId, json([id]), t)]),
      this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'artifact',?,? WHERE changes()=1").bind(run.projectId, json({ id, version, runId: run.id }), t),
      ...(run.parentRunId ? [this.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=? AND status IN ('queued','waiting')").bind(run.parentRunId)] : []),
    ]);
    if (!result[0].meta.changes) throw new AppError("任务已停止或源文件已修改，成片未覆盖现有版本", 409, "RUN_STOPPED");
    return this.artifact(id, run.projectId);
  }
  private workspaceCursor(projectId: string) {
    return this.db.prepare("SELECT id FROM events WHERE project_id=? ORDER BY id DESC LIMIT 1")
      .bind(projectId).rows<{ id: number }>()[0]?.id ?? 0;
  }
  private stepCounts(projectId: string, runIds?: string[]) {
    const rows = this.db.prepare(`
      WITH RECURSIVE tree(ancestor,id) AS (
        SELECT id,id FROM runs WHERE project_id=? ${runIds ? "AND id IN (" + jsonIds + ")" : ""}
        UNION ALL SELECT t.ancestor,r.id FROM tree t JOIN runs r ON r.parent_run_id=t.id
      )
      SELECT tree.ancestor AS run_id,COUNT(s.seq) AS count FROM tree JOIN execution_steps s ON s.run_id=tree.id GROUP BY tree.ancestor
    `).bind(projectId, ...(runIds ? [json(runIds)] : [])).rows<{ run_id: string; count: number }>();
    return Object.fromEntries(rows.map((row) => [row.run_id, row.count]));
  }
  private ancestors(projectId: string, runIds: string[]) {
    return this.db.prepare(`
      WITH RECURSIVE ancestors(id,parent_run_id) AS (
        SELECT id,parent_run_id FROM runs WHERE project_id=? AND id IN (${jsonIds})
        UNION SELECT r.id,r.parent_run_id FROM runs r JOIN ancestors a ON r.id=a.parent_run_id
      ) SELECT id,parent_run_id FROM ancestors
    `).bind(projectId, json(runIds)).rows<{ id: string; parent_run_id: string | null }>();
  }
  private readHistoryPage(projectId: string, sessionId: string, before?: number): HistoryPage {
    const size = 24;
    const roots = this.db.prepare("SELECT id,rowid AS position FROM runs WHERE project_id=? AND session_id=? AND parent_run_id IS NULL AND rowid<? ORDER BY rowid DESC LIMIT ?")
      .bind(projectId, sessionId, before ?? Number.MAX_SAFE_INTEGER, size + 1).rows<{ id: string; position: number }>();
    const oldest = roots[Math.min(roots.length, size) - 1];
    const pageRoots = roots.slice(0, size).map(({ id }) => id);
    const live = before === undefined ? this.db.prepare("SELECT id FROM runs WHERE project_id=? AND session_id=? AND parent_run_id IS NULL AND status IN ('queued','running','waiting')")
      .bind(projectId, sessionId).rows<{ id: string }>().map(({ id }) => id) : [];
    const rootIds = [...new Set([...pageRoots, ...live])];
    const runs = this.db.prepare(`WITH RECURSIVE tree(id) AS (
      SELECT id FROM runs WHERE id IN (${jsonIds}) UNION ALL SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id=t.id
    ) SELECT * FROM runs WHERE id IN (SELECT id FROM tree) ORDER BY parent_run_id IS NULL DESC,rowid DESC`)
      .bind(json(rootIds)).rows().map(workspaceRun);
    const ids = runs.map(({ id }) => id);
    const messages = this.db.prepare(`SELECT * FROM messages WHERE project_id=? AND session_id=? AND
      (run_id IN (${jsonIds}) OR (?=1 AND run_id IS NULL)) ORDER BY rowid`)
      .bind(projectId, sessionId, json(ids), before === undefined ? 1 : 0).rows().map(messageRow);
    const conversation = this.readConversation(projectId, ids, messages.map(({ id }) => id));
    for (const message of messages) message.eventSeq = conversation.messages.get(message.id);
    const steps = this.db.prepare(`SELECT ${stepColumns} FROM execution_steps WHERE project_id=? AND run_id IN (${jsonIds}) ORDER BY seq DESC LIMIT 200`)
      .bind(projectId, json(ids)).rows().reverse().map((row) => {
        const key = toolKey(String(row.run_id), String(row.call_id));
        return stepRow(row, (["wait_for_tasks", "job_output"].includes(String(row.name)) && row.finished_at ? conversation.toolSettlements.get(key) : undefined) ?? conversation.tools.get(key));
      });
    const changesByRun: Record<string, TurnFileChange[]> = {};
    for (const { runId, kind: _kind, ...change } of this.historyFileChanges(projectId, rootIds)) (changesByRun[runId] ??= []).push(change);
    return { messages, runs, steps, replies: conversation.replies, changesByRun,
      stepCounts: this.stepCounts(projectId, ids), deliveries: this.deliveries(projectId, sessionId, ids, true),
      historyBefore: roots.length > size ? oldest.position : undefined };
  }
  historyPage(projectId: string, sessionId: string, before: number) {
    return this.db.read(() => this.readHistoryPage(projectId, sessionId, before));
  }
  searchHistory(projectId: string, sessionId: string, query: string): HistoryMatch[] {
    const rows = this.db.prepare(`SELECT m.id,m.role,CASE WHEN m.content='' THEN '附件消息'
      ELSE substr(m.content,MAX(1,instr(lower(m.content),lower(?))-60),240) END AS snippet,
      r.rowid+1 AS before FROM messages m LEFT JOIN runs r ON r.id=m.run_id
      WHERE m.project_id=? AND m.session_id=? AND ((?='' AND m.role='user') OR (?<>'' AND instr(lower(m.content),lower(?))>0))
      ORDER BY m.rowid DESC LIMIT 50`)
      .bind(query, projectId, sessionId, query, query, query).rows<HistoryMatch>();
    return rows.map(({ before, ...match }) => ({ ...match, ...(before ? { before } : {}) }));
  }
  private readActiveBackgroundTasks(projectId: string, sessionId: string): ActiveBackgroundTask[] {
    return this.db.prepare(`SELECT id,project_id AS projectId,status,label,json_extract(payload,'$.operation.path') AS path
      FROM runs r WHERE project_id=? AND session_id=? AND background=1 AND status IN ('queued','running','waiting')
      AND ${currentAgent("r")} ORDER BY rowid DESC`).bind(projectId, sessionId).rows<ActiveBackgroundTask>().map((row) => ({ ...row }));
  }
  private readSnapshot(projectId: string, userId: string, cursor: number, sessionId: string): WorkspaceSnapshot {
    const project = this.readProject(projectId, userId);
    return { project, artifacts: this.readArtifacts(projectId), cursor, ...this.readHistoryPage(projectId, sessionId),
      chatQueue: this.readChatQueue(projectId, sessionId), sessionId, sessions: this.sessions(projectId),
      teamTasks: this.teamTasks(projectId, sessionId), activeBackgroundTasks: this.readActiveBackgroundTasks(projectId, sessionId) };
  }
  async snapshot(projectId: string, userId: string, sessionId = ""): Promise<WorkspaceSnapshot> {
    return this.db.read(() => this.readSnapshot(projectId, userId, this.workspaceCursor(projectId), sessionId));
  }
  /** Opening and incremental projections read the rows and their watermark from one SQLite view. */
  workspaceFrame(projectId: string, userId: string, after?: number, sessionId = ""): { frame: WorkspaceFrame | null; active: boolean } {
    return this.db.read(() => {
      const cursor = this.workspaceCursor(projectId);
      const active = Boolean(this.db.prepare("SELECT 1 FROM runs WHERE project_id=? AND session_id=? AND status IN ('queued','running') LIMIT 1").bind(projectId, sessionId).rows().length);
      if (after === undefined || after > cursor || (after !== 0 && !this.db.prepare("SELECT 1 FROM events WHERE id=? AND project_id=?").bind(after, projectId).rows().length)) {
        return { frame: { type: "snapshot", snapshot: this.readSnapshot(projectId, userId, cursor, sessionId) }, active };
      }
      return { frame: after === cursor ? null : this.readDelta(projectId, userId, after, cursor, sessionId), active };
    });
  }
  private readDelta(projectId: string, userId: string, after: number, cursor: number, sessionId: string): WorkspaceDelta {
    const changed = this.db.prepare(`
      SELECT type,CAST(json_extract(data,'$.id') AS TEXT) AS id FROM events
      WHERE project_id=? AND id>? AND id<=? AND type GLOB 'feed:*'
      GROUP BY type,CAST(json_extract(data,'$.id') AS TEXT)
    `).bind(projectId, after, cursor).rows<{ type: string; id: string }>();
    const keys = (entity: string) => changed.filter((row) => row.type === "feed:" + entity).map((row) => row.id);
    const delta: WorkspaceDelta = { type: "delta", projectId, after, cursor, ...(sessionId ? { sessionId } : {}) };
    if (keys("project").length) delta.project = this.readProject(projectId, userId);
    if (keys("chat-queue").length) delta.chatQueue = this.readChatQueue(projectId, sessionId);
    if (keys("sessions").length) delta.sessions = this.sessions(projectId);
    if (keys("delivery").length) delta.deliveries = this.deliveries(projectId, sessionId, keys("delivery"), false);
    if (keys("team").length) delta.teamTasks = this.teamTasks(projectId, sessionId);

    const artifacts = keys("artifact");
    if (artifacts.length) {
      const rows = this.db.prepare(`SELECT * FROM artifacts WHERE project_id=? AND id IN (${jsonIds})`)
        .bind(projectId, json(artifacts)).rows().map(artifactRow);
      delta.artifacts = rows.filter(({ path }) => !path.startsWith(PROJECT_TRASH));
      delta.removedArtifacts = rows.filter(({ path }) => path.startsWith(PROJECT_TRASH)).map(({ id }) => id);
    }
    const runs = keys("run");
    if (runs.length) delta.runs = this.db.prepare(`SELECT * FROM runs WHERE project_id=? AND session_id=? AND id IN (${jsonIds})`)
      .bind(projectId, sessionId, json(runs)).rows().map(workspaceRun);
    if (delta.runs?.some((run) => run.background)) delta.activeBackgroundTasks = this.readActiveBackgroundTasks(projectId, sessionId);

    const messages = keys("message");
    if (messages.length) delta.messages = this.db.prepare(`
      SELECT m.*,(SELECT MIN(e.id) FROM events e WHERE e.project_id=m.project_id AND e.type='message' AND json_extract(e.data,'$.id')=m.id) AS anchor
      FROM messages m WHERE m.project_id=? AND m.session_id=? AND m.id IN (${jsonIds}) ORDER BY m.rowid
    `).bind(projectId, sessionId, json(messages)).rows().map((row) => ({ ...messageRow(row), eventSeq: row.anchor == null ? undefined : Number(row.anchor) }));

    const replies = keys("reply");
    if (replies.length) {
      delta.replies = [];
      delta.removedReplies = [];
      const calls = this.db.prepare(`
        SELECT ${callColumns},(SELECT MIN(e.id) FROM events e WHERE e.project_id=r.project_id AND e.type='request' AND json_extract(e.data,'$.requestId')=c.id) AS anchor
        FROM model_calls c JOIN runs r ON r.id=c.run_id WHERE r.project_id=? AND r.session_id=? AND c.id IN (${jsonIds}) ORDER BY c.rowid
      `).bind(projectId, sessionId, json(replies)).rows();
      for (const row of calls) {
        const reply = projectReply(row, row.anchor == null ? undefined : Number(row.anchor));
        if (reply) delta.replies.push(reply);
        else delta.removedReplies.push(String(row.id));
      }
      if (!delta.replies.length) delete delta.replies;
      if (!delta.removedReplies.length) delete delta.removedReplies;
    }

    const steps = keys("step");
    if (steps.length) {
      const rows = this.db.prepare(`
        SELECT ${stepColumns},(SELECT CASE WHEN s.name IN ('wait_for_tasks','job_output') AND s.finished_at IS NOT NULL THEN MAX(e.id) ELSE MIN(e.id) END FROM events e WHERE e.project_id=s.project_id AND e.type='step'
          AND json_extract(e.data,'$.runId')=s.run_id AND json_extract(e.data,'$.callId')=s.call_id) AS anchor
        FROM execution_steps s WHERE s.project_id=? AND s.run_id IN (SELECT id FROM runs WHERE project_id=s.project_id AND session_id=?)
          AND s.seq IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) ORDER BY s.seq
      `).bind(projectId, sessionId, json(steps)).rows();
      const legacyAnchors = rows.some((row) => row.anchor == null) ? this.readConversation(projectId, [...new Set(rows.map((row) => String(row.run_id)))]).tools : undefined;
      delta.steps = rows.map((row) => stepRow(row, row.anchor == null ? legacyAnchors?.get(toolKey(String(row.run_id), String(row.call_id))) : Number(row.anchor)));
      delta.stepCounts = this.stepCounts(projectId, this.ancestors(projectId, delta.steps.map((step) => step.runId)).map((row) => row.id));
    }
    const changes = keys("changes");
    if (changes.length) {
      const owned = this.db.prepare(`SELECT id FROM runs WHERE project_id=? AND session_id=? AND id IN (${jsonIds})`)
        .bind(projectId, sessionId, json(changes)).rows<{ id: string }>().map(({ id }) => id);
      const roots = this.ancestors(projectId, owned).filter((row) => !row.parent_run_id);
      delta.changesByRun = Object.fromEntries(roots.map(({ id }) => [id, this.fileChanges(projectId, id).map(({ runId: _runId, kind: _kind, ...change }) => change)]));
    }
    return delta;
  }
  async getSettings(userId: string, encryptionSecret: string): Promise<ProviderSettings> {
    const row = await this.db.prepare("SELECT config,secrets FROM settings WHERE user_id=?").bind(userId).first<{ config: string; secrets: string }>();
    if (!row) return { ...DEFAULT_SETTINGS };
    return savedSettings(JSON.parse(row.config), await decryptSecrets(row.secrets, encryptionSecret));
  }
  async saveSettings(userId: string, input: Partial<ProviderSettings>, secret: string) {
    const row = await this.db.prepare("SELECT config,secrets FROM settings WHERE user_id=?").bind(userId).first<{ config: string; secrets: string }>();
    const old = row ? savedSettings(JSON.parse(row.config), await decryptSecrets(row.secrets, secret)) : DEFAULT_SETTINGS;
    const merged = mergeSettings(old, input);
    const { textApiKey, arkApiKey, minimaxApiKey, aiclubApiKey, ...config } = merged;
    const keys = { textApiKey, arkApiKey, minimaxApiKey, aiclubApiKey };
    const encrypted = Object.values(keys).some(Boolean) ? await encryptSecrets(keys, secret) : "";
    const saved = await this.db.prepare(`INSERT INTO settings VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET config=excluded.config,secrets=excluded.secrets,updated_at=excluded.updated_at
      WHERE settings.config=? AND settings.secrets=?`)
      .bind(userId, json(config), encrypted, now(), row?.config ?? null, row?.secrets ?? null).run();
    if (!saved.meta.changes) throw new AppError("模型设置已变化，请重新打开设置后再试。", 409, "SETTINGS_CHANGED");
    return merged;
  }
}
