import { JobOutput } from "./job-output";
import { memo, useEffect, useId, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BookOpen, ChevronRight, FilePenLine, Film, FolderSearch, Globe, ListCollapse, LoaderCircle, Workflow, Wrench } from "lucide-react";
import { STUDIO_NAME, type Artifact, type AssistantReply, type ExecutionDetail, type ExecutionPart, type ExecutionStep, type Run } from "@/lib/studio/types";
import { conversationNodes, descendantRunIds, groupAssistantProcess, isActiveRun, isLiveWait, type ConversationNode } from "@/lib/studio/conversation";
import { linkedArtifact } from "@/lib/studio/file-links";
import { api } from "./settings";
type Action = "pause" | "resume" | "cancel" | "resubmit";
const roles: Record<string, string> = { writer: "编剧", director: "导演", media: "制作", main: STUDIO_NAME };
const roleName = (run?: Run) => run?.payload.agentDefinition?.name || (run ? roles[run.agentRole] || run.agentRole : roles.media);
const names: Record<string, string> = { list_files: "查看目录", read_file: "读取文件", read_image: "查看图片", read_video: "创建视频检查任务", read_guide: "读取知识", web_search: "联网搜索", web_fetch: "阅读网页", list_agents: "查看协作任务", send_message: "发送协作消息", search_files: "搜索文件", write_file: "写入文件", edit_file: "修改文件", edit_files: "联动修改文件", move_file: "移动文件", rename_project: "命名项目", delegate: "委派任务", wait_for_tasks: "等待子任务", wait_for_input: "等待协作消息", control_task: "调整子任务", generate_image: "创建图片任务", generate_video: "创建视频任务", compose_video: "创建合成任务" };
Object.assign(names, { present_files: "标记交付文件", delegate_batch: "委派批次", list_team_tasks: "查看协作清单",
  save_team_task: "更新协作任务", list_tool_results: "查看工具记录", read_tool_result: "读取工具回执" });
function readableError(message: string) {
  if (/An assistant message with.*tool_calls|insufficient tool messages/.test(message)) return "对话上下文缺少工具回执，请重试继续。";
  if (/单次模型输出过大/.test(message)) return "长回复中断，已有内容已保留，可以重试继续。";
  return message;
}
const MarkdownBody = memo(function MarkdownBody({ content, files, onOpen }: { content: string; files: Artifact[]; onOpen: (id: string) => void }) {
  return <div className="message-content"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children, title }) => {
      const file = linkedArtifact(files, "/", href);
      if (file) return <button className="document-link" title={file.path} onClick={() => onOpen(file.id)}>{children}</button>;
      return <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>;
    },
    img: ({ src, alt }) => {
      const file = linkedArtifact(files, "/", typeof src === "string" ? src : undefined);
      return <img src={file?.url ?? src} alt={alt ?? ""}/>;
    },
  }}>{content}</ReactMarkdown></div>;
});
function formatToolDetail(value: string, truncated: boolean) {
  if (!truncated) {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch {}
  }
  return value;
}
function ToolRow({ step, owner, delegateName, rootId, projectId, files, onOpen }: { step: ExecutionStep; owner?: Run; delegateName?: string; rootId: string; projectId?: string; files: Artifact[]; onOpen: (id: string) => void }) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<ExecutionDetail>();
  const [error, setError] = useState("");
  const [loadingPart, setLoadingPart] = useState(false);
  const detailPath = "/projects/" + projectId + "/runs/" + step.runId + "/history/" + step.seq;
  const interrupted = step.status === "running" && owner && ["paused", "cancelled", "failed"].includes(owner.status), unknown = step.status === "running" && owner?.status === "done", working = step.status === "running" && !interrupted && !unknown;
  useEffect(() => {
    if (!expanded || !projectId) return;
    const controller = new AbortController();
    setError("");
    void api<ExecutionDetail>(detailPath, { signal: controller.signal }).then(
      (value) => { if (!controller.signal.aborted) setDetail(value); },
      (reason: Error) => { if (!controller.signal.aborted) setError(reason.message); },
    );
    return () => controller.abort();
  }, [expanded, projectId, detailPath, step.status, step.finishedAt, working]);
  const loadPart = async (field: "input" | "output") => {
    if (!detail || loadingPart) return;
    const value = detail[field] ?? "";
    setLoadingPart(true);
    try {
      const part = await api<ExecutionPart>(detailPath + "?field=" + field + "&offset=" + Array.from(value).length);
      setDetail((current) => current?.[field] === value ? { ...current, [field]: value + (part.text ?? ""),
        [field + "Truncated"]: part.nextOffset !== undefined } : current);
    } catch (reason) { setError((reason as Error).message); }
    finally { setLoadingPart(false); }
  };
  const Icon = working ? LoaderCircle : /web_/.test(step.name) ? Globe : /read_/.test(step.name) ? BookOpen : /write_|edit_|move_/.test(step.name) ? FilePenLine : /list_files|search_files/.test(step.name) ? FolderSearch : /video|image|production/.test(step.name) ? Film : /delegate|tasks|agents|message/.test(step.name) ? Workflow : Wrench;
  const file = files.find((file) => file.path === step.summary);
  const target = step.name === "delegate" ? delegateName || roles[step.summary] || step.summary : step.summary.replace(/^\/(?:01_创作|02_参考|03_图片|04_视频|05_音频|06_字幕|07_成片|08_记录)\//, "");
  const action = names[step.name] || "执行工具", label = step.status === "done" ? ["wait_for_tasks", "wait_for_input"].includes(step.name) ? "已结束等待" : "已" + action : action;
  const receipt = detail && <>
    <div>调用参数{detail.inputTruncated && " · 部分内容"}</div>
    <pre>{formatToolDetail(detail.input, detail.inputTruncated)}</pre>
    {detail.inputTruncated && <button className="history-more" disabled={loadingPart} onClick={() => void loadPart("input")}>读取更多参数</button>}
    <div>执行结果{detail.outputTruncated && " · 部分内容"}</div>
    {detail.output === null ? <span>暂无回执</span> : <pre>{formatToolDetail(detail.output, detail.outputTruncated)}</pre>}
    {detail.outputTruncated && <button className="history-more" disabled={loadingPart} onClick={() => void loadPart("output")}>读取更多结果</button>}
    {!!detail.images?.length && <div className="trace-attachments" aria-label="工具返回的图片">
      {detail.images.map(({ url, name }, index) => <a key={index} href={url} target="_blank" rel="noreferrer"><img alt={name} src={url} loading="lazy"/></a>)}
    </div>}
  </>;
  return <>
    <div className="execution-row" data-tool-id={step.callId} data-state={interrupted ? "interrupted" : step.status}>
      {projectId ? <button className="tool-disclosure" type="button" aria-expanded={expanded} aria-controls={expanded ? panelId : undefined}
        onClick={() => setExpanded(!expanded)}>
        <Icon size={15} className={working ? "spinning" : undefined} aria-hidden="true"/><span>{label}</span>
        <ChevronRight size={12} className="tool-chevron" aria-hidden="true"/>
      </button> : <><Icon size={15}/><span>{label}</span></>}
      {step.runId !== rootId && <span className="history-agent">{roleName(owner)}</span>}
      {target && (file ? <button className="history-target" title={file.path} onClick={() => onOpen(file.id)}>{file.path.split("/").pop()}</button> : <span className="history-target" title={step.summary}>{target}</span>)}
      {(working || interrupted || unknown || ["failed", "interrupted", "unknown"].includes(step.status)) && <span className="history-state">{working ? "执行中" : step.notDispatched ? "未执行" : interrupted || step.status === "interrupted" ? "已中断" : step.status === "failed" ? "失败" : "结果待确认"}</span>}
    </div>
    {expanded && <div id={panelId} className="tool-receipt">
      {error ? <span role="status">{error}</span> : !detail ? <span role="status">读取中</span> : detail.web ? <>
          <ul className="web-sources" aria-label="网页来源">
            {detail.web.sources.map(({ url, title, description }, index) => <li key={url + index}>
              <a href={url} target="_blank" rel="noopener noreferrer" title={url}>{title}</a>
              {description && <p>{description}</p>}
            </li>)}
          </ul>
          <details className="web-receipt-details">
            <summary>工具回执</summary>
            <div>{receipt}</div>
          </details>
        </> : receipt}
    </div>}
  </>;
}
function BackgroundTask({ run, files, onOpen, control }: {
  run: Run; files: Artifact[]; onOpen: (id: string) => void; control?: (run: Run, action: Action) => void;
}) {
  const path = run.payload.operation?.path ?? run.payload.archivedOutputPath;
  const [outputOpen, setOutputOpen] = useState(false);
  let artifactId: string | undefined;
  if (run.status === "done" && run.resultText) {
    try { artifactId = JSON.parse(run.resultText).id; } catch {}
  }
  const artifact = artifactId ? files.find((file) => file.id === artifactId) : undefined;
  const active = isActiveRun(run), stopped = run.status === "paused";
  const canResume = stopped || run.status === "failed" || (run.status === "cancelled" &&
    (Boolean(run.payload.providerTaskId) || Boolean(run.payload.outputUrl)));
  const resume = canResume && !run.payload.submissionUnknown, cancel = active || stopped;
  const name = path?.split("/").pop();
  const status = run.status === "done" ? "已保存" : run.status === "failed" ? "失败" : run.label;
  const detail = run.payload.cancellation?.detail || run.error;
  return <div className="recorded-background-task"><div className="execution-row background-task" data-background-task={run.id} data-state={run.status}>
    {active ? <LoaderCircle size={15} className="spinning" aria-hidden="true"/> : <Film size={15} aria-hidden="true"/>}
    <span>后台任务</span>
    {artifact ? <button className="history-target" title={artifact.path} onClick={() => onOpen(artifact.id)}>{artifact.path.split("/").pop()}</button> :
      name && <span className="history-target" title={path}>{name}</span>}
    {!run.payload.inherited && <button type="button" className="history-target" aria-expanded={outputOpen}
      onClick={() => setOutputOpen(!outputOpen)}>输出</button>}
    <span className="history-state" title={detail ?? undefined}>{status}</span>
    {control && !run.payload.imported && (resume || cancel) && <div className="background-task-actions">
      {active && <button type="button" onClick={() => control(run, "pause")}>暂停</button>}
      {resume && <button type="button" onClick={() => control(run, "resume")}>继续</button>}
      {cancel && <button type="button" title="取消后台任务" onClick={() => control(run, "cancel")}>取消</button>}
    </div>}
  </div>
    {outputOpen && <JobOutput url={"/api/studio/projects/" + run.projectId + "/runs/" + run.id + "/output" +
      (run.sessionId ? "?session=" + encodeURIComponent(run.sessionId) : "")}/>}
  </div>;
}
function AssistantProcess({ steps, running, children }: { steps: ExecutionStep[]; running?: ExecutionStep; children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const panel = useId();
  const grouped = steps.length > 1;
  const failures = steps.filter((step) => step.status === "failed" || step.status === "unknown" || step.status === "interrupted").length;
  return <div className="assistant-process">
    {grouped && <button type="button" className="assistant-process-toggle" aria-expanded={expanded} aria-controls={panel}
      onClick={() => setExpanded(!expanded)}>
      {running ? <LoaderCircle className="spinning" size={14} aria-hidden="true"/> : <ListCollapse size={14} aria-hidden="true"/>}
      <span>{running ? (names[running.name] || "执行工具") + "中" : "执行过程"}</span>
      <span className="assistant-process-count">{steps.length} 项{failures ? " · " + failures + " 项异常" : ""}</span>
      <ChevronRight size={12} className="tool-chevron" aria-hidden="true"/>
    </button>}
    <div id={panel} hidden={grouped && !expanded} className={grouped ? "assistant-process-steps" : undefined}>
      {(!grouped || expanded) && children}
    </div>
  </div>;
}

// Mirrors the reference's independent assistant-step and tool nodes instead of replacing one turn-wide text buffer.
export function AssistantTurn({ run, content, control, controlBackground, runs, steps, replies, count, files, onOpen, nodes: selectedNodes, showStatus = true, showHistory = true, onHistory }: {
  run?: Run; content: string; control: (action: Action) => void; controlBackground?: (run: Run, action: Action) => void; runs: Run[]; steps: ExecutionStep[]; replies: AssistantReply[]; count: number; files: Artifact[]; onOpen: (id: string) => void;
  nodes?: ConversationNode[]; showStatus?: boolean; showHistory?: boolean; onHistory?: (steps: ExecutionStep[]) => void;
}) {
  const [extra, setExtra] = useState<ExecutionStep[]>([]), [loading, setLoading] = useState(false), [loadError, setLoadError] = useState(""), [clock, setClock] = useState(Date.now);
  const retrying = run?.status === "waiting" && Boolean(run.error) && run.nextAttemptAt > 0;
  const retryRecord = run?.payload.modelRetry;
  const retryCount = retryRecord ? String(retryRecord.retry) + (retryRecord.maxRetries === undefined ? "" : "/" + retryRecord.maxRetries)
    : run?.label.match(/（(\d+(?:\/\d+)?)）$/u)?.[1];
  useEffect(() => { if (!retrying) return; const timer = setInterval(() => setClock(Date.now()), 500); return () => clearInterval(timer); }, [retrying]);
  const ids = useMemo(() => descendantRunIds(run?.id || "", runs), [run?.id, runs]);
  const history = [...new Map([...extra, ...steps.filter((step) => ids.has(step.runId))].map((step) => [step.seq, step])).values()];
  const owners = new Map(runs.map((owner) => [owner.id, owner]));
  const nodes = (selectedNodes ?? conversationNodes(ids, replies, history)).filter((node) => node.kind !== "tool" || !isLiveWait(node.step, owners.get(node.step.runId)));
  const sections = groupAssistantProcess(nodes);
  const children = runs.filter((item) => item.id !== run?.id && ids.has(item.id));
  const batches = new Map<string, Run[]>();
  for (const child of children) if (child.payload.batch) {
    const id = child.payload.batch.id;
    batches.set(id, [...(batches.get(id) ?? []), child]);
  }
  const hasReply = replies.some((reply) => reply.runId === run?.id && reply.kind === "reply" && reply.content.trim());
  const activeChildren = children.filter((item) => !item.background && !item.payload.batch && isActiveRun(item));
  const liveReplies = new Set(replies.filter((reply) => reply.status === "running" && reply.content.trim()).map((reply) => reply.runId));
  const liveTools = new Set(history.filter((step) => step.status === "running" && !isLiveWait(step, owners.get(step.runId))).map((step) => step.runId));
  const showRootActivity = run && isActiveRun(run) && (retrying || (
    !liveReplies.has(run.id) && !liveTools.has(run.id) &&
    (!activeChildren.length || run.label !== "等待子任务")
  ));
  const errors = (run ? [run, ...children] : []).filter((item) => !item.background && !item.payload.batch && item.error);
  const seconds = Math.max(0, Math.ceil(((run?.nextAttemptAt || 0) - clock) / 1000));
  return <div className="assistant-turn">
    {showHistory && run && history.length < count && <button className="history-more" disabled={loading} onClick={async () => {
      setLoading(true); setLoadError("");
      try { const before = history.length ? Math.min(...history.map((step) => step.seq)) : Number.MAX_SAFE_INTEGER;
        const data = await api<{ steps: ExecutionStep[] }>("/projects/" + run.projectId + "/runs/" + run.id + "/history?before=" + before); setExtra((old) => [...data.steps, ...old]); onHistory?.(data.steps); }
      catch (error) { setLoadError((error as Error).message); } finally { setLoading(false); }
    }}>{loading ? "加载中" : "查看更早操作"}</button>}
    {loadError && <p className="task-status-detail">{loadError}</p>}
    {sections.map((node) => {
      if (node.kind === "process") return <AssistantProcess key={"process:" + node.key} steps={node.steps}
        running={node.steps.findLast((step) => step.status === "running" && isActiveRun(owners.get(step.runId)))}>
        {node.steps.map((step) => <ToolRow key={step.seq} step={step} owner={owners.get(step.runId)}
          delegateName={step.name === "delegate" ? children.find((item) => item.agentRole === step.summary)?.payload.agentDefinition?.name : undefined}
          rootId={run?.id || ""} projectId={run?.projectId} files={files} onOpen={onOpen}/>)}
      </AssistantProcess>;
      const reply = node.reply, owner = owners.get(reply.runId);
      if (reply.kind === "compaction") return <div className="execution-row" key={reply.id}><ListCollapse size={15}/><span>上下文已自动整理</span></div>;
      const truncated = reply.status === "truncated", child = reply.runId !== run?.id;
      if (!reply.content && !truncated) return null;
      return <div className={child ? "subagent-reply" : "assistant-reply"} data-reply-id={reply.id} key={reply.id}>
        {child && <div className="subagent-reply-author"><Workflow size={15} aria-hidden="true"/><span>{roleName(owner)}</span></div>}
        {reply.content && <MarkdownBody content={reply.content} files={files} onOpen={onOpen}/>}
        {truncated && <div className="execution-row" role="status">回复已截断</div>}
      </div>;
    })}
    {showStatus && !hasReply && (run?.streamText || content) && <MarkdownBody content={run?.streamText || content} files={files} onOpen={onOpen}/>}
    {showStatus && showRootActivity && <div className="execution-row" role="status"><span className="task-status-dot" data-running/><span>{retrying ?
      (seconds ? seconds + " 秒后重试" : "等待重试") + (retryCount ? " · " + retryCount : "") : run.label}</span></div>}
    {showStatus && activeChildren.filter((item) => !liveReplies.has(item.id) && !liveTools.has(item.id)).map((item) => <div className="execution-row" role="status" key={item.id}><span className="task-status-dot" data-running/><span>{roleName(item)}</span><span>{item.label}</span></div>)}
    {showStatus && [...batches.entries()].map(([id, members]) => <details className="compact-task-list" key={id}>
      <summary>{members[0].payload.batch?.title} <small>{members.filter((item) => item.status === "done").length}/{members.length}</small></summary>
      {members.map((item) => <div className="execution-row" key={item.id}>
        <span>{item.payload.batch?.key}</span><span>{roleName(item)}</span><span title={item.error ?? undefined}>{item.status === "done" && item.label === "已完成" ? "完成" : item.label}</span>
        {controlBackground && !item.payload.imported && <span className="background-task-actions">
          {(item.status === "failed" || item.status === "paused" || item.status === "cancelled") &&
            <button type="button" onClick={() => controlBackground(item, "resume")}>继续</button>}
          {isActiveRun(item) && <button type="button" onClick={() => controlBackground(item, "pause")}>暂停</button>}
          {isActiveRun(item) && <button type="button" onClick={() => controlBackground(item, "cancel")}>取消</button>}
        </span>}
      </div>)}
    </details>)}
    {showStatus && children.filter((item) => item.background).map((item) => <BackgroundTask key={item.id} run={item} files={files} onOpen={onOpen} control={controlBackground}/>)}
    {showStatus && run?.payload.cancellation?.detail && <p className="task-status-detail">{run.payload.cancellation.detail}</p>}
    {showStatus && errors.map((item) => <p className="task-status-detail" key={item.id}>{item.id !== run?.id ? roleName(item) + "：" : ""}{readableError(item.error!)}</p>)}
    {showStatus && run?.status === "failed" && !run.payload.imported && !run.payload.inherited && <button className="history-more" onClick={() => control(run.payload.submissionUnknown ? "resubmit" : "resume")}>{run.payload.submissionUnknown ? "核对后重新提交" : "重试"}</button>}
  </div>;
}
