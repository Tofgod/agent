import { workflowCommand } from "@/lib/studio/workflow-types";
import { useCallback, useMemo, useRef, useState } from "react";
import { chatUserKey, type ChatFlowItem } from "@/lib/studio/conversation";
import { CHAT_ATTACHMENT_LIMIT, type ChatSubmission, type MessageAttachment, type QueuedChat, type WorkspaceSnapshot } from "@/lib/studio/types";

export type ChatEcho = ChatSubmission & {
  createdAt: string;
  status: "sending" | "accepted" | "failed" | "unconfirmed";
  error?: string;
};

export const showsInTranscript = (input: ChatSubmission) => input.mode !== "next-turn" && input.text !== "/compact" && !workflowCommand(input.text);
const storageKey = (scope: string) => "mujian.chat-echoes." + scope;
const empty: readonly ChatEcho[] = [];

function storedEchoes(scope: string): readonly ChatEcho[] {
  if (!scope) return empty;
  try {
    const entries: unknown = JSON.parse(sessionStorage.getItem(storageKey(scope)) ?? "null");
    if (!Array.isArray(entries)) return empty;
    return entries.filter((entry): entry is ChatEcho => Boolean(entry &&
      typeof entry.requestId === "string" && typeof entry.text === "string" && typeof entry.createdAt === "string" &&
      Array.isArray(entry.attachmentIds) && entry.attachmentIds.length <= CHAT_ATTACHMENT_LIMIT && entry.attachmentIds.every((id: unknown) => typeof id === "string") &&
      ["sending", "accepted", "failed", "unconfirmed"].includes(entry.status)))
      .map((entry) => entry.status === "sending" ? { ...entry, status: "unconfirmed" } : entry);
  } catch { return empty; }
}

export function useChatEchoes(scope: string) {
  const [byScope, setByScope] = useState<Record<string, readonly ChatEcho[]>>({});
  const latest = useRef(byScope);
  const update = useCallback((id: string, transform: (entries: readonly ChatEcho[]) => readonly ChatEcho[]) => {
    const before = latest.current[id] ?? (latest.current[id] = storedEchoes(id));
    const after = transform(before);
    if (after === before) return;
    latest.current = { ...latest.current, [id]: after };
    try {
      if (after.length) sessionStorage.setItem(storageKey(id), JSON.stringify(after));
      else sessionStorage.removeItem(storageKey(id));
    } catch {}
    setByScope(latest.current);
  }, []);
  const entries = useMemo(() => byScope[scope] ?? storedEchoes(scope), [byScope, scope]);
  return { entries, update };
}

type PendingItem = ChatFlowItem & { pending?: { echo?: ChatEcho; steer?: QueuedChat } };

/** Server-backed steering replaces the local echo, then the durable user row replaces both. */
export function mergeChatEchoes(flow: ChatFlowItem[], snapshot: WorkspaceSnapshot, local: readonly ChatEcho[]): PendingItem[] {
  const queued = snapshot.chatQueue ?? [];
  if (!local.length && !queued.some((item) => item.targetRunId)) return flow;
  const visibleIds = new Set(flow.flatMap(({ message }) => message.role === "user" && message.requestId ? [message.requestId] : []));
  const ownedIds = new Set(queued.map(({ requestId }) => requestId));
  const pendingRow = (requestId: string, text: string, attachments: MessageAttachment[], createdAt: string, pending: NonNullable<PendingItem["pending"]>): PendingItem => ({
    key: chatUserKey(requestId), first: true, last: true, pending,
    message: { id: requestId, requestId, projectId: snapshot.project.id, role: "user", agent: null, content: text, runId: null, attachments, artifactIds: [], createdAt },
  });
  const steering = queued.filter((item) => item.targetRunId && !visibleIds.has(item.requestId))
    .map((item) => pendingRow(item.requestId, item.text, item.attachments, item.createdAt ?? "", { steer: item }));
  const artifacts = new Map(snapshot.artifacts.map(({ id, path, kind, version }) => [id, { id, path, kind, version }]));
  const echoes = local.filter(({ requestId }) => !visibleIds.has(requestId) && !ownedIds.has(requestId)).map((entry) =>
    pendingRow(entry.requestId, entry.text, entry.attachmentIds.flatMap((id) => {
      const file = artifacts.get(id);
      return file ? [file] : [];
    }), entry.createdAt, { echo: entry }));
  const tail = flow.at(-1);
  if (echoes.length && tail?.message.role === "assistant" && !tail.nodes?.length && tail.message.runId &&
      !flow.some(({ message }) => message.role === "user" && message.runId === tail.message.runId) &&
      snapshot.runs.some((run) => run.id === tail.message.runId && ["queued", "running", "waiting"].includes(run.status))) {
    return [...flow.slice(0, -1), ...echoes, tail, ...steering];
  }
  return [...flow, ...steering, ...echoes];
}
