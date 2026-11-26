import type { AssistantReply, ExecutionStep, Message, Run } from "./types";
type Row = Record<string, unknown>;
export const toolKey = (runId: string, callId: string) => runId + ":" + callId;
export const chatUserKey = (requestId: string) => "user:" + requestId;
export const isActiveRun = (run?: Run) => run?.status === "queued" || run?.status === "running" || run?.status === "waiting";
export const isLiveWait = (step: ExecutionStep, run?: Run) =>
  step.name === "wait_for_tasks" && step.status === "running" && isActiveRun(run);

export function projectReply(call: Row, eventSeq?: number, response = call.response ? JSON.parse(String(call.response)) : undefined): AssistantReply | undefined {
  const identity = { id: String(call.id), runId: String(call.run_id), eventSeq, createdAt: String(call.created_at) };
  if (call.purpose === "compaction" && call.status === "completed")
    return { ...identity, kind: "compaction", content: "", status: "settled" };
  if (call.purpose !== "creation") return undefined;
  const content = typeof response?.content === "string" && response.content.trim() ? response.content : String(call.visible_text || "");
  if (call.status === "completed" && response?.finishReason === "max-tokens")
    return { ...identity, kind: "reply", content, status: "truncated" };
  if (!content.trim() && call.status !== "started") return undefined;
  return { ...identity, kind: "reply", content,
    status: call.status === "completed" ? "settled" : call.status === "started" ? "running" : "interrupted" };
}

/** Reference: agent-loop/assistant-stream.ts and ui-chat/conversation-nodes/{assistant,event-projection,turn-process}.ts.
 * Keep each attempt's identity and event anchor; adapt their view projection to our durable SQLite records. */
export function projectConversation(calls: Row[], events: Row[]) {
  const requestSeq = new Map<string, number>(), tools = new Map<string, number>(), toolSettlements = new Map<string, number>(), messages = new Map<string, number>();
  for (const event of events) {
    const data = JSON.parse(String(event.data));
    if (event.type === "request" && typeof data.requestId === "string" && !requestSeq.has(data.requestId)) requestSeq.set(data.requestId, Number(event.id));
    if (event.type === "message" && typeof data.id === "string" && !messages.has(data.id)) messages.set(data.id, Number(event.id));
    if (event.type === "step" && typeof data.callId === "string") {
      const key = toolKey(String(data.runId), data.callId);
      if (!tools.has(key) && !(data.status === "interrupted" && data.dispatchedAt === null)) tools.set(key, Number(event.id));
      toolSettlements.set(key, Number(event.id));
    }
  }
  const replies: AssistantReply[] = [];
  for (const call of calls) {
    const response = call.response ? JSON.parse(String(call.response)) : undefined;
    const eventSeq = requestSeq.get(String(call.id)), runId = String(call.run_id);
    // Earlier persisted calls still identify the tools they dispatched; never invent a tool execution.
    for (const [index, tool] of (Array.isArray(response?.tool_calls) ? response.tool_calls : []).entries()) {
      const key = toolKey(runId, String(tool.id));
      if (eventSeq !== undefined && !tools.has(key)) tools.set(key, eventSeq + .5 + index / 100);
    }
    const reply = projectReply(call, eventSeq, response);
    if (reply) replies.push(reply);
  }
  return { replies, tools, toolSettlements, messages };
}
export function descendantRunIds(root: string, runs: Run[]) {
  const children = new Map<string, string[]>();
  for (const run of runs) if (run.parentRunId) children.set(run.parentRunId, [...(children.get(run.parentRunId) || []), run.id]);
  const ids = new Set([root]), queue = [root];
  for (const id of queue) for (const child of children.get(id) || []) if (!ids.has(child)) { ids.add(child); queue.push(child); }
  return ids;
}
export type ConversationNode = { kind: "reply"; reply: AssistantReply } | { kind: "tool"; step: ExecutionStep };
const nodeSeq = (node: ConversationNode) => node.kind === "reply" ? node.reply.eventSeq : node.step.eventSeq;
const nodeTime = (node: ConversationNode) => node.kind === "reply" ? node.reply.createdAt : node.step.startedAt;
function compareNodes(a: ConversationNode, b: ConversationNode) {
  const x = nodeSeq(a), y = nodeSeq(b);
  if (x !== undefined && y !== undefined && x !== y) return x - y;
  return nodeTime(a).localeCompare(nodeTime(b)) || (a.kind === b.kind ? 0 : a.kind === "reply" ? -1 : 1);
}
export function conversationNodes(ids: Set<string>, replies: AssistantReply[], steps: ExecutionStep[]): ConversationNode[] {
  const nodes: ConversationNode[] = [...replies.filter((r) => ids.has(r.runId)).map((reply): ConversationNode => ({ kind: "reply", reply })), ...steps.filter((s) => ids.has(s.runId)).map((step): ConversationNode => ({ kind: "tool", step }))];
  return nodes.sort(compareNodes);
}
type AssistantBlock = Extract<ConversationNode, { kind: "reply" }> | { kind: "process"; key: string; steps: ExecutionStep[] };

export function groupAssistantProcess(nodes: readonly ConversationNode[]): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  for (const node of nodes) {
    if (node.kind === "reply") {
      blocks.push(node);
      continue;
    }
    const previous = blocks.at(-1);
    if (previous?.kind === "process") previous.steps.push(node.step);
    else blocks.push({ kind: "process", key: previous?.reply.id ?? "opening", steps: [node.step] });
  }
  return blocks;
}

export type ChatFlowItem = { key: string; message: Message; nodes?: ConversationNode[]; first: boolean; last: boolean };
/** The reference's admitted steering rows split a turn's flow; later replies must stay after that user input. */
export function projectChatFlow(messages: Message[], runs: Run[], replies: AssistantReply[], steps: ExecutionStep[]): ChatFlowItem[] {
  type Entry = { id: string; message: Message; node?: ConversationNode; seq?: number; time: string; activity?: boolean };
  const entries: Entry[] = [], runMap = new Map(runs.map((r) => [r.id, r]));
  const byRun = new Map<string, ConversationNode[]>();
  const indexNode = (id: string, node: ConversationNode) => {
    let runId: string | null = id;
    while (runId) {
      const nodes = byRun.get(runId);
      if (nodes) nodes.push(node);
      else byRun.set(runId, [node]);
      runId = runMap.get(runId)?.parentRunId ?? null;
    }
  };
  for (const reply of replies) if (reply.kind === "compaction" || reply.status === "truncated" || reply.content.trim())
    indexNode(reply.runId, { kind: "reply", reply });
  for (const step of steps) if (!isLiveWait(step, runMap.get(step.runId))) indexNode(step.runId, { kind: "tool", step });
  for (const message of messages) {
    if (message.role !== "assistant" || !message.runId) {
      const id = message.role === "user" && message.requestId ? chatUserKey(message.requestId) : message.id;
      entries.push({ id, message, seq: message.eventSeq, time: message.createdAt }); continue;
    }
    const nodes = byRun.get(message.runId)?.sort(compareNodes) ?? [], owner = runMap.get(message.runId);
    if (!nodes.length && (message.content || owner?.status !== "done")) entries.push({ id: message.id, message, seq: message.eventSeq, time: message.createdAt });
    for (const node of nodes) entries.push({ id: node.kind === "reply" ? node.reply.id : "tool:" + node.step.seq, message, node,
      seq: nodeSeq(node), time: nodeTime(node) });
    if (owner && isActiveRun(owner)) {
      const users = messages.filter((m) => m.role === "user" && m.createdAt >= owner.createdAt);
      const positions = [...entries.filter((entry) => entry.message.runId === owner.id).map((entry) => entry.seq || 0), ...users.map((m) => m.eventSeq || 0)];
      const times = [...users.map((m) => m.createdAt), ...nodes.map((n) => n.kind === "reply" ? n.reply.createdAt : n.step.startedAt), owner.createdAt].sort();
      entries.push({ id: message.id + ":activity", message, seq: Math.max(message.eventSeq || 0, ...positions) + .9, time: times.at(-1)!, activity: true });
    }
  }
  entries.sort((a, b) => a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq ? a.seq - b.seq : a.time.localeCompare(b.time));
  const flow: ChatFlowItem[] = [];
  const liveRows = new Set<ChatFlowItem>();
  for (const entry of entries) {
    const previous = flow.at(-1), assistant = entry.message.role === "assistant" && Boolean(entry.message.runId);
    if (assistant && previous?.message.role === "assistant" && previous.message.runId === entry.message.runId) {
      if (entry.node) (previous.nodes ??= []).push(entry.node);
    } else flow.push({ key: entry.id, message: entry.message, nodes: assistant ? entry.node ? [entry.node] : [] : undefined, first: true, last: true });
    if (entry.activity) liveRows.add(flow.at(-1)!);
  }
  // An opening placeholder gives way to actual nodes without retaining an empty reply above a steering row.
  const populated = new Set(flow.filter((item) => item.nodes?.length).map((item) => item.message.runId));
  const visible = flow.filter((item) => item.nodes === undefined || item.nodes.length || liveRows.has(item) || !populated.has(item.message.runId));
  const tails = new Map<string, ChatFlowItem>();
  for (const item of visible) {
    if (!item.message.runId || item.message.role !== "assistant") continue;
    const previous = tails.get(item.message.runId);
    if (previous) { previous.last = false; item.first = false; }
    tails.set(item.message.runId, item);
  }
  return visible;
}
