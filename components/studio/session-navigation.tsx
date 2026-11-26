import { Archive, ArrowDown, ArrowUp, Check, Pin, PinOff, RotateCcw } from "lucide-react";
import { useRef, useState } from "react";
import type { ProjectSession, SessionActivity, SessionTurnSummary } from "@/lib/studio/types";
import { Modal } from "./modal";

export type SessionChange = { action: "archive"; archived: boolean; stopActivity?: boolean }
  | { action: "pin"; pinned: boolean }
  | { action: "move"; target: string; after: boolean };

export function ManageSessions({ sessions, current, pending, onClose, onOpen, onChange }: {
  sessions: ProjectSession[]; current: string; pending: boolean; onClose: () => void; onOpen: (id: string) => void;
  onChange: (id: string, change: SessionChange) => void;
}) {
  const [filter, setFilter] = useState<"active" | "all" | "archived">("active");
  const moving = useRef<string | null>(null);
  const shown = sessions.filter(({ archived }) => filter === "all" || Boolean(archived) === (filter === "archived"));
  return <Modal title="管理对话" onClose={onClose}>
    <div className="session-manager-filters" aria-label="对话筛选">
      {([ ["active", "使用中"], ["all", "全部"], ["archived", "已归档"] ] as const).map(([key, label]) =>
        <button type="button" className="text-button" aria-pressed={filter === key} key={key} onClick={() => setFilter(key)}>{label}</button>)}
    </div>
    <div className="modal-scroll session-manager-list">
      {!shown.length && <p className="history-no-matches">暂无对话</p>}
      {shown.map((entry) => {
        const siblings = shown.filter((item) => !item.archived && Boolean(item.pinned) === Boolean(entry.pinned));
        const position = siblings.indexOf(entry), previous = siblings[position - 1], next = siblings[position + 1];
        const move = (target: string, after: boolean) => onChange(entry.id, { action: "move", target, after });
        const canDrop = () => {
          const source = sessions.find(({ id }) => id === moving.current);
          return source && source.id !== entry.id && !source.archived && !entry.archived && Boolean(source.pinned) === Boolean(entry.pinned);
        };
        return <div key={entry.id} className="session-manager-row" data-archived={entry.archived || undefined}
          draggable={!entry.archived && !pending} onDragStart={(event) => {
            moving.current = entry.id; event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/x-doman-session", entry.id || "main");
          }} onDragEnd={() => { moving.current = null; }} onDragOver={(event) => { if (canDrop()) event.preventDefault(); }}
          onDrop={(event) => {
            if (!canDrop() || moving.current === null) return;
            event.preventDefault();
            const row = event.currentTarget.getBoundingClientRect();
            onChange(moving.current, { action: "move", target: entry.id, after: event.clientY >= row.top + row.height / 2 });
            moving.current = null;
          }}>
          <button type="button" className="session-manager-title" disabled={entry.archived} title={entry.title} onClick={() => onOpen(entry.id)}>
            {entry.pinned && <Pin size={13} aria-hidden="true"/>}<span>{entry.title}</span>{current === entry.id && <Check size={14} aria-label="当前对话"/>}
          </button>
          <div className="session-manager-actions">
            {!entry.archived && <>
              <button className="icon-button" type="button" disabled={pending || !previous} title="上移" aria-label={"上移 " + entry.title} onClick={() => previous && move(previous.id, false)}><ArrowUp size={14}/></button>
              <button className="icon-button" type="button" disabled={pending || !next} title="下移" aria-label={"下移 " + entry.title} onClick={() => next && move(next.id, true)}><ArrowDown size={14}/></button>
              <button className="icon-button" type="button" disabled={pending} title={entry.pinned ? "取消置顶" : "置顶"}
                aria-label={(entry.pinned ? "取消置顶 " : "置顶 ") + entry.title} onClick={() => onChange(entry.id, { action: "pin", pinned: !entry.pinned })}>
                {entry.pinned ? <PinOff size={14}/> : <Pin size={14}/>}</button>
            </>}
            <button className="icon-button" type="button" disabled={pending} title={entry.archived ? "恢复对话" : "归档对话"}
              aria-label={(entry.archived ? "恢复 " : "归档 ") + entry.title} onClick={() => onChange(entry.id, { action: "archive", archived: !entry.archived })}>
              {entry.archived ? <RotateCcw size={14}/> : <Archive size={14}/>}</button>
          </div>
        </div>;
      })}
    </div>
  </Modal>;
}

export function ConfirmSessionArchive({ activity, pending, onClose, onConfirm }: {
  activity: SessionActivity; pending: boolean; onClose: () => void; onConfirm: () => void;
}) {
  const names = { turn: "对话", agent: "子任务", job: "后台任务" };
  return <Modal title="停止并归档" compact onClose={onClose}>
    <div className="extension-panel">
      <ul className="session-archive-activity">
        {activity.runs.map(({ id, label, kind }) => <li key={id}>{names[kind]} · {label}</li>)}
        {activity.schedules.map(({ id, title }) => <li key={id}>定时任务 · {title}</li>)}
        {activity.pending > 0 && <li>待发消息 · {activity.pending} 条</li>}
      </ul>
      <p>待发消息将取消，定时任务将暂停。恢复对话后可手动继续。</p>
      <div className="extension-actions">
        <button className="button" onClick={onClose} disabled={pending}>取消</button>
        <button className="button primary" onClick={onConfirm} disabled={pending}>停止并归档</button>
      </div>
    </div>
  </Modal>;
}

export function TurnOutline({ turns, onClose, onSelect }: {
  turns: SessionTurnSummary[] | null; onClose: () => void; onSelect: (turn: SessionTurnSummary) => void;
}) {
  return <Modal title="轮次导航" onClose={onClose}>
    <div className="modal-scroll session-outline" aria-busy={!turns}>
      {turns?.length === 0 && <p className="history-no-matches">暂无对话轮次</p>}
      {turns?.map((turn, index) => <button type="button" className="session-outline-row" key={turn.runId} onClick={() => onSelect(turn)}>
        <span>第 {index + 1} 轮</span><div><strong>{turn.prompt || "对话"}</strong>{turn.reply && <small>{turn.reply}</small>}</div>
      </button>)}
    </div>
  </Modal>;
}
