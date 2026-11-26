import { sqliteTable, check, primaryKey, text, integer, uniqueIndex, index, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(), userId: text("user_id").notNull(), title: text("title").notNull(),
  brief: text("brief").notNull(), style: text("style").notNull(), ratio: text("ratio").notNull(),
  duration: integer("duration").notNull(), status: text("status").notNull(),
  isExample: integer("is_example").notNull().default(0),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
  mainSessionTitle: text("main_session_title").notNull().default("主对话"),
}, (t) => [index("projects_user_idx").on(t.userId),
  uniqueIndex("projects_one_example_per_user").on(t.userId).where(sql.raw("is_example = 1"))]);
export const chatQueue = sqliteTable("chat_queue", {
  projectId: text("project_id").notNull().references(() => projects.id),
  sessionId: text("session_id").notNull().default(""),
  requestId: text("request_id").notNull(),
  original: text("original").notNull(),
  scheduledFrame: text("scheduled_frame"),
  content: text("content").notNull(),
  attachments: text("attachments").notNull(),
  version: integer("version").notNull().default(1),
  status: text("status").notNull().default("pending"),
  targetRunId: text("target_run_id"),
  turnOrder: integer("turn_order"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [uniqueIndex("chat_queue_request").on(t.projectId, t.requestId),
  index("chat_queue_pending").on(t.status, t.projectId),
  index("chat_queue_current_turn").on(t.targetRunId, t.status, t.turnOrder),
  index("chat_queue_session_idx").on(t.projectId, t.sessionId, t.status)]);
export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id),
  path: text("path").notNull(), kind: text("kind").notNull(), content: text("content").notNull(),
  version: integer("version").notNull(), status: text("status").notNull(),
  locked: integer("locked").notNull().default(0), url: text("url"), metadata: text("metadata").notNull(),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (t) => [uniqueIndex("artifacts_project_path").on(t.projectId, t.path)]);
export const artifactVersions = sqliteTable("artifact_versions", {
  id: text("id").primaryKey(), artifactId: text("artifact_id").notNull().references(() => artifacts.id),
  version: integer("version").notNull(), content: text("content").notNull(), url: text("url"),
  metadata: text("metadata").notNull(), createdAt: text("created_at").notNull(),
  runId: text("run_id").references((): AnySQLiteColumn => runs.id),
  path: text("path"), previousPath: text("previous_path"), kind: text("kind"),
}, (t) => [uniqueIndex("artifact_version_unique").on(t.artifactId, t.version), index("artifact_versions_run_idx").on(t.runId)]);
export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id),
  sessionId: text("session_id").notNull().default(""),
  inherited: integer("inherited").notNull().default(0),
  role: text("role").notNull(), agent: text("agent"), content: text("content").notNull(),
  runId: text("run_id"), artifactIds: text("artifact_ids").notNull(), createdAt: text("created_at").notNull(),
  requestId: text("request_id"), attachments: text("attachments").notNull().default("[]"),
}, (t) => [index("messages_project_idx").on(t.projectId), uniqueIndex("messages_chat_request").on(t.projectId, t.requestId), index("messages_session_idx").on(t.projectId, t.sessionId)]);
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id),
  sessionId: text("session_id").notNull().default(""),
  intent: text("intent").notNull(), status: text("status").notNull(), stage: text("stage").notNull(),
  progress: integer("progress").notNull(), label: text("label").notNull(), error: text("error"),
  payload: text("payload").notNull(), leaseUntil: integer("lease_until").notNull().default(0),
  turnPreset: text("turn_preset"),
  leaseOwner: integer("lease_owner").notNull().default(0), leaseToken: text("lease_token").notNull().default(""),
  attempts: integer("attempts").notNull().default(0), nextAttemptAt: integer("next_attempt_at").notNull().default(0), errorCode: text("error_code"),
  parentRunId: text("parent_run_id").references((): AnySQLiteColumn => runs.id), agentRole: text("agent_role").notNull().default("main"),
  background: integer("background").notNull().default(0), agentRevision: integer("agent_revision").notNull().default(0),
  generation: integer("generation").notNull().default(1), inputVersion: integer("input_version").notNull().default(0),
  streamText: text("stream_text").notNull().default(""), resultText: text("result_text").notNull().default(""),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (t) => [index("runs_project_idx").on(t.projectId), index("runs_due_idx").on(t.status, t.nextAttemptAt, t.leaseUntil),
  index("runs_parent_idx").on(t.parentRunId),
  check("runs_background_boolean", sql`${t.background} IN (0,1)`),
  index("runs_background_project").on(t.projectId, t.createdAt, t.id).where(sql.raw("background=1")),
  index("runs_session_idx").on(t.projectId, t.sessionId),
  uniqueIndex("runs_one_active_per_session").on(t.projectId, t.sessionId).where(sql.raw("parent_run_id IS NULL AND status IN ('queued','running','waiting')"))]);
export const projectSessions = sqliteTable("project_sessions", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id),
  title: text("title").notNull(), createdAt: text("created_at").notNull(),
  forkRunId: text("fork_run_id").references(() => runs.id), seed: text("seed"),
  workingDirectory: text("working_directory"),
}, (t) => [index("project_sessions_project_idx").on(t.projectId)]);
export const deliveries = sqliteTable("deliveries", {
  id: text("id").primaryKey(), runId: text("run_id").notNull().references(() => runs.id), files: text("files").notNull(),
}, (t) => [index("deliveries_run_idx").on(t.runId)]);
export const teamTasks = sqliteTable("team_tasks", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id),
  sessionId: text("session_id").notNull().default(""), title: text("title").notNull(),
  detail: text("detail").notNull(), status: text("status").notNull(), revision: integer("revision").notNull().default(1),
  ownerId: text("owner_id").references(() => runs.id), ownerIsLead: integer("owner_is_lead").notNull().default(0),
  dependencies: text("dependencies").notNull(),
  createdAt: text("created_at").notNull(), writeScopes: text("write_scopes").notNull().default("[]"),
}, (t) => [index("team_tasks_session_idx").on(t.projectId, t.sessionId)]);
export const teamModes = sqliteTable("team_modes", {
  projectId: text("project_id").notNull().references(() => projects.id), sessionId: text("session_id").notNull(),
  enabled: integer("enabled").notNull(),
}, (t) => [primaryKey({ columns: [t.projectId, t.sessionId] })]);
export const sessionReferenceSnapshots = sqliteTable("session_reference_snapshots", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id),
  targetSessionId: text("target_session_id").notNull(), inputId: text("input_id").notNull(), sourceSessionId: text("source_session_id").notNull(),
  preview: text("preview").notNull(), totalLines: integer("total_lines").notNull(),
}, (t) => [uniqueIndex("session_reference_capture_idx").on(t.projectId, t.targetSessionId, t.inputId, t.sourceSessionId)]);
export const sessionReferenceLines = sqliteTable("session_reference_lines", {
  snapshotId: text("snapshot_id").notNull().references(() => sessionReferenceSnapshots.id, { onDelete: "cascade" }),
  line: integer("line").notNull(), text: text("text").notNull(),
}, (t) => [primaryKey({ columns: [t.snapshotId, t.line] })]);
export const providerFiles = sqliteTable("provider_files", {
  key: text("key").primaryKey(), fileId: text("file_id").notNull(), expiresAt: integer("expires_at").notNull(),
});
export const agentSessionEvents = sqliteTable("agent_session_events", {
  runId: text("run_id").notNull().references(() => runs.id), revision: integer("revision").notNull(),
  kind: text("kind").notNull(), reference: text("reference"), patch: text("patch").notNull(), createdAt: text("created_at").notNull(),
  eventSeq: integer("event_seq"),
}, (t) => [primaryKey({ columns: [t.runId, t.revision] }),
  check("session_revision_positive", sql`${t.revision}>0`), check("session_patch_valid", sql`json_valid(${t.patch})`)]);
export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }), projectId: text("project_id").notNull().references(() => projects.id),
  type: text("type").notNull(), data: text("data").notNull(), createdAt: text("created_at").notNull(),
}, (t) => [index("events_project_idx").on(t.projectId, t.id)]);
export const forkEventAncestry = sqliteTable("fork_event_ancestry", {
  eventId: integer("event_id").primaryKey().references(() => events.id),
  originEventId: integer("origin_event_id").notNull().references(() => events.id),
  rootRunId: text("root_run_id").notNull().references(() => runs.id),
});
export const settings = sqliteTable("settings", {
  userId: text("user_id").primaryKey(), config: text("config").notNull(),
  secrets: text("secrets").notNull(), updatedAt: text("updated_at").notNull(),
});
export const sessionPresets = sqliteTable("session_presets", {
  id: text("id").primaryKey(), userId: text("user_id").notNull(), data: text("data").notNull(),
});
export const sessionPresetBindings = sqliteTable("session_preset_bindings", {
  projectId: text("project_id").notNull().references(() => projects.id), sessionId: text("session_id").notNull(),
  data: text("data").notNull(),
}, (t) => [primaryKey({ columns: [t.projectId, t.sessionId] })]);
export const sessionPresetDefaults = sqliteTable("session_preset_defaults", {
  userId: text("user_id").primaryKey(), presetId: text("preset_id").notNull().references(() => sessionPresets.id, { onDelete: "cascade" }),
});
export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(), userId: text("user_id").notNull(), version: text("version").notNull(),
  config: text("config").notNull(), secrets: text("secrets").notNull(),
});
export const mcpCredentials = sqliteTable("mcp_credentials", {
  userId: text("user_id").notNull(), name: text("name").notNull(), secret: text("secret").notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.name] })]);
export const studioSchedules = sqliteTable("studio_schedules", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id),
  data: text("data").notNull(), status: text("status").notNull(), nextAt: integer("next_at"), version: integer("version").notNull().default(1),
  last: text("last"), sessionId: text("session_id"), updatedAt: text("updated_at"),
}, (t) => [index("studio_schedules_due").on(t.status, t.nextAt), index("studio_schedules_project").on(t.projectId)]);
export const studioScheduleDeliveries = sqliteTable("studio_schedule_deliveries", {
  seq: integer("seq").primaryKey({ autoIncrement: true }), scheduleId: text("schedule_id").notNull().references(() => studioSchedules.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(), at: integer("at").notNull(), data: text("data").notNull(),
}, (t) => [uniqueIndex("studio_schedule_delivery_request").on(t.scheduleId, t.requestId), index("studio_schedule_delivery_history").on(t.scheduleId, t.seq)]);
export const toolReceipts = sqliteTable("tool_receipts", {
  runId: text("run_id").notNull().references(() => runs.id), callId: text("call_id").notNull(),
  result: text("result").notNull(), createdAt: text("created_at").notNull(),
  concludesTurn: integer("concludes_turn").notNull().default(0),
  additionalContexts: text("additional_contexts"),
}, (t) => [uniqueIndex("tool_receipts_call").on(t.runId, t.callId)]);
export const agentInputs = sqliteTable("agent_inputs", {
  id: text("id").primaryKey(), runId: text("run_id").notNull().references(() => runs.id),
  content: text("content").notNull(), createdAt: text("created_at").notNull(), source: text("source"),
}, (t) => [index("agent_inputs_run_idx").on(t.runId)]);
export const agentInbox = sqliteTable("agent_inbox", {
  seq: integer("seq").primaryKey({ autoIncrement: true }), id: text("id").notNull(),
  projectId: text("project_id").notNull(), sessionId: text("session_id").notNull(), runId: text("run_id"),
  target: text("target").notNull(), wake: integer("wake").notNull(), kind: text("kind").notNull(),
  state: text("state").notNull(), content: text("content").notNull(), attachments: text("attachments"), source: text("source"),
  createdAt: text("created_at").notNull(),
}, (t) => [uniqueIndex("agent_inbox_id").on(t.projectId, t.id),
  index("agent_inbox_delivery").on(t.projectId, t.sessionId, t.runId, t.state, t.seq)]);
export const modelRequestParts = sqliteTable("model_request_parts", {
  id: text("id").primaryKey(), content: text("content").notNull(),
});
export const modelCalls = sqliteTable("model_calls", {
  id: text("id").primaryKey(), runId: text("run_id").notNull().references(() => runs.id),
  request: text("request").notNull(), status: text("status").notNull(),
  visibleText: text("visible_text").notNull().default(""), response: text("response"), usage: text("usage"),
  providerRequestId: text("provider_request_id"), error: text("error"), errorCode: text("error_code"),
  createdAt: text("created_at").notNull(), settledAt: text("settled_at"), firstOutputAt: text("first_output_at"), lastOutputAt: text("last_output_at"),
  offloadImages: integer("offload_images"),
  requestHeaderId: text("request_header_id").references(() => modelRequestParts.id),
}, (t) => [index("model_calls_run_idx").on(t.runId)]);
export const executionSteps = sqliteTable("execution_steps", {
  seq: integer("seq").primaryKey({ autoIncrement: true }), projectId: text("project_id").notNull().references(() => projects.id),
  runId: text("run_id").notNull().references(() => runs.id), callId: text("call_id").notNull(), name: text("name").notNull(),
  status: text("status").notNull(), arguments: text("arguments").notNull(), result: text("result"), summary: text("summary").notNull().default(""),
  startedAt: text("started_at").notNull(), finishedAt: text("finished_at"), dispatchedAt: text("dispatched_at"),
  requestId: text("request_id"), callIndex: integer("call_index"), providerCallId: text("provider_call_id"),
  outputRef: text("output_ref"), outputImages: text("output_images"),
}, (t) => [uniqueIndex("execution_steps_call").on(t.runId, t.callId), index("execution_steps_project").on(t.projectId, t.seq),
  index("execution_steps_output_ref").on(t.projectId, t.outputRef)]);

export const backgroundJobOutput = sqliteTable("background_job_output", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull().references(() => runs.id),
  line: text("line").notNull(),
  channel: text("channel", { enum: ["stdout", "stderr", "log"] }).notNull().default("stdout"),
  fragment: integer("fragment").notNull().default(0),
  createdAt: text("created_at").notNull(),
}, (t) => [index("background_job_output_cursor").on(t.jobId, t.seq)]);
export const backgroundJobReads = sqliteTable("background_job_reads", {
  jobId: text("job_id").notNull().references(() => runs.id),
  owner: text("owner").notNull(),
  cursor: integer("cursor").notNull(),
  terminal: text("terminal"),
  observedTerminal: text("observed_terminal"),
}, (t) => [primaryKey({ columns: [t.jobId, t.owner] })]);
export const backgroundJobTruncation = sqliteTable("background_job_truncation", {
  jobId: text("job_id").primaryKey().notNull().references(() => runs.id),
  throughSeq: integer("through_seq").notNull(),
});
export const backgroundWakeBudget = sqliteTable("background_wake_budget", {
  projectId: text("project_id").notNull().references(() => projects.id),
  sessionId: text("session_id").notNull(),
  owner: text("owner").notNull(),
  used: integer("used").notNull(),
  userSeq: integer("user_seq").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.projectId, t.sessionId, t.owner] })]);
export const diskWorkspaces = sqliteTable("disk_workspaces", {
  projectId: text("project_id").primaryKey().notNull().references(() => projects.id),
});
export const diskWorkspaceFiles = sqliteTable("disk_workspace_files", {
  projectId: text("project_id").notNull().references(() => diskWorkspaces.projectId),
  path: text("path").notNull(),
  artifactId: text("artifact_id").notNull().references(() => artifacts.id),
  version: integer("version").notNull(),
  stamp: text("stamp").notNull(),
}, (t) => [primaryKey({ columns: [t.projectId, t.path] })]);
