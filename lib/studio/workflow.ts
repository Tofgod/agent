import type { Database, SqlStatement } from "./storage";
import { AppError } from "./security";
import { agentIdentity } from "./agent-identity";
import type { ToolContinuation } from "./tool-registry";
import type { Run } from "./types";
import type { GoalEdit, GoalRound, Interaction, InteractionDecision, SessionGoal, Todo, WorkflowView } from "./workflow-types";
import { goalObjective, goalRoundLimit, goalToolValue, questionWaitSeconds } from "./workflow-types";

type GoalToolCommit = { id: string; continuation?: ToolContinuation };
type Scope = { projectId: string; sessionId?: string };
type Entry<T> = { seq: number; value: T; run_id: string | null };
type PlanState = { active: boolean; entered: boolean };
type Armed = { goalId: string; after: number };
type Selections = { armed: Map<string, Armed>; plan: Map<string, boolean>; commands: Map<string, Promise<string>>; grants: Set<string> };
const perDatabase = new WeakMap<Database, Selections>();
const key = (scope: Scope) => scope.projectId + ":" + (scope.sessionId ?? "");
const params = (scope: Scope) => [scope.projectId, scope.sessionId ?? ""];
const now = () => new Date().toISOString();
const active = "('queued','running','waiting')";
const emptyPlan: PlanState = { active: false, entered: false };
const interactionColumns = "id,run_id AS runId,call_id AS callId,generation,kind,state,data,deadline,hold_until AS holdUntil,answer";
type InteractionRow = Omit<Interaction, "questions" | "plan" | "decision"> & { data: string; answer: string | null };
const interaction = ({ data, answer, deadline, holdUntil, ...row }: InteractionRow): Interaction =>
  ({ ...row, ...JSON.parse(data), ...(answer ? { decision: JSON.parse(answer) } : {}), ...(deadline ? { deadline } : {}), ...(holdUntil ? { holdUntil } : {}) });
const writableRun = "EXISTS(SELECT 1 FROM runs WHERE id=? AND project_id=? AND lease_token=? AND input_version=? AND status='running')";
const runGuard = (run: Run) => [run.id, run.projectId, run.leaseToken, run.inputVersion];
const roundPrompt = (goal: SessionGoal, round: number) =>
  "<goal_round>\n目标：" + JSON.stringify(goal.objective) + "\n轮次：" + round + "/" + goal.maxGoalRounds +
  "\n根据工作区、已保存状态和工具回执继续同一目标。只有实际验证交付完成后才标记完成。需要用户决策时提出问题。遵循用户对创作范围和媒体生成的指示。\n</goal_round>";

export class SessionWorkflows {
  private selections: Selections;
  constructor(private db: Database, readonly maxGoalRounds = 256, readonly blockedAfterRounds = 3,
    readonly questionTimeout?: number, readonly parallelTodos = true, readonly defaultApprovalPolicy: "ask" | "never" = "ask") {
    goalRoundLimit.parse(maxGoalRounds);
    goalRoundLimit.parse(blockedAfterRounds);
    if (questionTimeout !== undefined) questionWaitSeconds.parse(questionTimeout);
    this.selections = perDatabase.get(db) ?? { armed: new Map(), plan: new Map(), commands: new Map(), grants: new Set() };
    perDatabase.set(db, this.selections);
  }

  private latest<T>(scope: Scope, kind: string, owner = "lead"): Entry<T> | undefined {
    const [row] = this.db.prepare(`SELECT seq,value,run_id FROM studio_workflow_events
      WHERE project_id=? AND session_id=? AND owner=? AND kind=? ORDER BY seq DESC LIMIT 1`)
      .bind(...params(scope), owner, kind).rows<{ seq: number; value: string; run_id: string | null }>();
    return row && { ...row, value: JSON.parse(row.value) };
  }

  private entry(scope: Scope, kind: string, value: unknown, owner = "lead", run?: Run, guard = "1", values: unknown[] = []) {
    return this.db.prepare(`INSERT INTO studio_workflow_events(project_id,session_id,owner,kind,value,run_id,generation,created_at)
      SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`).bind(...params(scope), owner, kind, JSON.stringify(value),
      run?.id ?? null, run?.generation ?? null, now(), ...values);
  }

  goal(scope: Scope) {
    const current = this.latest<SessionGoal | null>(scope, "goal/change");
    if (!current?.value) return null;
    const [round] = this.db.prepare(`SELECT MAX(CAST(json_extract(value,'$.round') AS INTEGER)) AS count FROM studio_workflow_events
      WHERE project_id=? AND session_id=? AND kind='goal/round' AND json_extract(value,'$.goalId')=? AND seq>?`)
      .bind(...params(scope), current.value.id, current.seq).rows<{ count: number | null }>();
    return { ...current.value, roundsStarted: Math.max(current.value.roundsStarted, round.count ?? 0) };
  }

  forkStatements(source: Run, sessionId: string, eventSeq: number): SqlStatement[] {
    const scope = { projectId: source.projectId, sessionId }, owner = agentIdentity(source);
    const latest = <T>(kind: string) => {
      const [row] = this.db.prepare(`SELECT value,seq FROM studio_workflow_events WHERE project_id=?
        AND session_id=? AND owner=? AND kind=? AND event_seq<=? ORDER BY seq DESC LIMIT 1`)
        .bind(...params(source), owner, kind, eventSeq).rows<{ value: string; seq: number }>();
      return row && { seq: row.seq, value: JSON.parse(row.value) as T };
    };
    const result: SqlStatement[] = [];
    const goal = latest<SessionGoal | null>("goal/change");
    if (!source.parentRunId && goal?.value) {
      const [round] = this.db.prepare(`SELECT MAX(CAST(json_extract(value,'$.round') AS INTEGER)) AS count FROM studio_workflow_events
        WHERE project_id=? AND session_id=? AND kind='goal/round' AND json_extract(value,'$.goalId')=? AND event_seq<=? AND seq>?`)
        .bind(...params(source), goal.value.id, eventSeq, goal.seq).rows<{ count: number | null }>();
      result.push(this.entry(scope, "goal/change", { ...goal.value, roundsStarted: Math.max(goal.value.roundsStarted, round.count ?? 0) }));
    }
    const plan = latest<PlanState>("plan/mode");
    if (plan) result.push(this.entry(scope, "plan/mode", plan.value));
    const policy = latest<"ask" | "never">("approval/policy");
    if (policy) result.push(this.entry(scope, "approval/policy", policy.value));
    const [todo] = this.db.prepare(`SELECT value FROM studio_workflow_events WHERE project_id=? AND session_id=? AND owner=?
      AND kind='todo/write' AND run_id=? AND event_seq<=? ORDER BY seq DESC LIMIT 1`)
      .bind(...params(source), owner, source.id, eventSeq).rows<{ value: string }>();
    if (todo) result.push(this.entry(scope, "todo/write", JSON.parse(todo.value)));
    return result;
  }

  async createGoal(scope: Scope, objective: string, maxGoalRounds = this.maxGoalRounds, run?: Run, toolCall?: GoalToolCommit) {
    const current = this.goal(scope);
    if (current && current.phase !== "complete") throw new AppError("已有目标，请编辑或清除后再创建", 409, "GOAL_EXISTS");
    const time = now();
    const goal: SessionGoal = { id: crypto.randomUUID(), revision: 1, objective: goalObjective.parse(objective),
      phase: "active", roundsStarted: 0, maxGoalRounds: goalRoundLimit.parse(maxGoalRounds), createdAt: time, updatedAt: time };
    await this.changeGoal(scope, goal, true, run, toolCall);
    return goal;
  }

  async updateGoal(scope: Scope, input: GoalEdit, run?: Run, toolCall?: GoalToolCommit) {
    const goal = this.goal(scope);
    if (!goal || goal.id !== input.goal_id || goal.revision !== input.revision)
      throw new AppError("目标已经变化，请重新读取", 409, "GOAL_STALE");
    const invalid = () => new AppError("当前目标状态不支持这项操作", 409, "GOAL_TRANSITION");
    const edit = input.action === "edit", block = input.action === "blocked";
    if ((!edit && (input.objective !== undefined || input.max_goal_rounds !== undefined)) || (block !== Boolean(input.blocked_reason)) ||
      (edit && input.objective === undefined && input.max_goal_rounds === undefined)) throw invalid();
    if (input.action === "clear") return this.changeGoal(scope, null, false, run);
    const armed = this.isArmed(scope, goal);
    const next = { ...goal, revision: goal.revision + 1, updatedAt: [goal.updatedAt, now()].sort()[1] };
    switch (input.action) {
      case "edit":
        next.objective = input.objective ?? goal.objective;
        next.maxGoalRounds = input.max_goal_rounds ?? goal.maxGoalRounds;
        break;
      case "resume":
        if (goal.phase === "complete" || armed || goal.roundsStarted >= goal.maxGoalRounds || run && goal.phase === "paused") throw invalid();
        next.phase = "active"; delete next.blockedReason;
        break;
      case "pause":
        if (goal.phase !== "active") throw invalid();
        next.phase = "paused"; break;
      case "complete":
        if (goal.phase === "complete") throw invalid();
        next.phase = "complete"; delete next.blockedReason; break;
      case "blocked":
        if (goal.phase !== "active") throw invalid();
        next.phase = "blocked"; next.blockedReason = input.blocked_reason; break;
    }
    return this.changeGoal(scope, next, input.action === "resume" || edit && armed, run, toolCall);
  }

  private async changeGoal(scope: Scope, next: SessionGoal | null, arm: boolean, run?: Run, toolCall?: GoalToolCommit) {
    const previous = this.latest<SessionGoal | null>(scope, "goal/change")?.seq ?? 0;
    const [result] = await this.db.batch([
      this.entry(scope, "goal/change", next, "lead", run,
        `COALESCE((SELECT MAX(seq) FROM studio_workflow_events
          WHERE project_id=? AND session_id=? AND owner='lead' AND kind='goal/change'),0)=?` + (run ? " AND " + writableRun : "")
        + (run && toolCall ? " AND NOT EXISTS(SELECT 1 FROM tool_receipts WHERE run_id=? AND call_id=?)" : ""),
        [...params(scope), previous, ...(run ? runGuard(run) : []), ...(run && toolCall ? [run.id, toolCall.id] : [])]),
      ...(run && toolCall ? [this.db.prepare(`INSERT INTO tool_receipts(run_id,call_id,result,created_at,concludes_turn,additional_contexts)
        SELECT ?,?,?,?,?,? WHERE changes()=1`).bind(run.id, toolCall.id, JSON.stringify(goalToolValue(next, arm)), now(),
          toolCall.continuation?.concludesTurn ? 1 : 0, JSON.stringify(toolCall.continuation?.additionalContexts ?? []))] : []),
    ]);
    if (!result.meta.changes) throw new AppError("目标或当前轮次已经变化", 409, "GOAL_STALE");
    if (arm && next) this.selections.armed.set(key(scope), { goalId: next.id, after: result.meta.last_row_id! });
    else this.selections.armed.delete(key(scope));
    return next;
  }

  isArmed(scope: Scope, goal: SessionGoal) {
    return goal.phase === "active" && this.selections.armed.get(key(scope))?.goalId === goal.id;
  }

  activeGoalRun(scope: Scope, goalId: string) {
    const [row] = this.db.prepare(`SELECT id FROM runs WHERE project_id=? AND session_id=?
      AND parent_run_id IS NULL AND status IN ${active} AND json_extract(payload,'$.goalRound.goalId')=?`)
      .bind(...params(scope), goalId).rows<{ id: string }>();
    return row?.id;
  }

  async runCommand(scope: Scope, requestId: string, action: () => Promise<string>) {
    const type = "command/" + requestId, namespace = key(scope) + ":" + requestId;
    const existing = this.latest<string>(scope, type);
    if (existing) return existing.value;
    const pending = this.selections.commands.get(namespace);
    if (pending) return pending;
    const command = action().then(async (result) => { await this.entry(scope, type, result).run(); return result; });
    this.selections.commands.set(namespace, command);
    try { return await command; } finally { this.selections.commands.delete(namespace); }
  }

  async driveGoals(limit: number) {
    let queued = 0;
    for (const scopeKey of this.selections.armed.keys()) {
      if (queued >= limit) break;
      const [projectId, sessionId] = scopeKey.split(":");
      const scope = { projectId, sessionId }, goal = this.goal(scope);
      const armed = this.selections.armed.get(scopeKey);
      if (!goal || !armed || !this.isArmed(scope, goal)) { this.selections.armed.delete(scopeKey); continue; }
      const [latest] = this.db.prepare(`SELECT status,error_code,id,owner FROM (
        SELECT r.status,r.error_code,r.id,
          json_extract(r.payload,'$.goalRound.goalId') AS owner
        FROM runs r WHERE r.project_id=? AND r.session_id=? AND r.parent_run_id IS NULL
        AND EXISTS(SELECT 1 FROM studio_workflow_events a WHERE a.seq=? AND (r.created_at>=a.created_at OR r.id=a.run_id))
        AND json_extract(r.payload,'$.inherited') IS NOT 1
        ORDER BY r.rowid DESC LIMIT 1)`).bind(...params(scope), armed.after)
        .rows<{ status: string; error_code: string | null; id: string; owner: string | null }>();
      if (latest && (["failed", "cancelled", "paused"].includes(latest.status) && latest.error_code !== "GOAL_STALE" || latest.error_code === "MODEL_TRUNCATED")) {
        if (latest.owner === goal.id && ["cancelled", "paused"].includes(latest.status))
          await this.updateGoal(scope, { goal_id: goal.id, revision: goal.revision, action: "pause" });
        else {
          this.selections.armed.delete(scopeKey);
          await this.entry(scope, "goal/disarmed", { reason: latest.error_code ?? latest.status }).run();
        }
        continue;
      }
      if (latest && ["queued", "running", "waiting"].includes(latest.status)) continue;
      const idle = `EXISTS(SELECT 1 FROM projects WHERE id=? AND status<>'archived')
        AND NOT EXISTS(SELECT 1 FROM session_management WHERE project_id=? AND session_id=? AND archived=1)
        AND NOT EXISTS(SELECT 1 FROM runs WHERE project_id=? AND session_id=? AND status IN ${active} AND background=0
          AND json_extract(payload,'$.inherited') IS NOT 1 AND json_extract(payload,'$.imported') IS NOT 1)
        AND NOT EXISTS(SELECT 1 FROM chat_queue WHERE project_id=? AND session_id=? AND status='pending')`;
      const idleValues = [projectId, ...params(scope), ...params(scope), ...params(scope)];
      if (!this.db.prepare("SELECT 1 WHERE " + idle).bind(...idleValues).rows().length) continue;
      if (goal.roundsStarted >= goal.maxGoalRounds) {
        await this.updateGoal(scope, { goal_id: goal.id, revision: goal.revision, action: "blocked",
          blocked_reason: { code: "round-limit", message: "已达到目标续轮上限" } });
        continue;
      }
      const round = goal.roundsStarted + 1, id = crypto.randomUUID(), prompt = roundPrompt(goal, round);
      const source: GoalRound = { goalId: goal.id, revision: goal.revision, round };
      if (await this.openTurn(scope, id, prompt, "目标续轮", { goalRound: source }, { kind: "goal-round", ...source }, idle, idleValues, "目标续轮 " + round + "/" + goal.maxGoalRounds)) queued++;
    }
  }

  private async openTurn(...args: Parameters<SessionWorkflows["turnStatements"]>) {
    const [inserted] = await this.db.batch(this.turnStatements(...args));
    return Boolean(inserted.meta.changes);
  }

  private turnStatements(scope: Scope, id: string, content: string, label: string, payload: object, source: object, guard: string, guardValues: unknown[], visible = content) {
    const time = now(), userId = crypto.randomUUID(), replyId = crypto.randomUUID();
    return [
      this.db.prepare(`INSERT INTO runs(id,project_id,session_id,intent,status,stage,progress,label,payload,created_at,updated_at)
        SELECT ?,?,?,'agent','queued','agent',0,?,?,?,? WHERE ${guard}`)
        .bind(id, ...params(scope), label, JSON.stringify({ instruction: content, sourceVersions: {}, ...payload }), time, time, ...guardValues),
      this.db.prepare(`INSERT INTO messages(id,project_id,session_id,role,agent,content,run_id,artifact_ids,created_at)
        SELECT ?,?,?,'user',NULL,?,?,'[]',? WHERE changes()=1`).bind(userId, ...params(scope), visible, id, time),
      this.db.prepare("UPDATE agent_inbox SET content=?,source=? WHERE project_id=? AND id=? AND changes()=1")
        .bind(content, JSON.stringify(source), scope.projectId, userId),
      this.messageEvent(scope.projectId, userId, time),
      this.db.prepare(`INSERT INTO messages(id,project_id,session_id,role,agent,content,run_id,artifact_ids,created_at)
        SELECT ?,?,?,'assistant','main','',?,'[]',? WHERE EXISTS(SELECT 1 FROM runs WHERE id=?)`).bind(replyId, ...params(scope), id, time, id),
      this.messageEvent(scope.projectId, replyId, time),
    ];
  }

  private messageEvent(projectId: string, id: string, time: string) {
    return this.db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'message',json_object('id',?),? WHERE changes()=1")
      .bind(projectId, id, time);
  }

  isGoalRoundAdmitted(run: Run) {
    return Boolean(this.db.prepare("SELECT 1 FROM studio_workflow_events WHERE run_id=? AND kind='goal/round'").bind(run.id).rows().length);
  }

  goalAdmission(run: Run, requestId: string): SqlStatement[] {
    const attempt = run.payload.goalRound;
    if (!attempt || this.isGoalRoundAdmitted(run)) return [];
    const current = this.goal(run);
    if (this.hasCompetingInput(run)) return [];
    if (!current || !this.isArmed(run, current) || current.id !== attempt.goalId || current.revision !== attempt.revision ||
        current.roundsStarted + 1 !== attempt.round || attempt.round > current.maxGoalRounds)
      throw new AppError("目标已变化或需要恢复", 409, "GOAL_STALE");
    return [this.entry(run, "goal/round", attempt, "lead", run, "EXISTS(SELECT 1 FROM model_calls WHERE id=?)", [requestId])];
  }

  plan(scope: Scope, owner = "lead") { return this.latest<PlanState>(scope, "plan/mode", owner)?.value ?? emptyPlan; }

  selectedPlan(scope: Scope, owner = "lead") { return this.selections.plan.get(key(scope) + ":" + owner) ?? this.plan(scope, owner).active; }

  async setPlan(scope: Scope, selected: boolean, run?: Run) {
    const owner = run ? agentIdentity(run) : "lead";
    const current = this.plan(scope, owner);
    const namespace = key(scope) + ":" + owner;
    if ((this.selections.plan.get(namespace) ?? current.active) === selected) return;
    // Queuing a user message reserves a run, but a plan selection is deferred
    // only inside an actual open turn.
    const [open] = this.db.prepare(`SELECT e.type FROM events e JOIN runs r
      ON r.project_id=e.project_id AND r.id=json_extract(e.data,'$.runId')
      WHERE e.project_id=? AND r.session_id=? AND
        ${run?.parentRunId ? "r.id=?" : "r.parent_run_id IS NULL"}
        AND e.type IN ('turn/start','turn/end') AND json_extract(r.payload,'$.inherited') IS NOT 1
      ORDER BY e.id DESC LIMIT 1`)
      .bind(...params(scope), ...(run?.parentRunId ? [run.id] : [])).rows<{ type: string }>();
    if (open?.type === "turn/start") {
      const change = await this.entry(scope, "plan/selection", selected, owner, run,
        run ? writableRun : "1", run ? runGuard(run) : []).run();
      if (!change.meta.changes) throw new AppError("计划模式未切换，当前步骤已变化", 409, "AGENT_STEER");
      if (current.active === selected) this.selections.plan.delete(namespace);
      else this.selections.plan.set(namespace, selected);
      return;
    }
    if (current.active !== selected)
      await this.entry(scope, "plan/mode", { active: selected, entered: current.entered || selected }, owner).run();
    this.selections.plan.delete(namespace);
  }

  planAdmission(run: Run, planned: boolean | undefined) {
    if (planned === undefined) return;
    const owner = agentIdentity(run), namespace = key(run) + ":" + owner;
    const pending = this.selections.plan.get(namespace);
    const current = this.plan(run, owner);
    if ((pending ?? current.active) !== planned)
      throw new AppError("计划模式已变化，重新组装本步模型请求", 409, "AGENT_STEER");
    if (pending === undefined) return;
    return {
      statement: this.entry(run, "plan/mode", { active: pending, entered: current.entered || pending },
        owner, run, "changes()=1"),
      committed: () => { if (pending === this.selections.plan.get(namespace)) this.selections.plan.delete(namespace); },
    };
  }

  approvalPolicy(scope: Scope) {
    return this.latest<"ask" | "never">(scope, "approval/policy")?.value ?? this.defaultApprovalPolicy;
  }

  async requireApproval(run: Run, callId: string, toolName: string, reason: string): Promise<{ waitForInteraction: string } | { outcome: "allowed-once" | "rejected" | "cancelled" }> {
    const never = this.approvalPolicy(run) === "never";
    const asked = this.findInteraction(run.id, callId) ?? await this.requestInteraction(run, callId, "approval", { toolName, questions: [{
      id: "approval", header: "工具审批", question: reason, options: [{ label: "允许一次" }, { label: "拒绝" }],
    }] }, undefined, never);
    if (asked.generation !== run.generation || asked.state === "cancelled" || asked.state === "dismissed")
      return { outcome: "cancelled" as const };
    if (asked.state === "waiting") return { waitForInteraction: asked.id };
    if (asked.decision?.action === "answer" && asked.decision.answers[0]?.selected[0] === "允许一次")
      return { outcome: this.selections.grants.delete(asked.id) ? "allowed-once" : "cancelled" };
    return { outcome: "rejected" };
  }

  async setApprovalPolicy(scope: Scope, policy: "ask" | "never") {
    if (this.approvalPolicy(scope) === policy) return;
    await this.entry(scope, "approval/policy", policy).run();
  }

  async recoverInterruption() {
    await this.db.batch([
      this.db.prepare("UPDATE studio_interactions SET hold_until=NULL WHERE hold_until IS NOT NULL"),
      this.db.prepare(`UPDATE studio_interactions SET state='cancelled' WHERE state='waiting'
        AND (kind IN ('approval','plan') OR deadline IS NULL)`),
      this.db.prepare(`UPDATE runs SET status='failed',error_code='GOAL_STALE',error='进程重启后，目标需要手动恢复',
        label='目标待恢复',lease_until=0,updated_at=? WHERE status IN ${active} AND parent_run_id IS NULL
        AND json_type(payload,'$.goalRound')='object'
        AND NOT EXISTS(SELECT 1 FROM agent_inbox i WHERE i.run_id=runs.id AND i.kind='user' AND i.source IS NULL)`).bind(now()),
    ]);
  }

  hasCompetingInput(run: Run) {
    return this.db.prepare(`SELECT 1 FROM agent_inbox i WHERE i.project_id=? AND i.session_id=?
      AND ((i.run_id=? AND i.kind='user' AND i.source IS NULL) OR (i.kind='queue' AND i.state='pending')) LIMIT 1`)
      .bind(...params(run), run.id).rows().length > 0;
  }

  async rejectGoalRound(run: Run) {
    const goal = this.goal(run), attempt = run.payload.goalRound;
    if (!goal || !attempt || goal.id !== attempt.goalId || goal.revision !== attempt.revision || !this.isArmed(run, goal)) return;
    await this.updateGoal(run, { goal_id: goal.id, revision: goal.revision, action: "blocked",
      blocked_reason: { code: "prompt-rejected", message: "目标提示在进入模型步骤前被拒绝" } }, run);
  }

  async writeTodos(run: Run, callId: string, todos: Todo[]) {
    const count = (status: Todo["status"]) => todos.filter((todo) => todo.status === status).length;
    const result = { todos, counts: { pending: count("pending"), inProgress: count("in_progress"), completed: count("completed") } };
    const [write] = await this.db.batch([
      this.entry(run, "todo/write", todos, agentIdentity(run), run, writableRun +
        " AND NOT EXISTS(SELECT 1 FROM tool_receipts WHERE run_id=? AND call_id=?)", [...runGuard(run), run.id, callId]),
      this.db.prepare("INSERT INTO tool_receipts(run_id,call_id,result,created_at) SELECT ?,?,?,? WHERE changes()=1")
        .bind(run.id, callId, JSON.stringify(result), now()),
    ]);
    if (!write.meta.changes) throw new AppError("此轮待办已经结算或收到新消息", 409, "AGENT_STEER");
    return result;
  }

  findInteraction(runId: string, callId: string) {
    const [row] = this.db.prepare("SELECT " + interactionColumns + " FROM studio_interactions WHERE run_id=? AND call_id=?")
      .bind(runId, callId).rows<InteractionRow>();
    return row ? interaction(row) : undefined;
  }

  async requestInteraction(run: Run, callId: string, kind: Interaction["kind"], data: Pick<Interaction, "questions" | "plan" | "toolName">, deadline?: number, autoReject = false) {
    if (run.parentRunId && kind !== "approval") throw new AppError("请把需要用户决定的问题交给主智能体", 403, "DELEGATED_CALLER");
    const id = crypto.randomUUID();
    await this.db.prepare(`INSERT INTO studio_interactions(id,project_id,session_id,run_id,generation,call_id,kind,state,data,deadline)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${writableRun} ON CONFLICT(run_id,call_id) DO NOTHING`)
      .bind(id, ...params(run), run.id, run.generation, callId, kind, autoReject ? "answered" : "waiting", JSON.stringify(data), deadline ?? null, ...runGuard(run)).run();
    const asked = this.findInteraction(run.id, callId);
    if (!asked || asked.generation !== run.generation) throw new AppError("任务已停止或收到新输入", 409, "AGENT_STEER");
    return asked;
  }

  async transitionInteraction(id: string, from: Interaction["state"], to: Interaction["state"]) {
    const expiration = to === "pending" ? " AND MAX(deadline,COALESCE(hold_until,0))<=?" : "";
    await this.db.prepare("UPDATE studio_interactions SET state=? WHERE id=? AND state=?" + expiration)
      .bind(to, id, from, ...(expiration ? [Date.now()] : [])).run();
  }

  planReviewClosedForChat(runId: string) {
    return this.db.prepare(`SELECT 1 FROM studio_interactions i JOIN runs r ON r.id=i.run_id
      WHERE i.run_id=? AND i.generation=r.generation AND i.kind='plan' AND i.state='dismissed'
        AND json_extract(i.answer,'$.action')='dismiss' LIMIT 1`).bind(runId).rows().length > 0;
  }

  async holdQuestion(scope: Scope, id: string) {
    const time = Date.now();
    await this.db.prepare(`UPDATE studio_interactions SET hold_until=? WHERE project_id=? AND session_id=? AND id=?
      AND kind='question' AND deadline IS NOT NULL AND state='waiting' AND MAX(deadline,COALESCE(hold_until,0))>?`)
      .bind(time + 12_000, ...params(scope), id, time).run();
  }

  async decide(scope: Scope, id: string, decision: InteractionDecision) {
    const [row] = this.db.prepare("SELECT " + interactionColumns + " FROM studio_interactions WHERE project_id=? AND session_id=? AND id=?")
      .bind(...params(scope), id).rows<InteractionRow>();
    if (!row) throw new AppError("问题不存在", 404, "INTERACTION_NOT_FOUND");
    const item = interaction(row), encoded = JSON.stringify(decision);
    if ((row.state === "answered" || row.state === "dismissed") && row.answer === encoded) return;
    if (row.state !== "waiting" && row.state !== "pending") throw new AppError("问题已经结算", 409, "INTERACTION_SETTLED");
    if (decision.action === "answer") {
      const byId = new Map(decision.answers.map((answer) => [answer.id, answer]));
      const legal = byId.size === decision.answers.length && byId.size === item.questions.length && decision.answers.every(({ id, selected }) => {
        const question = item.questions.find((question) => question.id === id);
        return question && (question.multi_select || selected.length <= 1) && new Set(selected).size === selected.length &&
          selected.every((label) => question.options?.some((option) => option.label === label));
      });
      if (!legal || item.kind !== "question" && (!decision.answers[0]?.selected.length || decision.answers.length !== 1))
        throw new AppError("回答和问题选项不匹配", 400, "INTERACTION_ANSWER_INVALID");
    }
    const update = this.db.prepare("UPDATE studio_interactions SET state=?,answer=? WHERE id=? AND state=?")
      .bind(decision.action === "answer" ? "answered" : "dismissed", encoded, id, item.state);
    const [updated] = await this.db.batch([
      update,
      ...(item.state === "pending" && decision.action === "answer"
        ? this.lateAnswerStatements(scope, item, decision.answers)
        : item.state === "waiting" ? [this.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=? AND generation=? AND changes()=1")
          .bind(item.runId, item.generation)] : []),
    ]);
    if (!updated.meta.changes) throw new AppError("问题状态已经变化", 409, "INTERACTION_SETTLED");
    if (item.kind === "approval" && decision.action === "answer" && decision.answers[0]?.selected[0] === "允许一次")
      this.selections.grants.add(id);
  }

  private lateAnswerStatements(scope: Scope, item: Interaction, answers: Extract<InteractionDecision, { action: "answer" }>["answers"]) {
    const source = { kind: "answer_to_pending_question", tool: "ask_user_question", callId: item.callId, questions: item.questions };
    const content = JSON.stringify({ ...source, answers });
    const [current] = this.db.prepare(`SELECT id,intent FROM runs WHERE project_id=? AND session_id=? AND parent_run_id IS NULL
      AND status IN ${active} LIMIT 1`).bind(...params(scope)).rows<{ id: string; intent: string }>();
    if (!current) return this.turnStatements(scope, crypto.randomUUID(), content, "收到问题回答", {}, source,
      "changes()=1", [], "已回答智能体的问题");
    const timestamp = now(), messageId = crypto.randomUUID();
    if (current.intent !== "agent") return [
      this.db.prepare(`INSERT INTO chat_queue(project_id,session_id,request_id,original,content,attachments,created_at,updated_at,workflow_reply)
        SELECT ?,?,?,?,?, '[]',?,?,? WHERE changes()=1`)
        .bind(...params(scope), item.id, JSON.stringify(["已回答智能体的问题", []]), "已回答智能体的问题",
          timestamp, timestamp, JSON.stringify({ source, content })),
    ];
    return [
      this.db.prepare(`INSERT INTO messages(id,project_id,session_id,role,agent,content,run_id,artifact_ids,created_at)
        SELECT ?,?,?,'user',NULL,?,?,'[]',? WHERE changes()=1`)
        .bind(messageId, ...params(scope), "已回答智能体的问题", current.id, timestamp),
      this.db.prepare("UPDATE agent_inbox SET content=?,source=? WHERE project_id=? AND id=? AND changes()=1")
        .bind(content, JSON.stringify(source), scope.projectId, messageId),
      this.db.prepare("UPDATE runs SET input_version=input_version+1,next_attempt_at=0 WHERE id=? AND changes()=1")
        .bind(current.id),
      this.messageEvent(scope.projectId, messageId, timestamp),
    ];
  }

  view(scope: Scope): WorkflowView {
    const goal = this.goal(scope), plan = this.plan(scope);
    const pending = this.selectedPlan(scope) !== plan.active;
    const [turn] = this.db.prepare(`SELECT r.id,json_extract(e.data,'$.turn') AS generation FROM events e
      JOIN runs r ON r.id=json_extract(e.data,'$.runId') AND r.project_id=e.project_id
      WHERE e.project_id=? AND r.session_id=? AND e.type='turn/start' AND r.parent_run_id IS NULL
        AND json_extract(r.payload,'$.inherited') IS NOT 1 ORDER BY e.id DESC LIMIT 1`)
      .bind(...params(scope)).rows<{ id: string; generation: number }>();
    const todos = this.latest<Todo[]>(scope, "todo/write");
    const list = todos?.run_id === turn?.id && turn && todos
      ? this.db.prepare("SELECT generation FROM studio_workflow_events WHERE seq=?").bind(todos.seq).rows<{ generation: number }>() : [];
    const interactions = this.db.prepare("SELECT " + interactionColumns + " FROM studio_interactions WHERE project_id=? AND session_id=? AND state IN ('waiting','pending') ORDER BY rowid")
      .bind(...params(scope)).rows<InteractionRow>().map(interaction);
    return { goal: goal ? { ...goal, armed: this.isArmed(scope, goal) } : null, plan: { active: plan.active, pending },
      todos: (list[0]?.generation === turn?.generation || !turn && todos?.run_id === null) ? todos?.value ?? null : null, interactions };
  }
}
