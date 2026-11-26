import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

export function MessageActions({ content, createdAt, onError }: { content: string; createdAt?: string; onError: () => void }) {
  const [copied, setCopied] = useState(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const sent = createdAt ? new Date(createdAt) : undefined;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      clearTimeout(timer.current); setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch { onError(); }
  };
  return <div className={"message-actions " + (createdAt ? "user-message-actions" : "assistant-message-actions")} data-copied={copied || undefined}>
    {sent && Number.isFinite(sent.getTime()) && <time dateTime={createdAt} title={sent.toLocaleString("zh-CN", { hour12: false })}>{sent.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time>}
    <button type="button" aria-label={copied ? "已复制" : createdAt ? "复制消息" : "复制回复"} title={copied ? "已复制" : "复制"} onClick={() => void copy()}>{copied ? <Check size={15}/> : <Copy size={15}/>}</button>
    <span className="visually-hidden" role="status">{copied ? "已复制" : ""}</span>
  </div>;
}
