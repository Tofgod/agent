import { agentIdentity } from "./agent-identity";
import { taskNoticeKey, taskResult, taskResultReady } from "./agent-state";
import { AppError } from "./security";
import type { Store } from "./store";
import type { AgentMessage, Run } from "./types";

export type JobOutputChannel = "stdout" | "stderr" | "log";
export interface JobOutputFrame {
  cursor: number;
  lines: { seq: number; line: string; channel: JobOutputChannel; createdAt: string; fragment: number }[];
  dropped: boolean;
  more: boolean;
  status: Run["status"];
  label: string;
  progress: number;
  result?: ReturnType<typeof taskResult>;
}

export const JOB_OUTPUT_RETAIN_BYTES = 256 * 1024;
const SETTLED_OUTPUT_BYTES = 16 * 1024;
const noticePrefix = "子任务状态通知（数据）：";

export function backgroundOutput(store: Store, job: Run, after: number, limit: number | null = 32,
  view: "live" | "archive" = job.payload.imported || job.payload.inherited ? "archive" : "live"): JobOutputFrame {
  const db = store.db;
  const through = db.prepare("SELECT through_seq FROM background_job_truncation WHERE job_id=?")
    .bind(job.id).rows<{ through_seq: number }>().at(0)?.through_seq ?? 0;
  const consumed = view === "live" && ["done", "failed", "cancelled"].includes(job.status)
    ? db.prepare("SELECT MAX(cursor) AS cursor FROM background_job_reads WHERE job_id=?")
      .bind(job.id).rows<{ cursor: number | null }>().at(0)?.cursor ?? 0 : 0;
  const boundary = consumed > after ? db.prepare(`
    WITH sizes AS (
      SELECT seq,LENGTH(CAST(line AS BLOB)) AS bytes,SUM(LENGTH(CAST(line AS BLOB))) OVER (ORDER BY seq DESC) AS running
      FROM background_job_output WHERE job_id=? AND channel<>'log'
    ) SELECT seq,bytes,running FROM sizes WHERE seq<=? AND running>=? ORDER BY seq DESC LIMIT 1`)
    .bind(job.id, consumed, SETTLED_OUTPUT_BYTES).rows<{ seq: number; bytes: number; running: number }>().at(0) : undefined;
  const earliest = boundary && boundary.seq > after ? boundary.seq : 0;
  const lines = db.prepare("SELECT seq,line,channel,fragment,created_at AS createdAt FROM background_job_output WHERE job_id=? AND seq>? ORDER BY seq LIMIT ?")
    .bind(job.id, Math.max(after, earliest - 1), limit === null ? -1 : limit + (earliest ? 2 : 1)).rows<JobOutputFrame["lines"][number]>();
  let dropped = after < through || earliest > after + 1;
  if (boundary?.seq === earliest && lines[0]?.seq === earliest) {
    const bytes = Buffer.from(lines[0].line);
    let offset = Math.min(boundary.bytes, boundary.running - SETTLED_OUTPUT_BYTES);
    while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
    if (offset) {
      dropped = true;
      if (offset === bytes.length) lines.shift();
      else lines[0].line = bytes.subarray(offset).toString("utf8");
    }
  }
  const more = limit !== null && lines.length > limit;
  if (more) lines.length = limit;
  return { cursor: lines.at(-1)?.seq ?? Math.max(after, earliest), lines, dropped, more,
    status: job.status, label: job.label, progress: job.progress, ...(!more && taskResultReady(job) ? { result: taskResult(job) } : {}) };
}

export function renderJobOutput(lines: JobOutputFrame["lines"]) {
  const render = (channel: JobOutputChannel) => lines.filter((row) => row.channel === channel)
    .map(({ line, fragment }, index, rows) => line + (!fragment && index < rows.length - 1 ? "\n" : "")).join("");
  const stdout = render("stdout"), stderr = render("stderr");
  return stderr ? stdout + (stdout && !stdout.endsWith("\n") ? "\n" : "") + "[stderr]\n" + stderr : stdout;
}

function backgroundRead(store: Store, owner: string, jobId: string) {
  return store.db.prepare("SELECT cursor,terminal,observed_terminal AS observed FROM background_job_reads WHERE owner=? AND job_id=?")
    .bind(owner, jobId).rows<{ cursor: number; terminal: string | null; observed: string | null }>().at(0);
}

/** An inline notification consumes output only when its model request is admitted. */
export function backgroundTaskNotice(store: Store, run: Run, job: Run): AgentMessage | undefined {
  const terminal = taskNoticeKey(job);
  const prior = backgroundRead(store, agentIdentity(run), job.id);
  if (prior?.observed === terminal) return;
  const frame = backgroundOutput(store, job, prior?.cursor ?? 0, null);
  const notice = { ...taskResult(job), role: job.agentRole, name: job.payload.agentDefinition?.name };
  const output = renderJobOutput(frame.lines);
  const full = noticePrefix + JSON.stringify({ ...notice, ...(output ? { output } : {}) });
  if (frame.result && !frame.dropped && Buffer.byteLength(full, "utf8") <= 2048) {
    return { role: "user", content: full, source: { kind: "task-result", inlineOutput: { jobId: job.id, cursor: frame.cursor, terminal } } };
  }
  const hint = { task_id: job.id, status: notice.status, role: notice.role, name: notice.name, result_available: true, read_with: "job_output" };
  return { role: "user", content: noticePrefix + JSON.stringify(hint), source: { kind: "task-result" } };
}

function legacyNoticeDelivered(run: Run, job: Run, callId: string, terminal: string) {
  const state = run.payload.agent;
  if (!state || state.backgroundNotices?.[job.id] !== terminal) return false;
  const call = state.messages.findLastIndex((message) => message.role === "assistant" &&
    message.tool_calls?.some((tool) => tool.id === callId && tool.function.name === "job_output"));
  if (call < 0) return false;
  // The old notice carried only the result. Its preceding position in the
  // admitted tool call's history leaves the job's line cursor untouched.
  return state.messages.slice(0, call).some(({ source, content }) => {
    if (source?.kind !== "task-result" || source.inlineOutput || !content?.startsWith(noticePrefix)) return false;
    try {
      const notice = JSON.parse(content.slice(noticePrefix.length));
      return notice?.task_id === job.id && notice.status === job.status && !notice.result_available && notice.result === job.resultText;
    } catch { return false; }
  });
}

/** Keep the consuming cursor and the corresponding tool receipt in the same commit. */
export async function consumeJobOutput(store: Store, run: Run, callId: string, jobId: string, reason?: "timed_out" | "interrupted") {
  const cached = await store.toolResult(run.id, callId);
  if (cached) return cached;
  const owner = agentIdentity(run), db = store.db;
  const job = await store.run(jobId, run.projectId);
  if (!job.background || (job.sessionId ?? "") !== (run.sessionId ?? "") ||
      (run.parentRunId && job.parentRunId !== run.id) || job.payload.inherited || job.payload.imported)
    throw new AppError("后台任务不存在", 404, "JOB_NOT_FOUND");
  const prior = backgroundRead(store, owner, job.id);
  const frame = backgroundOutput(store, job, prior?.cursor ?? 0, null);
  const observed = taskResultReady(job) ? taskNoticeKey(job) : null;
  const terminal = frame.result ? observed : null;
  const alreadyDelivered = terminal && (terminal === prior?.terminal || legacyNoticeDelivered(run, job, callId, terminal));
  const result = { job_id: job.id, status: frame.status, label: frame.label, progress: frame.progress,
    text: renderJobOutput(frame.lines), cursor: frame.cursor,
    ...(frame.more ? { more: true } : {}), ...(frame.dropped ? { dropped: true } : {}),
    ...(frame.result && !alreadyDelivered ? { result: frame.result } : {}),
    ...(reason && !taskResultReady(job) ? { wait: reason } : {}) };
  const data = JSON.stringify(result);
  await db.batch([
    db.prepare(`INSERT INTO tool_receipts(run_id,call_id,result,created_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND project_id=? AND lease_token=? AND input_version=? AND status='running')
      ON CONFLICT(run_id,call_id) DO NOTHING`).bind(run.id, callId, data, new Date().toISOString(),
      run.id, run.projectId, run.leaseToken, run.inputVersion),
    db.prepare(`INSERT INTO background_job_reads(job_id,owner,cursor,terminal,observed_terminal) SELECT ?,?,?,?,? WHERE changes()=1
      ON CONFLICT(job_id,owner) DO UPDATE SET cursor=MAX(cursor,excluded.cursor),
        terminal=COALESCE(excluded.terminal,terminal),observed_terminal=COALESCE(excluded.observed_terminal,observed_terminal)`)
      .bind(job.id, owner, frame.cursor, terminal, observed),
  ]);
  const receipt = await store.toolResult(run.id, callId);
  if (receipt) return receipt;
  const current = await store.run(run.id, run.projectId);
  throw new AppError("任务已停止或收到新输入", 409, current.inputVersion !== run.inputVersion ? "AGENT_STEER" : "RUN_STOPPED");
}

export function streamJobOutput(request: Request, store: Store, job: Run) {
  const supplied = request.headers.get("Last-Event-ID") ?? new URL(request.url).searchParams.get("after") ?? "";
  let cursor = /^\d+$/.test(supplied) && Number.isSafeInteger(Number(supplied)) ? Number(supplied) : 0;
  let controller: ReadableStreamDefaultController<Uint8Array>, timer: ReturnType<typeof setTimeout>, closed = false;
  let lastFrame = "";
  const encoder = new TextEncoder();
  function stop() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    request.signal.removeEventListener("abort", stop);
    controller.close();
  }
  const poll = async () => {
    if (request.signal.aborted) { stop(); return; }
    try {
      if (closed) return;
      if ((controller.desiredSize ?? 0) > 0) {
        const current = await store.run(job.id, job.projectId);
        if (closed) return;
        const frame = backgroundOutput(store, current, cursor);
        const serialized = JSON.stringify(frame);
        if (frame.lines.length || serialized !== lastFrame) {
          controller.enqueue(encoder.encode("id: " + frame.cursor + "\ndata: " + serialized + "\n\n"));
          cursor = frame.cursor;
          lastFrame = serialized;
        }
        if (frame.result) { stop(); return; }
        if (frame.more) { timer = setTimeout(poll, 0); return; }
      }
      timer = setTimeout(poll, 350);
    } catch (error) {
      if (!closed) { closed = true; request.signal.removeEventListener("abort", stop); controller.error(error); }
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; request.signal.addEventListener("abort", stop, { once: true }); void poll(); },
    cancel() { closed = true; clearTimeout(timer); request.signal.removeEventListener("abort", stop); },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" } });
}
