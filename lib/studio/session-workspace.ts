import { notifyExecutions } from "./run-execution";
import { AppError } from "./security";
import { activeRunStatus, cancelledRunPayload, now, type Store } from "./store";
import type { SessionActivity, SessionSearchMatch, SessionTurnSummary } from "./types";

export function sessionActivity(store: Store, project: string, session: string): SessionActivity {
  const runs = store.db.prepare(`SELECT id,label,CASE WHEN background=1 THEN 'job' WHEN parent_run_id IS NULL THEN 'turn' ELSE 'agent' END AS kind
    FROM runs WHERE project_id=? AND session_id=? AND ${activeRunStatus}`).bind(project, session).rows<SessionActivity["runs"][number]>();
  const schedules = store.db.prepare(`SELECT id,json_extract(data,'$.title') AS title FROM studio_schedules
    WHERE project_id=? AND session_id=? AND status='active'`).bind(project, session).rows<SessionActivity["schedules"][number]>();
  const [{ pending }] = store.db.prepare("SELECT COUNT(*) AS pending FROM chat_queue WHERE project_id=? AND session_id=? AND status='pending'")
    .bind(project, session).rows<{ pending: number }>();
  return { runs, schedules, pending };
}

export async function setSessionArchived(store: Store, project: string, session: string, archived: boolean, stopActivity: boolean) {
  const time = now(), db = store.db;
  const [changed] = await db.batch([
    db.prepare(`INSERT INTO session_management(project_id,session_id,archived) SELECT ?,?,?
      WHERE (?=0 OR ?=1 OR (
        NOT EXISTS(SELECT 1 FROM runs WHERE project_id=? AND session_id=? AND ${activeRunStatus})
        AND NOT EXISTS(SELECT 1 FROM chat_queue WHERE project_id=? AND session_id=? AND status='pending')
        AND NOT EXISTS(SELECT 1 FROM studio_schedules WHERE project_id=? AND session_id=? AND status='active')))
      ON CONFLICT(project_id,session_id) DO UPDATE SET archived=excluded.archived,
        pinned=CASE WHEN excluded.archived=1 THEN 0 ELSE pinned END`)
      .bind(project, session, Number(archived), Number(archived), Number(stopActivity), project, session, project, session, project, session),
    db.prepare("INSERT INTO events(project_id,type,data,created_at) SELECT ?,'feed:sessions',?,? WHERE changes()=1")
      .bind(project, JSON.stringify({ id: session }), time),
    ...(archived && stopActivity ? [
      db.prepare(`UPDATE chat_queue SET status='cancelled',version=version+1,updated_at=?
        WHERE project_id=? AND session_id=? AND status='pending'`).bind(time, project, session),
      db.prepare(`UPDATE runs SET status='cancelled',label='已取消',next_attempt_at=0,updated_at=?,
        payload=json_set(${cancelledRunPayload},'$.stoppedBySessionArchive',json('true'))
        WHERE project_id=? AND session_id=? AND ${activeRunStatus}`).bind(time, project, session),
      db.prepare(`UPDATE studio_schedules SET status='paused',version=version+1,updated_at=?
        WHERE project_id=? AND session_id=? AND status='active'`).bind(time, project, session),
    ] : []),
  ]);
  if (!changed.meta.changes) return { activity: sessionActivity(store, project, session) };
  if (archived && stopActivity) {
    notifyExecutions(db, project);
    await store.recoverStoppedExecutions(project);
  }
  return { sessions: store.sessions(project) };
}

export async function setSessionPinned(store: Store, project: string, session: string, pinned: boolean) {
  store.assertActiveSession(project, session);
  await store.db.batch([
    store.db.prepare(`INSERT INTO session_management(project_id,session_id,pinned) VALUES(?,?,?)
      ON CONFLICT(project_id,session_id) DO UPDATE SET pinned=excluded.pinned WHERE archived=0`).bind(project, session, Number(pinned)),
    store.event(project, "feed:sessions", { id: session }),
  ]);
  return store.sessions(project);
}

export async function moveSession(store: Store, project: string, session: string, beforeId: string, after: boolean) {
  const sessions = store.sessions(project);
  const moving = sessions.find(({ id }) => id === session), target = sessions.find(({ id }) => id === beforeId);
  if (!moving || !target || moving.archived || target.archived || Boolean(moving.pinned) !== Boolean(target.pinned))
    throw new AppError("只能在同组的活动对话之间排序", 409, "SESSION_ORDER_CHANGED");
  if (session === beforeId) return sessions;
  const remaining = sessions.filter(({ id }) => id !== session);
  remaining.splice(remaining.indexOf(target) + Number(after), 0, moving);
  await store.db.batch([
    store.db.prepare(`INSERT INTO session_management(project_id,session_id,position)
      SELECT ?,value,CAST(key AS INTEGER) FROM json_each(?) WHERE 1
      ON CONFLICT(project_id,session_id) DO UPDATE SET position=excluded.position`)
      .bind(project, JSON.stringify(remaining.map(({ id }) => id))),
    store.event(project, "feed:sessions", { id: session }),
  ]);
  return store.sessions(project);
}

export function searchSessions(store: Store, user: string, query: string, includeContent: boolean): SessionSearchMatch[] {
  const rows = store.db.prepare(`WITH owned AS (SELECT id,title,main_session_title,status,updated_at FROM projects WHERE user_id=?),
    sessions AS (
      SELECT id AS projectId,'' AS sessionId,main_session_title AS title,updated_at AS updatedAt FROM owned
      UNION ALL SELECT s.project_id,s.id,s.title,s.created_at FROM project_sessions s JOIN owned p ON p.id=s.project_id
    ), matches AS (
      SELECT m.id,m.project_id,m.session_id,m.role,m.content,m.run_id,instr(lower(m.content),lower(?)) AS hit,
        ROW_NUMBER() OVER (PARTITION BY m.project_id,m.session_id ORDER BY m.rowid DESC) AS rank
      FROM messages m JOIN owned p ON p.id=m.project_id WHERE ?=1 AND instr(lower(m.content),lower(?))>0
    ) SELECT s.projectId,p.title AS projectTitle,s.sessionId,s.title,COALESCE(state.archived,0) AS archived,
      p.status='archived' AS projectArchived,m.id AS messageId,m.role,substr(m.content,MAX(1,m.hit-55),140) AS snippet,
      r.rowid+1 AS before
    FROM sessions s JOIN owned p ON p.id=s.projectId
    LEFT JOIN session_management state ON state.project_id=s.projectId AND state.session_id=s.sessionId
    LEFT JOIN matches m ON m.project_id=s.projectId AND m.session_id=s.sessionId AND m.rank=1
    LEFT JOIN runs r ON r.id=m.run_id AND r.project_id=s.projectId AND r.session_id=s.sessionId
    WHERE m.id IS NOT NULL OR instr(lower(s.title),lower(?))>0 OR instr(lower(s.sessionId),lower(?))>0 OR instr(lower(p.title),lower(?))>0
    ORDER BY (instr(lower(s.title),lower(?))>0) DESC,(m.id IS NOT NULL) DESC,s.updatedAt DESC,s.projectId,s.sessionId LIMIT 20`)
    .bind(user, query, Number(includeContent), query, query, query, query, query)
    .rows<{ projectId: string; projectTitle: string; sessionId: string; title: string; archived: number; projectArchived: number;
      messageId: string | null; role: "user" | "assistant"; snippet: string; before: number | null }>();
  return rows.map(({ messageId, role, snippet, before, archived, projectArchived, ...session }) => ({ ...session,
    archived: Boolean(archived), projectArchived: Boolean(projectArchived),
    ...(messageId ? { message: { id: messageId, role, snippet, ...(before ? { before } : {}) } } : {}),
  }));
}

export function sessionOutline(store: Store, project: string, session: string): SessionTurnSummary[] {
  return store.db.prepare(`SELECT r.id AS runId,r.rowid+1 AS before,COALESCE(u.id,a.id) AS id,
    substr(trim(u.content),1,120) AS prompt,CASE WHEN r.status='done' THEN substr(trim(a.content),1,120) ELSE '' END AS reply
    FROM runs r
    LEFT JOIN messages u ON u.rowid=(SELECT MIN(m.rowid) FROM messages m WHERE m.run_id=r.id AND m.role='user')
    LEFT JOIN messages a ON a.rowid=(SELECT MAX(m.rowid) FROM messages m WHERE m.run_id=r.id AND m.role='assistant')
    WHERE r.project_id=? AND r.session_id=? AND r.parent_run_id IS NULL AND (u.id IS NOT NULL OR a.id IS NOT NULL)
      AND r.intent<>'compact' ORDER BY r.rowid`).bind(project, session).rows<SessionTurnSummary>()
    .map((turn) => ({ ...turn, prompt: turn.prompt ?? "", reply: turn.reply ?? "" }));
}
