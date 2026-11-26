import { useCallback, useRef, useState } from "react";
import { CHAT_ATTACHMENT_LIMIT, type ChatSubmission } from "@/lib/studio/types";

export type ChatDraft = Omit<ChatSubmission, "requestId"> & { requestId?: string };
export const emptyChatDraft: ChatDraft = { text: "", attachmentIds: [] };
const draftKey = (projectId: string) => "mujian.chat-draft." + projectId;

function readDraft(projectId: string): ChatDraft {
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey(projectId)) || "null") as ChatDraft | null;
    if (typeof saved?.text === "string" && Array.isArray(saved.attachmentIds) &&
      saved.attachmentIds.length <= CHAT_ATTACHMENT_LIMIT && saved.attachmentIds.every((id) => typeof id === "string")) {
      return { text: saved.text, attachmentIds: saved.attachmentIds, requestId: typeof saved.requestId === "string" ? saved.requestId : undefined,
        mode: saved.mode === "next-turn" ? saved.mode : undefined };
    }
  } catch {}
  return emptyChatDraft;
}

/** A draft and any unacknowledged request belong to the project that created them. */
export function useChatDraft(projectId: string) {
  const [drafts, setDrafts] = useState<Record<string, ChatDraft>>({});
  const latest = useRef(drafts);
  const update = useCallback((id: string, change: (current: ChatDraft) => ChatDraft) => {
    const current = latest.current[id] ?? readDraft(id), next = change(current);
    if (next === current) return;
    latest.current = { ...latest.current, [id]: next };
    try {
      if (next.text || next.attachmentIds.length || next.requestId) localStorage.setItem(draftKey(id), JSON.stringify(next));
      else localStorage.removeItem(draftKey(id));
    } catch {}
    setDrafts(latest.current);
  }, []);
  return { draft: drafts[projectId] ?? readDraft(projectId), update };
}
