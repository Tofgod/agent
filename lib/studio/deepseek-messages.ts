import { createParser } from "eventsource-parser";
import { AppError } from "./security";
import { parseToolArguments } from "./tool-history";
import type { MessagesReplay, MessagesReplayBlock, MessagesUpdate } from "./deepseek-history";
export { isMessagesRoute, messagesEndpoint } from "./deepseek-route";

type Block = Record<string, unknown>;
interface WireCall { id: string; providerId?: string; function: { name: string; arguments: string } }
interface WireMessage { role: string; content: unknown; tool_call_id?: string; tool_calls?: WireCall[]; messagesReplay?: MessagesReplay }

function assistantBlocks(row: WireMessage, endpoint: string, model: string, thinking: boolean): Block[] {
  const text = typeof row.content === "string" ? row.content : "";
  const tools = (row.tool_calls ?? []).map((call) => ({ type: "tool_use", id: call.providerId ?? call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }));
  const baseline = () => [...(text ? [{ type: "text", text }] : []), ...tools];
  const replay = row.messagesReplay;
  if (!replay) return baseline();
  const replayThinking = thinking && replay.endpoint === endpoint && replay.model === model;
  let cursor = 0;
  const covered = new Set<number>(), output: Block[] = [];
  for (const block of replay.blocks) {
    if (block.type === "thinking") {
      if (replayThinking) output.push(block);
    } else if (block.type === "text") {
      if (!Number.isSafeInteger(block.length) || block.length < 0) return baseline();
      if (block.length) output.push({ type: "text", text: text.slice(cursor, cursor + block.length) });
      cursor += block.length;
    } else {
      const call = tools[block.callIndex];
      if (!call || covered.has(block.callIndex)) return baseline();
      covered.add(block.callIndex); output.push(call);
    }
  }
  return cursor === text.length && covered.size === tools.length ? output : baseline();
}

export function toMessagesContent(history: WireMessage[], options: { endpoint: string; model: string; thinking: boolean; updates?: MessagesUpdate[] }) {
  const rows: { role: "user" | "assistant" | "system"; content: Block[] }[] = [];
  const aliases = new Map<string, string>();
  const updates = new Map(options.updates?.map((update) => [update.after, update]));
  const pendingUpdates: MessagesUpdate[] = [];
  const flushUpdates = () => {
    if (!pendingUpdates.length) return;
    if (rows.at(-1)?.role !== "user") throw new AppError("Messages 更新前需要用户消息或工具回执", 400, "MODEL_RESPONSE_INVALID");
    for (const { system, additions, removals } of pendingUpdates.splice(0)) {
      if (system) rows.push({ role: "system", content: [{ type: "text", text: system }] });
      const changes = [
        ...(additions ?? []).map((name) => ({ type: "tool_addition", tool: { type: "tool_reference", name } })),
        ...(removals ?? []).map((name) => ({ type: "tool_removal", tool: { type: "tool_reference", name } })),
      ];
      if (changes.length) rows.push({ role: "system", content: changes });
    }
  };
  for (const [index, row] of history.entries()) {
    const role = row.role === "assistant" ? "assistant" : "user";
    for (const call of row.tool_calls ?? []) if (call.providerId) aliases.set(call.id, call.providerId);
    const content: Block[] = role === "assistant" ? assistantBlocks(row, options.endpoint, options.model, options.thinking) :
      typeof row.content === "string" ? row.content ? [{ type: "text", text: row.content }] : [] :
      Array.isArray(row.content) ? row.content.map((part): Block => {
        if (part.type !== "image_url") return part;
        const data = String(part.image_url?.url ?? "").match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
        if (!data) throw new AppError("图片内容不能发送到 Messages 接口", 400, "IMAGE_UNAVAILABLE");
        return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
      }) : [];
    if (row.role === "tool") {
      if (!row.tool_call_id) throw new AppError("工具回执缺少调用编号", 400, "MODEL_RESPONSE_INVALID");
      const text = typeof row.content === "string" ? row.content : content[0]?.text;
      let error = false;
      if (typeof text === "string") {
        try { const result = JSON.parse(text); error = Boolean(result?.error || result?.code); } catch { /* Tool text need not contain JSON. */ }
      }
      const id = aliases.get(row.tool_call_id) ?? row.tool_call_id;
      content.splice(0, content.length, { type: "tool_result", tool_use_id: id, content: content.slice(), ...(error ? { is_error: true } : {}) });
    }
    if (content.length) {
      if (role === "assistant") flushUpdates();
      const previous = rows.at(-1);
      if (previous?.role === role) previous.content.push(...content);
      else rows.push({ role, content });
    }
    const update = updates.get(index + 1);
    if (update) pendingUpdates.push(update);
  }
  flushUpdates();
  const pending = new Set<unknown>();
  for (const row of rows) {
    if (row.role === "system") continue;
    if (row.role === "assistant") {
      for (const call of row.content.filter(({ type }) => type === "tool_use")) {
        if (pending.has(call.id)) throw new AppError("Messages 请求包含重复的工具调用编号", 400, "MODEL_RESPONSE_INVALID");
        pending.add(call.id);
      }
      continue;
    }
    const results = row.content.filter(({ type }) => type === "tool_result");
    for (const result of results) {
      if (!pending.delete(result.tool_use_id)) throw new AppError("Messages 请求中的工具回执找不到对应调用", 400, "MODEL_RESPONSE_INVALID");
    }
    if (pending.size) throw new AppError("Messages 请求中的工具调用缺少回执", 400, "MODEL_RESPONSE_INVALID");
    if (results.length) row.content = [...results, ...row.content.filter(({ type }) => type !== "tool_result")];
  }
  if (pending.size) throw new AppError("Messages 请求中的工具调用缺少回执", 400, "MODEL_RESPONSE_INVALID");
  return rows;
}

function invalidMessages(detail: string) {
  return new AppError(detail, 502, "MODEL_RESPONSE_INVALID");
}
function emptyMessages() {
  return new AppError("DeepSeek Messages 未返回内容", 502, "MODEL_EMPTY_RESPONSE");
}
function messagesBlockType(block: unknown) {
  const type = (block as { type?: unknown } | undefined)?.type;
  if (type === "text" || type === "thinking" || type === "tool_use") return type;
  throw new AppError("DeepSeek Messages 返回了不支持的内容块", 502, "MODEL_UNSUPPORTED_CONTENT");
}
function messagesStopReason(reason: unknown) {
  switch (reason) {
    case "end_turn": case "stop_sequence": return "stop";
    case "tool_use": return "tool_calls";
    case "max_tokens": return "length";
    case "refusal": return "content_filter";
    default: throw invalidMessages("Messages 结束状态无效");
  }
}
function objectToolInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidMessages("DeepSeek Messages 的工具参数必须是 JSON 对象");
  return value;
}

const usageFields = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
type MessagesUsage = Partial<Record<typeof usageFields[number], number>>;
function updateMessagesUsage(usage: MessagesUsage | undefined, raw: unknown): MessagesUsage | undefined {
  if (raw === undefined) return usage;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalidMessages("Messages 用量格式无效");
  const fields = raw as Record<string, unknown>, cumulative = { ...usage };
  for (const key of usageFields) {
    const value = fields[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw invalidMessages("Messages 用量字段无效 " + key);
    cumulative[key] = value;
  }
  return cumulative;
}
function modelStreamUsage(usage: MessagesUsage | undefined) {
  if (!usage) return;
  const { input_tokens = 0, output_tokens = 0, cache_read_input_tokens, cache_creation_input_tokens } = usage;
  const promptTokens = input_tokens + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0);
  return { prompt_tokens: promptTokens, completion_tokens: output_tokens, total_tokens: promptTokens + output_tokens,
    ...(cache_read_input_tokens === undefined ? {} : { prompt_cache_hit_tokens: cache_read_input_tokens }),
    ...(cache_creation_input_tokens === undefined ? {} : { prompt_cache_write_tokens: cache_creation_input_tokens }) };
}

export function decodeMessagesResult(body: { content?: { type: string; text?: string; id?: string; name?: string; input?: unknown; thinking?: string; signature?: string }[];
  stop_reason?: string; usage?: Record<string, number> }) {
  if (!Array.isArray(body?.content)) throw invalidMessages("DeepSeek Messages 响应缺少内容列表");
  const blocks = body.content, finish = messagesStopReason(body.stop_reason);
  if (!blocks.length && finish === "stop") throw emptyMessages();
  let callIndex = 0;
  const replay = blocks.map((block): MessagesReplayBlock => {
    switch (messagesBlockType(block)) {
      case "text":
        if (typeof block.text !== "string") throw invalidMessages("Messages 文本块格式无效");
        return { type: "text", length: block.text.length };
      case "thinking":
        if (typeof block.thinking !== "string" || (block.signature !== undefined && typeof block.signature !== "string"))
          throw invalidMessages("Messages 思考块格式无效");
        return { type: "thinking", thinking: block.thinking, ...(block.signature ? { signature: block.signature } : {}) };
      case "tool_use":
        if (finish !== "length") objectToolInput(block.input);
        return { type: "tool_use", callIndex: callIndex++ };
    }
  });
  return { content: blocks.filter((block) => block.type === "text").map((block) => block.text).join(""),
    replay,
    tools: blocks.filter((block) => block.type === "tool_use").map((block) => ({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } })),
    finish, usage: modelStreamUsage(updateMessagesUsage(undefined, body.usage)) };
}

/** Recover only completed signed thinking blocks that can safely be sent on the original Messages route. */
export function interruptedMessagesReplay(frames: readonly { data: string }[], visibleText: string): MessagesReplayBlock[] | undefined {
  const blocks = new Map<number, { type: "text" | "thinking"; text: string; signature: string; closed: boolean }>();
  for (const { data } of frames) {
    let frame;
    try { frame = JSON.parse(data); } catch { break; }
    const index = frame?.index, start = frame?.content_block, delta = frame?.delta;
    if (!Number.isSafeInteger(index) || index < 0) continue;
    if (frame.type === "content_block_start" && (start?.type === "text" || start?.type === "thinking")) {
      if (blocks.has(index)) return;
      blocks.set(index, { type: start.type, text: typeof (start.text ?? start.thinking) === "string" ? start.text ?? start.thinking : "",
        signature: typeof start.signature === "string" ? start.signature : "", closed: false });
      continue;
    }
    const block = blocks.get(index);
    if (!block || block.closed) continue;
    if (frame.type === "content_block_stop") block.closed = true;
    if (frame.type !== "content_block_delta") continue;
    if (block.type === "text" && delta?.type === "text_delta" && typeof delta.text === "string") block.text += delta.text;
    if (block.type === "thinking" && delta?.type === "thinking_delta" && typeof delta.thinking === "string") block.text += delta.thinking;
    if (block.type === "thinking" && delta?.type === "signature_delta" && typeof delta.signature === "string") block.signature += delta.signature;
  }
  const ordered = [...blocks.values()];
  if (ordered.filter(({ type }) => type === "text").map(({ text }) => text).join("") !== visibleText) return;
  if (!ordered.some(({ type, text, signature, closed }) => type === "thinking" && text.trim() && signature && closed)) return;
  return ordered.flatMap((block): MessagesReplayBlock[] => block.type === "text"
    ? block.text ? [{ type: "text", length: block.text.length }] : []
    : block.closed && block.signature && block.text.trim() ? [{ type: "thinking", thinking: block.text, signature: block.signature }] : []);
}

/** Translate Messages streaming frames into the same validated result path used by Chat Completions. */
export function normalizeMessagesStream(response: Response, onReplay?: (blocks: MessagesReplayBlock[]) => void, onStreamFrame?: (data: string) => void): Response {
  if (!response.body) throw emptyMessages();
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  const toolInputs = new Map<number, { index: number; input: object; deltas: string[] }>();
  const open = new Set<number>(), replay = new Map<number, MessagesReplayBlock>();
  let controller: TransformStreamDefaultController<Uint8Array>, bytes = 0, toolIndex = 0;
  let started = false, stopped = false, finish: string | undefined;
  let usage: MessagesUsage | undefined;
  const emit = (data: unknown) => controller.enqueue(encoder.encode("data: " + (data === "[DONE]" ? data : JSON.stringify(data)) + "\n\n"));
  const chunk = (delta: Block, finish_reason?: string) => emit({ choices: [{ delta, finish_reason }] });
  const parser = createParser({ onEvent({ data }) {
    if (stopped) return;
    onStreamFrame?.(data);
    let event;
    try { event = JSON.parse(data); } catch { throw invalidMessages("Messages 响应流格式无效"); }
    if (!event || typeof event !== "object" || Array.isArray(event)) throw invalidMessages("Messages 响应流格式无效");
    if (event.error) { emit({ error: event.error }); return; }
    if (!started && ["content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"].includes(event.type))
      throw invalidMessages("Messages 响应缺少开始帧");
    switch (event.type) {
      case "message_start": {
        if (started) throw invalidMessages("Messages 响应重复发送开始帧");
        started = true;
        usage = updateMessagesUsage(usage, event.message?.usage);
        break;
      }
      case "content_block_start": {
        const block = event.content_block;
        if (!Number.isSafeInteger(event.index) || event.index < 0 || replay.has(event.index) || finish !== undefined)
          throw invalidMessages("Messages 响应块编号或顺序无效");
        const type = messagesBlockType(block);
        open.add(event.index);
        if (type === "text") {
          if (typeof block.text !== "string") throw invalidMessages("Messages 文本块格式无效");
          replay.set(event.index, { type: "text", length: block.text.length });
          if (block.text) chunk({ content: block.text });
        }
        if (type === "thinking") {
          if (typeof block.thinking !== "string" || (block.signature !== undefined && typeof block.signature !== "string"))
            throw invalidMessages("Messages 思考块格式无效");
          replay.set(event.index, { type: "thinking", thinking: block.thinking, ...(block.signature ? { signature: block.signature } : {}) });
          if (block.thinking) chunk({ reasoning_content: block.thinking });
        }
        if (type === "tool_use") {
          if (typeof block.id !== "string" || !block.id.trim() || typeof block.name !== "string" || !block.name.trim())
            throw invalidMessages("Messages 工具调用缺少编号或名称");
          const index = toolIndex++;
          replay.set(event.index, { type: "tool_use", callIndex: index });
          toolInputs.set(event.index, { index, input: objectToolInput(block.input), deltas: [] });
          chunk({ tool_calls: [{ index, id: block.id, type: "function", function: { name: block.name } }] });
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta, block = replay.get(event.index);
        if (!open.has(event.index)) throw new AppError("Messages 增量缺少对应响应块", 502, "MODEL_RESPONSE_INVALID");
        if (delta?.type === "text_delta") {
          if (block?.type !== "text" || typeof delta.text !== "string") throw new AppError("Messages 文本块格式无效", 502, "MODEL_RESPONSE_INVALID");
          block.length += delta.text.length; chunk({ content: delta.text });
        } else if (delta?.type === "thinking_delta") {
          if (block?.type !== "thinking" || typeof delta.thinking !== "string") throw new AppError("Messages 思考块格式无效", 502, "MODEL_RESPONSE_INVALID");
          block.thinking += delta.thinking; chunk({ reasoning_content: delta.thinking });
        } else if (delta?.type === "signature_delta") {
          if (block?.type !== "thinking" || typeof delta.signature !== "string") throw new AppError("Messages 思考签名格式无效", 502, "MODEL_RESPONSE_INVALID");
          block.signature = (block.signature ?? "") + delta.signature;
        } else if (delta?.type === "input_json_delta") {
          const tool = toolInputs.get(event.index);
          if (!tool || typeof delta.partial_json !== "string") throw invalidMessages("Messages 工具参数增量格式无效");
          if (delta.partial_json) tool.deltas.push(delta.partial_json);
          chunk({ tool_calls: [{ index: tool.index, function: { arguments: delta.partial_json } }] });
        } else throw invalidMessages("Messages 响应块的增量格式无效");
        break;
      }
      case "content_block_stop": {
        if (!open.delete(event.index)) throw new AppError("Messages 响应块尚未开始", 502, "MODEL_RESPONSE_INVALID");
        const tool = toolInputs.get(event.index);
        if (tool && !tool.deltas.length) chunk({ tool_calls: [{ index: tool.index, function: { arguments: JSON.stringify(tool.input) } }] });
        break;
      }
      case "message_delta": {
        const reason = event.delta?.stop_reason;
        usage = updateMessagesUsage(usage, event.usage);
        if (reason != null) {
          finish = messagesStopReason(reason);
          chunk({}, finish);
        }
        break;
      }
      case "message_stop":
        if (open.size || finish === undefined) throw invalidMessages("Messages 响应块或结束状态不完整");
        if (!replay.size && finish === "stop") throw emptyMessages();
        if (finish !== "length") {
          for (const { deltas } of toolInputs.values()) {
            if (deltas.length && !parseToolArguments(deltas.join(""))) throw invalidMessages("DeepSeek Messages 的工具参数不是完整的 JSON 对象");
          }
        }
        stopped = true;
        if (usage) emit({ usage: modelStreamUsage(usage) });
        onReplay?.([...replay.values()]);
        emit("[DONE]");
        break;
    }
  } });
  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(data, output) {
      controller = output;
      bytes += data.byteLength;
      if (bytes > 32 * 1024 * 1024) throw new AppError("模型响应协议数据过大", 502, "MODEL_TRUNCATED");
      // Heartbeats must also reset the downstream idle timer.
      output.enqueue(encoder.encode(": activity\n\n"));
      parser.feed(decoder.decode(data, { stream: true }));
    },
    flush(output) { controller = output; parser.feed(decoder.decode()); },
  }));
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}
