import { hydratedModelRequest } from "./model-request-record";
import { AppError } from "./security";
import { createTwoFilesPatch } from "diff";
import type { Store } from "./store";
import { committedRunEvent } from "./session-fork";
import type { AgentImage, AgentMessage, MessageAttachment, ModelUsage } from "./types";

export type TraceField = "request" | "messages" | "system" | "system-diff" | "tools" | "response" | "thinking" | "text" | "stream";
export interface TraceRow {
  seq: number; kind: string; at: string; runId: string; rootRunId: string; role: string; child: boolean;
  turn: number | null; step: number | null; label: string; status: string | null; detailId: string | null;
  attempt: number | null; durationMs: number | null; firstOutputMs: number | null; usage: ModelUsage | null; error: string | null;
  forkable: boolean;
  stepFirstOutputMs: number | null;
  decodeMs?: number | null;
}
export interface TracePage { rows: TraceRow[]; before: number | null; after?: number | null; usage: ModelUsage }
export interface TraceAttachment { name: string; url: string; kind: string; width?: number; height?: number; bytes?: number }
export interface TraceContent { text: string | null; nextOffset?: number; unavailable?: boolean; attachments?: TraceAttachment[] }

export function trajectory(store: Store, projectId: string, sessionId: string, before: number, query: string, after?: number, watch?: readonly number[]): TracePage {
  const limit = 60;
  const rows = store.db.prepare(`WITH RECURSIVE scope(id,root) AS (
      SELECT id,id FROM runs WHERE project_id=? AND session_id=? AND parent_run_id IS NULL
      UNION ALL SELECT r.id,scope.root FROM runs r JOIN scope ON scope.id=r.parent_run_id
    ) SELECT e.id AS seq,
      CASE WHEN e.type='reply' AND j.revision IS NOT NULL THEN 'trajectory/checkpoint' ELSE e.type END AS kind,
      e.created_at AS at,r.id AS runId,scope.root AS rootRunId,r.agent_role AS role,
      r.parent_run_id IS NOT NULL AS child,
      COALESCE(json_extract(e.data,'$.turn'),json_extract(c.request,'$.turn'),json_extract(mc.request,'$.turn')) AS turn,
      COALESCE(json_extract(e.data,'$.step'),json_extract(c.request,'$.step'),json_extract(mc.request,'$.step')) AS step,
      COALESCE(s.name,json_extract(c.request,'$.model'),substr(m.content,1,100),j.kind,json_extract(e.data,'$.phase'),
        CASE WHEN e.type='turn/end' THEN json_extract(e.data,'$.reason.kind')
          WHEN e.type IN ('llm/retry','llm/retry-started') THEN CAST(json_extract(e.data,'$.retry') AS TEXT) ||
            COALESCE('/' || json_extract(e.data,'$.maxRetries'),'') END,json_extract(e.data,'$.label'),e.type) AS label,
      COALESCE(c.status,s.status) AS status,COALESCE(c.id,CAST(s.seq AS TEXT),m.id) AS detailId,
      COALESCE(json_extract(c.request,'$.attempt'),json_extract(mc.request,'$.attempt')) AS attempt,
      ROUND(1000*(unixepoch(COALESCE(c.settled_at,s.finished_at),'subsec')-unixepoch(COALESCE(c.created_at,s.dispatched_at),'subsec'))) AS durationMs,
      ROUND(1000*(unixepoch(c.first_output_at,'subsec')-unixepoch(c.created_at,'subsec'))) AS firstOutputMs,
      MAX(0,ROUND(1000*(unixepoch(c.last_output_at,'subsec')-unixepoch(c.first_output_at,'subsec')))) AS decodeMs,
      CASE WHEN c.id IS NOT NULL THEN (
        SELECT ROUND(1000*(MIN(unixepoch(k.first_output_at,'subsec'))-MIN(unixepoch(k.created_at,'subsec'))))
        FROM model_calls k WHERE k.run_id=c.run_id AND json_extract(k.request,'$.turn')=json_extract(c.request,'$.turn')
          AND json_extract(k.request,'$.step')=json_extract(c.request,'$.step') AND json_extract(k.request,'$.purpose')=json_extract(c.request,'$.purpose')
      ) END AS stepFirstOutputMs,
      c.usage,COALESCE(c.error,c.error_code,CASE WHEN s.status='failed' THEN s.summary
        WHEN e.type='llm/retry' THEN json_extract(e.data,'$.failure.message') END) AS error,
      r.intent IN ('agent','compact') AND r.background=0 AND r.agent_role<>'media'
        AND (json_extract(r.payload,'$.imported') IS NOT 1 OR json_extract(r.payload,'$.archivedFork')=1 OR EXISTS(
          SELECT 1 FROM runs origin WHERE origin.id=a.root_run_id AND origin.project_id=r.project_id
          AND json_extract(origin.payload,'$.archivedFork')=1))
        AND (json_extract(r.payload,'$.inherited') IS NOT 1 OR a.event_id IS NOT NULL) AS forkable
    FROM events e
      LEFT JOIN messages m ON e.type='message' AND m.id=json_extract(e.data,'$.id') AND m.project_id=e.project_id
      JOIN runs r ON r.id=COALESCE(json_extract(e.data,'$.runId'),m.run_id) AND r.project_id=e.project_id
      JOIN scope ON scope.id=r.id
      LEFT JOIN fork_event_ancestry a ON a.event_id=e.id
      LEFT JOIN model_calls c ON e.type='request' AND c.id=json_extract(e.data,'$.requestId') AND c.run_id=r.id
      LEFT JOIN agent_session_events j ON j.run_id=r.id AND j.event_seq=e.id
      LEFT JOIN execution_steps s ON e.type IN ('step','tool/dispatched') AND s.seq=json_extract(e.data,'$.stepSeq') AND s.run_id=r.id
      LEFT JOIN model_calls mc ON mc.id=COALESCE(s.request_id,j.reference)
      LEFT JOIN model_request_parts h ON h.id=c.request_header_id
      CROSS JOIN (SELECT lower(?) AS term) search
    WHERE e.project_id=? AND r.session_id=? AND e.id<? AND e.id>?
      ${watch ? "AND e.id IN (SELECT value FROM json_each(?))" : ""} AND
      (((${committedRunEvent}) AND e.type NOT IN ('step','request','reply','message') AND json_type(e.data,'$.runId')='text')
        OR c.id IS NOT NULL OR m.id IS NOT NULL OR j.revision IS NOT NULL
        OR (s.seq IS NOT NULL AND NOT EXISTS(SELECT 1 FROM events old WHERE old.project_id=e.project_id AND old.type='step'
          AND old.id<e.id AND json_extract(old.data,'$.stepSeq')=s.seq)))
      AND (search.term='' OR instr(lower(concat(e.type,' ',CASE WHEN e.type IN ('llm/retry','llm/retry-started') THEN '重试 ' || e.data END,' ',r.agent_role,' ',s.name,' ',s.summary,' ',s.arguments,' ',s.result,' ',
        c.error,' ',c.visible_text,' ',c.response,' ',c.request,' ',h.content,' ',m.content,' ',m.attachments)),search.term)>0
        OR EXISTS(SELECT 1 FROM json_each(c.request,'$.messageParts') item
          LEFT JOIN model_request_parts p ON p.id=item.value AND item.type='text'
          WHERE instr(lower(COALESCE(p.content,item.value)),search.term)>0))
    ORDER BY e.id ${after === undefined ? "DESC" : "ASC"} LIMIT ?`).bind(projectId, sessionId, query, projectId, sessionId, before, after ?? 0,
      ...(watch ? [JSON.stringify(watch)] : []), limit + 1)
    .rows<Omit<TraceRow, "usage" | "forkable" | "child"> & { usage: string | null; forkable: number; child: number }>();
  const next = rows.length > limit;
  const [usage] = store.db.prepare(`SELECT COALESCE(SUM(json_extract(c.usage,'$.inputTokens')),0) AS inputTokens,
    COALESCE(SUM(json_extract(c.usage,'$.outputTokens')),0) AS outputTokens,COALESCE(SUM(json_extract(c.usage,'$.totalTokens')),0) AS totalTokens,
    COALESCE(SUM(json_extract(c.usage,'$.cachedInputTokens')),0) AS cachedInputTokens,
    SUM(json_extract(c.usage,'$.cacheWriteInputTokens')) AS cacheWriteInputTokens
    FROM model_calls c JOIN runs r ON r.id=c.run_id WHERE r.project_id=? AND r.session_id=?`).bind(projectId, sessionId).rows<ModelUsage>();
  if (usage.cacheWriteInputTokens == null) delete usage.cacheWriteInputTokens;
  return { rows: rows.slice(0, limit).map((row) => ({ ...row, forkable: Boolean(row.forkable), child: Boolean(row.child),
    usage: row.usage ? JSON.parse(row.usage) as ModelUsage : null })),
    before: after === undefined && next ? rows[limit - 1].seq : null,
    ...(after === undefined ? {} : { after: next ? rows[limit - 1].seq : null }), usage };
}

function modelTrace(store: Store, projectId: string, sessionId: string, runId: string, id: string) {
  const [row] = store.db.prepare(`SELECT ${hydratedModelRequest},c.response,c.visible_text,c.rowid AS position,r.parent_run_id FROM model_calls c JOIN runs r ON r.id=c.run_id
    LEFT JOIN model_request_parts h ON h.id=c.request_header_id WHERE r.project_id=? AND r.session_id=? AND r.id=? AND c.id=?`)
    .bind(projectId, sessionId, runId, id).rows<{ hydrated_request: string; response: string | null; visible_text: string; position: number; parent_run_id: string | null }>();
  if (!row) throw new AppError("模型调用记录不存在", 404);
  return row;
}

const mediaPath = (projectId: string, sessionId: string, runId: string, id: string, channel: string, index: number) =>
  "/api/studio/projects/" + projectId + "/trajectory/" + runId + "/" + id + "/image/" + index +
  "?channel=" + channel + (sessionId ? "&session=" + encodeURIComponent(sessionId) : "");

export function trajectoryImages(store: Store, projectId: string, sessionId: string, runId: string, id: string, channel: "model" | "tool"): AgentImage[] {
  if (channel === "model") {
    const row = modelTrace(store, projectId, sessionId, runId, id);
    const request = JSON.parse(row.hydrated_request) as { messages?: AgentMessage[] };
    const response = row.response ? JSON.parse(row.response) as AgentMessage : null;
    return [...(request.messages ?? []).flatMap((message) => message.images ?? []), ...response?.images ?? []];
  }
  const [row] = store.db.prepare(`SELECT s.output_images FROM execution_steps s JOIN runs r ON r.id=s.run_id
    WHERE s.seq=? AND r.project_id=? AND r.session_id=? AND r.id=?`).bind(id, projectId, sessionId, runId).rows<{ output_images: string | null }>();
  return row?.output_images ? JSON.parse(row.output_images) as AgentImage[] : [];
}

export function traceAttachments(store: Store, projectId: string, sessionId: string, runId: string, id: string, channel: "model" | "tool") {
  return trajectoryImages(store, projectId, sessionId, runId, id, channel).map(({ path, width, height, bytes }, index): TraceAttachment =>
    ({ name: path, width, height, bytes, kind: "image", url: mediaPath(projectId, sessionId, runId, id, channel, index) }));
}

export function trajectoryMessage(store: Store, projectId: string, sessionId: string, runId: string, id: string): TraceContent {
  const [row] = store.db.prepare("SELECT content,attachments FROM messages WHERE project_id=? AND session_id=? AND run_id=? AND id=?")
    .bind(projectId, sessionId, runId, id).rows<{ content: string; attachments: string }>();
  if (!row) throw new AppError("消息不存在", 404);
  const attachments = (JSON.parse(row.attachments) as MessageAttachment[]).map(({ id, path, version, kind }) => ({
    name: path, kind, url: "/api/studio/projects/" + projectId + (kind === "document" || kind === "script" ? "/artifacts/" : "/media/") + id +
      "?version=" + version + (sessionId ? "&session=" + encodeURIComponent(sessionId) : ""),
  }));
  return { text: row.content, attachments };
}

export function trajectoryContent(store: Store, projectId: string, sessionId: string, runId: string, id: string, field: TraceField, offset: number): TraceContent {
  const row = modelTrace(store, projectId, sessionId, runId, id);
  const request = JSON.parse(row.hydrated_request) as Record<string, unknown>;
  const response = row.response ? JSON.parse(row.response) : null;
  let content = field === "request" ? request : field === "response" ? response : field === "stream" ? response?.attemptTrace : field === "text" ? row.visible_text : field === "thinking"
    ? response?.messagesReplay?.blocks?.filter((block: { type: string }) => block.type === "thinking").map((block: { thinking: string }) => block.thinking).join("\n\n")
    : request[field];
  if (field === "system-diff" && typeof request.system === "string") {
    const previous = store.db.prepare(`SELECT COALESCE(json_extract(h.content,'$.system'),json_extract(c.request,'$.system')) AS system
      FROM model_calls c JOIN runs r ON r.id=c.run_id LEFT JOIN model_request_parts h ON h.id=c.request_header_id
      WHERE c.rowid<? AND r.project_id=? AND r.session_id=? AND
        (r.id=? OR (? IS NULL AND r.parent_run_id IS NULL)) AND json_extract(c.request,'$.purpose')='creation'
      ORDER BY c.rowid DESC LIMIT 1`).bind(row.position, projectId, sessionId, runId, row.parent_run_id).rows<{ system: string | null }>();
    const before = previous[0]?.system;
    content = before === request.system ? "提示词无变化" : before == null ? request.system :
      createTwoFilesPatch("上次", "本次", before, request.system, "", "", { context: 3 });
  }
  const attachments = !offset && ["request", "messages", "response", "text"].includes(field) ? traceAttachments(store, projectId, sessionId, runId, id, "model") : undefined;
  if (content === undefined || content === null || content === "") return { text: null, unavailable: !Array.isArray(request.messages), attachments };
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  const characters = Array.from(text);
  const size = 12_000;
  return { text: characters.slice(offset, offset + size).join(""), attachments, ...(offset + size < characters.length ? { nextOffset: offset + size } : {}) };
}
