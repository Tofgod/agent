import { createParser } from "eventsource-parser";
import type { AgentMessage, AgentToolCall, ModelUsage } from "./types";
import { AppError } from "./security";

const MAX_MODEL_OUTPUT_BYTES = 1024 * 1024;
const MODEL_STREAM_IDLE_MS = 60_000;
export const CONTEXT_OVERFLOW = "CONTEXT_WINDOW_EXCEEDED";
export const IMAGE_OFFLOAD_REQUIRED = "IMAGE_OFFLOAD_REQUIRED";

export class ImageBudgetError extends AppError {
  constructor(public offloadImages: number) {
    super("模型要求减少当前请求中的图片", 400, IMAGE_OFFLOAD_REQUIRED);
  }
}

export function imageBudgetError(error: unknown): ImageBudgetError | undefined {
  if (!error || typeof error !== "object") return;
  const { code, type, offload_images, offloadImages } = error as Record<string, unknown>;
  if (![code, type].some((value) => typeof value === "string" &&
    [IMAGE_OFFLOAD_REQUIRED, "IMAGE_COUNT_LIMIT_EXCEEDED", "TOO_MANY_IMAGES", "IMAGE_BUDGET_EXCEEDED"].includes(value.toUpperCase()))) return;
  const count = offload_images ?? offloadImages;
  return new ImageBudgetError(typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : 1);
}

export function isContextOverflow(error: unknown): boolean {
  const fields = typeof error === "object" && error !== null ? error as Record<string, unknown> : { message: error };
  const detail = [fields.code, fields.type, fields.message].filter((part) => typeof part === "string").join(" ");
  return /\bcontext[\s_-](?:length|window)[\s_-](?:exceeds?|exceeded|overflow(?:ed)?|limit[\s_-]exceeded)\b/i.test(detail) ||
    /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail) ||
    /\b(?:request|input|prompt|messages?)\b.{0,64}\b(?:exceeds?|exceeded|too (?:long|large))\b.{0,48}\b(?:context(?: window| length)?|for (?:the|this) model)\b/i.test(detail);
}

/** Both wire formats must have a complete assistant message before tools may be dispatched. */
export function settleModelMessage(content: unknown, toolCalls: unknown, finish: unknown): AgentMessage {
  if (finish === "length") {
    const text = typeof content === "string" ? content : null;
    if (text && Buffer.byteLength(text) > MAX_MODEL_OUTPUT_BYTES) throw new AppError("单次模型正文过大，请拆分文件写入", 502, "MODEL_TRUNCATED");
    return { role: "assistant", content: text, finishReason: "max-tokens" };
  }
  if (["aborted", "insufficient_system_resource"].includes(String(finish))) throw new AppError("模型服务中断了本次响应", 502, "MODEL_UNAVAILABLE");
  if (finish === "content_filter") throw new AppError(typeof content === "string" && content || "模型服务拒绝了本次请求", 502, "MODEL_REFUSED");
  if (finish !== "stop" && finish !== "tool_calls") throw new AppError("模型返回了未知的结束状态", 502, "MODEL_RESPONSE_INVALID");
  if (content != null && typeof content !== "string") throw new AppError("模型回复正文格式无效", 502, "MODEL_RESPONSE_INVALID");
  const calls: unknown = toolCalls ?? [];
  if (!Array.isArray(calls) || (finish === "tool_calls") !== Boolean(calls.length))
    throw new AppError("模型工具调用与结束状态不一致", 502, "MODEL_RESPONSE_INVALID");
  const ids = new Set<string>();
  let outputBytes = Buffer.byteLength(content || "");
  for (const call of calls) {
    if (call?.type !== "function" || typeof call.id !== "string" || !call.id.trim() ||
        typeof call.function?.name !== "string" || !call.function.name.trim() || typeof call.function.arguments !== "string")
      throw new AppError("模型返回了不完整的工具调用", 502, "MODEL_RESPONSE_INVALID");
    if (ids.has(call.id)) throw new AppError("模型返回了重复的工具调用编号", 502, "MODEL_RESPONSE_INVALID");
    ids.add(call.id);
    outputBytes += Buffer.byteLength(call.id) + Buffer.byteLength(call.function.name) + Buffer.byteLength(call.function.arguments);
    if (outputBytes > MAX_MODEL_OUTPUT_BYTES) throw new AppError("单次模型正文过大，请拆分文件写入", 502, "MODEL_TRUNCATED");
  }
  if (outputBytes > MAX_MODEL_OUTPUT_BYTES) throw new AppError("单次模型正文过大，请拆分文件写入", 502, "MODEL_TRUNCATED");
  return { role: "assistant", content: content || null, ...(calls.length ? { tool_calls: calls } : {}) };
}

export function modelUsage(value: unknown): ModelUsage | undefined {
  if (!value || typeof value !== "object") return;
  const raw = value as Record<string, unknown>;
  const valid = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  if (!valid(raw.prompt_tokens) || !valid(raw.completion_tokens)) return;
  return { inputTokens: raw.prompt_tokens, outputTokens: raw.completion_tokens,
    totalTokens: valid(raw.total_tokens) ? raw.total_tokens : raw.prompt_tokens + raw.completion_tokens,
    ...(valid(raw.prompt_cache_hit_tokens) ? { cachedInputTokens: raw.prompt_cache_hit_tokens } : {}),
    ...(valid(raw.prompt_cache_write_tokens) ? { cacheWriteInputTokens: raw.prompt_cache_write_tokens } : {}) };
}
export async function readModelStream(response: Response, options: { signal?: AbortSignal; idleMs?: number;
  onText?: (text: string) => Promise<void>; onUsage?: (usage: ModelUsage) => Promise<void>;
  onFirstOutput?: () => Promise<void>; onOutput?: () => void; onStreamFrame?: (data: string) => void; onReasoning?: (delta: string) => void } = {}): Promise<AgentMessage> {
  if (!response.body) throw new AppError("模型没有返回响应流", 502, "MODEL_RESPONSE_INVALID");
  const reader = response.body.getReader(), decoder = new TextDecoder(), calls = new Map<number, AgentToolCall>();
  let content = "", finish = "", ended = false, bytes = 0;
  const events: string[] = [], parser = createParser({ onEvent: (event) => events.push(event.data) });
  const abort = () => { void reader.cancel(options.signal?.reason).catch(() => {}); };
  options.signal?.addEventListener("abort", abort, { once: true });
  async function readChunk() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AppError("模型响应流长时间没有收到数据", 502, "MODEL_TIMEOUT")), options.idleMs ?? MODEL_STREAM_IDLE_MS);
    });
    try { return await Promise.race([reader.read(), timeout]); }
    finally { clearTimeout(timer); }
  }
  let outputBytes = 0, reasoningBytes = 0, emitted = false; const encoder = new TextEncoder();
  async function frame(data: string) {
    if (!data) return;
    options.onStreamFrame?.(data);
    if (data === "[DONE]") { ended = true; return; }
    let value;
    try { value = JSON.parse(data); } catch { throw new AppError("模型响应流格式无效", 502, "MODEL_RESPONSE_INVALID"); }
    if (value.error) {
      const budget = imageBudgetError(value.error);
      if (budget) throw budget;
      if (isContextOverflow(value.error)) throw new AppError("模型上下文超过供应商限制", 400, CONTEXT_OVERFLOW);
      throw new AppError("模型响应中断：" + String(value.error.message || "未知错误").slice(0, 280), 502, "MODEL_UNAVAILABLE");
    }
    const usage = modelUsage(value.usage); if (usage) await options.onUsage?.(usage);
    const choice = value.choices?.[0]; if (!choice) return;
    const delta = choice.delta || {};
    outputBytes += encoder.encode((typeof delta.content === "string" ? delta.content : "") + (typeof delta.refusal === "string" ? delta.refusal : "")).byteLength;
    const toolDeltas = delta.tool_calls ?? [];
    if (!Array.isArray(toolDeltas)) throw new AppError("模型工具调用格式无效", 502, "MODEL_RESPONSE_INVALID");
    for (const item of toolDeltas) {
      if (!item || (item.type != null && item.type !== "function") ||
          [item.id, item.function?.name, item.function?.arguments].some((part) => part != null && typeof part !== "string"))
        throw new AppError("模型工具调用格式无效", 502, "MODEL_RESPONSE_INVALID");
      outputBytes += encoder.encode((item.id || "") + (item.function?.name || "") + (item.function?.arguments || "")).byteLength;
    }
    if (outputBytes > MAX_MODEL_OUTPUT_BYTES) throw new AppError("单次模型正文过大，请拆分文件写入", 502, "MODEL_TRUNCATED");
    const produced = Boolean(delta.content || delta.refusal || delta.reasoning_content || toolDeltas.length);
    if (produced) options.onOutput?.();
    if (!emitted && produced) {
      emitted = true;
      await options.onFirstOutput?.();
    }
    if (options.onReasoning && typeof delta.reasoning_content === "string") {
      reasoningBytes += encoder.encode(delta.reasoning_content).byteLength;
      if (reasoningBytes > MAX_MODEL_OUTPUT_BYTES) throw new AppError("单次模型推理输出过大", 502, "MODEL_TRUNCATED");
      options.onReasoning(delta.reasoning_content);
    }
    if (typeof delta.content === "string") { content += delta.content; await options.onText?.(content); }
    if (typeof delta.refusal === "string") { content += delta.refusal; await options.onText?.(content); }
    for (const item of toolDeltas) {
      if (!Number.isSafeInteger(item.index) || item.index < 0) throw new AppError("模型工具调用编号无效", 502, "MODEL_RESPONSE_INVALID");
      const call = calls.get(item.index) || { id: "", type: "function" as const, function: { name: "", arguments: "" } };
      if (item.id) call.id += item.id;
      if (typeof item.function?.name === "string") call.function.name += item.function.name;
      if (typeof item.function?.arguments === "string") call.function.arguments += item.function.arguments;
      calls.set(item.index, call);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  try {
    while (!ended) {
      options.signal?.throwIfAborted();
      const next = await readChunk(); options.signal?.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 32 * 1024 * 1024) throw new AppError("模型响应协议数据过大", 502, "MODEL_TRUNCATED");
      parser.feed(decoder.decode(next.value, { stream: true }));
      for (const event of events) { await frame(event); if (ended) break; }
      events.length = 0;
    }
    if (!ended || !finish) throw new AppError("模型响应流意外结束，未执行未完成的工具调用", 502, "MODEL_UNAVAILABLE");
    const tools = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    return settleModelMessage(content, tools, finish);
  } finally {
    options.signal?.removeEventListener("abort", abort);
    // A stalled peer can leave its asynchronous teardown pending. Release our read immediately.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
