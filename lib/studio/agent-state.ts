import type { AgentImage, AgentState, Run, RunPayload } from "./types";

export const taskResultReady = (task: Run) => ["done", "failed", "cancelled", "paused"].includes(task.status);
export const taskNoticeKey = (task: Run) => task.generation + ":" + task.status +
  (task.payload.cancellation ? ":" + task.payload.cancellation.state : "");

export function taskResult(task: Run) {
  const structured = task.status === "done" ? task.payload.agent?.structuredResult : undefined;
  return { task_id: task.id, status: task.status, result: task.resultText, error: task.error,
    ...(structured ? { structured } : {}),
    ...(task.payload.cancellation ? { cancellation: task.payload.cancellation } : {}) };
}
export function taskNotice(task: Run, omitClosingText = false) {
  const result = taskResult(task);
  if (omitClosingText) result.result = "";
  return { ...result, ...(omitClosingText ? { closing_text_omitted: true } : {}),
    ...(Buffer.byteLength(JSON.stringify({ text: result.result, structured: result.structured }), "utf8") > 2048 ? {
      result: "", structured: undefined, result_available: true, read_with: "wait_for_tasks",
    } : {}), role: task.agentRole, name: task.payload.agentDefinition?.name };
}

/** A control receipt can acknowledge only the exact status it reported. */
export function acknowledgeTaskControl(state: AgentState, receipt: Record<string, unknown>, tasks: readonly Run[]): AgentState {
  if (receipt.action !== "pause" && receipt.action !== "cancel") return state;
  const task = tasks.find(({ id }) => id === receipt.task_id);
  if (!task || typeof receipt.generation !== "number" || !["paused", "cancelled"].includes(String(receipt.status))) return state;
  const cancellation = receipt.cancellation as { state?: string } | undefined;
  const token = receipt.generation + ":" + receipt.status + (cancellation?.state ? ":" + cancellation.state : "");
  return task.background ? { ...state, backgroundNotices: { ...state.backgroundNotices, [task.id]: token } } :
    { ...state, childNotices: { ...state.childNotices, [task.id]: token } };
}

/** A wait receipt and its acknowledgement enter the same durable checkpoint. */
export function acknowledgeTaskResults(state: AgentState, tasks: readonly Run[]): AgentState {
  const observed = tasks.filter(taskResultReady);
  if (!observed.length) return state;
  const childNotices = { ...state.childNotices }, backgroundNotices = { ...state.backgroundNotices };
  const artifactIds = new Set(state.artifactIds), images = [...(state.messages.at(-1)?.images ?? [])];
  const originalImageCount = images.length;
  for (const task of observed) {
    (task.background ? backgroundNotices : childNotices)[task.id] = taskNoticeKey(task);
    for (const id of task.payload.agent?.artifactIds ?? []) artifactIds.add(id);
    if (task.status !== "done") continue;
    try {
      const result = JSON.parse(task.resultText);
      if (typeof result?.id === "string") artifactIds.add(result.id);
      if (task.payload.inspection && Array.isArray(result?.frames)) {
        for (const frame of result.frames as AgentImage[]) { images.push(frame); artifactIds.add(frame.id); }
      }
    } catch {}
  }
  const messages = images.length > originalImageCount && state.messages.length
    ? [...state.messages.slice(0, -1), { ...state.messages.at(-1)!, images }] : state.messages;
  return { ...state, messages, childNotices, backgroundNotices, artifactIds: [...artifactIds] };
}

export function settleTool(state: AgentState, callId: string, result: unknown, artifactId?: string): AgentState {
  const file = result as { id?: unknown; version?: unknown; files?: { id?: unknown; version?: unknown }[] };
  const observed = [file, ...(Array.isArray(file?.files) ? file.files : [])].filter((f) => typeof f?.id === "string" && typeof f.version === "number");
  return { ...state, toolIndex: state.toolIndex + 1,
    observedVersions: observed.length ? { ...state.observedVersions, ...Object.fromEntries(observed.map((f) => [f.id, f.version])) } : state.observedVersions,
    messages: [...state.messages, { role: "tool", tool_call_id: callId, content: JSON.stringify(result) }],
    artifactIds: artifactId ? [...new Set([...state.artifactIds, artifactId])] : state.artifactIds };
}
export function productionFinished(payload: RunPayload, result: unknown, artifactId?: string): RunPayload {
  const callId = payload.production?.toolCallId || payload.operation?.toolCallId;
  if (!payload.agent || !callId) return payload;
  return { ...payload, agent: settleTool(payload.agent, callId, result, artifactId), production: undefined, operation: undefined, composition: undefined,
    sourceVersions: {} };
}
