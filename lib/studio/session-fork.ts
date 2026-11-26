import type { Database } from "./storage";
import type { ProjectSession, RunPayload, RunStatus, Stage } from "./types";

interface ForkRun {
  id: string; parent_run_id: string | null; intent: string; agent_role: string; status: RunStatus; stage: Stage;
  label: string; progress: number; payload: string; background: number; result_text: string; error: string | null;
  agent_revision: number; turn_preset: string | null; created_at: string; updated_at: string; revision_at_cut: number | null; last_seq: number | null;
}
type ForkChange = NonNullable<RunPayload["forkChanges"]>[number] & { runId: string };
const selectedIds = "SELECT value FROM json_each(?)";
export const committedRunEvent = "e.type NOT IN ('run','stream','run/registered','run/last-state') AND e.type NOT LIKE 'feed:%'";
const runEventSequences = `
  SELECT json_extract(data,CASE WHEN type='feed:run' THEN '$.id' ELSE '$.runId' END) AS run_id,
    MIN(id) FILTER (WHERE type='run/registered') AS registered,
    MAX(id) FILTER (WHERE type='run/last-state') AS last_state,
    MIN(id) FILTER (WHERE type='feed:run') AS first_feed,
    MAX(id) FILTER (WHERE type='feed:run') AS last_feed
  FROM events WHERE project_id=? AND type IN ('feed:run','run/registered','run/last-state') GROUP BY run_id`;
const liveRun = "json_extract(r.payload,'$.imported') IS NOT 1 AND json_extract(r.payload,'$.inherited') IS NOT 1";
const registrationSequence = `COALESCE(b.registered,CASE WHEN ${liveRun} THEN b.first_feed END)`;
const lastStateSequence = `COALESCE(b.last_state,CASE WHEN ${liveRun} THEN b.last_feed END)`;

// Feed events created while restoring rows are new writes. Keep the original boundaries in the copied timeline.
export const runBoundaries = `WITH run_events AS (${runEventSequences})
  SELECT ${registrationSequence} AS seq,'run/registered' AS type,json_object('runId',r.id) AS data,r.created_at,r.id AS run_id
    FROM runs r JOIN run_events b ON b.run_id=r.id WHERE r.parent_run_id IS NOT NULL
  UNION ALL
  SELECT ${lastStateSequence},'run/last-state',json_object('runId',r.id),r.updated_at,r.id
    FROM runs r JOIN run_events b ON b.run_id=r.id WHERE r.status IN ('done','failed','cancelled','paused')`;

/** Copy the persisted timeline into inert records so normal paging and tool inspection can read it. */
export function copyForkHistory(db: Database, projectId: string, sourceSessionId: string, session: ProjectSession,
  cut: { position: number; seq: number; time: string; sourceRunId?: string; settledCalls?: string[]; childRoot?: string }, fileChanges: (roots: string[]) => ForkChange[]) {
  const uid = () => crypto.randomUUID();
  const runs = db.prepare(`WITH RECURSIVE run_events AS (${runEventSequences}),tree(id) AS (
    SELECT id FROM runs WHERE project_id=? AND session_id=? AND (id=? OR ? IS NULL AND parent_run_id IS NULL AND rowid<=?)
    UNION ALL SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id=t.id
      LEFT JOIN run_events b ON b.run_id=r.id WHERE COALESCE(${registrationSequence}<=?,r.created_at<=?)
  ) SELECT r.id,r.parent_run_id,r.intent,r.agent_role,r.status,r.stage,r.label,r.progress,
    json_remove(r.payload,'$.agent','$.agentRevision','$.forkChanges') AS payload,r.background,r.result_text,r.error,r.agent_revision,
    r.turn_preset,r.created_at,r.updated_at,(SELECT MAX(e.revision) FROM agent_session_events e WHERE e.run_id=r.id AND e.created_at<=?) AS revision_at_cut,
    ${lastStateSequence} AS last_seq
    FROM runs r LEFT JOIN run_events b ON b.run_id=r.id WHERE r.id IN (SELECT id FROM tree) ORDER BY r.rowid`)
    .bind(projectId, projectId, sourceSessionId, cut.childRoot ?? null, cut.childRoot ?? null, cut.position, cut.seq, cut.time, cut.time).rows<ForkRun>();
  const runIds = new Map(runs.map(({ id }) => [id, uid()])), ids = JSON.stringify([...runIds.keys()]);
  const roots = runs.filter((run) => !run.parent_run_id || run.id === cut.childRoot).map(({ id }) => id);
  const changes = new Map<string, NonNullable<RunPayload["forkChanges"]>>();
  for (const { runId, ...change } of fileChanges(roots)) {
    const group = changes.get(runId);
    if (group) group.push(change);
    else changes.set(runId, [change]);
  }
  const statements = runs.map((run) => {
    const saved = JSON.parse(run.payload) as RunPayload;
    const settled = (run.last_seq ?? 0) <= cut.seq && run.updated_at <= cut.time && !["running", "queued", "waiting"].includes(run.status);
    const parent = run.parent_run_id ? runIds.get(run.parent_run_id) ?? null : null;
    const payload: RunPayload = {
      instruction: "", sourceVersions: saved.sourceVersions ?? {}, inherited: true,
      ...(saved.agentDefinition ? { agentDefinition: saved.agentDefinition } : {}),
      ...(saved.memberName ? { memberName: saved.memberName } : {}),
      ...(saved.operation ? { operation: saved.operation } : {}),
      ...(saved.batch ? { batch: { ...saved.batch, dependencies: saved.batch.dependencies.flatMap((id) => runIds.get(id) ?? []) } } : {}),
      ...(!parent ? { forkChanges: changes.get(run.id) ?? [] } : {}),
      ...(settled && run.status === "done" && !parent && (!saved.imported || saved.archivedFork)
        ? { forkSource: saved.forkSource ?? { runId: run.id, revision: run.revision_at_cut ?? run.agent_revision } } : {}),
    };
    return db.prepare(`INSERT INTO runs(id,project_id,session_id,parent_run_id,intent,agent_role,status,stage,progress,label,error,payload,
      background,result_text,created_at,updated_at,turn_preset) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(runIds.get(run.id), projectId, session.id, parent, run.intent, run.agent_role,
        settled ? run.status : "cancelled", run.stage, settled ? run.progress : 0, settled ? run.label : "分支时尚未完成",
        settled ? run.error : null, JSON.stringify(payload), run.background, settled ? run.result_text : "",
        run.created_at, settled ? run.updated_at : cut.time, run.turn_preset);
  });
  const rows = db.prepare(`SELECT m.id,m.run_id,m.role,m.agent,m.content,m.artifact_ids,m.attachments,m.created_at,
      (SELECT MAX(e.id) FROM events e WHERE e.project_id=m.project_id
        AND (e.type='feed:message' AND json_extract(e.data,'$.id')=m.id
          OR m.role='assistant' AND e.type='message' AND json_extract(e.data,'$.runId')=m.run_id)) AS last_seq
    FROM messages m WHERE m.project_id=? AND m.session_id=? AND m.created_at<=?
      AND COALESCE((SELECT MIN(e.id) FROM events e WHERE e.project_id=m.project_id AND e.type='feed:message' AND json_extract(e.data,'$.id')=m.id),0)<=?
      AND (m.run_id IN (${selectedIds}) OR (?=0 AND m.run_id IS NULL AND EXISTS(
        SELECT 1 FROM events e WHERE e.project_id=m.project_id AND e.type='message' AND json_extract(e.data,'$.id')=m.id AND e.id<=?)))
    ORDER BY m.rowid`).bind(projectId, sourceSessionId, cut.time, cut.seq, ids, Number(Boolean(cut.childRoot)), cut.seq)
    .rows<{ id: string; run_id: string | null; role: string; agent: string | null; content: string; artifact_ids: string;
      attachments: string; created_at: string; last_seq: number | null }>();
  const messageIds = new Map(rows.map(({ id }) => [id, uid()]));
  for (const row of rows) {
    const pendingReply = row.role === "assistant" && Boolean(cut.sourceRunId) && (row.last_seq ?? 0) > cut.seq;
    statements.push(db.prepare(`INSERT INTO messages(id,project_id,session_id,role,agent,run_id,content,artifact_ids,attachments,created_at,inherited)
    VALUES(?,?,?,?,?,?,?,?,?,?,1)`).bind(messageIds.get(row.id), projectId, session.id, row.role, row.agent, row.run_id ? runIds.get(row.run_id) : null,
      pendingReply ? "" : row.content, pendingReply ? "[]" : row.artifact_ids, row.attachments, row.created_at));
  }
  const replies = db.prepare(`SELECT c.id,c.run_id,c.response,c.visible_text,c.status,c.created_at,c.settled_at,c.first_output_at,c.last_output_at,c.usage,c.error_code,
    c.request,c.request_header_id,c.error,c.provider_request_id,c.offload_images,
    (SELECT MIN(e.id) FROM events e WHERE e.project_id=? AND e.type='reply' AND json_extract(e.data,'$.requestId')=c.id) AS settled_seq
    FROM model_calls c WHERE c.run_id IN (${selectedIds}) AND c.created_at<=? AND json_extract(c.request,'$.purpose') IN ('creation','compaction','manual-compaction')
      AND COALESCE((SELECT MIN(e.id) FROM events e WHERE e.project_id=? AND e.type='request' AND json_extract(e.data,'$.requestId')=c.id),0)<=?
    ORDER BY c.rowid`).bind(projectId, ids, cut.time, projectId, cut.seq)
    .rows<{ id: string; run_id: string; response: string | null; visible_text: string; status: string; created_at: string; settled_at: string | null;
      first_output_at: string | null; usage: string | null; error_code: string | null; request: string; request_header_id: string | null;
      error: string | null; provider_request_id: string | null; offload_images: number | null; settled_seq: number | null; last_output_at: string | null }>();
  const replyIds = new Map<string, string>();
  for (const row of replies) {
    const settled = Boolean(row.settled_at && row.settled_at <= cut.time && (row.settled_seq ?? 0) <= cut.seq);
    if (!cut.sourceRunId && !settled && !row.visible_text) continue;
    const id = uid(); replyIds.set(row.id, id);
    statements.push(db.prepare(`INSERT INTO model_calls(id,run_id,request,status,response,visible_text,created_at,settled_at,first_output_at,usage,error_code,
      request_header_id,error,provider_request_id,offload_images,last_output_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, runIds.get(row.run_id), row.request, settled ? row.status : "interrupted", settled ? row.response : null,
        settled ? row.visible_text : "", row.created_at, settled ? row.settled_at : cut.time, settled ? row.first_output_at : null,
        settled ? row.usage : null, settled ? row.error_code : null, row.request_header_id, settled ? row.error : null,
        settled ? row.provider_request_id : null, settled ? row.offload_images : null, settled ? row.last_output_at : null));
  }
  const steps = db.prepare(`SELECT s.run_id,s.call_id,s.name,s.status,s.arguments,s.summary,s.started_at,s.finished_at,
    s.request_id,s.call_index,s.provider_call_id,s.output_ref,s.output_images,s.dispatched_at,
    (SELECT MIN(e.id) FROM events e WHERE e.project_id=s.project_id AND e.type='step'
      AND json_extract(e.data,'$.stepSeq')=s.seq AND json_extract(e.data,'$.status')<>'running') AS settled_seq,
    COALESCE(s.result,CASE WHEN t.created_at<=? THEN t.result END) AS result
    FROM execution_steps s LEFT JOIN tool_receipts t ON t.run_id=s.run_id AND t.call_id=s.call_id
    WHERE s.project_id=? AND s.run_id IN (${selectedIds}) AND s.started_at<=? AND
      COALESCE((SELECT MIN(e.id) FROM events e WHERE e.project_id=s.project_id AND e.type='feed:step' AND json_extract(e.data,'$.id')=s.seq),0)<=?
    ORDER BY s.seq`).bind(cut.time, projectId, ids, cut.time, cut.seq)
    .rows<{ run_id: string; call_id: string; name: string; status: string; arguments: string; summary: string; started_at: string; finished_at: string | null;
      result: string | null; settled_seq: number | null; request_id: string | null; call_index: number | null; provider_call_id: string | null;
      output_ref: string | null; output_images: string | null; dispatched_at: string | null }>();
  for (const row of steps) {
    const committedAtAnchor = row.run_id === cut.sourceRunId && cut.settledCalls?.includes(row.call_id);
    const settled = committedAtAnchor || (row.settled_seq ?? 0) <= cut.seq && row.finished_at !== null && row.finished_at <= cut.time;
    statements.push(db.prepare(`INSERT INTO execution_steps(project_id,run_id,call_id,name,status,arguments,result,summary,started_at,finished_at,
      request_id,call_index,provider_call_id,output_ref,output_images,dispatched_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(projectId, runIds.get(row.run_id), row.call_id, row.name, settled ? row.status : "interrupted",
      row.arguments, settled ? row.result : null, settled ? row.summary : "", row.started_at, settled ? row.finished_at : null,
      row.request_id ? replyIds.get(row.request_id) ?? null : null, row.call_index, row.provider_call_id,
      settled ? row.output_ref : null, settled ? row.output_images : null, row.dispatched_at && row.dispatched_at <= cut.time ? row.dispatched_at : null));
  }
  const deliveries = db.prepare(`SELECT d.run_id,d.files,e.created_at FROM deliveries d JOIN events e
    ON e.project_id=? AND e.type='feed:delivery' AND json_extract(e.data,'$.id')=d.id
    WHERE d.run_id IN (${selectedIds}) AND e.id<=? AND e.created_at<=? ORDER BY e.id`).bind(projectId, ids, cut.seq, cut.time)
    .rows<{ run_id: string; files: string; created_at: string }>();
  for (const row of deliveries) {
    const id = uid();
    statements.push(db.prepare("INSERT INTO deliveries(id,run_id,files) VALUES(?,?,?)").bind(id, runIds.get(row.run_id), row.files),
      db.prepare("INSERT INTO events(project_id,type,data,created_at) VALUES(?,'feed:delivery',?,?)")
        .bind(projectId, JSON.stringify({ id }), row.created_at));
  }
  const timeline = db.prepare(`WITH boundaries AS (${runBoundaries})
    SELECT e.id AS seq,e.type,e.data,e.created_at,COALESCE(a.origin_event_id,e.id) AS origin,
      COALESCE(a.root_run_id,json_extract(e.data,'$.runId'),m.run_id) AS original_run
    FROM events e LEFT JOIN fork_event_ancestry a ON a.event_id=e.id
    LEFT JOIN messages m ON e.type='message' AND m.id=json_extract(e.data,'$.id')
    WHERE e.project_id=? AND e.id<=? AND
    (((${committedRunEvent}) AND json_extract(e.data,'$.runId') IN (${selectedIds}))
    OR (e.type='message' AND json_extract(e.data,'$.id') IN (${selectedIds})))
    UNION ALL SELECT seq,type,data,created_at,seq,run_id FROM boundaries WHERE seq<=? AND run_id IN (${selectedIds})
    ORDER BY seq, type`)
    .bind(projectId, projectId, cut.seq, ids, JSON.stringify([...messageIds.keys()]), cut.seq, ids).rows<{ type: string; data: string; created_at: string; origin: number; original_run: string | null }>();
  for (const row of timeline) {
    const original = JSON.parse(row.data), id = messageIds.get(original.id), runId = runIds.get(original.runId);
    if ((row.type === "step" || row.type === "tool/dispatched") && runId && original.callId) {
      statements.push(db.prepare(`INSERT INTO events(project_id,type,data,created_at)
        SELECT ?,?,json_object('runId',run_id,'callId',call_id,'stepSeq',seq,'requestId',request_id,'callIndex',call_index,
          'status',COALESCE(?,status),'dispatchedAt',dispatched_at),?
        FROM execution_steps WHERE run_id=? AND call_id=?`).bind(projectId, row.type, original.status ?? null, row.created_at, runId, original.callId));
      ancestry();
      continue;
    }
    const requestId = replyIds.get(original.requestId);
    const data = row.type === "message" ? (id ? { id } : runId ? { runId } : null)
      : row.type === "request" ? (runId && requestId ? { runId, requestId, turn: original.turn, step: original.step, attempt: original.attempt } : null)
        : row.type === "reply" ? (runId && requestId ? { runId, requestId, status: original.status, errorCode: original.errorCode } : null)
        : row.type === "step" ? (runId ? { runId, callId: original.callId } : null)
          : runId ? { ...original, runId, sessionId: session.id, ...(original.requestId ? { requestId } : {}),
            ...(row.type === "llm/retry" || row.type === "llm/retry-started" ? { retryId: [runId, original.turn, original.step].join(":"),
              ...(original.previousRequestId ? { previousRequestId: replyIds.get(original.previousRequestId) } : {}) } : {}),
            ...(row.type === "inbox/rejected" && Array.isArray(original.messageIds)
              ? { messageIds: original.messageIds.flatMap((id: string) => messageIds.get(id) ?? []) } : {}) } : null;
    if (data) {
      statements.push(db.prepare("INSERT INTO events(project_id,type,data,created_at) VALUES(?,?,?,?)")
        .bind(projectId, row.type, JSON.stringify(data), row.created_at));
      ancestry();
    }
    function ancestry() {
      if (row.original_run) statements.push(db.prepare(`INSERT INTO fork_event_ancestry(event_id,origin_event_id,root_run_id)
        SELECT last_insert_rowid(),?,? WHERE changes()=1`).bind(row.origin, row.original_run));
    }
  }
  if (cut.sourceRunId) {
    const forked = JSON.stringify([...runIds.values()]);
    for (const phase of ["step", "turn"] as const) {
      const sameStep = phase === "step" ? "AND json_extract(closed.data,'$.step')=json_extract(open.data,'$.step')" : "";
      statements.push(db.prepare(`INSERT OR IGNORE INTO events(project_id,type,data,created_at)
        SELECT open.project_id,?,json_set(open.data,'$.reason',json(?)),?
        FROM events open WHERE open.project_id=? AND open.type=? AND json_extract(open.data,'$.runId') IN (${selectedIds})
        AND NOT EXISTS(SELECT 1 FROM events closed WHERE closed.project_id=open.project_id AND closed.type=?
          AND json_extract(closed.data,'$.runId')=json_extract(open.data,'$.runId')
          AND json_extract(closed.data,'$.turn')=json_extract(open.data,'$.turn') ${sameStep}) ORDER BY open.id`)
        .bind(phase + "/end", JSON.stringify({ kind: "interrupted", reason: "forked" }), cut.time, projectId, phase + "/start", forked, phase + "/end"));
    }
  }
  return statements;
}
