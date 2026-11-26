import { AppError, safeError } from "./security";
import type { Store } from "./store";
import type { Run } from "./types";
import { canRetryModelError, defaultModelRetry, modelFailureDetails, modelRetryPolicyKey, scheduledModelDelay, type ModelRetryRecord } from "./model-retry-policy";
import { isMessagesRoute } from "./deepseek-route";

export async function failRun(store: Store, lease: Run, error: unknown) {
  const current = await store.run(lease.id, lease.projectId);
  if (current.leaseToken !== lease.leaseToken || ["paused", "cancelled", "done"].includes(current.status)) return current;
  const code = error instanceof AppError ? error.code : "EXECUTION_ERROR";
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 0;
  const observed = modelFailureDetails(error);
  const request = observed?.request;
  if (request && request.inputVersion !== current.inputVersion)
    return store.updateRun(current, { status: "queued", label: "处理新消息", nextAttemptAt: 0 });
  const policy = observed?.policy ?? defaultModelRetry;
  const modelFailure = ["agent", "maintenance"].includes(current.stage) && (Boolean(observed) || canRetryModelError(policy, code));
  const retryable = ["MEDIA_DOWNLOAD_FAILED", "MEDIA_UNAVAILABLE", "MEDIA_RATE_LIMIT"].includes(code) ||
    (current.stage === "agent" && code === "MODEL_TRUNCATED") ||
    Boolean(current.payload.providerTaskId && (status === 429 || status >= 500));
  const attempts = request?.attempt ?? current.attempts + 1;
  const backoff = (request?.backoffs ?? attempts - 1) + 1;
  const advisedDelay = (error as { retryAfterMs?: unknown })?.retryAfterMs;
  const providerDelay = typeof advisedDelay === "number" && Number.isFinite(advisedDelay) && advisedDelay > 0 ? advisedDelay : undefined;
  if (request && observed.recovery === "direct" && !current.payload.submissionUnknown) {
    return store.updateRun(current, { status: "queued", label: "重试回复", attempts, nextAttemptAt: 0,
      payload: { ...current.payload, modelRetry: undefined, modelDirectRetry: request.id } });
  }
  const delay = modelFailure ? (observed?.recovery !== "terminal" && canRetryModelError(policy, code) ? scheduledModelDelay(policy, backoff, providerDelay) : undefined) : retryable && attempts <= 3
    ? providerDelay ?? [2000, 10000, 30000][Math.min(2, attempts - 1)] * (0.8 + Math.random() * 0.4) : undefined;
  const retry = delay !== undefined && !current.payload.submissionUnknown;
  const limit = modelFailure ? policy.maxRetries : 3;
  const message = safeError(error) + (current.payload.submissionUnknown ? "。本次提交结果未知，请先到供应商核对；重新提交可能重复计费。" : "");
  const modelRetry: ModelRetryRecord | undefined = retry && request ? {
    retryId: [current.id, request.turn, request.step].join(":"), requestId: request.id,
    turn: request.turn, step: request.step, inputVersion: request.inputVersion,
    provider: isMessagesRoute(request.baseUrl) ? "deepseek-messages" : "deepseek-chat-completions",
    mode: policy.mode, policyKey: modelRetryPolicyKey(policy), retry: backoff, ...(backoff !== attempts ? { attempt: attempts } : {}),
    ...(policy.mode === "normal" ? { maxRetries: limit } : {}),
    delayMs: delay, failure: { code, message },
  } : undefined;
  return store.updateRun(current, { status: retry ? "waiting" : "failed", attempts, error: message, errorCode: code,
    label: retry ? Math.ceil(delay / 1000) + "秒后重试（" + (modelFailure ? backoff : attempts) + (modelFailure && policy.mode === "always" ? "" : "/" + limit) + "）" : "执行停止",
    nextAttemptAt: retry ? Date.now() + delay : 0,
    ...(modelRetry || current.payload.modelRetry || current.payload.modelDirectRetry
      ? { payload: { ...current.payload, modelRetry, modelDirectRetry: undefined } } : {}),
  });
}
