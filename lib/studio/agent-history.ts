import { repairToolHistory, toolNotStarted, toolOutcomeUnknown } from "./tool-history";
import type { Store } from "./store";
import type { AgentMessage, AgentState, Run } from "./types";

export function interruptedAssistant(response: unknown, text: string): AgentMessage | undefined {
  const stored = typeof response === "string" ? JSON.parse(response) as AgentMessage : undefined;
  if (!text && !stored?.messagesReplay) return;
  return { role: "assistant", content: text || null, ...(stored?.messagesReplay ? { messagesReplay: stored.messagesReplay } : {}) };
}

export async function inheritConversation(store: Store, previous: Run): Promise<AgentState | undefined> {
  const saved = previous.payload.agent;
  if (!saved) return;
  let messages = saved.messages.slice(0, saved.unadmittedInputStart);
  if (saved.pendingRequest) {
    const attempt = await store.modelCall(previous, saved.pendingRequest.id);
    const purpose = attempt && JSON.parse(String(attempt.request)).purpose;
    if (purpose === "creation" && attempt?.status === "completed" && attempt.response) {
      const response = JSON.parse(String(attempt.response)) as AgentMessage;
      if (response.content?.trim() || response.tool_calls?.length || response.messagesReplay || response.chatReasoning) messages = [...messages, response];
    } else if (purpose === "creation" && attempt && (attempt.status === "interrupted" ||
      (attempt.status === "started" && ["cancelled", "paused"].includes(previous.status)))) {
      const assistant = interruptedAssistant(attempt.response, String(attempt.visible_text ?? ""));
      if (assistant) messages = [...messages, assistant];
    }
  }
  if (previous.status !== "done" || saved.pendingRequest || previous.payload.archivedFork) {
    const interruptedCalls = new Set(messages.findLast((message) => message.role === "assistant")?.tool_calls?.map((call) => call.id) ?? []);
    const repaired = await repairToolHistory(messages, async (id) => {
      const result = await store.toolHistoryResult(previous.id, id);
      if (result?.status === "pending") return null;
      if (!result && previous.payload.archivedFork && interruptedCalls.has(id))
        return store.toolStepDispatched(previous.id, id) ? toolOutcomeUnknown : toolNotStarted;
      if (!result && previous.agentRevision && interruptedCalls.has(id) && !store.toolStepDispatched(previous.id, id))
        return toolNotStarted;
      return result;
    });
    messages = repaired.messages;
  }
  const last = messages.findLast((message) => message.role === "assistant");
  return { ...saved, messages, unadmittedInputStart: undefined, unadmittedInputIds: undefined, childNotices: {}, waitingFor: undefined, waitingForJob: undefined, waitingForInputUntil: undefined, waitingForTasksUntil: undefined, waitingInputVersion: undefined, pendingRequest: undefined,
    finalReply: undefined, finalReplyReason: undefined, contextRecovery: undefined, contextOverflow: undefined, compactionBypass: undefined, pressureCompactions: undefined, artifactIds: [], toolIndex: last?.tool_calls?.length ?? 0,
    admittedTools: undefined, toolRequestId: undefined,
    repeatToolCall: undefined, pendingNotices: undefined, toolConcludesTurn: undefined };
}
