"use client";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Virtualizer, elementScroll, observeElementOffset, observeElementRect } from "@tanstack/virtual-core";
import { ChevronDown, ChevronRight, GitBranch, Search } from "lucide-react";
import type { TraceContent, TraceField, TracePage, TraceRow } from "@/lib/studio/trajectory";
import type { ModelUsage } from "@/lib/studio/types";
import { Modal } from "./modal";
import { api } from "./settings";
import { trajectoryChanges } from "./trajectory-refresh";

const checkpointNames: Record<string, string> = {
  "model/request": "模型请求已保存", "model/accepted": "已接收模型回复",
  "tools/settled": "工具回执已保存", "context/pruned": "已裁剪上下文",
  "context/compacted": "已压缩上下文", "context/unchanged": "沿用原上下文",
  "inbox/claimed": "已接收补充输入", "tasks/waiting": "等待任务", checkpoint: "运行检查点",
};
const statusNames: Record<string, string> = {
  started: "生成中", running: "运行中", completed: "完成", done: "完成",
  failed: "失败", interrupted: "中断", skipped: "已跳过",
};
const fields: [TraceField, string][] = [
  ["text", "正文"], ["messages", "输入"], ["system", "提示词"], ["tools", "工具定义"],
  ["response", "输出"], ["thinking", "思考"], ["system-diff", "提示词变更"], ["request", "完整请求"],
];
const toolFields = [["input", "参数"], ["output", "回执"]] as const;
const message = (error: unknown) => error instanceof Error ? error.message : "无法读取执行记录";
const elapsed = (ms: number) => ms < 1000 ? Math.max(0, ms) + " ms" : (ms / 1000).toFixed(2) + " s";

function heading(row: TraceRow) {
  switch (row.kind) {
    case "trajectory/checkpoint": return checkpointNames[row.label] || row.label;
    case "turn/start": return "开始轮次";
    case "turn/end": return row.label === "max-tokens" ? "回复已截断" : "结束轮次";
    case "step/start": return "开始步骤";
    case "step/end": return "结束步骤";
    case "llm/retry": return "计划重试 · " + row.label;
    case "llm/retry-started": return "开始重试 · " + row.label;
    case "tool/dispatched": return "已调用 " + row.label;
    case "request/context": return "请求上下文";
    case "compaction/prune": return "裁剪旧工具回执";
    case "image/offload": return "调整图片上下文";
    case "command/run": return "开始整理上下文";
    case "command/done": return "已整理上下文";
    case "message": return row.label || "消息";
    default: return row.label || (row.kind === "request" ? "模型请求" : "工具");
  }
}

function useTraceRevision(revision: number | undefined, load: { current: (() => void) | undefined }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (revision === undefined || timer.current !== undefined) return;
    timer.current = setTimeout(() => { timer.current = undefined; load.current?.(); }, 120);
  }, [revision, load]);
  useEffect(() => () => { clearTimeout(timer.current); timer.current = undefined; }, []);
}

function TraceDetail({ row, endpoint, scopeQuery, live, revision }: {
  row: TraceRow; endpoint: string; scopeQuery: string; live: boolean; revision?: number;
}) {
  const [field, setField] = useState<TraceField | "input" | "output">(row.kind === "step" || row.kind === "tool/dispatched" ? "output" : "text");
  const [part, setPart] = useState<TraceContent | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const isModel = row.kind === "request";
  const channel = isModel ? "model" : row.kind === "message" ? "message" : "tool";
  const source = endpoint + "/trajectory/" + row.runId + "/" + row.detailId;
  const loadRef = useRef<() => void>(undefined);
  useTraceRevision(revision, loadRef);
  const read = (offset: number, signal?: AbortSignal) =>
    api<TraceContent>(source + "?field=" + field + "&channel=" + channel + "&offset=" + offset + scopeQuery, { signal });
  useEffect(() => {
    const controller = new AbortController();
    let fetching = false, pending = false;
    const load = () => {
      if (fetching) { pending = true; return; }
      fetching = true;
      void read(0, controller.signal).then((value) => {
        if (!controller.signal.aborted) setPart(value);
      }).catch((error) => { if (!controller.signal.aborted) setError(message(error)); }).finally(() => {
        fetching = false;
        if (pending && !controller.signal.aborted) { pending = false; load(); }
      });
    };
    setError(""); setPart(null); setCopied(false); load();
    const watching = live && ((isModel && row.status === "started" && field === "text") || (!isModel && row.status === "running"));
    loadRef.current = watching ? load : undefined;
    const timer = watching ? setInterval(load, 950) : undefined;
    return () => { controller.abort(); clearInterval(timer); loadRef.current = undefined; };
  }, [source, field, row.status, live, scopeQuery]); // Fetch a new snapshot when a running record settles.
  const tabs = isModel ? row.status === "failed" || row.status === "interrupted" ? [...fields, ["stream", "流事件"] as const] : fields
    : channel === "tool" ? toolFields : [];
  return <section className="trace-detail" aria-label="记录详情">
    <div className="trace-detail-header"><strong>{heading(row)}</strong>
      <div className="trace-metrics">
        {row.attempt !== null && <span>尝试 {row.attempt}</span>}
        {row.firstOutputMs !== null && <span>首输出 {elapsed(row.firstOutputMs)}</span>}
        {row.stepFirstOutputMs !== null && <span>整步首输出 {elapsed(row.stepFirstOutputMs)}</span>}
        {row.durationMs !== null && <span>耗时 {elapsed(row.durationMs)}</span>}
        {row.kind === "request" && row.decodeMs != null && <span>生成 {elapsed(row.decodeMs)}</span>}
        {row.usage && <span>输入 {row.usage.inputTokens.toLocaleString()} · 输出 {row.usage.outputTokens.toLocaleString()} token
          {row.usage.cachedInputTokens !== undefined && " · 缓存读取 " + row.usage.cachedInputTokens.toLocaleString()}
          {row.usage.cacheWriteInputTokens !== undefined && " · 缓存写入 " + row.usage.cacheWriteInputTokens.toLocaleString()}</span>}
      </div>
      {row.error && <p className="extension-error">{row.error}</p>}
    </div>
    {!!tabs.length && <div className="trace-detail-tabs">{tabs.map(([id, label]) => <button type="button" aria-pressed={id === field} key={id} onClick={() => setField(id)}>{label}</button>)}</div>}
    {error && <p className="extension-error" role="alert">{error}</p>}
    {!part && !error && <p className="extension-muted" role="status">载入中…</p>}
    {part?.text ? <><pre className="trace-content" tabIndex={0}>{part.text}</pre><div className="trace-content-actions">
      {part.nextOffset !== undefined && <button type="button" className="button" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try {
          const more = await read(part.nextOffset!);
          setPart((now) => now?.nextOffset === part.nextOffset ? { ...more, text: (now?.text ?? "") + (more.text ?? ""), attachments: now?.attachments } : now);
        } catch (error) { setError(message(error)); } finally { setBusy(false); }
      }}>读取更多</button>}
      <button type="button" className="button" onClick={() => void navigator.clipboard.writeText(part.text!).then(() => setCopied(true)).catch(() => setError("复制失败"))}>
        {copied ? "已复制" : part.nextOffset ? "复制已载入内容" : "复制"}</button></div></>
      : part && <p className="extension-muted">{part.unavailable ? "历史记录没有保存此内容" : "暂无内容"}</p>}
    {!!part?.attachments?.length && <div className="trace-attachments" aria-label="附件">
      {part.attachments.map((attachment, index) => <a key={index} href={attachment.url} target="_blank" rel="noreferrer" title={attachment.name}>
        {attachment.kind === "image" && <img src={attachment.url} alt={attachment.name} loading="lazy"/>}
        <span>{attachment.name}</span>{attachment.width && attachment.height && <small>{attachment.width} × {attachment.height}</small>}
      </a>)}
    </div>}
  </section>;
}

type Interval = [number, number];
function TimeOverview({ rows, range, onRange }: { rows: TraceRow[]; range: Interval | null; onRange: (range: Interval | null) => void }) {
  const [zoom, setZoom] = useState(1), [position, setPosition] = useState(100), start = useRef<number | null>(null);
  if (!rows.length) return null;
  const first = rows.reduce((min, row) => Math.min(min, Date.parse(row.at)), Infinity);
  const end = rows.reduce((max, row) => Math.max(max, Date.parse(row.at) + (row.durationMs ?? row.firstOutputMs ?? 0)), first + 1);
  const window = Math.max(1, (end - first) / zoom), left = first + (end - first - window) * position / 100;
  const percent = (at: number) => (at - left) / window * 100;
  const instant = (point: number, rect: DOMRect) => left + Math.max(0, Math.min(1, (point - rect.left) / rect.width)) * window;
  const format = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
  return <section className="trace-overview" aria-label="时间概览">
    <div className="trace-overview-controls">
      <span>{format(left)} – {format(left + window)}</span><div className="toolbar-spacer"/>
      <label>缩放<input aria-label="时间线缩放" type="range" min={1} max={8} value={zoom} onChange={(event) => setZoom(Number(event.target.value))}/></label>
      {zoom > 1 && <label>平移<input aria-label="时间线平移" type="range" min={0} max={100} value={position} onChange={(event) => setPosition(Number(event.target.value))}/></label>}
      {range && <button className="button" type="button" onClick={() => onRange(null)}>清除选区</button>}
    </div>
    <div className="trace-graph" aria-label="拖选时间区间" onPointerDown={(event) => {
      if (event.button !== 0) return;
      start.current = instant(event.clientX, event.currentTarget.getBoundingClientRect());
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={(event) => {
      if (start.current === null) return;
      const at = instant(event.clientX, event.currentTarget.getBoundingClientRect());
      onRange([Math.min(start.current, at), Math.max(start.current, at)]);
    }} onPointerUp={() => { start.current = null; }} onPointerCancel={() => { start.current = null; }}>
      {range && <div className="trace-graph-range" style={{ left: percent(range[0]) + "%", width: Math.max(1, percent(range[1]) - percent(range[0])) + "%" }}/>}
      {rows.filter((row) => row.kind === "request" || row.kind === "step").map((row) => {
        const known = row.kind === "request" && row.firstOutputMs !== null && row.decodeMs != null
          ? row.firstOutputMs + row.decodeMs : row.durationMs ?? row.firstOutputMs ?? 0;
        const at = Date.parse(row.at), width = Math.max(.35, known / window * 100);
        if (percent(at) + width < 0 || percent(at) > 100) return null;
        const leading = row.kind === "request" && known && row.firstOutputMs ? Math.min(100, row.firstOutputMs / known * 100) : 0;
        const timing = [row.firstOutputMs !== null && "首输出 " + elapsed(row.firstOutputMs),
          row.decodeMs != null && "生成 " + elapsed(row.decodeMs)].filter(Boolean).join(" · ");
        return <div className={"trace-graph-mark " + row.kind} title={heading(row) + (timing ? " · " + timing : "")} key={row.seq}
          style={{ left: percent(at) + "%", width: width + "%" }}><span style={{ width: leading + "%" }}/></div>;
      })}
    </div>
  </section>;
}

type LedgerRow = { key: string; item: TraceRow } | { key: string; group: string; label: string; count: number; child?: boolean };

function TraceLedger({ rows, current, folded, toggle, select, loading, more, loadingMore, loadMore, queryKey }: {
  rows: LedgerRow[]; current?: number; folded: ReadonlySet<string>; toggle(id: string): void; select(seq: number): void;
  loading: boolean; more: boolean; loadingMore: boolean; loadMore(): void; queryKey: string;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const anchor = useRef<{ key: string; offset: number } | undefined>(undefined);
  const previous = useRef<{ queryKey: string; first?: string; last?: string }>({ queryKey });
  const [, redraw] = useReducer((count) => count + 1, 0);
  const options = {
    count: rows.length, getScrollElement: () => scroll.current, estimateSize: (index: number) => {
      const row = rows[index]; return row && "item" in row && row.item.detailId ? 39 : 29;
    },
    getItemKey: (index: number) => rows[index].key, overscan: 8,
    observeElementRect, observeElementOffset, scrollToFn: elementScroll, onChange: () => redraw(),
  };
  const [virtual] = useState(() => new Virtualizer<HTMLDivElement, HTMLLIElement>(options));
  virtual.setOptions(options);
  useLayoutEffect(() => virtual._didMount(), [virtual]);
  useLayoutEffect(() => virtual._willUpdate());
  const first = rows[0]?.key, last = rows.at(-1)?.key;
  useLayoutEffect(() => {
    if (previous.current.queryKey !== queryKey) { follow.current = true; anchor.current = undefined; }
    const saved = anchor.current;
    if (saved && first !== previous.current.first) {
      const index = rows.findIndex(({ key }) => key === saved.key);
      const offset = index < 0 ? undefined : virtual.getOffsetForIndex(index, "start")?.[0];
      if (offset !== undefined) virtual.scrollToOffset(offset + saved.offset);
      anchor.current = undefined;
    } else if (follow.current && last && last !== previous.current.last) {
      virtual.scrollToIndex(rows.length - 1, { align: "end" });
    }
    previous.current = { queryKey, first, last };
  }, [queryKey, first, last, rows.length, virtual]);
  return <div className="trace-list" aria-label="执行时间线" ref={scroll} onScroll={({ currentTarget }) => {
    follow.current = currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight < 36;
  }}>
    {loading && <p className="extension-muted" role="status">载入中…</p>}
    {!loading && !rows.length && <p className="extension-muted">暂无记录</p>}
    {more && <button type="button" className="button trace-earlier" disabled={loadingMore || loading} onClick={() => {
      const offset = scroll.current?.scrollTop ?? 0;
      const currentItem = virtual.getVirtualItemForOffset(offset);
      anchor.current = currentItem ? { key: String(currentItem.key), offset: offset - currentItem.start } : undefined;
      follow.current = false;
      loadMore();
    }}>更早记录</button>}
    {!!rows.length && <ol className="trace-virtual-list" style={{ height: virtual.getTotalSize() }}>
      {virtual.getVirtualItems().map(({ index, start, key }) => {
        const row = rows[index];
        return <li className="trace-virtual-row" key={key} data-index={index} ref={virtual.measureElement}
          style={{ transform: "translateY(" + start + "px)" }}>
          {"item" in row ? <button type="button" className={"trace-row" + (row.item.child ? " trace-child" : "") + (row.item.detailId ? "" : " trace-boundary")}
            aria-current={current === row.item.seq ? "true" : undefined} onClick={() => select(row.item.seq)}>
            <span><strong>{heading(row.item)}</strong>{(row.item.step != null || (row.item.attempt ?? 0) > 1) &&
              <small>{[row.item.step != null && "第 " + row.item.step + " 步", (row.item.attempt ?? 0) > 1 && "重试 " + (row.item.attempt! - 1)].filter(Boolean).join(" · ")}</small>}</span>
            <small>{statusNames[row.item.status ?? ""] || new Date(row.item.at).toLocaleTimeString("zh-CN", { hour12: false })}</small>
          </button> : <button type="button" className={"trace-fold" + (row.child ? " child" : "")} aria-expanded={!folded.has(row.group)}
            onClick={() => toggle(row.group)}>
            {folded.has(row.group) ? <ChevronRight size={13}/> : <ChevronDown size={13}/>}
            {row.label}<small>{row.count} 条</small>
          </button>}
        </li>;
      })}
    </ol>}
  </div>;
}

export function ExecutionInspector({ projectId, sessionId, active, revision, readOnly, onClose, onFork }: {
  projectId: string; sessionId: string; active: boolean; revision?: number; readOnly: boolean; onClose: () => void; onFork: (runId: string, seq: number) => Promise<void>;
}) {
  const endpoint = "/projects/" + projectId, scopeQuery = sessionId ? "&session=" + encodeURIComponent(sessionId) : "";
  const [search, setSearch] = useState(""), [query, setQuery] = useState("");
  const [rows, setRows] = useState<TraceRow[]>([]), [before, setBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<number>(), [error, setError] = useState(""), [forking, setForking] = useState(false);
  const [detailsOnly, setDetailsOnly] = useState(false);
  const [range, setRange] = useState<Interval | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [usage, setUsage] = useState<ModelUsage | null>(null);
  const loadedQuery = useRef<string | null>(null);
  const refreshRef = useRef<() => void>(undefined);
  useTraceRevision(revision, refreshRef);
  const head = useRef(0);
  const openRows = useRef<number[]>([]);
  useEffect(() => {
    openRows.current = rows.filter(({ status }) => status === "started" || status === "running" || status === "pending")
      .map(({ seq }) => seq);
  }, [rows]);
  const queryKey = endpoint + scopeQuery + "\n" + query;
  const fetchPage = (signal?: AbortSignal, before?: number, after?: number, watch?: number[]) => api<TracePage>(endpoint + "/trajectory?query=" +
    encodeURIComponent(watch ? "" : query) + (before !== undefined ? "&before=" + before : "") +
    (after !== undefined ? "&after=" + after : "") + (watch ? "&watch=" + watch.join(",") : "") + scopeQuery, { signal });
  useEffect(() => {
    const controller = new AbortController();
    let first = loadedQuery.current !== queryKey, fetching = false, pending = false;
    async function refresh() {
      if (fetching) { pending = true; return; }
      fetching = true;
      try {
        const next = await fetchPage(controller.signal);
        if (controller.signal.aborted) return;
        setUsage(next.usage);
        if (first) { setRows(next.rows); setBefore(next.before); loadedQuery.current = queryKey; head.current = next.rows[0]?.seq ?? 0; }
        else {
          const changes = await trajectoryChanges(next, head.current, openRows.current, (before, after, watch) =>
            fetchPage(controller.signal, before, after, watch));
          if (controller.signal.aborted) return;
          head.current = Math.max(head.current, next.rows[0]?.seq ?? 0);
          setRows((current) => [...changes.values(), ...current.filter((row) => !changes.has(row.seq))].sort((a, b) => b.seq - a.seq));
        }
        first = false;
      } catch (err) { if (!controller.signal.aborted) setError(message(err)); }
      finally {
        fetching = false;
        if (!controller.signal.aborted) {
          setLoading(false);
          if (pending) { pending = false; void refresh(); }
        }
      }
    }
    setError("");
    if (first) { setRows([]); setBefore(null); setLoading(true); }
    void refresh();
    refreshRef.current = refresh;
    const timer = active ? setInterval(() => void refresh(), 950) : undefined;
    return () => { controller.abort(); clearInterval(timer); refreshRef.current = undefined; };
  }, [queryKey, active]);
  const inside = range ? rows.filter((row) => Date.parse(row.at) <= range[1] && Date.parse(row.at) + (row.durationMs ?? 0) >= range[0]) : rows;
  const visible = detailsOnly ? inside.filter((row) => row.kind === "request" || row.kind === "step") : inside;
  const groups = new Map<string, Map<string, TraceRow[]>>();
  for (const item of [...visible].reverse()) {
    const key = item.rootRunId;
    const group = groups.get(key) ?? new Map<string, TraceRow[]>();
    groups.set(key, group);
    const execution = item.child ? item.runId : "";
    const items = group.get(execution) ?? [];
    items.push(item); group.set(execution, items);
  }
  const toggle = (id: string) => setFolded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const ledger: LedgerRow[] = [];
  for (const [id, children] of groups) {
    const turn = children.get("")?.[0].turn;
    ledger.push({ key: "turn-" + id, group: id, label: turn ? "轮次 " + turn : "子任务",
      count: [...children.values()].reduce((sum, items) => sum + items.length, 0) });
    if (folded.has(id)) continue;
    for (const [group, items] of children) {
      if (group) ledger.push({ key: "child-" + group, group, label: items[0].role, count: items.length, child: true });
      if (!folded.has(group)) for (const item of items) ledger.push({ key: String(item.seq), item });
    }
  }
  const row = visible.find((item) => item.seq === selected) ?? visible.find((item) => item.detailId) ?? visible[0];
  return <Modal title="执行检查器" wide onClose={onClose}>
    <div className="trace-inspector">
      <form className="trace-toolbar" onSubmit={(event) => {
        event.preventDefault(); setQuery(search.trim()); setSelected(undefined);
      }}>
        <div className="modal-search-field"><Search size={16} aria-hidden="true"/><input aria-label="搜索执行记录" placeholder="搜索执行记录" value={search} maxLength={160} onChange={(event) => {
          setSearch(event.target.value); if (!event.target.value) setQuery("");
        }}/></div>
        <button type="submit" className="button">搜索</button>
        <button type="button" className="button" aria-pressed={detailsOnly} onClick={() => setDetailsOnly(!detailsOnly)}>仅调用</button>
      </form>
      <TimeOverview rows={rows} range={range} onRange={setRange}/>
      {usage && <div className="trace-metrics trace-total">累计 token {usage.totalTokens.toLocaleString()} · 输入 {usage.inputTokens.toLocaleString()} · 输出 {usage.outputTokens.toLocaleString()}</div>}
      {error && <p className="extension-error" role="alert">{error}</p>}
      <div className="trace-body">
        <TraceLedger rows={ledger} current={row?.seq} folded={folded} toggle={toggle} select={(seq) => { setSelected(seq); setError(""); }}
          loading={loading} more={before !== null} loadingMore={loadingMore} queryKey={queryKey} loadMore={async () => {
            if (before === null) return;
            setLoadingMore(true); setError("");
            try {
              const older = await fetchPage(undefined, before);
              if (loadedQuery.current !== queryKey) return;
              setRows((current) => [...new Map([...current, ...older.rows].map((item) => [item.seq, item])).values()].sort((a, b) => b.seq - a.seq));
              setBefore(older.before);
            } catch (error) { setError(message(error)); } finally { setLoadingMore(false); }
          }}/>
        <div className="trace-inspection">
          {row && <div className="trace-selected">
            <time dateTime={row.at}>{new Date(row.at).toLocaleString("zh-CN", { hour12: false })}</time>
            {row.forkable && !readOnly && <button type="button" className="button" disabled={forking} onClick={async () => {
              setForking(true); setError("");
              try { await onFork(row.runId, row.seq); } catch (error) { setError(message(error)); } finally { setForking(false); }
            }}><GitBranch size={14}/>从此处建立分支</button>}
          </div>}
          {row?.detailId && ["request", "step", "message"].includes(row.kind) ?
            <TraceDetail key={row.seq} row={row} endpoint={endpoint} scopeQuery={scopeQuery} live={active} revision={revision}/>
            : row ? <div><strong className="trace-checkpoint-label">{heading(row)}</strong>
              {row.error && <p className="task-status-detail">{row.error}</p>}</div> : <p className="extension-muted">选择一条记录</p>}
        </div>
      </div>
    </div>
  </Modal>;
}
