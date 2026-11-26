import { AppError } from "./security";
import type { Store } from "./store";
import type { Run } from "./types";
import type { Database } from "./storage";

const subscriptions = new WeakMap<Database, Map<string, Set<() => void>>>();

/** Publish after the mutation commits. The timer also observes writes from another process. */
export function notifyExecutions(db: Database, projectId: string) {
  const listeners = subscriptions.get(db)?.get(projectId);
  if (listeners?.size) setImmediate(() => { for (const check of listeners) check(); });
}

/** A model request or tool batch shares one cancellation signal for the claimed run. */
export function watchExecution(store: Store, run: Run) {
  const controller = new AbortController();
  const execution = store.db.prepare("SELECT status,lease_token,input_version FROM runs WHERE id=? AND project_id=?").bind(run.id, run.projectId);
  const check = () => {
    controller.signal.throwIfAborted();
    const [current] = execution.rows<{ status: string; lease_token: string; input_version: number }>();
    if (current?.status !== "running" || current.lease_token !== run.leaseToken) throw new AppError("任务已停止", 409, "RUN_STOPPED");
    if (current.input_version !== run.inputVersion) throw new AppError("收到新的输入", 409, "AGENT_STEER");
  };
  const inspect = () => {
    try { check(); } catch (error) { controller.abort(error); }
  };
  const projects = subscriptions.get(store.db) ?? new Map<string, Set<() => void>>();
  subscriptions.set(store.db, projects);
  const listeners = projects.get(run.projectId) ?? new Set<() => void>();
  projects.set(run.projectId, listeners);
  listeners.add(inspect);
  const timer = setInterval(inspect, 500);
  return { signal: controller.signal, check, close: () => {
    clearInterval(timer); listeners.delete(inspect);
    if (!listeners.size) projects.delete(run.projectId);
  } };
}
