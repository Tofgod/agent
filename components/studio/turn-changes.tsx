import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileDiff, LoaderCircle, X } from "lucide-react";
import type { FileComparison, FileDiffHunk, TurnFileChange } from "@/lib/studio/types";
import { api } from "./settings";

export function TurnChanges({ changes, onOpen }: { changes: TurnFileChange[]; onOpen: (file: TurnFileChange) => void }) {
  const item = (file: TurnFileChange) => (
    <button className="turn-change-link" key={file.id} title={file.path} onClick={() => onOpen(file)}>
      <span>{file.path.split("/").pop()}</span><ChevronRight size={12}/>
    </button>
  );
  return <div className="turn-changes">
    {changes.length === 1
      ? <div className="turn-change-label"><FileDiff size={14}/><span>本轮改动</span>{item(changes[0])}</div>
      : <details>
        <summary className="turn-change-label"><FileDiff size={14}/><span>本轮改动 · {changes.length} 个文件</span><ChevronDown size={12}/></summary>
        <div className="turn-change-list">{changes.map(item)}</div>
      </details>}
  </div>;
}

function Hunk({ hunk }: { hunk: FileDiffHunk }) {
  let oldLine = hunk.oldStart, newLine = hunk.newStart;
  return <div className="diff-hunk">
    {hunk.lines.map((line, index) => {
      const prefix = line[0];
      const marker = prefix === "\\" ? "" : prefix;
      const oldNumber = prefix === "-" || prefix === " " ? oldLine++ : "";
      const newNumber = prefix === "+" || prefix === " " ? newLine++ : "";
      return <div className="diff-line" data-change={prefix === "+" ? "added" : prefix === "-" ? "removed" : "context"} key={index}>
        <span className="diff-line-number">{oldNumber}</span><span className="diff-line-number">{newNumber}</span>
        <span className="diff-marker">{marker}</span><span>{prefix === "\\" ? "文件末尾无换行" : line.slice(1)}</span>
      </div>;
    })}
  </div>;
}

function MediaVersion({ file }: { file: NonNullable<Extract<FileComparison, { kind: "media" }>["after"]> }) {
  if (file.kind === "image") return <img src={file.url} alt="素材版本"/>;
  if (file.kind === "audio") return <audio src={file.url} controls preload="metadata"/>;
  return <video src={file.url} controls playsInline preload="metadata"/>;
}

export function TurnComparison({ projectId, runId, file, onClose }: {
  projectId: string; runId: string; file: TurnFileChange; onClose: () => void;
}) {
  const [comparison, setComparison] = useState<FileComparison>(), [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(""); setComparison(undefined);
    const url = "/projects/" + projectId + "/runs/" + runId + "/changes/" + file.id + "?through=" + file.afterVersion;
    void api<FileComparison>(url, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setComparison(result); })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [projectId, runId, file.id, file.afterVersion, attempt]);
  const change = comparison ?? file;
  return <section className="workspace-pane turn-comparison" aria-label="文件改动对比">
    <div className="file-toolbar">
      <span className="file-name" title={change.path}>{change.path.split("/").pop()}</span>
      <span className="comparison-versions">{change.beforeVersion ? "v" + change.beforeVersion : "新建"} → v{change.afterVersion}</span>
      <div className="toolbar-spacer"/>
      <button className="icon-button" aria-label="关闭对比" title="返回文件预览" onClick={onClose}><X size={16}/></button>
    </div>
    {change.previousPath && change.previousPath !== change.path && <div className="comparison-path" title={change.previousPath + " → " + change.path}>
      {change.previousPath} → {change.path}
    </div>}
    <div className="comparison-body">
      {error ? <div className="comparison-note" role="alert">{error} <button className="text-button" onClick={() => setAttempt((value) => value + 1)}>重试</button></div>
        : !comparison ? <div className="comparison-note" role="status"><LoaderCircle className="spinning" size={15} aria-label="读取对比"/></div>
          : comparison.kind === "text" ? <>
            {comparison.truncated && <div className="comparison-note">{comparison.coarse ? "差异较大，以下为两版开头节选" : "差异较长，仅显示部分改动"}</div>}
            {comparison.hunks.length
              ? comparison.hunks.map((hunk, index) => <Hunk key={index} hunk={hunk}/>)
              : <div className="comparison-note">{comparison.beforeVersion ? "文字内容未变化" : "文件为空"}</div>}
          </> : <div className="comparison-media">
            {(comparison.beforeVersion ? ["before", "after"] as const : ["after"] as const).map((side) => (
              <div key={side}>
                <div className="comparison-media-label">{side === "before" ? "改前 · v" + comparison.beforeVersion : "改后 · v" + comparison.afterVersion}</div>
                {comparison[side] ? <MediaVersion file={comparison[side]}/> : <div className="comparison-note">此版本没有可预览素材</div>}
              </div>
            ))}
          </div>}
    </div>
  </section>;
}
