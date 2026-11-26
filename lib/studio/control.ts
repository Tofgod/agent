import type { Store, ToolCaller } from "./store";
import type { ProviderSettings, Run } from "./types";
import { AppError } from "./security";
import { cancelMediaTask, queryMediaTask } from "./providers";

export async function controlTaskFromTool(store: Store, target: Run, action: "pause" | "resume" | "cancel", settings: ProviderSettings, caller: ToolCaller) {
  if (target.projectId !== caller.run.projectId) throw new AppError("只能控制当前项目的任务", 403, "TASK_NOT_REACHABLE");
  const cached = await store.toolResult(caller.run.id, caller.callId);
  if (cached) return cached;
  await store.assertTaskControl(caller.run, target);
  await controlRun(store, target, action, settings, caller);
  const receipt = await store.toolResult(caller.run.id, caller.callId);
  if (receipt) return receipt;
  const actor = await store.run(caller.run.id, caller.run.projectId);
  if (actor.leaseToken !== caller.run.leaseToken || actor.status !== "running") throw new AppError("任务已停止", 409, "RUN_STOPPED");
  if (actor.inputVersion !== caller.run.inputVersion) throw new AppError("收到新的输入", 409, "AGENT_STEER");
  throw new AppError("任务已更新，请重新操作", 409, "RUN_CHANGED");
}

export async function controlRun(store: Store, run: Run, action: "pause" | "resume" | "cancel" | "resubmit", settings: ProviderSettings, caller?: ToolCaller) {
  run = await store.run(run.id, run.projectId);
  if (run.payload.inherited) throw new AppError("这是继承的执行记录，请在当前对话发起新的任务", 409, "INHERITED_RUN");
  if (run.payload.imported) throw new AppError("这是归档中的任务记录，请在对话中创建新的任务", 409, "ARCHIVED_RUN");
  if (action === "pause" || action === "cancel") {
    await store.controlTree(run, action, caller);
    return;
  }
  store.assertActiveSession(run.projectId, run.sessionId ?? "");
  if (!run.parentRunId && store.activeRoot(run.projectId, run.sessionId ?? "", run.id)) throw new AppError("请先暂停当前任务", 409, "PROJECT_BUSY");
  if (run.payload.submissionUnknown && action !== "resubmit") throw new AppError("本次提交结果未知，请先核对供应商任务，再重新提交", 409, "SUBMISSION_UNKNOWN");
  let payload = run.payload;
  if (action === "resubmit" && (run.leaseUntil > Date.now() || payload.cancellation && ["checking", "running", "unknown"].includes(payload.cancellation.state) && payload.providerTaskId))
    throw new AppError("原提交仍在执行或尚未核对，不能再次付费提交；请继续获取原任务结果", 409, "SUBMISSION_UNSETTLED");
  if (action === "resubmit" && (payload.providerTaskId || payload.outputUrl))
    throw new AppError("已有供应商任务或生成结果，请使用继续获取原结果", 409, "SUBMISSION_EXISTS");
  payload = { ...payload, cancellation: undefined, stoppedBySessionArchive: undefined, agentInterrupted: undefined };
  if (action === "resubmit") payload = { ...payload, submissionUnknown: false, providerTaskId: undefined, outputUrl: undefined, outputDuration: undefined, pendingArtifactId: undefined, submissionId: undefined };
  else if (payload.providerTaskId && payload.mediaProvider && !payload.outputUrl && run.status === "failed") {
    const task = await queryMediaTask(settings, payload.mediaProvider, payload.providerTaskId, payload.providerBaseUrl);
    if (task.status === "failed" || task.status === "cancelled") payload = { ...payload, providerTaskId: undefined, pendingArtifactId: undefined, submissionUnknown: false };
  }
  if (run.status === "done") {
    if (caller) await store.recordCompletedControl(run, caller);
    return;
  }
  await store.resumeTree(run, payload, caller);
}

export async function reconcileCancellation(store: Store, run: Run, settings: ProviderSettings) {
  if (!await store.claimCancellation(run)) return;
  const current = await store.run(run.id, run.projectId);
  try {
    const task = await cancelMediaTask(settings, current.payload.mediaProvider!, current.payload.providerTaskId!, current.payload.providerBaseUrl);
    const state = task.status === "succeeded" ? "completed" : task.status === "queued" ? "checking" : task.status;
    const queryOnly = current.payload.mediaProvider === "aiclub";
    const detail = queryOnly && (state === "checking" || state === "running")
      ? "本地已停止，AI Club 任务仍" + (state === "running" ? "在生成" : "在排队") + "，可继续获取结果"
      : state === "completed" ? "供应商已生成，可继续获取结果" : state === "running" ? "供应商正在生成，无法取消；可继续获取结果" : state === "cancelled" ? "供应商已确认取消" : state === "failed" ? "供应商任务已失败" : "供应商仍在排队，等待核对取消结果";
    await store.settleCancellation(current, { state, detail, attempts: (current.payload.cancellation?.attempts || 0) + 1, checkedAt: new Date().toISOString() }, task);
  } catch (error) {
    await store.settleCancellation(current, { state: "unknown", detail: "本地已停止，供应商状态未确认；可核对状态或继续获取结果", attempts: (current.payload.cancellation?.attempts || 0) + 1, checkedAt: new Date().toISOString() });
  } finally { await store.releaseLease(current); }
}
