"use client";
import { useEffect, useState } from "react";
import { Check, ChevronDown, Download, History, LockKeyhole, LockKeyholeOpen, Paperclip, X } from "lucide-react";
import type { Artifact } from "@/lib/studio/types";
import { Modal } from "./modal";
import { TextPreview } from "./text-preview";
import { api } from "./settings";
import { lazy, Suspense } from "react";
const MarkdownEditor = lazy(() => import("./markdown-editor").then((module) => ({ default: module.MarkdownEditor })));
import { documentDraft, refreshDraft, type DocumentDraft } from "@/lib/studio/draft";
type Props = { file: Artifact; artifacts: Artifact[]; onClose: () => void; onSave: (content: string, version: number) => Promise<Artifact>;
  onLock: (locked: boolean) => Promise<void>; onOpen: (id: string) => void; onMake: (intent: "direct" | "frames" | "videos") => void;
  onOpenVersion: (version: number) => void; onOpenCurrent?: () => void;
  attached: boolean; onAttach?: () => void; historical?: boolean };
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function FilePreview({ file, artifacts, onClose, onSave, onLock, onMake, onOpen, onOpenVersion, onOpenCurrent, attached, onAttach, historical }: Props) {
  const [draft, setDraft] = useState(() => documentDraft(file.content, file.version)), [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [versions, setVersions] = useState<{ version: number; createdAt: string }[] | null>(null), [error, setError] = useState("");
  const endpoint = "/projects/" + file.projectId + "/artifacts/" + file.id;
  const dirty = draft.value !== draft.baseContent, conflict = dirty && draft.baseVersion < file.version;
  useEffect(() => {
    if (historical) return;
    try {
      const saved = JSON.parse(localStorage.getItem("mujian.draft." + file.id) || "null") as DocumentDraft | null;
      if (saved && typeof saved.value === "string" && typeof saved.baseContent === "string" && Number.isInteger(saved.baseVersion)) setDraft(saved);
    } catch {}
  }, [file.id, historical]);
  useEffect(() => { setDraft((d) => refreshDraft(d, file.content, file.version)); }, [file.content, file.version, draft.baseVersion]);
  useEffect(() => {
    if (historical) return;
    try { if (dirty) localStorage.setItem("mujian.draft." + file.id, JSON.stringify(draft)); else localStorage.removeItem("mujian.draft." + file.id); } catch {}
  }, [draft, dirty, file.id, historical]);
  const save = async (restoreVersion?: number) => {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const content = restoreVersion === undefined ? draft.value : (await api<Artifact>(endpoint + "?version=" + restoreVersion)).content;
      const saved = await onSave(content, restoreVersion === undefined ? draft.baseVersion : file.version);
      setDraft(documentDraft(saved.content, saved.version)); setVersions(null);
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  };
  const history = async () => {
    try { setVersions(await api<{ version: number; createdAt: string }[]>(endpoint + "/versions?view=index")); }
    catch (e) { setError((e as Error).message); }
  };
  const media = ["image", "video", "audio", "final"].includes(file.kind);
  const filename = file.path.split("/").pop()!;
  return <section className="workspace-pane" aria-label="文件预览与编辑">
    <div className="file-toolbar"><span className="file-name" title={file.path}>{filename}</span>
      {historical ? <span className="version-button">v{file.version}</span> : <button className="version-button" onClick={history} title="历史版本">v{file.version}<ChevronDown size={11}/></button>}<div className="toolbar-spacer"/>
      {onOpenCurrent && <button className="text-button" onClick={onOpenCurrent}>当前版本</button>}
      {!media && !historical && <div className="preview-tabs"><button className={!editing ? "active" : ""} onClick={() => setEditing(false)}>预览</button><button className={editing ? "active" : ""} onClick={() => setEditing(true)}>编辑</button></div>}
      {!historical && <><button className="icon-button" disabled={!onAttach || attached || file.status !== "ready"}
        title={attached ? "已添加到消息" : "添加到消息"} aria-label={attached ? "已添加到消息" : "添加到消息"} onClick={onAttach}>
        {attached ? <Check size={15}/> : <Paperclip size={15}/>}
      </button>
      <button className="icon-button" onClick={() => void onLock(!file.locked)} title={file.locked ? "解锁" : "锁定"} aria-label={file.locked ? "解锁文件" : "锁定文件"}>{file.locked ? <LockKeyhole size={15}/> : <LockKeyholeOpen size={15}/>}</button></>}
      <button className="icon-button" aria-label="下载文件" title="下载" onClick={async () => {
        if (file.url) { const r = await fetch(file.url); downloadBlob(await r.blob(), filename); }
        else downloadBlob(new Blob([draft.value], { type: "text/markdown;charset=utf-8" }), filename);
      }}><Download size={15}/></button>
      <button className="icon-button" onClick={onClose} aria-label="关闭当前文件" title="关闭文件"><X size={17}/></button>
    </div>
    {file.status === "stale" && <div className="file-notice">内容需要更新</div>}
    {conflict && <div className="file-notice conflict-notice"><span>文件已有新版本，当前草稿已保留。</span><div>
      <button className="text-button" onClick={() => setDraft(documentDraft(file.content, file.version))}>载入新版本</button>
      <button className="text-button" onClick={() => setDraft((d) => ({ ...d, baseContent: file.content, baseVersion: file.version }))}>保留草稿</button>
    </div></div>}
    {error && <div className="file-notice" role="alert">{error}</div>}
    <div className="preview-scroll plain-preview">
      {!media ? editing ? <Suspense fallback={null}><MarkdownEditor value={draft.value} readOnly={file.locked} onChange={(value) => setDraft((d) => ({ ...d, value }))} onSave={() => { if (dirty && !saving && !file.locked && !conflict) void save(); }}/></Suspense> :
        <TextPreview text={draft.value} sourcePath={file.path} artifacts={artifacts} onOpen={onOpen}/> :
        <div className="media-preview">{file.url ?
          file.kind === "image" ? <img src={file.url} alt={filename}/> :
          file.kind === "audio" ? <audio src={file.url} controls/> :
          <video key={file.url + file.version} src={file.url} controls playsInline preload="metadata"/> :
          <span>{file.status === "generating" ? "生成中" : "暂无素材"}</span>}</div>}
    </div>
    {dirty ? <div className="file-bottom"><span className="unsaved">未保存</span><div className="toolbar-spacer"/>
      <button className="button" onClick={() => setDraft(documentDraft(file.content, file.version))}>撤销</button>
      <button className="button primary" onClick={() => void save()} disabled={saving || file.locked || conflict}><Check size={14}/>{saving ? "保存中" : "保存"}</button></div> :
      !historical && (file.kind === "script" || file.kind === "storyboard") && <div className="file-bottom">
        {file.kind === "script" ? <button className="button" onClick={() => onMake("direct")}>生成分镜</button> :
          <><button className="button" onClick={() => onMake("frames")}>生成关键帧</button><button className="button primary" onClick={() => onMake("videos")}>制作视频</button></>}
      </div>}
    {versions && <Modal title="历史版本" onClose={() => setVersions(null)}>
      <div className="modal-scroll version-list">{versions.map((v) => <div className="version-row" key={v.version}>
        <History size={15}/><span>v{v.version}</span><time>{new Date(v.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
        {v.version === file.version ? <span className="muted">当前</span> : <>
          <button className="text-button" disabled={saving} aria-label={"查看版本 " + v.version} onClick={() => { setVersions(null); onOpenVersion(v.version); }}>查看</button>
          {!media && <button className="button small" disabled={saving || file.locked} onClick={() => void save(v.version)}>恢复</button>}
        </>}
      </div>)}</div>
    </Modal>}
  </section>;
}
