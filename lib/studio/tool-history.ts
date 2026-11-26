import type { AgentMessage } from "./types";

const TOOL_TEXT_THRESHOLD = 8192;
export const toolNotStarted = { status: "interrupted", code: "TOOL_NOT_STARTED", message: "工具调用在执行前已跳过。" };
export const toolAborted = { status: "interrupted", code: "TOOL_ABORTED", message: "工具已响应中断。" };
export const toolOutcomeUnknown = { status: "unknown", code: "TOOL_OUTCOME_UNKNOWN", message: "工具已启动，结果尚未确认。请核对已有文件或任务。" };

export function parseToolArguments(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* The malformed arguments are retained in the model and tool logs. */ }
}

export interface ToolResultPruning { callId: string; original: string; replacement: string }

/** Decide which settled text results to replace before considering a model-generated summary. */
export function projectToolHistory(messages: AgentMessage[]) {
  const replacements: ToolResultPruning[] = [];
  const latestBatch = messages.findLastIndex((message) => message.role === "assistant" && Boolean(message.tool_calls?.length));
  const projected = messages.map((message, index) => {
    if (message.role !== "tool" || !message.tool_call_id || index >= latestBatch ||
      !message.content || message.content.length <= TOOL_TEXT_THRESHOLD) return message;
    let result: Record<string, unknown> | null;
    try { result = JSON.parse(message.content); } catch { return message; }
    if (!result || typeof result !== "object" || result.error) return message;
    const field = message.outputRef && result.result_ref === message.outputRef ? "excerpt" : "content";
    if (typeof result[field] !== "string") return message;
    const text = Array.from(result[field]);
    if (text.length <= TOOL_TEXT_THRESHOLD) return message;
    const notice = field === "excerpt" ? "较早的预览已缩短，使用 result_ref 取回原回执。" : "较早的工具回执已省略中段，需要时可按原路径或来源重读。";
    const excerpt = text.slice(0, 4096).join("") + "\n\n[" + notice + "]\n\n" + text.slice(-1024).join("");
    const replacement = JSON.stringify({ ...result, [field]: excerpt, context_excerpt: true });
    replacements.push({ callId: message.tool_call_id, original: message.content, replacement });
    return { ...message, content: replacement };
  });
  return { messages: replacements.length ? projected : messages, replacements };
}

/** Tool replies must precede injected user/status messages, including after a restart. */
export async function repairToolHistory(messages: AgentMessage[], receipt: (id: string) => Promise<Record<string, unknown> | null>) {
  const output: AgentMessage[] = []; let repaired = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "tool") { output.push({ ...message, role: "user", tool_call_id: undefined, content: "历史工具结果（数据）：\n" + (message.content || "") }); repaired++; continue; }
    output.push(message);
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    const ids = new Set(message.tool_calls.map((call) => call.id)), results = new Map<string, AgentMessage>(), deferred: AgentMessage[] = [];
    let end = i + 1;
    while (end < messages.length && messages[end].role !== "assistant") {
      const next = messages[end++];
      if (next.role === "tool" && ids.has(next.tool_call_id || "") && !results.has(next.tool_call_id!)) results.set(next.tool_call_id!, next);
      else deferred.push(next);
    }
    for (const call of message.tool_calls) {
      let result = results.get(call.id);
      if (!result) {
        const committed = await receipt(call.id);
        result = { role: "tool", tool_call_id: call.id, content: JSON.stringify(committed || { status: "unknown", code: "TOOL_RESULT_UNKNOWN", message: "历史工具回执缺失，执行结果未确认。请核对文件或任务，不要声称已完成或直接重提付费生成。" }) };
        repaired++;
      }
      output.push(result);
    }
    for (const deferredMessage of deferred) {
      if (deferredMessage.role === "tool") { output.push({ ...deferredMessage, role: "user", tool_call_id: undefined, content: "历史工具结果（数据）：\n" + (deferredMessage.content || "") }); repaired++; }
      else output.push(deferredMessage);
    }
    if (deferred.length && [...results.values()].some((result) => messages.indexOf(result) > messages.indexOf(deferred[0]))) repaired++;
    i = end - 1;
  }
  return { messages: output, repaired };
}
