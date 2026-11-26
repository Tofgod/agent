import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JobOutputFrame } from "@/lib/studio/background-jobs";

export function JobOutput({ url }: { url: string }) {
  const [frame, setFrame] = useState<JobOutputFrame>();
  const [lines, setLines] = useState<JobOutputFrame["lines"]>([]);
  const [disconnected, setDisconnected] = useState(false);
  const [dropped, setDropped] = useState(false);
  const content = useRef<HTMLDivElement>(null), follow = useRef(true);
  useEffect(() => {
    const stream = new EventSource(url);
    stream.onmessage = (event) => {
      const next = JSON.parse(event.data) as JobOutputFrame;
      setFrame(next);
      setDisconnected(false);
      if (next.dropped) setDropped(true);
      if (next.lines.length) setLines((old) => [...old, ...next.lines.filter((line) => line.seq > (old.at(-1)?.seq ?? 0))].slice(-512));
      if (next.result) stream.close();
    };
    stream.onerror = () => setDisconnected(true);
    return () => stream.close();
  }, [url]);
  useEffect(() => {
    if (follow.current && content.current) content.current.scrollTop = content.current.scrollHeight;
  }, [lines]);
  return <div className="job-output">
    {(dropped || disconnected) && <small>{disconnected ? "正在重连" : "部分早期记录已超出保留范围"}</small>}
    <div className="job-output-scroll" ref={content} tabIndex={0} aria-label="任务输出"
      onScroll={({ currentTarget }) => { follow.current = currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight < 28; }}>
      {lines.map(({ seq, line, channel, fragment }, index) => {
        const previous = lines[index - 1], next = lines[index + 1];
        const start = !previous?.fragment || previous.channel !== channel || previous.line.endsWith("\n");
        const newline = !line.endsWith("\n") && (!fragment || next && next.channel !== channel);
        return <span key={seq}>{channel === "stderr" && start && <small>stderr · </small>}{line}{newline && "\n"}</span>;
      })}
      {!lines.length && <small>{frame?.label || "读取输出…"}</small>}
    </div>
    {frame?.result?.error && <small>{frame.result.error}</small>}
  </div>;
}

export function JobOutputDetails({ url, label, title, status }: {
  url: string; label: React.ReactNode; title?: string; status?: string;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="background-menu-file job-output-trigger" aria-expanded={open} title={title}
      onClick={() => setOpen((value) => !value)}>
      <ChevronRight size={12} aria-hidden="true"/>
      {label}
      {status && <small>{status}</small>}
    </button>
    {open && <JobOutput key={url} url={url}/>}
  </>;
}
