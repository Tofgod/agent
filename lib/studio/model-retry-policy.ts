import { z } from "zod";
import { isMessagesRoute } from "./deepseek-route";

const policy = z.object({
  mode: z.enum(["normal", "always"]).default("normal"),
  maxRetries: z.number().int().nonnegative().safe().default(5),
  initialDelayMs: z.number().int().min(1).max(2_147_483_647).default(500),
  maxDelayMs: z.number().int().min(1).max(2_147_483_647).default(10_000),
  jitterRatio: z.number().min(0).max(1).default(0.1),
  codes: z.array(z.string().min(1)).default(["MODEL_UNAVAILABLE", "MODEL_RATE_LIMIT", "MODEL_TIMEOUT", "MODEL_EMPTY_RESPONSE"]),
}).strict().refine(({ initialDelayMs, maxDelayMs }) => initialDelayMs <= maxDelayMs);
const config = z.object({ "chat-completions": policy.optional(), messages: policy.optional() }).strict();
export type ModelRetryConfig = Partial<Record<keyof z.infer<typeof config>, z.input<typeof policy>>>;
export type ModelRetryPolicy = z.infer<typeof policy>;

export const defaultModelRetry = policy.parse({});
export const canRetryModelError = (retry: ModelRetryPolicy, code: string) =>
  retry.mode === "always" || retry.codes.includes(code);

export class ModelRetryPolicies {
  private readonly routes: z.infer<typeof config>;
  constructor(value?: ModelRetryConfig) { this.routes = config.parse(value ?? {}); }
  forRoute(baseUrl: string) { return this.routes[isMessagesRoute(baseUrl) ? "messages" : "chat-completions"] ?? defaultModelRetry; }
}

export function scheduledModelDelay(policy: ModelRetryPolicy, attempt: number, providerDelay?: number) {
  if (policy.mode === "normal" && (attempt > policy.maxRetries || (providerDelay !== undefined && providerDelay > policy.maxDelayMs))) return;
  if (providerDelay !== undefined && providerDelay <= policy.maxDelayMs) return providerDelay;
  const exponential = Math.min(policy.initialDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * Math.random();
  return Math.min(exponential * jitter, policy.maxDelayMs);
}

export function modelRetryPolicyKey(policy: ModelRetryPolicy) {
  const backoff = [policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio];
  return JSON.stringify(policy.mode === "always" ? [policy.mode, ...backoff] :
    [policy.mode, policy.maxRetries, [...policy.codes].sort(), ...backoff]);
}

interface RetryRequest {
  id: string;
  baseUrl: string;
  turn: number;
  step: number;
  attempt: number;
  inputVersion: number;
  backoffs?: number;
}
export interface ModelRetryRecord {
  retryId: string;
  requestId: string;
  turn: number;
  step: number;
  inputVersion: number;
  provider: "deepseek-messages" | "deepseek-chat-completions";
  mode: ModelRetryPolicy["mode"];
  policyKey: string;
  retry: number;
  attempt?: number;
  maxRetries?: number;
  delayMs: number;
  failure: { code: string; message: string };
}
const observed = new WeakMap<Error, { policy: ModelRetryPolicy; request: RetryRequest; recovery?: "direct" | "terminal" }>();
export function markModelFailure(error: Error, policy: ModelRetryPolicy, request: RetryRequest, recovery?: "direct" | "terminal") {
  observed.set(error, { policy, request, recovery });
  return error;
}
export function modelFailureDetails(error: unknown) {
  return error instanceof Error ? observed.get(error) : undefined;
}
