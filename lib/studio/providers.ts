import { mcpModelBlocks } from "./tool-output";
import { fetchWithoutRedirect } from "./http";
import { IMAGE_MODELS, reasoningEfforts, type ReasoningEffort, type AgentImage, type AgentMessage, type MediaProvider, type ModelUsage, type ProviderSettings, type VideoReferences } from "./types";
import type { AgentTool } from "./file-tools";
import { parseJsonResponse } from "./contracts";
import { AppError, validateProviderUrl } from "./security";
import type { ZodType } from "zod";
import { CONTEXT_OVERFLOW, ImageBudgetError, imageBudgetError, isContextOverflow, modelUsage, readModelStream, settleModelMessage } from "./model-stream";
import { MODEL_OUTPUT_TOKENS } from "./context-tokens";
import { videoProvider, videoRequestOptions, type VideoOptions } from "./video-input";
import { imageRequestOptions, type ImageOptions, type MediaRatio, type VideoRatio } from "./media-specs";
import { parseToolArguments } from "./tool-history";
import { decodeMessagesResult, isMessagesRoute, messagesEndpoint, normalizeMessagesStream, toMessagesContent } from "./deepseek-messages";
import { FILES_BETA, providerImageFile } from "./deepseek-files";
import type { Database } from "./storage";
import { deepSeekCatalogCapabilities, type MessagesReplayBlock, type MessagesSeries } from "./deepseek-history";
export { videoDurationLimits, videoProvider } from "./video-input";

export function retryAfter(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return;
  const delay = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}
export class ModelRequestError extends AppError {
  constructor(message: string, status: number, code: string, public retryAfterMs?: number, public providerRequestId?: string) { super(message, status, code); }
}

export interface ModelCall {
  system: string; input: unknown; schema?: ZodType; temperature?: number; maxTokens?: number;
  images?: string[];
}
export type ModelFunction = <T = unknown>(call: ModelCall) => Promise<T>;
async function deepSeekResponse(settings: ProviderSettings, messages: AgentMessage[] | unknown[], options: Record<string, unknown>, signal?: AbortSignal,
  features: { files?: boolean; series?: MessagesSeries; thinking?: boolean } = {}) {
  if (!settings.textApiKey) throw new AppError("请先在设置中连接 DeepSeek", 409, "MODEL_NOT_CONFIGURED");
  const base = validateProviderUrl(settings.textBaseUrl);
  const native = isMessagesRoute(base);
  const endpoint = native ? messagesEndpoint(base) : base.endsWith("/chat/completions") ? base : base + "/chat/completions";
  const thinking = features.thinking === true && (native || Boolean(settings.textReasoningEffort));
  const effort = thinking ? settings.textReasoningEffort : undefined;
  const model = { model: settings.textModel, thinking: { type: thinking ? "enabled" : "disabled" } };
  const declared = features.series?.tools ?? options.tools as AgentTool[] | undefined;
  const body = native ? {
    ...model, ...(effort ? { output_config: { effort } } : {}), system: features.series?.leadingSystem ?? (messages[0] as AgentMessage | undefined)?.content,
    messages: toMessagesContent(messages.slice(1) as AgentMessage[], { endpoint, model: settings.textModel, thinking, updates: features.series?.updates }),
    max_tokens: options.max_tokens, stream: options.stream ?? false,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(declared?.length ? { tools: declared.map(({ function: entry, ...tool }) => ({
      name: entry.name, description: entry.description, input_schema: entry.parameters, ...("deferred" in tool && tool.deferred ? { defer_loading: true } : {}),
    })) } : {}),
  } : { ...model, ...(effort ? { reasoning_effort: effort } : {}), messages, stream: false, ...options };
  const response = await fetchWithoutRedirect(endpoint, {
    method: "POST", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000),
    headers: { Authorization: "Bearer " + settings.textApiKey, "Content-Type": "application/json", ...(native ? { "anthropic-version": "2023-06-01" } : {}),
      ...(native && features.files ? { "anthropic-beta": FILES_BETA } : {}) },
    body: JSON.stringify(body),
  }).catch((error) => {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof AppError) throw error;
    const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
    const detail = error instanceof Error ? error.message + ((error as Error & { cause?: { code?: string } }).cause?.code ? "（" + (error as Error & { cause?: { code?: string } }).cause!.code + "）" : "") : "网络请求失败";
    throw new AppError(timeout ? "模型响应超时" : "连接 DeepSeek 失败：" + sanitize(detail, settings), 502, timeout ? "MODEL_TIMEOUT" : "MODEL_UNAVAILABLE");
  });
  if (!response.ok) {
    const raw = await response.text();
    let fault: { message?: unknown } | undefined;
    try { fault = JSON.parse(raw)?.error; } catch {}
    const imageBudget = [400, 413, 422].includes(response.status) ? imageBudgetError(fault) : undefined;
    if (imageBudget) throw imageBudget;
    const overflow = [400, 413, 422].includes(response.status) && isContextOverflow(fault ?? raw);
    const code = overflow ? CONTEXT_OVERFLOW : response.status === 429 ? "MODEL_RATE_LIMIT" : response.status >= 500 ? "MODEL_UNAVAILABLE" :
      [401, 403].includes(response.status) ? "MODEL_AUTH" : "MODEL_ERROR";
    let detail = overflow ? "模型上下文超过供应商限制" : typeof fault?.message === "string" ? fault.message : raw;
    if (response.status === 400 && /tool_calls|tool_call_id/.test(detail)) detail = "对话上下文的工具回执不完整，执行结果已保留，请重试继续";
    throw new ModelRequestError("DeepSeek 请求失败 (" + response.status + ")：" + sanitize(detail, settings), response.status, code,
      retryAfter(response.headers), response.headers.get("x-request-id") || response.headers.get("request-id") || undefined);
  }
  return response;
}
async function requestDeepSeek(settings: ProviderSettings, messages: AgentMessage[] | unknown[], options: Record<string, unknown>) {
  const response = await deepSeekResponse(settings, messages, options);
  if (isMessagesRoute(settings.textBaseUrl)) {
    const result = decodeMessagesResult(await response.json() as Parameters<typeof decodeMessagesResult>[0]);
    return settleModelMessage(result.content, result.tools, result.finish);
  }
  const body = await response.json() as { choices?: { finish_reason?: string; message?: AgentMessage }[] };
  const choice = body.choices?.[0];
  if (choice?.finish_reason === "length") throw new AppError("模型输出被截断，请缩短单次输出后重试", 502, "MODEL_TRUNCATED");
  if (!choice?.message) throw new AppError("模型未返回消息", 502, "MODEL_RESPONSE_INVALID");
  return choice.message;
}
export function createModel(settings: ProviderSettings): ModelFunction {
  return async <T>(call: ModelCall): Promise<T> => {
    const content = call.images?.length ? [
      { type: "text", text: JSON.stringify(call.input) },
      ...call.images.map((url) => ({ type: "image_url", image_url: { url } })),
    ] : JSON.stringify(call.input);
    const message = await requestDeepSeek(settings, [
      { role: "system", content: call.system + "\n只输出合法 JSON，不要输出 Markdown 围栏。" }, { role: "user", content },
    ], { max_tokens: call.maxTokens ?? 7500, response_format: { type: "json_object" } });
    const value = parseJsonResponse(message.content || "");
    return (call.schema ? call.schema.parse(value) : value) as T;
  };
}
export interface AgentCallOptions { signal?: AbortSignal; onText?: (text: string) => Promise<void>; onUsage?: (usage: ModelUsage) => Promise<void>;
  onFirstOutput?: () => Promise<void>; onOutput?: () => void; onRequestId?: (id: string) => void; resolveImage?: (image: AgentImage) => Promise<string>; providerFiles?: Database;
  messagesSeries?: MessagesSeries; maxTokens?: number; onStreamFrame?: (data: string) => void }
export type AgentFunction = (system: string, messages: AgentMessage[], tools: AgentTool[], options?: AgentCallOptions) => Promise<AgentMessage>;
export type TextModelResolver = (settings: ProviderSettings, signal: AbortSignal) => Promise<{
  id: string; inputModalities: readonly ("text" | "image")[]; thinking: readonly boolean[]; efforts?: readonly ReasoningEffort[];
}>;

/** Resolve the connection and configured capabilities without issuing a completion. */
export const resolveDeepSeekModel: TextModelResolver = async (settings, signal) => {
  signal.throwIfAborted();
  const baseUrl = validateProviderUrl(settings.textBaseUrl);
  if (!settings.textApiKey) throw new AppError("请先在设置中连接 DeepSeek", 409, "MODEL_NOT_CONFIGURED");
  if (settings.textModel !== "deepseek-flash") throw new AppError("当前线路没有此模型", 400, "MODEL_ROUTE_UNAVAILABLE");
  return { id: settings.textModel, inputModalities: new URL(baseUrl).origin === "https://api.deepseek.com" ? ["text", "image"] : ["text"],
    thinking: isMessagesRoute(baseUrl) || new URL(baseUrl).origin === "https://api.deepseek.com" ? [false, true] : [false],
    ...(new URL(baseUrl).origin === "https://api.deepseek.com" ? { efforts: reasoningEfforts } : {}) };
};
export const resolveLiveDeepSeekModel: TextModelResolver = async (settings, signal) => {
  const model = await resolveDeepSeekModel(settings, signal);
  const capabilities = await deepSeekCatalogCapabilities(settings);
  signal.throwIfAborted();
  if (capabilities.unauthorized) throw new AppError("DeepSeek 未接受当前线路的凭据", 409, "MODEL_NOT_CONFIGURED");
  if (capabilities.listed === false) throw new AppError("当前 DeepSeek 线路未列出该模型", 409, "MODEL_ROUTE_UNAVAILABLE");
  return { ...model, ...(capabilities.imageInput !== undefined ? { inputModalities: capabilities.imageInput ? ["text", "image"] : ["text"] } : {}),
    ...(capabilities.efforts ? { efforts: capabilities.efforts } : {}) };
};
const imagePart = (url: string) => ({ type: "image_url", image_url: { url } });
const textPart = (text: string) => ({ type: "text", text });

export function createAgentModel(settings: ProviderSettings): AgentFunction {
  return async (system, messages, tools, options) => {
    const native = isMessagesRoute(settings.textBaseUrl);
    const thinking = settings.textThinking === true && (native || Boolean(settings.textReasoningEffort));
    const chatEndpoint = native ? "" : validateProviderUrl(settings.textBaseUrl).replace(/\/chat\/completions$/, "") + "/chat/completions";
    const history = native ? messages : messages.filter(({ messagesReplay, content, tool_calls }) => !messagesReplay || content || tool_calls?.length);
    const mcpCalls = new Set(history.flatMap(({ tool_calls }) => (tool_calls ?? [])
      .filter((call) => call.function.name.startsWith("mcp_")).map(({ id }) => id)));
    const wire = await Promise.all(history.map(async ({ images, source: _source, outputRef: _outputRef, finishReason: _finishReason, attemptTrace: _attemptTrace, orderedToolContent, tool_calls, messagesReplay, chatReasoning, ...rest }) => {
      const message = { ...rest, ...(!native && thinking && chatReasoning?.endpoint === chatEndpoint && chatReasoning.model === settings.textModel
        && rest.role === "assistant" && tools.length ? { reasoning_content: chatReasoning.text } : {}), ...(native && messagesReplay ? { messagesReplay } : {}), ...(tool_calls ? { tool_calls: tool_calls.map(({ providerId, ...call }) => ({
        ...call, ...(native && providerId ? { providerId } : {}), function: { ...call.function, arguments: call.function.arguments && parseToolArguments(call.function.arguments) ? call.function.arguments : "{}" },
      })) } : {}) };
      let urls: string[] = [];
      if (images?.length) {
        if (!options?.resolveImage) throw new AppError("图片存储不可用，请重新读取图片", 409, "IMAGE_UNAVAILABLE");
        if (message.role === "assistant") throw new AppError("模型输出不能携带输入图片", 400, "MODEL_RESPONSE_INVALID");
        urls = await Promise.all(images.map(options.resolveImage));
      }
      const ordered = orderedToolContent ?? (message.role === "tool" && mcpCalls.has(message.tool_call_id ?? "")
        ? mcpModelBlocks(message.content, images ?? [])?.map((part) => part.type === "text" ? part :
          { type: "image" as const, index: images!.indexOf(part.image) }) : undefined);
      return ordered ? { ...message, content: ordered.flatMap((part): (ReturnType<typeof textPart> | ReturnType<typeof imagePart>)[] =>
        part.type === "text" ? [part] : urls[part.index] ? [imagePart(urls[part.index])] : []) }
        : urls.length ? { ...message, content: [textPart(message.content || ""), ...urls.map(imagePart)] } : message;
    }));
    const files = new Map<string, string>();
    const inline = [{ role: "system", content: system }, ...wire];
    const database = native && settings.textApiKey ? options?.providerFiles : undefined;
    const fileRoot = database ? validateProviderUrl(settings.textBaseUrl) : "";
    let inlineFallback = false;
    const prepared = database ? await Promise.all(inline.map(async (row) => Array.isArray(row.content) ? { ...row,
      content: await Promise.all(row.content.map(async (part) => {
        if (!("image_url" in part)) return part;
        const file = await providerImageFile(database, fileRoot, settings.textApiKey, part.image_url.url, options?.signal);
        if (!file) { inlineFallback = true; return part; }
        files.set(file.key, file.id);
        return { type: "image", source: { type: "file", file_id: file.id } };
      })) } : row)) : inline;
    const request = {
      ...(tools.length ? { tools, tool_choice: "auto" } : {}), max_tokens: options?.maxTokens ?? MODEL_OUTPUT_TOKENS, stream: true, stream_options: { include_usage: true },
    };
    const features = { series: native ? options?.messagesSeries : undefined, thinking };
    let response: Response;
    try { response = await deepSeekResponse(settings, inlineFallback ? inline : prepared, request, options?.signal, { ...features, files: !inlineFallback && files.size > 0 }); }
    catch (error) {
      if (!database || inlineFallback || !files.size || !(error instanceof AppError) || ![400, 404, 422].includes(error.status) ||
          !/file.*(?:expired|not found|missing|deleted)|(?:missing|expired).*file/i.test(error.message)) throw error;
      await database.batch([...files].map(([key, id]) => database.prepare("DELETE FROM provider_files WHERE key=? AND file_id=?").bind(key, id)));
      response = await deepSeekResponse(settings, inline, request, options?.signal, features);
    }
    const requestId = response.headers.get("x-request-id") || response.headers.get("request-id");
    if (requestId) options?.onRequestId?.(requestId);
    const withReplay = (message: AgentMessage, replay: MessagesReplayBlock[] | undefined): AgentMessage => {
      const blocks = replay?.filter(({ type }) => (thinking || type !== "thinking") &&
        (message.finishReason !== "max-tokens" || type !== "tool_use"));
      return blocks?.length ? { ...message,
        messagesReplay: { endpoint: messagesEndpoint(validateProviderUrl(settings.textBaseUrl)), model: settings.textModel, blocks } } : message;
    };
    const withChatReasoning = (message: AgentMessage, reason: unknown): AgentMessage => !native && thinking && typeof reason === "string" && reason
      ? { ...message, chatReasoning: { endpoint: chatEndpoint, model: settings.textModel, text: reason } } : message;
    try {
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        let blocks: MessagesReplayBlock[] | undefined, reasoning = "";
        const message = native
          ? await readModelStream(normalizeMessagesStream(response, (value) => { blocks = value; }, options?.onStreamFrame),
            { ...options, onStreamFrame: undefined })
          : await readModelStream(response, { ...options, onReasoning: thinking ? (delta) => { reasoning += delta; } : undefined });
        return native ? withReplay(message, blocks) : withChatReasoning(message, reasoning);
      }
      if (native) {
        const result = decodeMessagesResult(await response.json() as Parameters<typeof decodeMessagesResult>[0]);
        const message = settleModelMessage(result.content, result.tools, result.finish);
        const usage = modelUsage(result.usage); if (usage) await options?.onUsage?.(usage);
        if (message.content || message.tool_calls?.length || result.replay.length) await options?.onFirstOutput?.();
        if (message.content) await options?.onText?.(message.content);
        return withReplay(message, result.replay);
      }
      const body = await response.json() as { choices?: { finish_reason?: string; message?: AgentMessage & { reasoning_content?: string } }[]; usage?: unknown; error?: unknown };
      const imageBudget = imageBudgetError(body.error);
      if (imageBudget) throw imageBudget;
      const usage = modelUsage(body.usage); if (usage) await options?.onUsage?.(usage);
      const choice = body.choices?.[0];
      if (!choice?.message) throw new AppError("模型没有返回消息", 502, "MODEL_EMPTY_RESPONSE");
      const message = settleModelMessage(choice.message.content, choice.message.tool_calls, choice.finish_reason);
      if (message.content || message.tool_calls?.length) await options?.onFirstOutput?.();
      if (message.content) await options?.onText?.(message.content);
      return withChatReasoning(message, choice.message.reasoning_content);
    } catch (error) {
      if (options?.signal?.aborted) throw options.signal.reason;
      if (error instanceof ImageBudgetError) throw error;
      if (error instanceof AppError) throw new AppError(sanitize(error.message, settings), error.status, error.code);
      throw new AppError("读取模型响应失败", 502, "MODEL_UNAVAILABLE");
    }
  };
}

export interface MediaResult {
  provider: MediaProvider; model: string; baseUrl: string; taskId?: string; requestId?: string; outputUrl?: string;
}
export interface MediaTask {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  outputUrl?: string; error?: string; duration?: number;
  lastFrameUrl?: string; ratio?: string; resolution?: string; fps?: number;
}
export function videoTaskOutput(task: MediaTask) {
  return { outputUrl: task.outputUrl, outputDuration: task.duration, outputLastFrameUrl: task.lastFrameUrl,
    outputRatio: task.ratio, outputResolution: task.resolution, outputFps: task.fps };
}
const AICLUB_BASE = "https://aiclub.zimaocloud.com/model";
const mediaConnections = {
  volcengine: { name: "火山方舟", key: "arkApiKey" },
  minimax: { name: "MiniMax", key: "minimaxApiKey" },
  aiclub: { name: "AI Club", key: "aiclubApiKey" },
} as const;
export function imageProvider(model: ProviderSettings["imageModel"]): MediaProvider {
  return model === IMAGE_MODELS[1] ? "aiclub" : "volcengine";
}
export function mediaBaseUrl(settings: ProviderSettings, provider: MediaProvider) {
  if (provider === "aiclub") return AICLUB_BASE;
  return provider === "volcengine" ? settings.arkBaseUrl : settings.minimaxBaseUrl;
}
export function requireMedia(settings: ProviderSettings, provider: MediaProvider) {
  const connection = mediaConnections[provider], key = settings[connection.key];
  if (!key) throw new AppError("请先在模型设置中填写 " + connection.name + " API Key", 409, "MEDIA_NOT_CONFIGURED");
  return key;
}
function sanitize(value: string, settings: ProviderSettings) {
  for (const key of [settings.textApiKey, ...Object.values(mediaConnections).map(({ key }) => settings[key])]) if (key) value = value.replaceAll(key, "[密钥]");
  return value.slice(0, 280);
}
export class MediaRequestError extends AppError {
  constructor(message: string, status: number, code: string, public submissionRejected: boolean, public retryAfterMs?: number) { super(message, status, code); }
}
interface ProviderBody {
  action?: string;
  duration?: number; ratio?: string; resolution?: string; framespersecond?: number;
  id?: string; task_id?: string; requestId?: string; status?: string; error?: { message?: string; code?: string };
  base_resp?: { status_code?: number; status_msg?: string };
  content?: { video_url?: string; url?: string; last_frame_url?: string };
  data?: { url?: string; error?: { message?: string; code?: string } }[];
  task?: ProviderBody;
}
async function mediaRequest(settings: ProviderSettings, provider: MediaProvider, path: string, options: { method?: string; body?: unknown; baseUrl?: string } = {}): Promise<ProviderBody> {
  const key = requireMedia(settings, provider);
  const base = validateProviderUrl(provider === "aiclub" ? AICLUB_BASE : (options.baseUrl || mediaBaseUrl(settings, provider)));
  const response = await fetchWithoutRedirect(base + path, {
    method: options.method || "GET", signal: AbortSignal.timeout(options.body ? 180000 : 30000),
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  }).catch(() => { throw new MediaRequestError("连接" + mediaConnections[provider].name + "失败", 502, "MEDIA_UNAVAILABLE", false); });
  const raw = await response.text();
  let body: ProviderBody = {}, parsed = true;
  try {
    const value = raw ? JSON.parse(raw) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) parsed = false;
    else body = value;
  } catch { parsed = false; }
  if (!response.ok || body.error || body.base_resp?.status_code) {
    const message = body.error?.message || body.base_resp?.status_msg || raw || response.statusText;
    const code = response.status === 429 ? "MEDIA_RATE_LIMIT" : [401, 403].includes(response.status) ? "MEDIA_AUTH" : response.status >= 500 ? "MEDIA_UNAVAILABLE" : "MEDIA_ERROR";
    throw new MediaRequestError("生成服务请求失败 (" + response.status + ")：" + sanitize(String(message), settings),
      response.ok ? 502 : response.status, code, response.status >= 400 && response.status < 500, retryAfter(response.headers));
  }
  if (!parsed) throw new MediaRequestError("生成服务返回了无法识别的结果", 502, "MEDIA_RESPONSE_INVALID", false);
  return body;
}
function outputUrl(value: unknown): string {
  if (typeof value !== "string") throw new AppError("生成服务未返回素材地址", 502, "MEDIA_RESPONSE_INVALID");
  const url = new URL(value);
  validateProviderUrl(url.origin + url.pathname);
  return url.toString();
}
export async function submitImage(settings: ProviderSettings, prompt: string, ratio: MediaRatio, refs: { uri: string; tag: string }[], options: ImageOptions = {}): Promise<MediaResult> {
  const provider = imageProvider(settings.imageModel);
  const spec = imageRequestOptions(settings.imageModel, ratio, options, refs.length);
  const path = provider === "aiclub" ? "/openApi/v1/images/generations" : "/images/generations";
  const body = await mediaRequest(settings, provider, path, { method: "POST", body: {
    model: settings.imageModel, prompt, response_format: "url", ...spec,
    output_format: spec.output_format ?? (provider === "volcengine" || spec.background === "transparent" ? "png" : undefined),
    ...(refs.length ? { image: refs.map((r) => r.uri) } : {}),
  } });
  const item = body.data?.[0];
  if (item?.error) throw new MediaRequestError("图片生成失败：" + sanitize(item.error.message || String(item.error.code), settings), 422, "PROVIDER_TASK_FAILED", true);
  const requestId = typeof body.requestId === "string" ? body.requestId.slice(0, 200) : undefined;
  return { provider, model: settings.imageModel, baseUrl: mediaBaseUrl(settings, provider), requestId, outputUrl: outputUrl(item?.url) };
}
function videoTaskPath(provider: MediaProvider, taskId: string) {
  const id = encodeURIComponent(taskId);
  if (provider === "aiclub") return "/openApi/doubao/v1/tasks/" + id;
  return provider === "volcengine" ? "/contents/generations/tasks/" + id : "/v2/query/video_generation/" + id;
}
export async function submitVideo(settings: ProviderSettings, prompt: string, input: string | VideoReferences, ratio: VideoRatio | undefined,
  duration: number | undefined, generateAudio?: boolean, options: VideoOptions = {}, draftTaskId?: string): Promise<MediaResult> {
  const model = settings.videoModel, provider = videoProvider(model);
  const refs = typeof input === "string" ? { first: input } : input;
  const spec = videoRequestOptions(model, prompt, refs, duration, ratio, "16:9", { ...options, generate_audio: options.generate_audio ?? generateAudio }, draftTaskId);
  const content: Record<string, unknown>[] = [];
  if (draftTaskId) content.push({ type: "draft_task", draft_task: { id: draftTaskId } });
  if (prompt.trim()) content.push({ type: "text", text: prompt });
  if (refs.first) content.push({ type: "image_url", image_url: { url: refs.first }, role: "first_frame" });
  if (refs.last) content.push({ type: "image_url", image_url: { url: refs.last }, role: "last_frame" });
  for (const url of refs.images ?? []) content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
  for (const url of refs.videos ?? []) content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
  for (const url of refs.audio ?? []) content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
  const path = provider === "aiclub" ? "/openApi/doubao/v1/video" : provider === "volcengine" ? "/contents/generations/tasks" : "/v2/video_generation";
  const body = await mediaRequest(settings, provider, path, { method: "POST", body: { model, content, ...spec } });
  const taskId = provider === "minimax" ? body.task_id : body.id;
  if (typeof taskId !== "string" || !taskId) throw new AppError("生成服务未返回任务编号，请到供应商核对本次提交", 502, "MEDIA_RESPONSE_INVALID");
  return { provider, model, baseUrl: mediaBaseUrl(settings, provider), taskId };
}
export async function queryMediaTask(settings: ProviderSettings, provider: MediaProvider, taskId: string, baseUrl?: string): Promise<MediaTask> {
  const body = await mediaRequest(settings, provider, videoTaskPath(provider, taskId), { baseUrl });
  const task = provider === "minimax" ? body.task : body;
  const status = task?.status;
  if (status && ["failed", "cancelled", "expired"].includes(status)) return {
    status: status === "cancelled" ? "cancelled" : "failed",
    error: sanitize(task?.error?.message || task?.error?.code || (status === "expired" ? "供应商任务已过期" : "供应商任务失败或取消"), settings),
  };
  if (status === "succeeded") return { status, outputUrl: outputUrl(provider === "minimax" ? task?.content?.url : task?.content?.video_url),
    duration: typeof task?.duration === "number" && task.duration > 0 ? task.duration : undefined,
    lastFrameUrl: task?.content?.last_frame_url ? outputUrl(task.content.last_frame_url) : undefined,
    ratio: typeof task?.ratio === "string" ? task.ratio : undefined,
    resolution: typeof task?.resolution === "string" ? task.resolution : undefined,
    fps: typeof task?.framespersecond === "number" && task.framespersecond > 0 ? task.framespersecond : undefined };
  if (status === "queued" || status === "running") return { status };
  throw new AppError("生成服务返回了未知任务状态", 502, "MEDIA_RESPONSE_INVALID");
}
export async function cancelMediaTask(settings: ProviderSettings, provider: MediaProvider, taskId: string, baseUrl?: string) {
  // AI Club only documents task lookup. Ark and MiniMax DELETE may also erase finished records.
  const task = await queryMediaTask(settings, provider, taskId, baseUrl);
  if (provider === "aiclub" || task.status !== "queued") return task;
  const result = await mediaRequest(settings, provider, (provider === "volcengine" ? "/contents/generations/tasks/" : "/v2/video_generation/") + encodeURIComponent(taskId), { method: "DELETE", baseUrl });
  if (result.status === "cancelled" && result.action !== "deleted") return { status: "cancelled" as const };
  if (result.action === "deleted" || result.status === "deleted") throw new AppError("供应商记录在状态变化后被删除，无法确认取消结果", 502, "CANCEL_UNCONFIRMED");
  return queryMediaTask(settings, provider, taskId, baseUrl);
}
