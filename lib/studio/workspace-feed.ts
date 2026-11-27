import type { Store } from "./store";
import type { ExecutionStep, HistoryPage, WorkspaceDelta, WorkspaceFrame, WorkspaceSnapshot } from "./types";

export function encodeWorkspaceFrame(frame: WorkspaceFrame) {
  const cursor = frame.type === "snapshot" ? frame.snapshot.cursor : frame.cursor;
  return "id: " + cursor + "\ndata: " + JSON.stringify(frame) + "\n\n";
}

export function streamWorkspace(request: Request, store: Store, projectId: string, userId: string, sessionId = "") {
  const resume = request.headers.get("Last-Event-ID")?.trim() || new URL(request.url).searchParams.get("after");
  let cursor = resume && /^\d+$/.test(resume) && Number.isSafeInteger(Number(resume)) ? Number(resume) : undefined;
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, controller: ReadableStreamDefaultController<Uint8Array>;
  let lastSent = 0;
  const encoder = new TextEncoder();
  const cleanup = () => {
    if (stopped) return false;
    stopped = true;
    clearTimeout(timer);
    request.signal.removeEventListener("abort", stop);
    return true;
  };
  const stop = () => { if (cleanup()) controller.close(); };
  const stream = new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
      const poll = () => {
        if (stopped || request.signal.aborted) { stop(); return; }
        if ((controller.desiredSize ?? 0) <= 0) { timer = setTimeout(poll, 180); return; }
        try {
          const { frame, active } = store.workspaceFrame(projectId, userId, cursor, sessionId);
          if (frame) {
            controller.enqueue(encoder.encode((lastSent ? "" : "retry: 800\n") + encodeWorkspaceFrame(frame)));
            cursor = frame.type === "snapshot" ? frame.snapshot.cursor : frame.cursor;
            lastSent = Date.now();
          } else if (Date.now() - lastSent >= 15000) {
            controller.enqueue(encoder.encode((lastSent ? "" : "retry: 800\n") + ": heartbeat\n\n"));
            lastSent = Date.now();
          }
          timer = setTimeout(poll, active ? 180 : 400);
        } catch (error) {
          if (cleanup()) controller.error(error);
        }
      };
      request.signal.addEventListener("abort", stop, { once: true });
      poll();
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}

function upsert<T, Key>(before: T[], changes: T[] | undefined, key: (value: T) => Key) {
  if (!changes?.length) return before;
  const rows = new Map(before.map((item) => [key(item), item]));
  for (const item of changes) rows.set(key(item), item);
  return [...rows.values()];
}

export function mergeExecutionSteps(existing: ExecutionStep[], updates: ExecutionStep[]) {
  if (!updates.length) return existing;
  return upsert(existing, updates, (item) => item.seq).sort((a, b) => a.seq - b.seq);
}

/** Each entity is its committed value at cursor. Overlap with a command response is safe. */
export function applyWorkspaceDelta(before: WorkspaceSnapshot | null, delta: WorkspaceDelta): WorkspaceSnapshot | null {
  if (!before || before.project.id !== delta.projectId || (before.sessionId ?? "") !== (delta.sessionId ?? "") || before.cursor < delta.after) return null;
  if (delta.cursor <= before.cursor) return before;
  const removed = delta.removedReplies?.length ? new Set(delta.removedReplies) : undefined;
  const replies = removed ? before.replies.filter((reply) => !removed.has(reply.id)) : before.replies;
  const artifacts = delta.removedArtifacts?.length ? before.artifacts.filter(({ id }) => !delta.removedArtifacts!.includes(id)) : before.artifacts;
  return {
    ...before, cursor: delta.cursor, project: delta.project ?? before.project,
    chatQueue: delta.chatQueue ?? before.chatQueue,
    sessions: delta.sessions ?? before.sessions,
    teamTasks: delta.teamTasks ?? before.teamTasks,
    workflow: delta.workflow ?? before.workflow,
    activeBackgroundTasks: delta.activeBackgroundTasks ?? before.activeBackgroundTasks,
    deliveries: upsert(before.deliveries ?? [], delta.deliveries, (delivery) => delivery.id),
    artifacts: upsert(artifacts, delta.artifacts, (item) => item.id),
    messages: upsert(before.messages, delta.messages, (item) => item.id),
    runs: upsert(before.runs, delta.runs, (item) => item.id),
    steps: delta.steps?.length ? mergeExecutionSteps(before.steps, delta.steps) : before.steps,
    replies: upsert(replies, delta.replies, (item) => item.id),
    stepCounts: delta.stepCounts ? { ...before.stepCounts, ...delta.stepCounts } : before.stepCounts,
    changesByRun: delta.changesByRun ? { ...before.changesByRun, ...delta.changesByRun } : before.changesByRun,
  };
}

export function prependHistory(before: WorkspaceSnapshot, page: HistoryPage): WorkspaceSnapshot {
  return {
    ...before, historyBefore: page.historyBefore, messages: upsert(page.messages, before.messages, (row) => row.id),
    runs: upsert(page.runs, before.runs, (row) => row.id), replies: upsert(page.replies, before.replies, (row) => row.id),
    steps: mergeExecutionSteps(page.steps, before.steps), stepCounts: { ...page.stepCounts, ...before.stepCounts },
    changesByRun: { ...page.changesByRun, ...before.changesByRun },
    deliveries: upsert(page.deliveries ?? [], before.deliveries, (row) => row.id),
  };
}
