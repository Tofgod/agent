"use client";
import { ChevronDown, ChevronRight, Clapperboard, FileText, Film, Folder, Image as ImageIcon, LoaderCircle, MoreHorizontal, Music2, Plus, Users } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "./settings";
import { Modal } from "./modal";
import type { Artifact } from "@/lib/studio/types";
import { PROJECT_FOLDERS } from "@/lib/studio/project-layout";
type Node = { name: string; path: string; children: Map<string, Node>; file?: Artifact };
export const projectFileDragType = "application/x-doman-project-file";

type FileAction = { kind: "create"; folder: string } | { kind: "rename" | "remove"; file: Artifact };

export function ProjectFiles({ projectId, projectTitle, files, selected, folders, toggle, open, onCreated, readOnly }: {
  projectId: string; readOnly: boolean; onCreated: (file: Artifact) => void;
  projectTitle: string; files: Artifact[]; selected: string | null; folders: Record<string, boolean>;
  toggle: (path: string) => void; open: (id: string) => void;
}) {
  const [action, setAction] = useState<FileAction>();
  const [name, setName] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [menu, setMenu] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!action || action.kind === "remove") return;
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      if (action.kind === "rename") input.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [action]);
  const begin = (next: FileAction) => {
    setName(next.kind === "rename" ? next.file.path.split("/").at(-1)! : "");
    setError("");
    setAction(next);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!action || busy) return;
    const value = name.trim();
    if (action.kind !== "remove" && (!value || /[/\\]/.test(value) || value.startsWith("."))) { setError("请输入文件名"); return; }
    setBusy(true);
    setError("");
    const root = "/projects/" + projectId + "/artifacts";
    try {
      if (action.kind === "create") {
        const path = action.folder + "/" + (/\.md$/i.test(value) ? value : value + ".md");
        const file = await api<Artifact>(root, { method: "POST", body: JSON.stringify({ path }) });
        onCreated(file);
      } else {
        const path = action.kind === "remove" ? null : action.file.path.slice(0, action.file.path.lastIndexOf("/") + 1) + value;
        await api(root + "/" + action.file.id + "/location", { method: "PATCH", body: JSON.stringify({ path, version: action.file.version }) });
      }
      setAction(undefined);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const root: Node = { name: "", path: "", children: new Map() };
  function insert(path: string, file?: Artifact) {
    let parent = root;
    const parts = path.split("/").filter(Boolean);
    for (const part of parts) {
      if (!parent.children.has(part)) parent.children.set(part, { name: part, path: parent.path + "/" + part, children: new Map() });
      parent = parent.children.get(part)!;
    }
    if (file) parent.file = file;
  }
  for (const folder of PROJECT_FOLDERS) insert(folder.path);
  for (const file of files) insert(file.path, file);
  function render(node: Node, depth: number): React.ReactNode {
    if (node.file) {
      const f = node.file;
      const Icon = f.kind === "image" ? ImageIcon : f.kind === "video" || f.kind === "final" ? Film : f.kind === "audio" ? Music2 :
        f.kind === "characters" ? Users : f.kind === "storyboard" ? Clapperboard : FileText;
      return <div className="project-file-entry" key={f.id} onContextMenu={readOnly ? undefined : (event) => { event.preventDefault(); setMenu(f.id); }}>
        <button title={projectTitle + node.path} className={"file-row " + (f.id === selected ? "selected" : "")}
        aria-current={f.id === selected ? "true" : undefined}
        draggable={f.status === "ready"} onDragStart={(event) => {
          event.dataTransfer.setData(projectFileDragType, JSON.stringify({ projectId: f.projectId, fileId: f.id }));
          event.dataTransfer.effectAllowed = "copy";
        }}
        style={{ paddingLeft: 20 + depth * 12 }} onClick={() => open(f.id)}>
        <Icon size={14} strokeWidth={1.6}/><span>{node.name}</span>
        {f.status === "generating" && <LoaderCircle size={12} className="spinning"/>}
        {f.status === "stale" && <span className="file-stale" title="需要更新">·</span>}
        </button>
        {!readOnly && <Popover open={menu === f.id} onOpenChange={(open) => setMenu(open ? f.id : undefined)}>
          <PopoverTrigger className="file-row-action icon-button" aria-label={node.name + "的操作"} title="文件操作">
            <MoreHorizontal size={15}/>
          </PopoverTrigger>
          <PopoverContent className="conversation-popover file-action-menu" align="end" sideOffset={4} aria-label="文件操作">
            <PopoverClose className="conversation-popover-action" disabled={f.locked || f.status === "generating"}
              onClick={() => begin({ kind: "rename", file: f })}>重命名</PopoverClose>
            <PopoverClose className="conversation-popover-action" disabled={f.locked || f.status === "generating"}
              onClick={() => begin({ kind: "remove", file: f })}>删除</PopoverClose>
          </PopoverContent>
        </Popover>}
      </div>;
    }
    const expanded = folders[node.path] ?? depth === 0;
    return <div key={node.path}><div className="project-file-entry"><button className="folder-row" title={node.name} style={{ paddingLeft: 5 + depth * 12 }} onClick={() => toggle(node.path)} aria-expanded={expanded}>
      {expanded ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}<Folder size={14} strokeWidth={1.6}/><span>{node.name}</span>
    </button>{!readOnly && <button type="button" className="file-row-action icon-button" title="新建文档"
      aria-label={"在" + node.name + "中新建文档"} onClick={() => begin({ kind: "create", folder: node.path })}><Plus size={15}/></button>}
    </div>{expanded && [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")).map((child) => render(child, depth + 1))}</div>;
  }
  return <>
    <div className="project-files" aria-label={projectTitle + "的文件"}>{[...root.children.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")).map((node) => render(node, 0))}</div>
    {action && <Modal title={action.kind === "create" ? "新建文档" : action.kind === "rename" ? "重命名文件" : "删除文件"} compact
      onClose={() => { if (!busy) setAction(undefined); }}>
      <form className="conversation-rename" onSubmit={(event) => void submit(event)}>
        {action.kind === "remove" ? <p className="file-remove-name">{action.file.path.split("/").at(-1)}</p> :
          <input ref={input} aria-label="文件名" value={name} maxLength={180} placeholder="文件名" onChange={(event) => setName(event.target.value)}/>}
        {error && <p role="alert" className="conversation-rename-error">{error}</p>}
        <div className="conversation-rename-actions">
          <button type="button" className="button" disabled={busy} onClick={() => setAction(undefined)}>取消</button>
          <button className="button primary" disabled={busy || (action.kind !== "remove" && !name.trim())}>{action.kind === "remove" ? "删除" : "保存"}</button>
        </div>
      </form>
    </Modal>}
  </>;
}
