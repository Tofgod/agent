"use client";
import { type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode, Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowDown, ArrowUp, Blocks, Check, ChevronDown, ChevronRight, Clapperboard, Command, Download, FileText, Film, Folder, FolderOpen, GitBranch, Image as ImageIcon, Link2, ListOrdered, LoaderCircle, Music2, PanelLeftClose, PanelLeftOpen, PanelRight, Paperclip, Pencil, Pin, Plus, RotateCcw, Search, Settings2, Square, Trash2, Users, X } from "lucide-react";
import { CHAT_ATTACHMENT_LIMIT, STUDIO_NAME, type Artifact, type ChatSubmission, type ExecutionStep, type HistoryMatch, type HistoryPage, type MessageAttachment, type Project, type ProjectSession, type PublicSettings, type QueuedChat, type QueuedChatEdit, type Run, type RunIntent, type SessionActivity, type SessionSearchMatch, type SessionTurnSummary, type TurnFileChange, type WorkspaceFrame, type WorkspaceSnapshot } from "@/lib/studio/types";
import { descendantRunIds, isActiveRun, projectChatFlow } from "@/lib/studio/conversation";
import { applyWorkspaceDelta, prependHistory } from "@/lib/studio/workspace-feed";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { JobOutputDetails } from "./job-output";
import { AssistantTurn } from "./assistant-turn";
import { FilePreview } from "./file-preview";
import { ModelSettings, RequestError, api } from "./settings";
import { ProjectFiles, projectFileDragType } from "./project-files";
import { ResizeHandle } from "./resize-handle";
import { MessageActions } from "./message-actions";
import { emptyChatDraft, useChatDraft, type ChatDraft } from "./chat-drafts";
import { mergeChatEchoes, showsInTranscript, useChatEchoes } from "./chat-echoes";
import { useChatScroll } from "./chat-scroll";
import { TurnChanges, TurnComparison } from "./turn-changes";
import { ChatQueue } from "./chat-queue";
import { Modal } from "./modal";
import type { SkillEntry } from "@/lib/studio/skills";
import { skillCompletion, skillGestures } from "@/lib/studio/skill-gestures";
import { ConfirmSessionArchive, ManageSessions, TurnOutline, type SessionChange } from "./session-navigation";
const StudioExtensions = lazy(() => import("./extensions").then((module) => ({ default: module.StudioExtensions })));
const SkillDocument = lazy(() => import("./extensions").then((module) => ({ default: module.SkillDocument })));
const ExecutionInspector = lazy(() => import("./execution-inspector").then((module) => ({ default: module.ExecutionInspector })));
const agentName = { main: STUDIO_NAME, writer: "编剧", director: "导演" };
type QueueDraft = { requestId: string; version: number; draft: ChatDraft };
function HeaderPopover({ label, trigger, panel, iconOnly = false, children }: {
  label: string; trigger: ReactNode; panel: string; iconOnly?: boolean; children: ReactNode;
}) {
  return <Popover>
    <PopoverTrigger className={iconOnly ? "icon-button conversation-menu-trigger" : "conversation-header-button conversation-menu-trigger"}
      title={label} aria-label={iconOnly ? label : undefined}>
      {trigger}{!iconOnly && <ChevronDown size={12} aria-hidden="true"/>}
    </PopoverTrigger>
    <PopoverContent aria-label={label} align={iconOnly ? "end" : "start"} sideOffset={6} collisionPadding={12}
      className={"conversation-popover " + panel}
      onCloseAutoFocus={(event) => {
        if (document.activeElement !== document.body) event.preventDefault();
      }}>
      {children}
    </PopoverContent>
  </Popover>;
}
function FileIcon({ kind, size = 15 }: { kind: Artifact["kind"]; size?: number }) {
  const Icon = kind === "image" ? ImageIcon : kind === "video" || kind === "final" ? Film : kind === "audio" ? Music2 : kind === "characters" ? Users : kind === "storyboard" ? Clapperboard : FileText;
  return <Icon size={size} strokeWidth={1.6}/>;
}
const scopeKey = (project: string, session = "") => session ? project + "/" + session : project;
const scopedEndpoint = (scope: string, path: string, params = new URLSearchParams()) => {
  const [project, session] = scope.split("/");
  if (session) params.set("session", session);
  return "/projects/" + project + path + (params.size ? "?" + params.toString() : "");
};
export default function Studio() {
  const [projects, setProjects] = useState<Project[]>([]), [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null), [projectId, setProjectId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  const scope = scopeKey(projectId, sessionId);
  const [versionedFile, setVersionedFile] = useState<Artifact | null>(null);
  const previewRequest = useRef(0);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const historyAnchor = useRef<{ node: Element; y: number } | null>(null);
  const jumpMessage = useRef("");
  const pendingSearchJump = useRef<{ scope: string; message: HistoryMatch }>(null);
  const historySearchRequest = useRef<AbortController>(null);
  const [historySearch, setHistorySearch] = useState<string | null>(null);
  const [matches, setMatches] = useState<HistoryMatch[] | null>(null);
  const [rename, setRename] = useState<{ id: string; title: string } | null>(null);
  const [renameIssue, setRenameIssue] = useState("");
  const [archiveConfirm, setArchiveConfirm] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteIssue, setDeleteIssue] = useState("");
  const [manageSessions, setManageSessions] = useState(false);
  const [sessionAction, setSessionAction] = useState(false);
  const [sessionArchive, setSessionArchive] = useState<{ id: string; activity: SessionActivity } | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [turns, setTurns] = useState<SessionTurnSummary[] | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const renameInput = useRef<HTMLInputElement>(null), renameOpen = rename !== null;
  useEffect(() => {
    if (renameOpen) { renameInput.current?.focus(); renameInput.current?.select(); }
  }, [renameOpen]);
  const [showArchived, setShowArchived] = useState(false);
  const [fileId, setFileId] = useState<string | null>(null);
  const [review, setReview] = useState<{ runId: string; file: TurnFileChange } | null>(null);
  const { draft: projectDraft, update: updateProjectDraft } = useChatDraft(scope);
  const { entries: chatEchoes, update: updateChatEchoes } = useChatEchoes(scope);
  const [queueDrafts, setQueueDrafts] = useState<Record<string, QueueDraft | null>>({});
  const [queueBusy, setQueueBusy] = useState("");
  const editing = queueDrafts[scope], draft = editing?.draft ?? projectDraft;
  const updateDraft = (id: string, change: (before: ChatDraft) => ChatDraft) => {
    const target = queueDrafts[id];
    if (!target) { updateProjectDraft(id, change); return; }
    setQueueDrafts((current) => current[id]?.requestId === target.requestId
      ? { ...current, [id]: { ...current[id], draft: change(current[id].draft) } } : current);
  };
  const sendingProjects = useRef(new Map<string, { requestId: string; confirmed: boolean; controller: AbortController }>());
  const shortcutRequests = useRef(new Map<string, string>());
  const [pendingProjects, setPendingProjects] = useState<string[]>([]), [uploadProject, setUploadProject] = useState("");
  const sending = pendingProjects.includes(scope), uploading = uploadProject === scope;
  const [stoppingRun, setStoppingRun] = useState("");
  const escapePress = useRef<{ runId: string; generation: number; region: Element; time: number } | null>(null);
  const [sidebar, setSidebar] = useState(true), [showSettings, setShowSettings] = useState(false);
  const [extensions, setExtensions] = useState<"skills" | "mcp" | "presets" | "schedules" | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [skillCatalog, setSkillCatalog] = useState<{ scope: string; entries: SkillEntry[] }>();
  const [presetRevision, setPresetRevision] = useState(0);
  const [showSkills, setShowSkills] = useState(false);
  const [skillDocument, setSkillDocument] = useState<{ projectId: string; skill: SkillEntry } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0), [slashDismissed, setSlashDismissed] = useState("");
  const [composerCaret, setComposerCaret] = useState<number>();
  const pendingSkill = skillCompletion(draft.text, composerCaret ?? draft.text.length);
  const slash = pendingSkill?.query;
  const watchSkills = slash !== undefined || showSkills;
  const skillCommands = skillCatalog?.scope === scope ? skillCatalog.entries : undefined;
  const skillNames = useMemo(() => new Set(skillCommands?.map(({ name }) => name)), [skillCommands]);
  useEffect(() => {
    if (!scope) return;
    let pending: AbortController;
    const refresh = () => {
      pending?.abort();
      const controller = pending = new AbortController();
      void api<SkillEntry[]>(scopedEndpoint(scope, "/skills/commands"), { signal: controller.signal })
        .then((entries) => {
          if (!controller.signal.aborted) {
            setSkillCatalog({ scope, entries });
            setSlashIndex(0);
          }
        }).catch(() => {});
    };
    refresh();
    const stream = watchSkills ? new EventSource("/api/studio" + scopedEndpoint(scope, "/skills/watch")) : undefined;
    if (stream) {
      let connected = false;
      stream.onmessage = refresh;
      stream.onopen = () => { if (connected) refresh(); connected = true; };
    }
    return () => { stream?.close(); pending?.abort(); };
  }, [scope, watchSkills, presetRevision]);
  const slashSuggestions = slash === undefined || slashDismissed === draft.text ? [] : (skillCommands ?? []).filter(({ name }) =>
    [...slash].reduce((position, character) => position < 0 ? -1 : (name.indexOf(character, position) + 1 || -1), 0) >= 0)
    .sort((a, b) => Number(b.name.startsWith(slash)) - Number(a.name.startsWith(slash)) || a.name.localeCompare(b.name)).slice(0, 8);
  const [workspaceOpen, setWorkspaceOpen] = useState(true), [fileTreeOpen, setFileTreeOpen] = useState(true);
  const [workspaceWidth, setWorkspaceWidth] = useState<number | null>(null), [treeWidth, setTreeWidth] = useState<number | null>(null);
  const [creating, setCreating] = useState(false), [search, setSearch] = useState<string | null>(null);
  const [sessionMatches, setSessionMatches] = useState<SessionSearchMatch[]>([]);
  const [searchingSessions, setSearchingSessions] = useState(false);
  const [folders, setFolders] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");
  const [historySteps, setHistorySteps] = useState<ExecutionStep[]>([]);
  const currentSession = snapshot?.sessions?.find((session) => session.id === sessionId);
  const projectArchived = snapshot?.project.status === "archived";
  const archived = projectArchived || currentSession?.archived === true;
  const activeId = useRef("");
  const workspace = useRef<WorkspaceSnapshot | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null), importInput = useRef<HTMLInputElement>(null), composer = useRef<HTMLTextAreaElement>(null);
  const [importing, setImporting] = useState(false);
  const chatScroll = useChatScroll(scope);
  useEffect(() => { if (window.innerWidth < 650) { setSidebar(false); setWorkspaceOpen(false); } }, []);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("mujian.layout") || "{}");
      if (Number.isFinite(saved.workspace) && saved.workspace >= 420) setWorkspaceWidth(saved.workspace);
      if (Number.isFinite(saved.tree) && saved.tree >= 150 && saved.tree <= 320) setTreeWidth(saved.tree);
    } catch {}
  }, []);
  const resizeWorkspace = (width: number) => { setWorkspaceWidth(width); try { localStorage.setItem("mujian.layout", JSON.stringify({ workspace: width, tree: treeWidth })); } catch {} };
  const resizeTree = (width: number) => { setTreeWidth(width); try { localStorage.setItem("mujian.layout", JSON.stringify({ workspace: workspaceWidth, tree: width })); } catch {} };
  const error = useCallback((e: unknown) => { setNotice((e as Error).message); if (e instanceof RequestError && ["MODEL_NOT_CONFIGURED", "MEDIA_NOT_CONFIGURED"].includes(e.code || "")) setShowSettings(true); }, []);
  useEffect(() => {
    const query = search?.trim();
    if (!query) { setSessionMatches([]); setSearchingSessions(false); return; }
    const controller = new AbortController();
    const endpoint = "/sessions/search?" + new URLSearchParams({ query });
    setSessionMatches([]); setSearchingSessions(true);
    let full = false;
    void api<SessionSearchMatch[]>(endpoint + "&content=false", { signal: controller.signal }).then((rows) => {
      if (!full && !controller.signal.aborted) setSessionMatches(rows);
    }).catch(() => {});
    const wait = setTimeout(() => {
      void api<SessionSearchMatch[]>(endpoint, { signal: controller.signal }).then((rows) => {
        if (!controller.signal.aborted) { full = true; setSessionMatches(rows); }
      }).catch(() => {}).finally(() => { if (!controller.signal.aborted) setSearchingSessions(false); });
    }, 250);
    return () => { clearTimeout(wait); controller.abort(); };
  }, [search]);
  useEffect(() => {
    const showSearch = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || document.querySelector('[role="dialog"]')) return;
      event.preventDefault(); setSidebar(true); setSearch("");
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".project-search")?.focus());
    };
    window.addEventListener("keydown", showSearch);
    return () => window.removeEventListener("keydown", showSearch);
  }, []);
  useEffect(() => {
    if (!outlineOpen || !projectId) return;
    const controller = new AbortController();
    setTurns(null);
    void api<SessionTurnSummary[]>(scopedEndpoint(scope, "/sessions/outline"), { signal: controller.signal })
      .then((rows) => { if (!controller.signal.aborted) setTurns(rows); })
      .catch((failure) => { if (!controller.signal.aborted) { setOutlineOpen(false); error(failure); } });
    return () => controller.abort();
  }, [error, outlineOpen, projectId, scope]);
  const receive = useCallback((next: WorkspaceSnapshot) => {
    if (scopeKey(next.project.id, next.sessionId) !== activeId.current || next === workspace.current) return;
    const pending = sendingProjects.current.get(activeId.current);
    const ownsRequest = (id: string) => next.messages.some((message) => message.requestId === id) ||
      next.chatQueue?.some((message) => message.requestId === id);
    if (pending && ownsRequest(pending.requestId)) {
      pending.confirmed = true;
      pending.controller.abort();
    }
    updateChatEchoes(activeId.current, (entries) => {
      const remaining = entries.filter(({ requestId }) => !ownsRequest(requestId));
      return remaining.length === entries.length ? entries : remaining;
    });
    if (next.project !== workspace.current?.project)
      setProjects((prev) => prev.map((p) => p.id === next.project.id ? next.project : p));
    workspace.current = next;
    setSnapshot(next);
  }, [updateChatEchoes]);
  useEffect(() => {
    api<{ projects: Project[]; settings: PublicSettings }>("/bootstrap").then((data) => {
      setProjects(data.projects); setSettings(data.settings);
      const saved = localStorage.getItem("mujian.project");
      const selected = data.projects.find((p) => p.id === saved) ?? data.projects.find((p) => p.status !== "archived");
      const project = selected?.id ?? "";
      setShowArchived(selected?.status === "archived");
      setSessionId(localStorage.getItem("mujian.session." + project) ?? ""); setProjectId(project);
    }).catch(error);
  }, [error]);
  useEffect(() => {
    activeId.current = scope;
    if (projectId) {
      localStorage.setItem("mujian.project", projectId);
      localStorage.setItem("mujian.session." + projectId, sessionId);
    }
    setHistorySearch(null); setMatches(null); setRename(null); setOutlineOpen(false); setManageSessions(false); jumpMessage.current = "";
    setComposerCaret(undefined);
    historySearchRequest.current?.abort();
    workspace.current = null;
    previewRequest.current++; setVersionedFile(null); setFileId(null); setReview(null); setSnapshot(null); setLoadingHistory(false); historyAnchor.current = null; setHistorySteps([]); setFolders({}); setNotice("");
    if (!projectId) return;
    let closed = false, source: EventSource | undefined, reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const cursor = workspace.current?.cursor;
      const connection = new EventSource("/api/studio" + scopedEndpoint(scope, "/events", new URLSearchParams(cursor === undefined ? {} : { after: String(cursor) })));
      source = connection;
      connection.onmessage = (event) => {
        if (closed || source !== connection) return;
        try {
          const frame = JSON.parse(event.data) as WorkspaceFrame;
          if (frame.type === "snapshot" && scopeKey(frame.snapshot.project.id, frame.snapshot.sessionId) === scope) {
            setHistorySteps([]);
            receive(frame.snapshot);
            return;
          }
          if (frame.type === "delta") {
            const next = applyWorkspaceDelta(workspace.current, frame);
            if (next) { receive(next); return; }
          }
        } catch {}
        // EventSource can acknowledge an ID before the application can apply it.
        // Reopen from our last applied cursor if a frame cannot be merged.
        connection.close();
        reconnectTimer = setTimeout(connect, 500);
      };
    };
    connect();
    return () => { closed = true; source?.close(); clearTimeout(reconnectTimer); };
  }, [projectId, sessionId, scope, receive]);
  useEffect(() => {
    const input = composer.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = Math.min(190, input.scrollHeight) + "px";
  }, [scope, draft.text]);
  const sentRequestId = projectDraft.requestId;
  useEffect(() => {
    if (sentRequestId && snapshot && scopeKey(snapshot.project.id, snapshot.sessionId) === scope &&
        (snapshot.messages.some((m) => m.requestId === sentRequestId) || snapshot.chatQueue?.some((m) => m.requestId === sentRequestId))) {
      updateProjectDraft(scope, (current) => current.requestId === sentRequestId ? emptyChatDraft : current);
      setNotice("");
    }
  }, [scope, snapshot, sentRequestId, updateProjectDraft]);
  const currentSnapshot = snapshot && scopeKey(snapshot.project.id, snapshot.sessionId) === scope ? snapshot : undefined;
  const activeRun = currentSnapshot?.runs.find((run) => !run.parentRunId && isActiveRun(run));
  const backgroundTasks = currentSnapshot?.activeBackgroundTasks ?? [];
  const queueItems = currentSnapshot?.chatQueue;
  const nextTurnItems = queueItems?.filter((item) => !item.targetRunId);
  const editClosed = Boolean(editing && snapshot && scopeKey(snapshot.project.id, snapshot.sessionId) === scope && !queueItems?.some((item) => item.requestId === editing.requestId));
  const canSend = Boolean(!archived && (draft.text.trim() || draft.attachmentIds.length) && !sending && !uploading && !editClosed && queueBusy !== scope && snapshot && scopeKey(snapshot.project.id, snapshot.sessionId) === scope);
  const steerable = activeRun?.stage === "agent";
  const defaultQueue = Boolean(activeRun && (activeRun.intent === "compact" || settings?.busyEnter === "queue"));
  const stopTarget = activeRun && !editing && !canSend && !sending ? activeRun : undefined;
  const primaryLabel = editing ? "保存待发消息" : stopTarget ? stopTarget.intent === "compact" ? "停止整理" : "停止生成" : sending ? "发送中" : draft.requestId ? "重试发送" : defaultQueue ? "排到下一轮" : "发送消息";
  useEffect(() => { escapePress.current = null; }, [scope, activeRun?.id, activeRun?.generation, showSettings]);
  const streamSteps = snapshot?.steps;
  const allSteps = useMemo(() => [...new Map([...historySteps, ...(streamSteps || [])].map((step) => [step.seq, step])).values()], [historySteps, streamSteps]);
  const chatFlow = currentSnapshot ? mergeChatEchoes(
    projectChatFlow(currentSnapshot.messages, currentSnapshot.runs, currentSnapshot.replies, allSteps), currentSnapshot, chatEchoes,
  ) : [];
  const file = versionedFile ?? snapshot?.artifacts.find((a) => a.id === fileId);
  const openFile = useCallback((id: string, path?: string) => {
    setSkillDocument(null);
    const parts = (path || workspace.current?.artifacts.find((f) => f.id === id)?.path || "").split("/").filter(Boolean);
    setFolders((current) => ({ ...current, ...Object.fromEntries(parts.slice(0, -1).map((_, i) => ["/" + parts.slice(0, i + 1).join("/"), true])) }));
    previewRequest.current++; setVersionedFile(null); setFileId(id); setReview(null); setWorkspaceOpen(true); if (window.innerWidth < 650) setFileTreeOpen(false);
  }, []);
  const openPinned = async (attachment: MessageAttachment) => {
    openFile(attachment.id, attachment.path);
    setFileId(null);
    const request = previewRequest.current;
    try {
      const file = await api<Artifact>("/projects/" + projectId + "/artifacts/" + attachment.id + "?version=" + attachment.version);
      if (request === previewRequest.current && activeId.current === scope) setVersionedFile(file);
    } catch (e) { if (request === previewRequest.current && activeId.current === scope) error(e); }
  };
  const openSession = async (forkRunId?: string) => {
    if (creatingSession) return;
    setCreatingSession(true);
    try {
      const session = await api<ProjectSession>(scopedEndpoint(scope, "/sessions"), { method: "POST", body: JSON.stringify({
        title: (forkRunId ? "分支 " : "对话 ") + ((snapshot?.sessions?.length ?? 1) + 1),
        ...(forkRunId ? { forkRunId } : {}),
      }) });
      if (activeId.current === scope) setSessionId(session.id);
    } catch (e) { if (activeId.current === scope) error(e); }
    finally { setCreatingSession(false); }
  };
  const forkAtCheckpoint = async (runId: string, atSeq: number) => {
    const session = await api<ProjectSession>(scopedEndpoint(scope, "/sessions"), { method: "POST", body: JSON.stringify({
      title: "分支 " + ((snapshot?.sessions?.length ?? 1) + 1), forkRunId: runId, atSeq,
    }) });
    if (activeId.current === scope) { setInspecting(false); setSessionId(session.id); }
  };
  const openSkillCommands = () => setShowSkills(true);
  const previewSkill = async (name: string) => {
    try {
      const items = await api<SkillEntry[]>(scopedEndpoint(scope, "/skills/commands"));
      const skill = items.find((item) => item.name === name);
      if (!skill) return;
      if (activeId.current === scope) { setSkillDocument({ projectId, skill }); setWorkspaceOpen(true); if (window.innerWidth < 650) setFileTreeOpen(false); }
    } catch (e) { error(e); }
  };
  const pickSkill = (skill: SkillEntry) => {
    const insertion = "/" + skill.name;
    const match = showSkills ? undefined : pendingSkill;
    const prefix = match ? draft.text.slice(0, match.start) : "";
    const suffix = match ? draft.text.slice(match.end) : draft.text.replace(/^\s*\/[a-z0-9-]*(?:\s+|$)/i, "");
    const space = /^\s/.test(suffix) ? "" : " ";
    const nextCaret = prefix.length + insertion.length + 1;
    updateDraft(scope, (before) => ({ ...before, text: prefix + insertion + space + suffix }));
    setShowSkills(false); setComposerCaret(nextCaret);
    requestAnimationFrame(() => { composer.current?.focus(); composer.current?.setSelectionRange(nextCaret, nextCaret); });
  };
  const renameSession = async () => {
    if (!rename?.title.trim() || renaming) return;
    setRenaming(true);
    setRenameIssue("");
    try {
      await api(scopedEndpoint(scopeKey(projectId, rename.id), "/sessions"), { method: "PATCH", body: JSON.stringify({ title: rename.title.trim() }) });
      if (activeId.current === scope) setRename((draft) => draft?.id === rename.id ? null : draft);
    } catch (e) { if (activeId.current === scope) setRenameIssue((e as Error).message); }
    finally { setRenaming(false); }
  };
  const archiveProject = async (stopSchedules = false) => {
    if (archiving) return;
    setArchiving(true);
    try {
      const project = await api<Project>("/projects/" + projectId + "/archive", {
        method: "PATCH", body: JSON.stringify({ archived: !projectArchived, stopSchedules }),
      });
      setProjects((items) => items.map((item) => item.id === project.id ? project : item));
      if (activeId.current === scope) { setArchiveConfirm(null); setShowArchived(project.status === "archived"); }
    } catch (e) {
      if (activeId.current === scope) {
        if (e instanceof RequestError && e.code === "PROJECT_SCHEDULES_ACTIVE") setArchiveConfirm(projectId);
        else { setArchiveConfirm(null); error(e); }
      }
    } finally { setArchiving(false); }
  };
  const deleteProject = async () => {
    if (!deleteTarget || deleting) return;
    const id = deleteTarget.id;
    setDeleting(true);
    setDeleteIssue("");
    try {
      await api("/projects/" + id, { method: "DELETE" });
    } catch (e) {
      if (!(e instanceof RequestError && e.code === "PROJECT_NOT_FOUND")) {
        setDeleteIssue((e as Error).message);
        return;
      }
    } finally { setDeleting(false); }

    const remaining = projects.filter((item) => item.id !== id);
    setProjects((items) => items.filter((item) => item.id !== id));
    setSessionMatches((items) => items.filter((item) => item.projectId !== id));
    setDeleteTarget(null);
    localStorage.removeItem("mujian.session." + id);
    if (localStorage.getItem("mujian.project") === id) localStorage.removeItem("mujian.project");
    for (const [storage, prefix] of [[localStorage, "mujian.chat-draft."], [sessionStorage, "mujian.chat-echoes."]] as const) {
      for (let index = storage.length - 1; index >= 0; index--) {
        const key = storage.key(index);
        if (key === prefix + id || key?.startsWith(prefix + id + "/")) storage.removeItem(key);
      }
    }
    const archivedFallback = remaining.find((item) => item.status === "archived");
    if (!archivedFallback) setShowArchived(false);
    if (activeId.current.split("/")[0] === id) {
      const next = (showArchived ? archivedFallback : undefined) ?? remaining.find((item) => item.status !== "archived") ?? archivedFallback;
      setProjectId(next?.id ?? "");
      setSessionId(next ? localStorage.getItem("mujian.session." + next.id) ?? "" : "");
      setShowArchived(next?.status === "archived");
    }
  };
  const importProject = async (file?: File) => {
    if (!file || importing) return;
    setImporting(true);
    try {
      if (file.size > 300 * 1024 * 1024) throw new Error("当前可导入 300 MiB 以内的项目归档");
      const project = await api<Project>("/projects/import", { method: "POST", headers: { "Content-Type": "application/zip" }, body: file });
      setProjects((old) => [project, ...old]); setSessionId(""); setProjectId(project.id); setShowArchived(false);
    } catch (e) { error(e); }
    finally { setImporting(false); }
  };
  useLayoutEffect(() => {
    const anchor = historyAnchor.current, viewport = chatScroll.viewport.current;
    if (anchor && viewport && anchor.node.isConnected) viewport.scrollTop += anchor.node.getBoundingClientRect().top - anchor.y;
    historyAnchor.current = null;
    if (viewport && jumpMessage.current) {
      viewport.querySelector('[data-message-id="' + CSS.escape(jumpMessage.current) + '"]')?.scrollIntoView({ block: "center" });
      jumpMessage.current = "";
    }
  }, [snapshot, chatScroll.viewport]);
  const searchMessages = async (query: string) => {
    historySearchRequest.current?.abort();
    const request = new AbortController();
    historySearchRequest.current = request;
    try {
      const found = await api<HistoryMatch[]>(scopedEndpoint(scope, "/history", new URLSearchParams({ query })), { signal: request.signal });
      if (!request.signal.aborted && activeId.current === scope) setMatches(found);
    } catch (e) { if (!request.signal.aborted && activeId.current === scope) error(e); }
  };
  const closeHistorySearch = () => {
    historySearchRequest.current?.abort();
    setHistorySearch(null);
  };
  const openMatch = async (match: HistoryMatch) => {
    if (loadingHistory) return;
    const present = chatScroll.viewport.current?.querySelector('[data-message-id="' + CSS.escape(match.id) + '"]');
    chatScroll.hold(); closeHistorySearch();
    if (present) { present.scrollIntoView({ block: "center" }); return; }
    if (!match.before) return;
    setLoadingHistory(true);
    try {
      let before = workspace.current?.historyBefore;
      while (before) {
        const page = await api<HistoryPage>(scopedEndpoint(scope, "/history", new URLSearchParams({ before: String(before) })));
        const current = workspace.current;
        if (!current || activeId.current !== scope || current.historyBefore !== before) return;
        const found = page.messages.some((message) => message.id === match.id);
        if (found) jumpMessage.current = match.id;
        receive(prependHistory(current, page));
        if (found || page.historyBefore === undefined || page.historyBefore >= before) return;
        before = page.historyBefore;
      }
    } catch (e) { if (activeId.current === scope) error(e); }
    finally { if (activeId.current === scope) setLoadingHistory(false); }
  };
  useEffect(() => {
    const target = pendingSearchJump.current;
    if (!target || !currentSnapshot || target.scope !== scope) return;
    pendingSearchJump.current = null;
    void openMatch(target.message);
  }, [scope, currentSnapshot]);
  const selectSessionMatch = (match: SessionSearchMatch) => {
    if (match.archived) { setNotice("请先恢复对话"); return; }
    const target = scopeKey(match.projectId, match.sessionId);
    setSearch(null); setShowArchived(match.projectArchived);
    if (target === scope) { if (match.message) void openMatch(match.message); return; }
    pendingSearchJump.current = match.message ? { scope: target, message: match.message } : null;
    setProjectId(match.projectId); setSessionId(match.sessionId);
  };
  const changeSession = async (id: string, change: SessionChange, owner = projectId) => {
    if (sessionAction) return;
    setSessionAction(true);
    try {
      const response = await api<{ sessions?: ProjectSession[]; activity?: SessionActivity }>(
        scopedEndpoint(scopeKey(owner, id), "/sessions/management"), { method: "PATCH", body: JSON.stringify(change) });
      if (response.activity) { setSessionArchive({ id, activity: response.activity }); return; }
      setSessionArchive(null);
      const sessions = response.sessions;
      if (sessions && workspace.current?.project.id === owner) receive({ ...workspace.current, sessions });
      if (change.action === "archive") {
        setSessionMatches((matches) => matches.map((match) => match.projectId === owner && match.sessionId === id ? { ...match, archived: change.archived } : match));
        if (owner === projectId && id === sessionId && change.archived) {
          const fallback = sessions?.find((entry) => !entry.archived);
          if (fallback) setSessionId(fallback.id);
        }
        setNotice(change.archived ? "对话已归档" : "对话已恢复");
      }
    } catch (failure) { error(failure); }
    finally { setSessionAction(false); }
  };
  const copySession = async () => {
    try {
      const response = await fetch("/api/studio" + scopedEndpoint(scope, "/sessions/export", new URLSearchParams({ format: "markdown" })));
      if (!response.ok) throw new Error("无法读取对话记录");
      await navigator.clipboard.writeText(await response.text());
      setNotice("已复制对话 Markdown");
    } catch (failure) { error(failure); }
  };
  const loadOlder = async () => {
    const before = workspace.current?.historyBefore;
    if (!before || loadingHistory) return;
    setLoadingHistory(true);
    try {
      const page = await api<HistoryPage>(scopedEndpoint(scope, "/history", new URLSearchParams({ before: String(before) })));
      const current = workspace.current, viewport = chatScroll.viewport.current;
      if (!current || activeId.current !== scope || current.historyBefore !== before) return;
      if (viewport) {
        const top = viewport.getBoundingClientRect().top;
        const node = Array.from(viewport.querySelectorAll(".message")).find((item) => item.getBoundingClientRect().bottom > top);
        if (node) historyAnchor.current = { node, y: node.getBoundingClientRect().top };
        chatScroll.hold();
      }
      receive(prependHistory(current, page));
    } catch (e) { if (activeId.current === scope) error(e); }
    finally { if (activeId.current === scope) setLoadingHistory(false); }
  };
  const openChange = (runId: string, change: TurnFileChange) => {
    openFile(change.id, snapshot?.artifacts.find((artifact) => artifact.id === change.id)?.path || change.path);
    setReview({ runId, file: change });
  };
  const newProject = async () => {
    if (creating) return;
    setCreating(true); setNotice("");
    try {
      const p = await api<Project>("/projects", { method: "POST", body: "{}" });
      setProjects((old) => [p, ...old]); setSessionId(""); setProjectId(p.id); setSearch(null); setShowArchived(false);
      if (window.innerWidth < 650) setSidebar(false);
      composer.current?.focus();
    } catch (e) { error(e); } finally { setCreating(false); }
  };
  const control = async (run: Pick<Run, "id" | "projectId">, action: "pause" | "resume" | "cancel" | "resubmit") => {
    try { await api("/projects/" + run.projectId + "/runs/" + run.id, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ action }) }); }
    catch (e) { error(e); }
  };
  const stop = async (run: Run) => {
    setStoppingRun(run.id);
    try { await control(run, "cancel"); }
    finally { setStoppingRun(""); }
  };
  const onConversationKey = (event: KeyboardEvent<HTMLElement>) => {
    const previous = escapePress.current;
    escapePress.current = null;
    if (event.key !== "Escape" || event.repeat || event.nativeEvent.isComposing || event.defaultPrevented ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || showSettings || !activeRun || stoppingRun === activeRun.id) return;
    const region = (event.target as Element).closest(".composer, .messages-scroll");
    if (!region || !event.currentTarget.contains(region)) return;
    event.preventDefault();
    const time = performance.now();
    if (previous?.runId === activeRun.id && previous.generation === activeRun.generation && previous.region === region && time - previous.time <= 500)
      void stop(activeRun);
    else escapePress.current = { runId: activeRun.id, generation: activeRun.generation, region, time };
  };
  const submitChat = async (id: string, submission: ChatSubmission) => {
    if (sendingProjects.current.has(id)) return false;
    const pending = { requestId: submission.requestId, confirmed: false, controller: new AbortController() };
    sendingProjects.current.set(id, pending);
    setPendingProjects([...sendingProjects.current.keys()]);
    setNotice("");
    const echo = showsInTranscript(submission);
    if (echo) updateChatEchoes(id, (entries) => {
      const existing = entries.find(({ requestId }) => requestId === submission.requestId);
      return existing ? entries.map((entry) => entry === existing ? { ...entry, status: "sending", error: undefined } : entry) :
        [...entries, { ...submission, createdAt: new Date().toISOString(), status: "sending" }];
    });
    if (echo && activeId.current === id) chatScroll.jumpToLatest();
    const settleEcho = (status: "accepted" | "failed" | "unconfirmed", error?: string) => {
      if (echo) updateChatEchoes(id, (entries) => entries.some(({ requestId }) => requestId === submission.requestId)
        ? entries.map((entry) => entry.requestId === submission.requestId ? { ...entry, status, error } : entry)
        : entries);
    };
    try {
      await api(scopedEndpoint(id, "/chat"), {
        method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(submission),
        signal: AbortSignal.any([pending.controller.signal, AbortSignal.timeout(20000)]),
      });
      settleEcho("accepted");
      return true;
    } catch (e) {
      if (pending.confirmed) return true;
      settleEcho(e instanceof RequestError ? "failed" : "unconfirmed", e instanceof RequestError ? e.message : undefined);
      if (activeId.current === id) {
        if (echo) {
          if (e instanceof RequestError && e.code === "MODEL_NOT_CONFIGURED") setShowSettings(true);
        } else if (e instanceof RequestError) error(e);
        else setNotice("发送结果暂未确认，可重试。");
      }
      return false;
    } finally {
      sendingProjects.current.delete(id);
      setPendingProjects([...sendingProjects.current.keys()]);
    }
  };
  const editQueueItem = (item: QueuedChat) => {
    setQueueDrafts((drafts) => ({ ...drafts, [scope]: { requestId: item.requestId, version: item.version,
      draft: { text: item.text, attachmentIds: item.attachments.map((file) => file.id) } } }));
    composer.current?.focus();
  };
  const mutateQueue = async (requestId: string, change: QueuedChatEdit) => {
    if (queueBusy) return;
    setQueueBusy(scope);
    try {
      await api(scopedEndpoint(scope, "/chat-queue/" + requestId), { method: "PATCH", body: JSON.stringify(change) });
      setQueueDrafts((drafts) => drafts[scope]?.requestId === requestId ? { ...drafts, [scope]: null } : drafts);
    } catch (e) { if (activeId.current === scope) error(e); }
    finally { setQueueBusy(""); }
  };
  const steerQueue = async () => {
    if (!steerable || !activeRun || queueBusy || sending || uploading || editing) return;
    const items = queueItems?.filter((item) => !item.targetRunId).map(({ requestId, version }) => ({ requestId, version }));
    if (!items?.length) return;
    setQueueBusy(scope);
    try {
      await api(scopedEndpoint(scope, "/chat-queue"), { method: "PATCH", body: JSON.stringify({ runId: activeRun.id, items }) });
    } catch (e) { if (activeId.current === scope) error(e); }
    finally { setQueueBusy(""); }
  };
  const send = async (queue = defaultQueue) => {
    if (!canSend || sendingProjects.current.has(scope)) return;
    const text = draft.text.trim();
    if (editing) {
      await mutateQueue(editing.requestId, { action: "replace", version: editing.version, text, attachmentIds: draft.attachmentIds });
      return;
    }
    const requestId = draft.requestId || crypto.randomUUID();
    const mode = draft.requestId ? draft.mode : queue && text !== "/compact" ? "next-turn" : undefined;
    const submission = { requestId, text, attachmentIds: draft.attachmentIds, mode };
    if (showsInTranscript(submission)) {
      const sending = submitChat(scope, submission);
      updateProjectDraft(scope, () => emptyChatDraft);
      await sending;
      return;
    }
    updateProjectDraft(scope, (current) => ({ ...current, requestId, mode }));
    if (await submitChat(scope, submission))
      updateProjectDraft(scope, (current) => current.requestId === requestId ? emptyChatDraft : current);
  };
  const sendShortcut = async (text: string, attachmentIds: string[] = []) => {
    if (!projectId || sendingProjects.current.has(scope)) return;
    const key = JSON.stringify([scope, text, attachmentIds]);
    const requestId = shortcutRequests.current.get(key) || crypto.randomUUID();
    shortcutRequests.current.set(key, requestId);
    if (await submitChat(scope, { requestId, text, attachmentIds })) shortcutRequests.current.delete(key);
  };
  const make = (intent: RunIntent) => sendShortcut(
    intent === "direct" ? "根据引用的文件生成分镜。" : intent === "frames" ?
      "根据引用的文件生成关键帧。" : "根据引用的文件制作视频。",
    file ? [file.id] : [],
  );
  const attach = (id: string, artifactId: string) => {
    let full = false;
    updateDraft(id, (current) => {
      if (current.attachmentIds.includes(artifactId)) return current;
      if (current.attachmentIds.length >= CHAT_ATTACHMENT_LIMIT) { full = true; return current; }
      return { text: current.text, attachmentIds: [...current.attachmentIds, artifactId] };
    });
    if (full && activeId.current === id) setNotice("一条消息最多引用 " + CHAT_ATTACHMENT_LIMIT + " 个素材");
  };
  const upload = async (files: FileList | null) => {
    const id = scope;
    if (!files?.length || !id || uploadProject || sendingProjects.current.has(id)) return;
    if (files.length + draft.attachmentIds.length > CHAT_ATTACHMENT_LIMIT) {
      setNotice("一条消息最多引用 " + CHAT_ATTACHMENT_LIMIT + " 个素材");
      return;
    }
    setNotice(""); setUploadProject(id);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData(); form.set("file", file);
        const artifact = await api<Artifact>(scopedEndpoint(id, "/upload"), { method: "POST", body: form });
        attach(id, artifact.id);
        if (activeId.current === id) openFile(artifact.id, artifact.path);
      }
    } catch (e) { if (activeId.current === id) error(e); }
    finally { setUploadProject(""); }
  };
  const dropAttachment = (event: DragEvent<HTMLDivElement>) => {
    const types = event.dataTransfer.types;
    if (!types.includes(projectFileDragType) && !types.includes("Files")) return;
    event.preventDefault();
    if (!currentSnapshot || uploadProject || sendingProjects.current.has(scope)) return;
    if (types.includes(projectFileDragType)) {
      try {
        const { projectId, fileId } = JSON.parse(event.dataTransfer.getData(projectFileDragType));
        if (currentSnapshot.project.id === projectId && currentSnapshot.artifacts.some((file) => file.id === fileId && file.status === "ready")) attach(scope, fileId);
      } catch {}
      return;
    }
    void upload(event.dataTransfer.files);
  };
  const loadingConversation = Boolean(projectId && !snapshot && !notice);
  return <main className={"studio " + (!sidebar ? "sidebar-hidden" : "") + (workspaceOpen ? " has-preview" : "")}>
    {sidebar && <aside className="project-sidebar">
      <div className="sidebar-top"><span className="brand-mark"><Clapperboard size={17} strokeWidth={1.7}/></span><span className="wordmark">{STUDIO_NAME}</span><div className="toolbar-spacer"/>
        <button className="icon-button" title="搜索项目与对话" aria-label="搜索项目与对话" onClick={() => setSearch(search === null ? "" : null)}><Search size={17}/></button>
        <button className="icon-button" title="收起侧栏" aria-label="收起侧栏" onClick={() => setSidebar(false)}><PanelLeftClose size={17}/></button></div>
      <button className="new-project-button" disabled={creating} onClick={() => void newProject()}>{creating ? <LoaderCircle size={17} className="spinning"/> : <Plus size={17}/>}新建项目</button>
      {search !== null && <input className="project-search" autoFocus value={search} maxLength={160} onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") setSearch(null); }} placeholder="搜索项目与对话" aria-label="搜索项目与对话"/>}
      <div className="sidebar-scroll">{search?.trim() ? <nav className="session-search-results" aria-label="搜索结果" aria-busy={searchingSessions}>
        {!searchingSessions && !sessionMatches.length && <p className="history-no-matches">没有匹配的对话</p>}
        {sessionMatches.map((match) => <div className="session-search-row" key={scopeKey(match.projectId, match.sessionId)}>
          <button type="button" className="session-search-match" onClick={() => selectSessionMatch(match)}>
            <strong>{match.title}</strong><small>{match.projectTitle}{match.archived ? " · 已归档" : ""}</small>
            {match.message && <span>{match.message.snippet}</span>}
          </button>
          {match.archived && !match.projectArchived && <button type="button" className="icon-button" title="恢复对话" aria-label={"恢复 " + match.title}
            disabled={sessionAction} onClick={() => void changeSession(match.sessionId, { action: "archive", archived: false }, match.projectId)}><RotateCcw size={14}/></button>}
        </div>)}
      </nav> : <><div className="sidebar-label"><button className="text-button" aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>项目</button>
        {projects.some((p) => p.status === "archived") && <button className="text-button" aria-pressed={showArchived} onClick={() => setShowArchived(true)}>归档</button>}</div>
        <nav aria-label={showArchived ? "归档项目" : "项目列表"}>{projects.filter((p) => (p.status === "archived") === showArchived).map((p) => <div className="project-group" key={p.id}>
          <button className={"project-item " + (p.id === projectId ? "selected" : "")} title={p.title} onClick={() => { if (projectId !== p.id) { setSessionId(localStorage.getItem("mujian.session." + p.id) ?? ""); setProjectId(p.id); } }} aria-current={p.id === projectId ? "page" : undefined}>
            <Folder size={15} strokeWidth={1.6}/>
            <span>{p.title}</span>{p.isExample && <small>示例</small>}</button>
          {showArchived && <button type="button" className="icon-button project-delete" title="永久删除" aria-label={"永久删除「" + p.title + "」"}
            onClick={() => { setDeleteIssue(""); setDeleteTarget(p); }}><Trash2 size={15} strokeWidth={1.6}/></button>}
        </div>)}</nav></>}
      </div>
      <button className="settings-button" onClick={() => setShowSettings(true)}><Settings2 size={17}/><span>设置</span><small>{settings?.textConnected ? "" : "未连接模型"}</small></button>
    </aside>}
    <section className="conversation-pane" onKeyDown={onConversationKey} onBlurCapture={(event) => {
      const next = event.relatedTarget;
      if (!next || !escapePress.current?.region.contains(next)) escapePress.current = null;
    }}>
      <header className="conversation-header">
        {!sidebar && <button className="icon-button" onClick={() => setSidebar(true)} title="展开侧栏" aria-label="展开侧栏"><PanelLeftOpen size={18}/></button>}
        <span className="project-title" title={snapshot?.project.title}>{snapshot?.project.title || STUDIO_NAME}</span>
        {currentSnapshot && <div key={"sessions:" + scope} className="conversation-sessions">
          <HeaderPopover label="切换对话" panel="session-list" trigger={<span className="session-name">{currentSession?.title ?? "主对话"}</span>}>
            {currentSnapshot.sessions?.filter((session) => !session.archived).map((session) => <div className="session-option" key={session.id}>
              <PopoverClose className="session-option-title" aria-current={session.id === sessionId ? "true" : undefined}
                title={session.title} onClick={() => setSessionId(session.id)}>
                {session.pinned && <Pin size={13} aria-hidden="true"/>}<span>{session.title}</span>{session.id === sessionId && <Check size={14} aria-hidden="true"/>}
              </PopoverClose>
              {!archived && <PopoverClose className="session-option-edit" title="重命名" aria-label={"重命名「" + session.title + "」"}
                onClick={() => {
                  setRenameIssue(""); setRename({ id: session.id, title: session.title });
                }}><Pencil size={14} aria-hidden="true"/></PopoverClose>}
              {!archived && session.id !== sessionId && <PopoverClose className="session-option-edit" title="引用对话" aria-label={"引用「" + session.title + "」"}
                onClick={() => {
                  const id = btoa(JSON.stringify(session.id)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
                  const label = session.title.replace(/[\\\]]/g, (character) => "\\" + character);
                  updateDraft(scope, (before) => ({ ...before, text: (before.text ? before.text.trimEnd() + " " : "") + "@[" + label + "](dsh-session:" + id + ") " }));
                  requestAnimationFrame(() => composer.current?.focus());
                }}><Link2 size={14} aria-hidden="true"/></PopoverClose>}
            </div>)}
            {!projectArchived && <PopoverClose className="conversation-popover-action session-list-manage" onClick={() => setManageSessions(true)}>管理对话</PopoverClose>}
          </HeaderPopover>
          {!projectArchived && <button type="button" className="conversation-header-button new-conversation-button" disabled={creatingSession} onClick={() => void openSession()}>
            <Plus size={13} aria-hidden="true"/>新建对话
          </button>}
          {!!backgroundTasks.length && <HeaderPopover label="后台任务" panel="background-menu"
            trigger={<>后台任务 <span className="background-menu-count">{backgroundTasks.length}</span></>}>
            <ul className="background-menu-list">{backgroundTasks.map((task) => {
              const name = task.path?.split("/").pop();
              const status = name && task.label.startsWith(name + " · ") ? task.label.slice(name.length + 3) : task.label;
              return <li className="background-menu-item" key={task.id}>
                <LoaderCircle size={14} className="spinning" aria-hidden="true"/>
                <JobOutputDetails url={"/api/studio" + scopedEndpoint(scope, "/runs/" + task.id + "/output")}
                  title={task.path ?? undefined} label={<strong>{name || task.label}</strong>}
                  status={name && status && status !== name ? status : undefined}/>
                <div className="background-menu-actions">
                  <button type="button" aria-label={"暂停 " + (name || task.label)} onClick={() => void control(task, "pause")}>暂停</button>
                  <button type="button" aria-label={"取消 " + (name || task.label)} onClick={() => void control(task, "cancel")}>取消</button>
                </div>
              </li>;
            })}</ul>
          </HeaderPopover>}
        </div>}
        <div className="toolbar-spacer"/>
        {currentSnapshot && <button className="icon-button" title="扩展" aria-label="扩展" onClick={() => setExtensions("skills")}><Blocks size={17}/></button>}
        {currentSnapshot && <button className="icon-button" title="执行检查器" aria-label="执行检查器" onClick={() => setInspecting(true)}><Activity size={17}/></button>}
        {currentSnapshot?.messages.length ? <button className="icon-button" title="轮次导航" aria-label="轮次导航" onClick={() => setOutlineOpen(true)}><ListOrdered size={17}/></button> : null}
        {snapshot && <button className="icon-button" title="搜索对话" aria-label="搜索对话" onClick={() => {
          setHistorySearch(""); setMatches(null); void searchMessages("");
        }}><Search size={17}/></button>}
        <button className={"icon-button " + (workspaceOpen ? "pressed" : "")} title="文件" aria-label={workspaceOpen ? "收起文件区域" : "打开文件区域"} aria-expanded={workspaceOpen} onClick={() => setWorkspaceOpen((open) => !open)}><PanelRight size={18}/></button>
        <HeaderPopover key={"export:" + scope} label="导出" panel="conversation-export" iconOnly trigger={<Download size={18} aria-hidden="true"/>}>
          <PopoverClose className="conversation-popover-action" disabled={!currentSnapshot} onClick={() => void copySession()}>复制对话为 Markdown</PopoverClose>
          <PopoverClose className="conversation-popover-action" disabled={!currentSnapshot} onClick={() => { window.location.href = "/api/studio" + scopedEndpoint(scope, "/sessions/export"); }}>下载对话日志</PopoverClose>
          <PopoverClose className="conversation-popover-action" disabled={!currentSnapshot} onClick={() => { window.location.href = "/api/studio/projects/" + projectId + "/export?format=archive"; }}>下载项目归档</PopoverClose>
          <PopoverClose className="conversation-popover-action" disabled={!currentSnapshot} onClick={() => { window.location.href = "/api/studio/projects/" + projectId + "/export"; }}>下载项目文本</PopoverClose>
          {!archived && <PopoverClose className="conversation-popover-action" disabled={!currentSnapshot || sending} onClick={() => void sendShortcut("将项目视频素材合成 MP4。")}>合成 MP4</PopoverClose>}
          <PopoverClose className="conversation-popover-action" disabled={!currentSnapshot || sending} onClick={() => void archiveProject()}>{projectArchived ? "恢复项目" : "归档项目"}</PopoverClose>
          <PopoverClose className="conversation-popover-action" disabled={importing} onClick={() => importInput.current?.click()}>{importing ? "正在导入" : "导入项目归档"}</PopoverClose>
        </HeaderPopover>
        <input className="visually-hidden" type="file" accept=".zip,application/zip" ref={importInput} onChange={(event) => {
          void importProject(event.target.files?.[0]); event.target.value = "";
        }}/>
      </header>
      {currentSession?.archived && !projectArchived && <div className="notice">对话已归档<button type="button" className="text-button" onClick={() => void changeSession(sessionId, { action: "archive", archived: false })}>恢复对话</button></div>}
      {notice && <div className="notice" role="alert"><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={14}/></button></div>}
      <div className="chat-viewport">
      <div className="messages-scroll" ref={chatScroll.viewport} onScroll={chatScroll.onScroll}
        onWheel={chatScroll.onWheel} onKeyDown={chatScroll.onKeyDown} tabIndex={0} aria-label="对话记录" aria-busy={loadingConversation || undefined}>
        <div className="messages" ref={chatScroll.content}>
        {snapshot?.historyBefore && <button className="history-more older-messages" disabled={loadingHistory} onClick={() => void loadOlder()}>{loadingHistory ? "正在加载" : "加载更早消息"}</button>}
        {snapshot && chatFlow.map(({ message, key, nodes, first, last, pending }) => {
          const run = message.role === "assistant" && message.runId ? snapshot.runs.find((r) => r.id === message.runId) : undefined;
          const changes = last && run && ["done", "failed", "cancelled", "paused"].includes(run.status) ? snapshot.changesByRun?.[run.id] : undefined;
          const echo = pending?.echo, steer = pending?.steer;
          const retryEcho = echo && (echo.status === "failed" || echo.status === "unconfirmed");
          return <div className={"message " + message.role} key={key} data-message-id={message.id} data-pending-chat={echo?.status ?? (steer ? "steering" : undefined)}>
          {message.role === "assistant" && <div className="message-author">{agentName[message.agent || "main"]}</div>}
          <div className={message.role === "user" ? "user-message-bubble" : undefined}>
          {message.role === "assistant" ? <AssistantTurn run={run} content={last ? message.content : ""}
            runs={snapshot.runs} steps={allSteps} replies={snapshot.replies || []} nodes={nodes} showStatus={last} showHistory={first}
            onHistory={(steps) => setHistorySteps((old) => [...old, ...steps])} count={snapshot.stepCounts?.[message.runId || ""] || 0} files={snapshot.artifacts} onOpen={openFile}
            controlBackground={run?.payload.inherited ? undefined : (task, action) => void control(task, action)}
            control={(action) => { if (run) void control(run, action); }}/>
            : <>
              {message.content && <div className="message-content">{(() => {
                const commands = skillGestures(message.content).filter(({ name }) => skillNames.has(name));
                if (!commands.length) return message.content;
                return <>{commands.map(({ name, start, end }, index) => <Fragment key={start}>
                  {message.content.slice(commands[index - 1]?.end ?? 0, start)}
                  <button type="button" className="inline-skill" onClick={() => void previewSkill(name)}>{message.content.slice(start, end)}</button>
                </Fragment>)}{message.content.slice(commands.at(-1)!.end)}</>;
              })()}</div>}
              {!!message.attachments?.length && <div className="message-attachments" aria-label="本条消息引用的素材">
                {message.attachments.map((attachment) => {
                  return <button className="attachment-pill" key={attachment.id}
                    onClick={() => void openPinned(attachment)}
                    title={attachment.path + " · v" + attachment.version}>
                    <FileIcon kind={attachment.kind} size={13}/><span>{attachment.path.split("/").pop()}</span>
                  </button>;
                })}
              </div>}
            </>}
          {last && message.artifactIds.some((id) => !changes?.some((change) => change.id === id)) && <div className="message-files">{message.artifactIds.filter((id) => !changes?.some((change) => change.id === id)).map((id) => {
            const f = snapshot.artifacts.find((a) => a.id === id);
            return f ? <button key={id} onClick={() => openFile(id)}><FileIcon kind={f.kind} size={16}/><span>{f.path.split("/").pop()}</span><ChevronRight size={14}/></button> : null;
          })}</div>}
          {last && run && !isActiveRun(run) && (() => {
            const ids = descendantRunIds(run.id, snapshot.runs);
            const files = snapshot.deliveries?.filter((delivery) => ids.has(delivery.runId)).flatMap((delivery) => delivery.files) ?? [];
            return files.length > 0 && <div className="message-files" aria-label="交付文件">
              {[...new Map(files.map((file) => [file.id + ":" + file.version, file])).values()].map((file) =>
                <button key={file.id + ":" + file.version} onClick={() => void openPinned(file)} title={file.path + " · v" + file.version}>
                  <FileIcon kind={file.kind}/><span>{file.label || file.path.split("/").pop()}</span><small>v{file.version}</small>
                </button>)}
            </div>;
          })()}
          {run && !!changes?.length && <TurnChanges changes={changes} onOpen={(change) => openChange(run.id, change)}/>}
          {message.role === "assistant" && last && (!run || !isActiveRun(run)) && <div className="assistant-message-footer">
            {message.content.trim() && <MessageActions content={message.content} onError={() => setNotice("复制失败，请重试。")}/>}
            {!archived && run?.canFork && <button type="button" className="conversation-fork-button" disabled={creatingSession}
              onClick={() => void openSession(run.id)}>
              <GitBranch size={15} aria-hidden="true"/>从此轮分支
            </button>}
          </div>}
          </div>
          {pending ? <div className="pending-message-actions">
            <span role="status" title={echo?.error}>{steer ? "本轮下一步" : echo?.status === "accepted" ? "等待同步" :
              echo?.status === "failed" ? "发送失败" : echo?.status === "unconfirmed" ? "发送结果未确认" : "发送中"}</span>
            {retryEcho && !archived && <button type="button" title={echo.error || "重试发送"} aria-label="重试发送" disabled={sending || !!queueBusy}
              onClick={() => void submitChat(scope, { requestId: echo.requestId, text: echo.text, attachmentIds: echo.attachmentIds, mode: echo.mode })}><RotateCcw size={13} aria-hidden="true"/></button>}
            {steer && !archived && <>
              <button type="button" aria-label="编辑待发消息" title="编辑待发消息" disabled={sending || uploading || !!queueBusy}
                onClick={() => editQueueItem(steer)}><Pencil size={13} aria-hidden="true"/></button>
              <button type="button" aria-label="撤回待发消息" title="撤回待发消息" disabled={sending || uploading || !!queueBusy}
                onClick={() => void mutateQueue(steer.requestId, { action: "cancel", version: steer.version })}><X size={14} aria-hidden="true"/></button>
            </>}
          </div> : message.role === "user" && <MessageActions content={message.content} createdAt={message.createdAt} onError={() => setNotice("复制失败，请重试。")}/>}
        </div>;
        })}
      </div></div>
      {loadingConversation && <div className="chat-loading" role="status" key={scope}>
        <div className="chat-loading-indicator">
          <span className="chat-loading-dots" aria-hidden="true"><span/><span/><span/></span>
          <span>载入对话</span>
        </div>
      </div>}
      {chatScroll.readingHistory && <button className="chat-latest" onClick={chatScroll.jumpToLatest} title="回到最新消息" aria-label="回到最新消息"><ArrowDown size={16}/></button>}
      </div>
      {!archived && <div className="composer-wrap">
        {!!nextTurnItems?.length && <ChatQueue key={scope} items={nextTurnItems} editingId={editing?.requestId} busy={Boolean(queueBusy) || sending || uploading}
          runId={activeRun?.stage === "agent" ? activeRun.id : undefined}
          onEdit={editQueueItem} onChange={(id, change) => void mutateQueue(id, change)}/>}
        {editClosed && <div className="queued-target" role="status">这条消息已离开待发队列，编辑内容仍在输入框中。</div>}
        <div className="composer" onDragOver={(event) => {
          if (event.dataTransfer.types.includes(projectFileDragType) || event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = currentSnapshot && !uploadProject && !sending ? "copy" : "none";
          }
        }} onDrop={dropAttachment}>
        {!!draft.attachmentIds.length && <div className="composer-attachments" aria-label="待发送素材">
          {draft.attachmentIds.map((id) => {
            const attachment = snapshot && scopeKey(snapshot.project.id, snapshot.sessionId) === scope ? snapshot.artifacts.find((item) => item.id === id) : undefined;
            const name = attachment?.path.split("/").pop() || "素材";
            return <button className="attachment-pill" key={id} disabled={sending} aria-label={"移除" + name}
              title={"移除" + (attachment?.path || name)} onClick={() => updateDraft(scope, (current) => ({
                text: current.text, attachmentIds: current.attachmentIds.filter((item) => item !== id),
              }))}><FileIcon kind={attachment?.kind || "document"} size={13}/><span>{name}</span><X size={12}/></button>;
          })}
        </div>}
        {!!slashSuggestions.length && <div className="skill-suggestions" role="listbox" aria-label="技能建议">
          {slashSuggestions.map((skill, index) => <button key={skill.name} type="button" role="option" aria-selected={index === slashIndex}
            onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setSlashIndex(index)} onClick={() => pickSkill(skill)}>
            <strong>/{skill.name}</strong><small>{skill.description}</small></button>)}
        </div>}
        <textarea ref={composer} rows={2} value={draft.text} disabled={sending || queueBusy === scope} maxLength={16000}
          onChange={(e) => {
            const { value: text, selectionStart } = e.target;
            setComposerCaret(selectionStart); setSlashIndex(0);
            updateDraft(scope, (current) => ({ text, attachmentIds: current.attachmentIds }));
          }}
          onSelect={(e) => setComposerCaret(e.currentTarget.selectionStart)}
          onPaste={(event) => {
            if (!currentSnapshot || event.clipboardData.getData("text/plain") ||
                !Array.from(event.clipboardData.files).some((file) => file.type.startsWith("image/"))) return;
            event.preventDefault();
            void upload(event.clipboardData.files);
          }}
          placeholder={editing ? "编辑待发消息" : "描述故事，或告诉我哪里需要修改"} aria-label={editing ? "编辑待发消息" : "消息"}
          onKeyDown={(e) => {
            if (slashSuggestions.length && !e.nativeEvent.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault(); setSlashIndex((index) => (index + (e.key === "ArrowDown" ? 1 : slashSuggestions.length - 1)) % slashSuggestions.length); return;
              }
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setSlashDismissed(draft.text); return; }
              if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                e.preventDefault(); pickSkill(slashSuggestions[slashIndex] ?? slashSuggestions[0]); return;
              }
            }
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || e.getModifierState("AltGraph")) return;
            e.preventDefault();
            if (e.repeat || e.ctrlKey && e.metaKey) return;
            const accelerated = e.metaKey || e.ctrlKey;
            if (accelerated && !draft.text.trim() && !draft.attachmentIds.length) { void steerQueue(); return; }
            void send(e.altKey && steerable ? true : accelerated && steerable ? !defaultQueue : defaultQueue);
          }}/>
        <div className="composer-tools"><button className="icon-button" title={uploading ? "上传中" : "上传素材"} aria-label={uploading ? "上传中" : "上传素材"}
          disabled={Boolean(uploadProject) || sending || !snapshot} onClick={() => uploadInput.current?.click()}>{uploading ? <LoaderCircle size={18} className="spinning"/> : <Paperclip size={19}/>}</button>
          <input className="visually-hidden" type="file" multiple ref={uploadInput} accept=".md,image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,audio/mpeg,audio/wav,audio/mp4,audio/webm,audio/ogg" onChange={(e) => { void upload(e.target.files); e.target.value = ""; }}/>
          <button className="icon-button" type="button" title="使用技能" aria-label="使用技能" disabled={!currentSnapshot || sending}
            onClick={() => void openSkillCommands()}><Command size={17}/></button>
          <div className="toolbar-spacer"/>
          {editing ? <button className="queue-mode" type="button" disabled={uploading || Boolean(queueBusy)} onClick={() => setQueueDrafts((drafts) => ({ ...drafts, [scope]: null }))}>取消编辑</button> :
            steerable && canSend && !draft.requestId && <button className="queue-mode" type="button" title="⌘ / Ctrl + Enter" onClick={() => void send(!defaultQueue)}>{defaultQueue ? "补充当前轮" : "排到下一轮"}</button>}
          <button className="composer-primary" disabled={stopTarget ? stoppingRun === stopTarget.id : !canSend}
            onClick={() => void (stopTarget ? stop(stopTarget) : send())} aria-label={primaryLabel} title={stopTarget ? primaryLabel + "（连按两次 Esc）" : primaryLabel}>
            {stopTarget ? <Square size={13} fill="currentColor"/> : sending ? <LoaderCircle size={18} className="spinning"/> : editing ? <Check size={18}/> : <ArrowUp size={20}/>}
          </button>
        </div>
      </div></div>}
    </section>
    {workspaceOpen && snapshot && <aside className={"workspace-panel " + (!fileTreeOpen ? "tree-hidden" : "")} aria-label="项目文件与预览"
      style={{ "--workspace-width": workspaceWidth ? workspaceWidth + "px" : undefined, "--tree-width": treeWidth ? treeWidth + "px" : undefined } as CSSProperties}>
      <ResizeHandle label="调整预览区域宽度" edge="left" min={420}
        max={() => window.innerWidth <= 1200 ? window.innerWidth - 24 : window.innerWidth - (sidebar ? 208 : 0) - 332} onResize={resizeWorkspace}/>
      <header className="workspace-header">
        <button className="icon-button" onClick={() => setFileTreeOpen((open) => !open)} title={fileTreeOpen ? "收起目录" : "展开目录"} aria-label={fileTreeOpen ? "收起目录" : "展开目录"} aria-expanded={fileTreeOpen}><PanelLeftOpen size={17}/></button>
        <span className="workspace-title">文件</span><span className="workspace-project">{snapshot.project.title}</span><div className="toolbar-spacer"/>
        {!archived && <button className="icon-button" aria-label="打开本机项目目录" title="打开本机项目目录"
          onClick={() => void api(scopedEndpoint(scope, "/files/native"), { method: "POST" }).catch(error)}><FolderOpen size={16}/></button>}
        <button className="icon-button" aria-label="关闭文件区域" title="关闭" onClick={() => setWorkspaceOpen(false)}><X size={17}/></button>
      </header>
      <div className="workspace-layout">
        {fileTreeOpen && <nav className="workspace-files" aria-label="当前项目文件目录">
          <ResizeHandle label="调整文件目录宽度" edge="right" min={150} max={() => 320} onResize={resizeTree}/>
          <div className="workspace-files-scroll"><ProjectFiles key={projectId} projectId={projectId} readOnly={Boolean(archived)} projectTitle={snapshot.project.title} files={snapshot.artifacts} selected={fileId}
          folders={folders} onCreated={(file) => { setFolders((current) => ({ ...current, [file.path.slice(0, file.path.lastIndexOf("/"))]: true })); openFile(file.id); }} toggle={(path) => setFolders((f) => ({ ...f, [path]: !(f[path] ?? path.split("/").filter(Boolean).length === 1) }))} open={openFile}/></div></nav>}
        {skillDocument?.projectId === projectId ? <Suspense fallback={null}><SkillDocument key={skillDocument.skill.scope + ":" + skillDocument.skill.name}
          projectId={projectId} session={sessionId} skill={skillDocument.skill} readOnly={archived} close={() => setSkillDocument(null)}/></Suspense>
          : review ? <TurnComparison key={review.runId + "/" + review.file.id + "/" + review.file.afterVersion}
          projectId={projectId} runId={review.runId} file={review.file} onClose={() => setReview(null)}/>
          : file ? <FilePreview key={file.id + (versionedFile || archived ? ":v" + file.version : "")} file={file} historical={Boolean(versionedFile || archived)} artifacts={snapshot.artifacts} onClose={() => { previewRequest.current++; setVersionedFile(null); setFileId(null); }} onOpen={openFile}
      onOpenVersion={(version) => void openPinned({ ...file, version })}
      onOpenCurrent={versionedFile && snapshot.artifacts.some((artifact) => artifact.id === file.id) ? () => openFile(file.id) : undefined}
      attached={draft.attachmentIds.includes(file.id)} onAttach={sending || uploading ? undefined : () => attach(scope, file.id)}
      onSave={(content, version) => api<Artifact>("/projects/" + projectId + "/artifacts/" + file.id, { method: "PATCH", body: JSON.stringify({ content, version }) })}
      onLock={async (locked) => { try { await api("/projects/" + projectId + "/artifacts/" + file.id, { method: "PATCH", body: JSON.stringify({ locked }) }); } catch (e) { error(e); } }}
      onMake={(intent) => void make(intent)}/> : <div className="preview-empty"><FileText size={26} strokeWidth={1.2}/><span>选择文件</span></div>}
      </div>
    </aside>}
    {historySearch !== null && <Modal title="搜索对话" onClose={closeHistorySearch}>
      <form className="history-search" onSubmit={(event) => { event.preventDefault(); if (historySearch.trim()) void searchMessages(historySearch.trim()); }}>
        <div className="modal-search-field"><Search size={16} aria-hidden="true"/><input data-dialog-autofocus aria-label="搜索内容" placeholder="搜索对话内容" value={historySearch} onChange={(event) => {
          historySearchRequest.current?.abort();
          setHistorySearch(event.target.value); setMatches(null);
          if (!event.target.value.trim()) void searchMessages("");
        }} maxLength={160}/></div>
        <button className="button" type="submit" disabled={!historySearch.trim()}>搜索</button>
      </form>
      <div className="modal-scroll history-matches" role="region" aria-label="搜索结果">
        {matches?.length === 0 && <p className="history-no-matches">没有匹配的消息</p>}
        {matches?.map((match) => <button className="history-match" key={match.id} onClick={() => void openMatch(match)}>
          <span className="history-match-role">{match.role === "user" ? "你" : STUDIO_NAME}</span>
          <span className="history-match-text">{match.snippet}</span>
        </button>)}
      </div>
    </Modal>}
    {outlineOpen && <TurnOutline turns={turns} onClose={() => setOutlineOpen(false)} onSelect={(turn) => {
      setOutlineOpen(false); void openMatch({ id: turn.id, role: "user", snippet: turn.prompt, before: turn.before });
    }}/>}
    {manageSessions && !sessionArchive && <ManageSessions sessions={currentSnapshot?.sessions ?? []} current={sessionId} pending={sessionAction}
      onClose={() => setManageSessions(false)} onOpen={(id) => { setManageSessions(false); setSessionId(id); }} onChange={(id, change) => void changeSession(id, change)}/>}
    {sessionArchive && <ConfirmSessionArchive activity={sessionArchive.activity} pending={sessionAction} onClose={() => setSessionArchive(null)}
      onConfirm={() => void changeSession(sessionArchive.id, { action: "archive", archived: true, stopActivity: true })}/>}
    {archiveConfirm === projectId && <Modal title="归档项目" compact onClose={() => setArchiveConfirm(null)}>
      <div className="extension-panel">
        <p>该项目还有活动定时任务。暂停后归档，恢复项目时任务仍保持暂停。</p>
        <div className="extension-actions">
          <button className="button" type="button" disabled={archiving} onClick={() => setArchiveConfirm(null)}>取消</button>
          <button className="button" type="button" disabled={archiving} onClick={() => void archiveProject(true)}>暂停并归档</button>
        </div>
      </div>
    </Modal>}
    {deleteTarget && <Modal title="永久删除项目" compact busy={deleting} onClose={() => setDeleteTarget(null)}>
      <div className="project-delete-confirm" aria-busy={deleting}>
        <p><strong>「{deleteTarget.title}」</strong>的文件、对话和任务记录将被永久删除。此操作无法撤销。</p>
        {deleteIssue && <p className="conversation-rename-error" role="alert">{deleteIssue}</p>}
        <div className="conversation-rename-actions">
          <button className="button" type="button" data-dialog-autofocus disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button>
          <button className="button primary" type="button" disabled={deleting} onClick={() => void deleteProject()}>{deleting ? "正在删除…" : "永久删除"}</button>
        </div>
      </div>
    </Modal>}
    {rename && <Modal title="重命名对话" compact onClose={() => setRename(null)}>
      <form className="conversation-rename" onSubmit={(event) => { event.preventDefault(); void renameSession(); }}>
        <input ref={renameInput} aria-label="对话名称" value={rename.title} onChange={(event) => setRename({ ...rename, title: event.target.value })} maxLength={100}/>
        {renameIssue && <p className="conversation-rename-error" role="alert">{renameIssue}</p>}
        <div className="conversation-rename-actions">
          <button className="button" type="button" onClick={() => setRename(null)}>取消</button>
          <button className="button primary" type="submit" disabled={!rename.title.trim() || renaming}>保存</button>
        </div>
      </form>
    </Modal>}
    {showSettings && settings && <ModelSettings value={settings} onClose={() => setShowSettings(false)} onSaved={setSettings}/>}
    <Suspense fallback={null}>
      {extensions && currentSnapshot && <StudioExtensions key={scope} projectId={projectId} session={sessionId}
        sessions={currentSnapshot.sessions ?? []} readOnly={archived} initial={extensions} onClose={() => setExtensions(null)}
        onPresetChange={() => { setSkillCatalog(undefined); setPresetRevision((revision) => revision + 1); }}
        onOpenSession={(id, owner) => { setExtensions(null); setProjectId(owner); setSessionId(id); }}/>}
      {inspecting && currentSnapshot && <ExecutionInspector key={scope} projectId={projectId} sessionId={sessionId}
        active={currentSnapshot.runs.some(isActiveRun)} revision={currentSnapshot.cursor} readOnly={archived} onClose={() => setInspecting(false)} onFork={forkAtCheckpoint}/>}
    </Suspense>
    {showSkills && currentSnapshot && <Modal title="使用技能" compact onClose={() => setShowSkills(false)}>
      <div className="extension-panel">
        {skillCommands?.length ? <ul className="extension-list">{skillCommands.map((skill) =>
          <li key={skill.name}><button type="button" className="extension-row" onClick={() => pickSkill(skill)}>
            <span><strong>/{skill.name}</strong><small>{skill.description}</small></span></button></li>)}</ul>
          : skillCommands && <button type="button" className="button" onClick={() => { setShowSkills(false); setExtensions("skills"); }}>管理 Skills</button>}
      </div>
    </Modal>}
  </main>;
}
