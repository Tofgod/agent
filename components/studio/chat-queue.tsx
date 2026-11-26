import { useId, useState } from "react";
import { ChevronDown, ListEnd, Paperclip, Pencil, Send, X } from "lucide-react";
import type { QueuedChat, QueuedChatEdit } from "@/lib/studio/types";

export function ChatQueue({ items, runId, editingId, busy, onEdit, onChange }: {
  items: QueuedChat[]; runId?: string; editingId?: string; busy: boolean;
  onEdit: (item: QueuedChat) => void;
  onChange: (id: string, change: QueuedChatEdit) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const open = items.length < 2 || expanded || Boolean(editingId);
  return <div className="chat-queue-dock">
    {items.length > 1 && <button type="button" className="chat-queue-toggle" aria-expanded={open} aria-controls={listId}
      disabled={Boolean(editingId)} onClick={() => setExpanded(!expanded)}>
      <ListEnd size={15} aria-hidden="true"/><span>{items.length} 条待发消息</span><ChevronDown size={13} aria-hidden="true"/>
    </button>}
    <ul id={listId} className="chat-queue" aria-label="待发消息" hidden={!open}>
      {open && items.map((item) => {
        const names = item.attachments.map((file) => file.path.split("/").pop());
        return <li key={item.requestId} data-editing={editingId === item.requestId || undefined}>
          <ListEnd size={15} aria-hidden="true"/>
          {!!names.length && <span className="queued-files" title={names.join("、")}><Paperclip size={12} aria-hidden="true"/>
            <span>{names[0]}</span>{names.length > 1 && <small>+{names.length - 1}</small>}
          </span>}
          <span className="queued-text" title={item.text}>{item.text}</span>
          {item.targetRunId && <small className="queued-target">本轮下一步</small>}
          {runId && !item.targetRunId && <button className="icon-button" type="button" aria-label="加入当前轮" title="加入当前轮的下一步"
            disabled={busy || editingId === item.requestId} onClick={() => onChange(item.requestId, { action: "steer", version: item.version, runId })}><Send size={14}/></button>}
          <button className="icon-button" type="button" aria-label="编辑待发消息" title="编辑待发消息" disabled={busy} onClick={() => onEdit(item)}><Pencil size={14}/></button>
          <button className="icon-button" type="button" aria-label="撤回待发消息" title="撤回待发消息" disabled={busy}
            onClick={() => onChange(item.requestId, { action: "cancel", version: item.version })}><X size={15}/></button>
        </li>;
      })}
    </ul>
  </div>;
}
