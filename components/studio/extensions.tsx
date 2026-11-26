"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FileText, Folder, Plus, Trash2 } from "lucide-react";
import { NativeSelect } from "@/components/ui/native-select";
import type { ManagedSkillScope, SkillDirectory, SkillEntry } from "@/lib/studio/skills";
import type { McpProbeView, McpServerView } from "@/lib/studio/mcp";
import type { SessionPreset } from "@/lib/studio/session-presets";
import type { ScheduleHistory, ScheduleRecord } from "@/lib/studio/schedules";
import type { ProjectSession } from "@/lib/studio/types";
import { MarkdownEditor } from "./markdown-editor";
import { Modal } from "./modal";
import { api, RequestError } from "./settings";

type Tab = "skills" | "mcp" | "presets" | "schedules";
const labels: Record<Tab, string> = { skills: "Skills", mcp: "MCP", presets: "会话预设", schedules: "定时任务" };
const json = (method: string, value?: unknown) => ({ method, ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "请求失败";
const scopeQuery = (session: string) => session ? "?session=" + encodeURIComponent(session) : "";

function useItems<T>(endpoint: string, watch?: string, signalOnly = false) {
  const [items, setItems] = useState<T[] | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const reload = useCallback(async (signal?: AbortSignal) => {
    const request = ++revision.current;
    const values = await api<T[]>(endpoint, { signal });
    if (!signal?.aborted && request === revision.current) setItems(values);
  }, [endpoint]);
  useEffect(() => {
    setItems(null);
    if (watch) {
      const events = new EventSource(watch);
      const controller = new AbortController();
      const refresh = () => void reload(controller.signal).catch((err) => { if (!controller.signal.aborted) setError(errorMessage(err)); });
      if (signalOnly) refresh();
      events.onmessage = (event) => signalOnly ? refresh() : setItems(JSON.parse(event.data) as T[]);
      return () => { controller.abort(); events.close(); };
    }
    const controller = new AbortController();
    void reload(controller.signal).catch((err) => { if (!controller.signal.aborted) setError(errorMessage(err)); });
    return () => controller.abort();
  }, [reload, watch, signalOnly]);
  async function act(action: () => Promise<unknown>) {
    if (busy) return;
    setError(""); setBusy(true);
    try { await action(); } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  return { items, error, busy, reload, act };
}

function Feedback({ error }: { error: string }) {
  return error ? <p className="extension-error" role="alert">{error}</p> : null;
}

function ItemList({ loading, empty, children, title, onNew, actions }: {
  loading?: boolean; empty: boolean; title: string; onNew?: () => void; children?: ReactNode; actions?: ReactNode;
}) {
  return <>
    <div className="extension-heading">
      <strong>{title}</strong>
      {(actions || onNew) && <div className="extension-heading-actions">
        {actions}
        {onNew && <button type="button" className="button" onClick={onNew}><Plus size={14}/>新建</button>}
      </div>}
    </div>
    {loading ? <p className="extension-muted" role="status">载入中…</p> : empty ? <p className="extension-muted">暂无记录</p> : <ul className="extension-list">{children}</ul>}
  </>;
}

function EditActions({ busy, onClose, onDelete, name, saveDisabled, closeLabel = "取消" }: {
  busy: boolean; onClose: () => void; onDelete?: () => void; name?: string; saveDisabled?: boolean; closeLabel?: string;
}) {
  const [confirm, setConfirm] = useState(false);
  return <div className="extension-actions">
    {onDelete && (confirm ? <><span className="extension-muted" title={name}>删除「{name}」？</span>
      <button className="button" type="button" disabled={busy} onClick={onDelete}>确认删除</button></> : <button className="icon-button" type="button" aria-label="删除" title="删除" onClick={() => setConfirm(true)}><Trash2 size={16}/></button>)}
    <div className="toolbar-spacer"/>
    <button className="button" type="button" disabled={busy} onClick={onClose}>{closeLabel}</button>
    <button className="button primary" type="submit" disabled={busy || saveDisabled}>{busy ? "保存中…" : "保存"}</button>
  </div>;
}

function SkillFiles({ endpoint, file, onSelect, children }: { endpoint: string; file: string; onSelect: (path: string) => void; children: ReactNode }) {
  const [directory, setDirectory] = useState<SkillDirectory>();
  const [directoryError, setDirectoryError] = useState("");
  const [preview, setPreview] = useState<{ path: string; text: string | null; error?: string }>();
  const query = endpoint.includes("?") ? "&" : "?";
  const resource = file ? endpoint + query + "resource=" + encodeURIComponent(file) : "";
  useEffect(() => {
    const controller = new AbortController();
    void api<SkillDirectory>(endpoint + query + "directory=1", { signal: controller.signal })
      .then((items) => { if (!controller.signal.aborted) setDirectory(items); })
      .catch((error) => { if (!controller.signal.aborted) setDirectoryError(errorMessage(error)); });
    return () => controller.abort();
  }, [endpoint, query]);
  useEffect(() => {
    if (!resource) return;
    const controller = new AbortController();
    void api<{ text: string | null }>(resource, { signal: controller.signal })
      .then(({ text }) => { if (!controller.signal.aborted) setPreview({ path: file, text }); })
      .catch((error) => { if (!controller.signal.aborted) setPreview({ path: file, text: null, error: errorMessage(error) }); });
    return () => controller.abort();
  }, [resource, file]);
  const current = preview?.path === file ? preview : undefined;
  return <div className="skill-workspace">
    <nav className="skill-file-list" aria-label="技能目录">
      <ul>
        <li><button type="button" aria-current={!file ? "true" : undefined} onClick={() => onSelect("")}>
          <FileText size={14} aria-hidden="true"/><span>{directory?.entry ?? "SKILL.md"}</span>
        </button></li>
        {directory?.files.map(({ path, kind }) => {
          const parts = path.split("/"), label = parts.at(-1);
          const style = { paddingInlineStart: 8 + Math.min(parts.length - 1, 6) * 10 };
          return <li key={path}>{kind === "directory" ? <div className="skill-folder" style={style} title={path}>
            <Folder size={14} aria-hidden="true"/><span>{label}</span>
          </div> : <button type="button" style={style} title={path} aria-current={file === path ? "true" : undefined} onClick={() => onSelect(path)}>
            <FileText size={14} aria-hidden="true"/><span>{label}</span>
          </button>}</li>;
        })}
      </ul>
      {directoryError && <Feedback error={directoryError}/>}
    </nav>
    <div className="extension-editor" hidden={Boolean(file)}>{children}</div>
    {file && <section className="extension-editor skill-file-preview" aria-label="技能文件预览">
      <header title={file}>{file}</header>
      {current?.error ? <Feedback error={current.error}/> : !current ? <p role="status">读取中…</p> : current.text === null
        ? <a className="button" href={"/api/studio" + resource + "&download=1"} download>下载文件</a>
        : <pre className="raw-content">{current.text}</pre>}
    </section>}
  </div>;
}

function SkillsPanel({ endpoint, session, readOnly, initial }: { endpoint: string; session: string; readOnly: boolean; initial?: SkillEntry }) {
  const remote = useItems<SkillEntry>(endpoint + "/skills" + scopeQuery(session), "/api/studio" + endpoint + "/skills/watch" + scopeQuery(session), true);
  const [edit, setEdit] = useState<{ name?: string; scope: SkillEntry["scope"]; text: string } | null>(null);
  const [scope, setScope] = useState<ManagedSkillScope>("project");
  const [file, setFile] = useState("");
  const show = async (item: SkillEntry) => {
    const { text } = await api<{ text: string }>(endpoint + "/skills/" + item.scope + "/" + item.name + scopeQuery(session));
    setFile(""); setEdit({ name: item.name, scope: item.scope, text });
  };
  useEffect(() => { if (initial) void remote.act(() => show(initial)); }, [initial]);
  const locked = readOnly || edit?.scope === "external" || edit?.scope === "provider";
  const save = () => edit && !locked && !file && remote.act(async () => {
    await api(endpoint + "/skills/" + edit.scope + (edit.name ? "/" + edit.name : ""), json(edit.name ? "PUT" : "POST", { text: edit.text }));
    await remote.reload(); setEdit(null);
  });
  const editor = edit && <MarkdownEditor value={edit.text} readOnly={locked} onChange={(text) => setEdit({ ...edit, text })} onSave={() => void save()}/>;
  const skillPath = edit?.name && edit.scope !== "provider" ? endpoint + "/skills/" + edit.scope + "/" + edit.name + scopeQuery(session) : "";
  if (edit) return <form className="extension-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="form-fields">
      <div className="form-row"><label>范围<NativeSelect value={edit.scope} disabled={Boolean(edit.name) || locked}
        onChange={(event) => setEdit({ ...edit, scope: event.target.value as SkillEntry["scope"] })}><option value="project">当前项目</option><option value="global">所有项目</option><option value="external">本机目录</option><option value="provider">扩展来源</option></NativeSelect></label>
        {!file && <label>导入 SKILL.md<input type="file" accept=".md,text/markdown" disabled={locked}
          onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void remote.act(async () => setEdit({ ...edit, text: await file.text() })); }}/></label>}</div>
      {skillPath ? <SkillFiles key={skillPath} endpoint={skillPath} file={file} onSelect={setFile}>{editor}</SkillFiles> : <div className="extension-editor">{editor}</div>}
    </div>
    <div className="extension-edit-footer">
      <Feedback error={remote.error}/>
      {locked || file ? <button type="button" className="button" onClick={() => file ? setFile("") : setEdit(null)}>返回</button> : <EditActions key={edit.name ?? "new"} busy={remote.busy} onClose={() => setEdit(null)} name={edit.name}
        onDelete={edit.name ? () => void remote.act(async () => {
          await api(endpoint + "/skills/" + edit.scope + "/" + edit.name, json("DELETE")); await remote.reload(); setEdit(null);
        }) : undefined}/>}
    </div>
  </form>;
  return <div className="extension-panel">
    <ItemList title="技能" loading={remote.items === null && !remote.error} empty={!remote.items?.length}
      onNew={readOnly ? undefined : () => setEdit({ scope: "project", text: "---\nname: my-skill\ndescription: 什么时候使用这个技能\n---\n\n" })}
      actions={!readOnly && <>
        <NativeSelect size="sm" aria-label="导入范围" value={scope} onChange={(event) => setScope(event.target.value as ManagedSkillScope)}>
          <option value="project">当前项目</option><option value="global">所有项目</option>
        </NativeSelect>
        <label className="button" title="导入技能目录">导入目录<input className="visually-hidden" type="file" aria-label="导入技能目录" {...{ webkitdirectory: "" }} multiple disabled={remote.busy}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length) void remote.act(async () => {
              const bundle = new FormData(); bundle.set("scope", scope);
              for (const file of files) {
                const relative = file.webkitRelativePath.split("/").slice(1).join("/");
                if (relative && file.name !== ".DS_Store") bundle.append(relative, file);
              }
              await api(endpoint + "/skills/bundle", { method: "POST", body: bundle }); await remote.reload();
            });
          }}/></label>
      </>}>
      {remote.items?.map((item) => <li key={item.scope + ":" + item.name}><button className="extension-row" type="button" disabled={remote.busy}
        onClick={() => void remote.act(() => show(item))}><span><strong>/{item.name}</strong><small>{item.description}</small></span><small>{{ project: "项目", external: "本机", global: "全局", provider: "扩展" }[item.scope]}</small></button></li>)}
    </ItemList>
    <Feedback error={remote.error}/>
  </div>;
}

type McpDraft = { id?: string; name: string; enabled: boolean; transport: McpServerView["transport"]; location: string; args: string; cwd: string;
  credentials: string; hasCredentials?: boolean; startupTimeoutMs?: string; toolCallTimeoutMs?: string;
  reconnect?: Partial<NonNullable<McpServerView["reconnect"]>>; maxInstructionBytes?: string; closeTimeoutMs?: string; failOnStartupError?: boolean };
function McpCredentials({ endpoint }: { endpoint: string }) {
  const remote = useItems<string>(endpoint);
  const [draft, setDraft] = useState<{ name: string; value: string; existing?: boolean } | null>(null);
  const save = (name: string, value: string | null) => remote.act(async () => {
    await api(endpoint, json("PUT", { name, value }));
    await remote.reload();
    setDraft(null);
  });
  return <details className="mcp-credentials">
    <summary>凭据</summary>
    {draft ? <form className="mcp-credential-form form-fields" onSubmit={(event) => { event.preventDefault(); void save(draft.name, draft.value); }}>
      <label>名称<input required readOnly={draft.existing} value={draft.name} maxLength={80}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}/></label>
      <label>密钥<input required type="password" autoComplete="off" value={draft.value} maxLength={8192}
        onChange={(event) => setDraft({ ...draft, value: event.target.value })}/></label>
      <EditActions key={draft.name + Boolean(draft.existing)} busy={remote.busy} name={draft.name} onClose={() => setDraft(null)}
        onDelete={draft.existing ? () => void save(draft.name, null) : undefined}/>
    </form> : <ul className="extension-list">
      {remote.items?.map((name) => <li key={name}><button className="extension-row" type="button" onClick={() => setDraft({ name, value: "", existing: true })}>
        <code>{name}</code><span>更新</span>
      </button></li>)}
      <li><button type="button" className="button" onClick={() => setDraft({ name: "", value: "" })}><Plus size={13}/>新建凭据</button></li>
    </ul>}
    <Feedback error={remote.error}/>
  </details>;
}
function McpPanel() {
  const endpoint = "/extensions/mcp";
  const remote = useItems<McpServerView>(endpoint, "/api/studio" + endpoint + "/watch");
  const [edit, setEdit] = useState<McpDraft | null>(null);
  const [tested, setTested] = useState("");
  if (edit) return <form className="extension-form" onSubmit={(event) => { event.preventDefault(); void remote.act(async () => {
    const args = edit.transport === "stdio" ? JSON.parse(edit.args || "[]") : undefined;
    const credentials = edit.credentials.trim() ? JSON.parse(edit.credentials) : undefined;
    await api(endpoint + (edit.id ? "/" + edit.id : ""), json(edit.id ? "PUT" : "POST", {
      name: edit.name, enabled: edit.enabled, transport: edit.transport, credentials,
      startupTimeoutMs: edit.startupTimeoutMs ? Number(edit.startupTimeoutMs) : undefined,
      toolCallTimeoutMs: edit.toolCallTimeoutMs ? Number(edit.toolCallTimeoutMs) : undefined,
      closeTimeoutMs: edit.closeTimeoutMs ? Number(edit.closeTimeoutMs) : undefined, failOnStartupError: edit.failOnStartupError,
      maxInstructionBytes: edit.maxInstructionBytes ? Number(edit.maxInstructionBytes) : undefined, reconnect: edit.reconnect,
      ...(edit.transport === "stdio" ? { command: edit.location, args, cwd: edit.cwd || undefined } : { url: edit.location }),
    }));
    setEdit(null);
  }); }}>
    <div className="form-fields">
      <div className="form-row"><label>名称<input required maxLength={64} value={edit.name} onChange={(event) => setEdit({ ...edit, name: event.target.value })}/></label>
      <label>连接方式<NativeSelect value={edit.transport} onChange={(event) => setEdit({ ...edit, transport: event.target.value as McpDraft["transport"], location: "", credentials: "" })}>
        <option value="streamable-http">Streamable HTTP</option><option value="stdio">本地命令 (stdio)</option>
      </NativeSelect></label></div>
      <label>{edit.transport === "stdio" ? "命令" : "服务地址"}<input required value={edit.location} spellCheck={false}
        placeholder={edit.transport === "stdio" ? "node" : "https://…/mcp"} onChange={(event) => setEdit({ ...edit, location: event.target.value })}/></label>
      {edit.transport === "stdio" && <div className="form-row">
        <label>参数（JSON 数组）<input value={edit.args} spellCheck={false} placeholder={'["server.js"]'} onChange={(event) => setEdit({ ...edit, args: event.target.value })}/></label>
        <label>工作目录（可选）<input value={edit.cwd} spellCheck={false} onChange={(event) => setEdit({ ...edit, cwd: event.target.value })}/></label></div>}
      <label>{edit.transport === "stdio" ? "环境变量" : "请求头"}（JSON 对象，可选）<textarea rows={2} autoComplete="off" spellCheck={false}
        placeholder={edit.hasCredentials ? "留空保留，输入 {} 清除" : '{"Authorization":"Bearer ${credential:NAME}"}'} value={edit.credentials} onChange={(event) => setEdit({ ...edit, credentials: event.target.value })}/></label>
      <div className="form-row">
        <label>连接超时（毫秒）<input type="number" min={1} max={2147483647} placeholder="默认" value={edit.startupTimeoutMs ?? ""}
          onChange={(event) => setEdit({ ...edit, startupTimeoutMs: event.target.value })}/></label>
        <label>调用超时（毫秒）<input type="number" min={1} max={2147483647} placeholder="60000" value={edit.toolCallTimeoutMs ?? ""}
          onChange={(event) => setEdit({ ...edit, toolCallTimeoutMs: event.target.value })}/></label>
      </div>
      <details>
        <summary>连接选项</summary>
        <div className="form-fields">
          <label className="check-label"><input type="checkbox" checked={edit.reconnect?.enabled !== false}
            onChange={(event) => setEdit({ ...edit, reconnect: { ...edit.reconnect, enabled: event.target.checked } })}/>自动重连</label>
          <div className="form-row">{([
            ["初始等待（毫秒）", "initialDelayMs", 500, 1], ["最长等待（毫秒）", "maxDelayMs", 30000, 1], ["最多重连次数", "maxAttempts", 10, 0],
          ] as const).map(([label, key, fallback, min]) => <label key={key}>{label}<input type="number" min={min}
            placeholder={String(fallback)} value={edit.reconnect?.[key] ?? ""} onChange={(event) => setEdit({ ...edit,
              reconnect: { ...edit.reconnect, [key]: event.target.value ? Number(event.target.value) : undefined },
            })}/></label>)}</div>
          <label>服务指令上限（字节）<input type="number" min={1} placeholder="32768" value={edit.maxInstructionBytes ?? ""}
            onChange={(event) => setEdit({ ...edit, maxInstructionBytes: event.target.value })}/></label>
          <label>关闭超时（毫秒）<input type="number" min={1} max={2147483647} placeholder="5000" value={edit.closeTimeoutMs ?? ""}
            onChange={(event) => setEdit({ ...edit, closeTimeoutMs: event.target.value })}/></label>
          <label className="check-label"><input type="checkbox" checked={edit.failOnStartupError === true}
            onChange={(event) => setEdit({ ...edit, failOnStartupError: event.target.checked })}/>首次连接失败时停止启用</label>
        </div>
      </details>
      <label className="check-label"><input type="checkbox" checked={edit.enabled} onChange={(event) => setEdit({ ...edit, enabled: event.target.checked })}/>启用连接</label>
    </div>
    <div className="extension-edit-footer">
      <Feedback error={remote.error}/>
      <EditActions key={edit.id ?? "new"} busy={remote.busy} name={edit.name} onClose={() => setEdit(null)}
        onDelete={edit.id ? () => void remote.act(async () => { await api(endpoint + "/" + edit.id, json("DELETE")); setEdit(null); }) : undefined}/>
    </div>
  </form>;
  return <div className="extension-panel">
    <ItemList title="MCP 服务" loading={remote.items === null && !remote.error} empty={!remote.items?.length}
      onNew={() => setEdit({ name: "", enabled: true, transport: "streamable-http", location: "", args: "[]", cwd: "", credentials: "" })}>
      {remote.items?.map((row) => <li className="extension-list-item" key={row.id}>
        <button type="button" className="extension-row" disabled={!row.configured} onClick={() => setEdit({ id: row.id, name: row.name, enabled: row.enabled, transport: row.transport,
          location: row.transport === "stdio" ? row.command : row.url, args: row.transport === "stdio" ? JSON.stringify(row.args) : "[]",
          cwd: row.transport === "stdio" ? row.cwd ?? "" : "", credentials: "", hasCredentials: row.hasCredentials,
          startupTimeoutMs: row.startupTimeoutMs?.toString(), toolCallTimeoutMs: row.toolCallTimeoutMs?.toString(),
          reconnect: row.reconnect, maxInstructionBytes: row.maxInstructionBytes?.toString(),
          closeTimeoutMs: row.closeTimeoutMs?.toString(), failOnStartupError: row.failOnStartupError })}>
          <span><strong>{row.name}</strong><small>{row.transport === "stdio" ? "stdio" : "Streamable HTTP"} · {row.status === "ready" ? row.toolCount + " 个工具" :
            { disabled: "已停用", reconnecting: "正在重连", connecting: "正在连接", offline: "离线", "waiting-credentials": "等待凭据" }[row.status]}</small>{row.failure && <small>{row.failure}</small>}</span>
        </button>
        <button type="button" className="button" disabled={remote.busy} onClick={() => void remote.act(async () => {
          setTested(""); const tested = await api<McpProbeView>(endpoint + "/" + row.id + "/test", json("POST"));
          const outcome = tested.ok ? tested.name + " 已连接，发现 " + tested.toolCount + " 个工具" +
            (tested.truncated ? "（结果已截断）" : "") : tested.message;
          setTested(outcome + (tested.closeConfirmed ? "，测试连接已关闭" : "，" + tested.cleanupError));
        })}>测试连接</button>
        {row.enabled && <button type="button" className="button" disabled={remote.busy} onClick={() => void remote.act(async () => {
          await api(endpoint + "/" + row.id + "/restart", json("POST"));
        })}>重连</button>}
      </li>)}
    </ItemList>
    <Feedback error={remote.error}/>{tested && <p className="extension-muted" role="status">{tested}</p>}
    <McpCredentials endpoint={endpoint + "/credentials"}/>
  </div>;
}

function PresetsPanel({ endpoint, session, readOnly, onPresetChange }: { endpoint: string; session: string; readOnly: boolean; onPresetChange: () => void }) {
  const path = "/extensions/presets", binding = endpoint + "/preset" + scopeQuery(session);
  const remote = useItems<SessionPreset>(path);
  const [chosen, setChosen] = useState<SessionPreset | null>(null);
  const [selection, setSelection] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [edit, setEdit] = useState<SessionPreset | null>(null);
  const [skills, setSkills] = useState<SkillEntry[]>([]), [servers, setServers] = useState<McpServerView[]>([]);
  const [tools, setTools] = useState<{ name: string; label: string }[]>([]);
  const plugins = useItems<{ id: string; name: string }>("/extensions/plugins").items;
  const [defaultPreset, setDefaultPreset] = useState("");
  useEffect(() => {
    const controller = new AbortController(), options = { signal: controller.signal };
    void Promise.all([api<SessionPreset | null>(binding, options), api<SkillEntry[]>(endpoint + "/skills", options), api<McpServerView[]>("/extensions/mcp", options),
      api<{ name: string; label: string }[]>("/extensions/tools", options), api<{ id: string | null }>(path + "/default", options)])
      .then(([preset, catalog, mcp, local, defaults]) => {
        if (!controller.signal.aborted) { setChosen(preset); setSelection(preset?.id ?? ""); setSkills(catalog); setServers(mcp); setTools(local); setDefaultPreset(defaults.id ?? ""); setLoaded(true); }
      }).catch(() => {});
    return () => controller.abort();
  }, [binding, endpoint]);
  const newPreset = () => setEdit({ id: "", name: "", instructions: "", skills: null, mcpServers: null, tools: null, childPresets: [], plugins: [] });
  const toggle = (values: readonly string[], id: string) => values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
  if (edit) return <form className="extension-form" onSubmit={(event) => { event.preventDefault(); void remote.act(async () => {
    const { id, ...configuration } = edit;
    await api(path + (id ? "/" + id : ""), json(id ? "PUT" : "POST", configuration)); await remote.reload(); setEdit(null);
  }); }}>
    <div className="form-fields">
      <label>名称<input required maxLength={80} value={edit.name} onChange={(event) => setEdit({ ...edit, name: event.target.value })}/></label>
      <label>会话指令<textarea rows={5} maxLength={16000} value={edit.instructions} onChange={(event) => setEdit({ ...edit, instructions: event.target.value })}/></label>
      {Boolean(plugins?.length || edit.plugins?.length) && <fieldset className="extension-options"><legend>扩展组件</legend>
        {[...new Set([...plugins?.map(({ id }) => id) ?? [], ...edit.plugins ?? []])].map((id) =>
          <label className="check-label" key={id}><input type="checkbox" checked={edit.plugins?.includes(id) ?? false}
            onChange={() => setEdit({ ...edit, plugins: toggle(edit.plugins ?? [], id) })}/>{plugins?.find((plugin) => plugin.id === id)?.name ?? id}</label>)}
      </fieldset>}
      <fieldset className="extension-options"><legend>Skills</legend>
        <label className="check-label"><input type="checkbox" checked={edit.skills === null} onChange={(event) => setEdit({ ...edit, skills: event.target.checked ? null : [] })}/>允许全部</label>
        {edit.skills && [...new Set([...skills.map((skill) => skill.name), ...edit.skills])].map((name) =>
          <label className="check-label" key={name}><input type="checkbox" checked={edit.skills!.includes(name)} onChange={() => setEdit({ ...edit, skills: toggle(edit.skills!, name) })}/>/{name}</label>)}
      </fieldset>
      <fieldset className="extension-options"><legend>MCP</legend>
        <label className="check-label"><input type="checkbox" checked={edit.mcpServers === null} onChange={(event) => setEdit({ ...edit, mcpServers: event.target.checked ? null : [] })}/>允许全部</label>
        {edit.mcpServers && servers.map((server) =>
          <label className="check-label" key={server.id}><input type="checkbox" checked={edit.mcpServers!.includes(server.id)} onChange={() => setEdit({ ...edit, mcpServers: toggle(edit.mcpServers!, server.id) })}/>{server.name}</label>)}
      </fieldset>
      <details className="extension-option-details"><summary>本地工具</summary>
        <div className="extension-options">
          <label className="check-label"><input type="checkbox" checked={edit.tools == null} onChange={(event) => setEdit({ ...edit, tools: event.target.checked ? null : [] })}/>允许全部</label>
          {edit.tools && tools.map(({ name, label }) => <label className="check-label" key={name} title={name}>
            <input type="checkbox" checked={edit.tools!.includes(name)} onChange={() => setEdit({ ...edit, tools: toggle(edit.tools!, name) })}/>{label}
          </label>)}
        </div>
      </details>
      {!!remote.items?.filter(({ id }) => id !== edit.id).length && <fieldset className="extension-options"><legend>允许委派选择的预设</legend>
        {remote.items.filter(({ id }) => id !== edit.id).map((item) => <label className="check-label" key={item.id}>
          <input type="checkbox" checked={edit.childPresets?.includes(item.id) ?? false}
            onChange={() => setEdit({ ...edit, childPresets: toggle(edit.childPresets ?? [], item.id) })}/>{item.name}
        </label>)}
      </fieldset>}
    </div>
    <div className="extension-edit-footer">
      <Feedback error={remote.error}/>
      <EditActions key={edit.id || "new"} busy={remote.busy} name={edit.name} onClose={() => setEdit(null)}
        onDelete={edit.id ? () => void remote.act(async () => { await api(path + "/" + edit.id, json("DELETE")); await remote.reload(); setEdit(null); }) : undefined}/>
    </div>
  </form>;
  return <div className="extension-panel">
    <form className="extension-selection preset-selection" onSubmit={(event) => {
      event.preventDefault();
      void remote.act(async () => {
        setChosen(await api<SessionPreset | null>(binding, json("PUT", { id: selection || null })));
        onPresetChange();
      });
    }}>
      <label>当前对话<NativeSelect size="sm" name="preset" value={selection} disabled={readOnly || !loaded || remote.busy}
        onChange={(event) => setSelection(event.target.value)}>
        <option value="">默认</option>{remote.items?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        {chosen && remote.items && !remote.items.some((item) => item.id === chosen.id) && <option value={chosen.id} disabled>{chosen.name}（已保留）</option>}
      </NativeSelect></label>
      {!readOnly && <button type="submit" className="button" disabled={!loaded || remote.busy}>应用</button>}
    </form>
    <div className="extension-selection preset-selection">
      <label>新会话默认预设<NativeSelect size="sm" value={defaultPreset} disabled={!loaded || remote.busy} onChange={(event) => {
        const id = event.target.value;
        void remote.act(async () => { const saved = await api<{ id: string | null }>(path + "/default", json("PUT", { id: id || null }));
          setDefaultPreset(saved.id ?? ""); });
      }}><option value="">默认</option>{remote.items?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</NativeSelect></label>
    </div>
    <ItemList title="预设" loading={remote.items === null && !remote.error} empty={!remote.items?.length} onNew={newPreset}>
      {remote.items?.map((item) => <li key={item.id}><button type="button" className="extension-row" onClick={() => setEdit(item)}>
        <span><strong>{item.name}</strong>{item.instructions && <small>{item.instructions.split("\n")[0]}</small>}</span>
        {chosen?.id === item.id && <small>使用中</small>}
      </button></li>)}
    </ItemList>
    <Feedback error={remote.error}/>
  </div>;
}

const localDate = (time: number) => {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const formatted = (time: number) => new Date(time).toLocaleString("zh-CN", { hour12: false, dateStyle: "short", timeStyle: "short" });
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
type ScheduleDraft = { record?: ScheduleRecord; title: string; prompt: string;
  type: "once" | "after" | "every" | "daily" | "weekly" | "monthly" | "rrule" | "cron";
  local: string; clock: string; weekdays: number[]; rule: string; target: string; zone: string; interval: number; presetId: string;
  cwd: string; timingChanged?: boolean };
type ScheduleListItem = ScheduleRecord & { projectTitle?: string; projectArchived?: boolean };
const targetOnce = "__new_once", targetNew = "__new";
function draftFor(session: string, row?: ScheduleRecord): ScheduleDraft {
  const timing = row?.timing;
  const cron = timing?.kind === "cron" ? "cron" in timing ? timing.cron : { expression: timing.expression, time_zone: timing.timeZone } : null;
  const wall = timing?.kind === "daily" ? timing.daily : timing?.kind === "weekly" ? timing.weekly : null;
  const localAt = timing?.kind === "at" && typeof timing.at !== "string" ? timing.at : null;
  return { record: row, title: row?.title ?? "", prompt: row?.prompt ?? "",
    type: timing?.kind === "at" ? "once" : timing?.kind ?? "once",
    rule: timing?.kind === "rrule" ? timing.rrule : cron?.expression ?? "",
    zone: cron?.time_zone ?? wall?.time_zone ?? localAt?.time_zone ?? browserZone(),
    interval: timing?.kind === "every" ? timing.every_seconds : timing?.kind === "after" ? timing.after_seconds : 60,
    presetId: row?.target.kind !== "session" ? row?.target.presetId ?? "" : "",
    cwd: row?.target.kind !== "session" ? row?.target.cwd ?? "" : "",
    clock: wall?.time ?? "09:00:00", weekdays: timing?.kind === "weekly" ? timing.weekly.weekdays : [1],
    local: localAt ? localAt.date + "T" + localAt.time : localDate(row?.nextAt ?? Date.now() + 600_000),
    target: row ? row.target.kind === "session" ? row.target.id : row.target.kind === "new_once" ? targetOnce : targetNew : session,
  };
}
function editedTiming(edit: ScheduleDraft) {
  if (edit.record && !edit.timingChanged) return edit.record.timing;
  const clock = edit.clock.length === 5 ? edit.clock + ":00" : edit.clock;
  const [date, time] = edit.local.split("T");
  switch (edit.type) {
    case "once": return { kind: "at", at: { date, time: time?.length === 5 ? time + ":00" : time, time_zone: edit.zone } };
    case "after": return { kind: "after", after_seconds: edit.interval };
    case "every": return { kind: "every", every_seconds: edit.interval };
    case "daily": return { kind: "daily", daily: { time: clock, time_zone: edit.zone } };
    case "weekly": return { kind: "weekly", weekly: { time: clock, time_zone: edit.zone, weekdays: edit.weekdays } };
    case "cron": return { kind: "cron", cron: { expression: edit.rule, time_zone: edit.zone } };
    case "rrule": return { kind: "rrule", rrule: edit.rule };
    case "monthly": return { kind: "rrule", rrule: "DTSTART;TZID=" + edit.zone + ":" +
      edit.local.replaceAll("-", "").replaceAll(":", "").slice(0, 13) + "00\nRRULE:FREQ=MONTHLY" };
  }
}
const scheduleTarget = (edit: ScheduleDraft) => edit.target === targetOnce || edit.target === targetNew
  ? { kind: edit.target === targetOnce ? "new_once" : "new", presetId: edit.presetId || undefined, cwd: edit.cwd.trim() || undefined }
  : { kind: "session", id: edit.target };
function scheduleChanges(edit: ScheduleDraft) {
  const { record, title, prompt } = edit;
  const target = scheduleTarget(edit), timing = editedTiming(edit);
  return {
    ...(record?.title !== title.trim() ? { title } : {}),
    ...(record?.prompt !== prompt.trim() ? { prompt } : {}),
    ...(!record || edit.timingChanged && JSON.stringify(timing) !== JSON.stringify(record.timing) ? { timing } : {}),
    ...(JSON.stringify(target) !== JSON.stringify(record?.target) ? { target } : {}),
  };
}
function rebaseSchedule(session: string, latest: ScheduleRecord, draft: ScheduleDraft, keep: boolean) {
  const base = draftFor(session, latest);
  if (!keep) return base;
  const changes = scheduleChanges(draft);
  const { type, local, clock, weekdays, rule, zone, interval, target, presetId, cwd } = draft;
  return { ...base, title: changes.title ?? base.title, prompt: changes.prompt ?? base.prompt,
    ...(changes.timing ? { type, local, clock, weekdays, rule, zone, interval, timingChanged: true } : {}),
    ...(changes.target ? { target, presetId, cwd } : {}),
  };
}
function ScheduleDeliveries({ endpoint, onOpen }: { endpoint: string; onOpen: (id: string) => void }) {
  const [page, setPage] = useState<ScheduleHistory | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [cursorExpired, setCursorExpired] = useState(false);
  const load = async (before?: number) => {
    setBusy(true); setError("");
    try {
      const next = await api<ScheduleHistory>(endpoint + (before === undefined ? "" : "?before=" + before));
      setPage((current) => ({ ...next, rows: before === undefined ? next.rows : [...current?.rows ?? [], ...next.rows] }));
      setCursorExpired(false);
    } catch (err) {
      if (err instanceof RequestError && err.code === "delivery_cursor_not_found") setCursorExpired(true);
      setError(errorMessage(err));
    } finally { setBusy(false); }
  };
  return <details className="schedule-history" onToggle={(event) => { if (event.currentTarget.open && !page && !busy) void load(); }}>
    <summary>任务运行记录</summary>
    {busy && !page && <p className="extension-muted">载入中…</p>}
    {page && !page.rows.length && <p className="extension-muted">暂无投递</p>}
    {page?.rows.map((row) => <div className="schedule-delivery" key={row.seq}>
      <div className="extension-actions"><time>{formatted(row.at)} · {row.manual ? "立即运行" : "定时投递"}</time>
        <div className="toolbar-spacer"/><button className="button" type="button" onClick={() => onOpen(row.sessionId)}>打开对话</button></div>
      {row.prompt && <details><summary>执行指令</summary><p>{row.prompt}</p></details>}
    </div>)}
    {cursorExpired ? <button type="button" className="button" disabled={busy} onClick={() => void load()}>刷新记录</button> :
      page?.before != null && <button type="button" className="button" disabled={busy} onClick={() => void load(page.before!)}>更早记录</button>}
    {page && page.before === null && page.earlierRecordsUnavailable && <p className="extension-muted">
      {page.earlierRecordsPruned ? "较早的投递记录已按保留规则清理" : "早期投递记录不可用"}</p>}
    <Feedback error={error}/>
  </details>;
}

function SchedulesPanel({ projectId, session, sessions, readOnly, onOpen, drafts }: {
  projectId: string; session: string; sessions: ProjectSession[]; readOnly: boolean; onOpen: (id: string, projectId: string) => void;
  drafts: Map<string, ScheduleDraft>;
}) {
  const endpoint = "/projects/" + projectId;
  const [allProjects, setAllProjects] = useState(false), [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<"all" | ScheduleRecord["status"]>("active");
  const [search, setSearch] = useState("");
  const pageSize = 100;
  const params = new URLSearchParams({ offset: String(offset), limit: String(pageSize), query: search.trim() });
  if (filter !== "all") params.set("status", filter);
  const remote = useItems<ScheduleListItem>(allProjects ? "/extensions/schedules?" + params : endpoint + "/schedules");
  const [edit, setCurrentEdit] = useState<ScheduleDraft | null>(null), [otherSessions, setOtherSessions] = useState<ProjectSession[]>([]);
  const [conflict, setConflict] = useState(false);
  const setEdit = (value: ScheduleDraft | null) => {
    if (value) {
      const key = value.record?.id ?? "new";
      if (value.record ? Object.keys(scheduleChanges(value)).length : value.title || value.prompt || value.timingChanged) drafts.set(key, value);
      else drafts.delete(key);
    } else setConflict(false);
    setCurrentEdit(value);
  };
  const open = (row?: ScheduleRecord) => {
    const draft = drafts.get(row?.id ?? "new");
    setConflict(Boolean(row && draft?.record && draft.record.version !== row.version));
    setEdit(draft ?? draftFor(session, row));
  };
  const editingProject = edit?.record?.projectId ?? projectId;
  const targets = editingProject === projectId ? sessions : otherSessions;
  const [delivered, setDelivered] = useState("");
  const [clearFinished, setClearFinished] = useState(false);
  const availablePresets = useItems<SessionPreset>("/extensions/presets").items;
  const visible = allProjects ? remote.items ?? [] : (remote.items ?? []).filter((row) => (filter === "all" || row.status === filter) &&
    (!search.trim() || (row.title + " " + row.prompt + " " + (row.sessionId ?? "")).toLowerCase().includes(search.trim().toLowerCase())));
  const { reload } = remote;
  useEffect(() => {
    if (editingProject === projectId) return;
    const controller = new AbortController();
    setOtherSessions([]);
    void api<ProjectSession[]>("/projects/" + editingProject + "/sessions", { signal: controller.signal }).then(setOtherSessions).catch(() => {});
    return () => controller.abort();
  }, [editingProject, projectId]);
  useEffect(() => {
    if (edit) return;
    const controller = new AbortController();
    const timer = setInterval(() => { void reload(controller.signal).catch(() => {}); }, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [reload, edit]);
  const action = (row: ScheduleRecord, type: "pause" | "resume" | "delete" | "run") => remote.act(async () => {
    const result = await api<{ alreadyPending?: boolean } | null>("/projects/" + row.projectId + "/schedules/" + row.id,
      json("PATCH", { version: row.version, action: type }));
    if (type === "run") setDelivered(result?.alreadyPending ? "已有投递，未重复运行" : "已投递到对话");
    if (type === "delete") { drafts.delete(row.id); setEdit(null); }
    await reload();
  });
  if (edit) return <form className="extension-form" onSubmit={(event) => { event.preventDefault(); void remote.act(async () => {
    if (conflict) return;
    const changes = scheduleChanges(edit);
    if (edit.record && !Object.keys(changes).length) return;
    const path = "/projects/" + editingProject + "/schedules" + (edit.record ? "/" + edit.record.id : "");
    try {
      await api(path, json(edit.record ? "PUT" : "POST", { ...changes,
        ...(edit.record ? { expectedUpdatedAt: edit.record.updatedAt ?? null, version: edit.record.version } : {}) }));
    } catch (error) {
      if (error instanceof RequestError && error.code === "SCHEDULE_CONFLICT") { setConflict(true); return; }
      throw error;
    }
    drafts.delete(edit.record?.id ?? "new"); setEdit(null); await reload();
  }); }}>
    <div className="form-fields">
      <label>任务名称<input value={edit.title} required maxLength={120} onChange={(event) => setEdit({ ...edit, title: event.target.value })}/></label>
      <label>执行指令<textarea value={edit.prompt} required maxLength={16000} rows={4} onChange={(event) => setEdit({ ...edit, prompt: event.target.value })}/></label>
      <div className="form-row"><label>触发规则<NativeSelect value={edit.type}
        onChange={(event) => setEdit({ ...edit, type: event.target.value as ScheduleDraft["type"], timingChanged: true })}>
        <option value="once">指定时间</option><option value="after">延时一次</option><option value="every">固定间隔</option>
        <option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option>
        <option value="rrule">自定义 RRULE</option><option value="cron">自定义 Cron</option>
      </NativeSelect></label>
      <label>投递到<NativeSelect value={edit.target} onChange={(event) => setEdit({ ...edit, target: event.target.value })}>
        {targets.map((value) => <option key={value.id} value={value.id}>{value.title}</option>)}<option value={targetOnce}>新对话，后续复用</option><option value={targetNew}>每次新建对话</option>
      </NativeSelect></label></div>
      {(edit.target === targetOnce || edit.target === targetNew) && <div className="form-row">
        <label>新对话预设<NativeSelect value={edit.presetId} onChange={(event) => setEdit({ ...edit, presetId: event.target.value })}>
          <option value="">使用默认预设</option>{availablePresets?.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</NativeSelect></label>
        <label>项目内工作目录<input value={edit.cwd} placeholder="/" onChange={(event) => setEdit({ ...edit, cwd: event.target.value })}/></label>
      </div>}
      {edit.type === "rrule" || edit.type === "cron" ? <label>重复规则<textarea required spellCheck={false} rows={2} value={edit.rule}
        onChange={(event) => setEdit({ ...edit, rule: event.target.value, timingChanged: true })}
        placeholder={edit.type === "cron" ? "0 9 * * 1-5" : "DTSTART;TZID=" + edit.zone + ":20270101T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO"}/></label>
        : edit.type === "after" || edit.type === "every" ? <label>{edit.type === "after" ? "延时（秒）" : "间隔（秒）"}
          <input type="number" min={edit.type === "after" ? 1 : 60} required value={edit.interval}
            onChange={(event) => setEdit({ ...edit, interval: Number(event.target.value), timingChanged: true })}/></label>
        : edit.type === "daily" || edit.type === "weekly" ? <label>执行时间<input type="time" step=".001" required value={edit.clock}
          onChange={(event) => setEdit({ ...edit, clock: event.target.value, timingChanged: true })}/></label>
        : <label>执行时间<input type="datetime-local" step="1" required value={edit.local}
          onChange={(event) => setEdit({ ...edit, local: event.target.value, timingChanged: true })}/></label>}
      {edit.type === "weekly" && <div className="extension-selection" aria-label="执行日期">
        {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((day, index) => <label className="check-label" key={day}>
          <input type="checkbox" checked={edit.weekdays.includes(index + 1)} onChange={(event) => setEdit({ ...edit, timingChanged: true,
            weekdays: event.target.checked ? [...edit.weekdays, index + 1] : edit.weekdays.filter((entry) => entry !== index + 1) })}/>{day}</label>)}
      </div>}
      {edit.type !== "rrule" && edit.type !== "after" && edit.type !== "every" && <label>时区<input required value={edit.zone}
        onChange={(event) => setEdit({ ...edit, zone: event.target.value, timingChanged: true })}/></label>}
      {edit.record && <ScheduleDeliveries endpoint={"/projects/" + editingProject + "/schedules/" + edit.record.id + "/history"}
        onOpen={(id) => onOpen(id, editingProject)}/>}
    </div>
    <div className="extension-edit-footer">
      <Feedback error={remote.error}/>
      {edit.record && conflict && <div role="status" className="extension-actions">
        <span>任务已有新版</span>
        {([["读取最新版", false], ["保留修改并复核", true]] as const).map(([label, keep]) =>
          <button key={label} className="button" type="button" disabled={remote.busy} onClick={() => void remote.act(async () => {
            const latest = await api<ScheduleRecord>("/projects/" + editingProject + "/schedules/" + edit.record!.id);
            setEdit(rebaseSchedule(session, latest, edit, keep)); setConflict(false);
          })}>{label}</button>)}
      </div>}
      <EditActions key={edit.record?.id ?? "new"} busy={remote.busy} name={edit.title} onClose={() => setEdit(null)}
        closeLabel="返回" saveDisabled={conflict || Boolean(edit.record && !Object.keys(scheduleChanges(edit)).length)}
        onDelete={edit.record && !conflict ? () => { void action(edit.record!, "delete"); } : undefined}/>
    </div>
  </form>;
  return <div className="extension-panel">
    <div className="extension-selection">
      <label>范围<NativeSelect size="sm" value={allProjects ? "all" : "project"} onChange={(event) => {
        setAllProjects(event.target.value === "all"); setOffset(0); setClearFinished(false);
      }}>
        <option value="project">当前项目</option><option value="all">所有项目</option></NativeSelect></label>
      <label>搜索任务<input value={search} maxLength={160} onChange={(event) => { setSearch(event.target.value); setOffset(0); }}/></label>
      <label>状态<NativeSelect size="sm" value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter); setOffset(0); }}>
        <option value="all">全部</option><option value="active">已开启</option><option value="paused">已暂停</option><option value="finished">已结束</option></NativeSelect></label>
      {allProjects && (
        clearFinished ? <div className="extension-actions">
          <button className="button" type="button" disabled={remote.busy} onClick={() => setClearFinished(false)}>取消</button>
          <button className="button" type="button" disabled={remote.busy} onClick={() => void remote.act(async () => {
            const result = await api<{ removed: number }>("/extensions/schedules/finished", json("DELETE"));
            setClearFinished(false); setDelivered("已清理 " + result.removed + " 个结束的任务"); await reload();
          })}>确认清理</button>
        </div> : <button className="button" type="button" onClick={() => setClearFinished(true)}>清理已结束</button>)}
    </div>
    <ItemList title="定时任务" loading={remote.items === null && !remote.error} empty={!visible.length}
      onNew={readOnly ? undefined : () => open()}>
      {visible.map((row) => <li key={row.id}>
        <div className="extension-list-item">
          <button type="button" className="extension-row" disabled={row.projectArchived || row.projectId === projectId && readOnly}
            onClick={() => open(row)}><span><strong>{row.title}</strong>
            {row.projectTitle && <small>{row.projectTitle}</small>}
            <small>{row.status === "paused" ? "已暂停" : row.status === "finished" ? "已结束" : row.nextAt ? "下次 " + formatted(row.effectiveNextAt ?? row.nextAt) : "进行中"}</small>
            {row.last && <small>上次投递 {formatted(row.last.at)}</small>}</span></button>
          {!row.projectArchived && (row.projectId !== projectId || !readOnly) && <><button className="button" type="button" disabled={remote.busy} onClick={() => void action(row, "run")}>立即运行</button>
          {row.status !== "finished" && <button className="button" type="button" disabled={remote.busy} onClick={() => void action(row, row.status === "paused" ? "resume" : "pause")}>
            {row.status === "paused" ? "恢复" : "暂停"}</button>}</>}
        </div>
      </li>)}
    </ItemList>
    {allProjects && (offset > 0 || (remote.items?.length ?? 0) >= pageSize) && <div className="extension-actions">
      {offset > 0 && <button className="button" type="button" onClick={() => setOffset(Math.max(0, offset - pageSize))}>上一页</button>}
      {(remote.items?.length ?? 0) >= pageSize && <button className="button" type="button" onClick={() => setOffset(offset + pageSize)}>下一页</button>}
    </div>}
    <Feedback error={remote.error}/>{delivered && <p className="extension-muted" role="status">{delivered}</p>}
  </div>;
}

export function StudioExtensions({ projectId, session, sessions, readOnly, initial, skill, onClose, onOpenSession, onPresetChange }: {
  projectId: string; session: string; sessions: ProjectSession[]; readOnly: boolean; initial: Tab;
  skill?: SkillEntry; onClose: () => void; onOpenSession: (id: string, projectId: string) => void; onPresetChange: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initial);
  const scheduleDrafts = useRef(new Map<string, ScheduleDraft>());
  const endpoint = "/projects/" + projectId;
  return <Modal title="扩展" wide onClose={onClose}>
    <nav className="extension-tabs" aria-label="扩展功能">{Object.entries(labels).map(([key, name]) =>
      <button type="button" key={key} aria-pressed={tab === key} onClick={() => setTab(key as Tab)}>{name}</button>)}</nav>
    <div className="modal-scroll" key={tab}>
      {tab === "skills" && <SkillsPanel endpoint={endpoint} session={session} readOnly={readOnly} initial={skill}/>}
      {tab === "mcp" && <McpPanel/>}
      {tab === "presets" && <PresetsPanel endpoint={endpoint} session={session} readOnly={readOnly} onPresetChange={onPresetChange}/>}
      {tab === "schedules" && <SchedulesPanel projectId={projectId} session={session} sessions={sessions} readOnly={readOnly} onOpen={onOpenSession}
        drafts={scheduleDrafts.current}/>}
    </div>
  </Modal>;
}

export function SkillDocument({ projectId, session, skill, readOnly, close }: {
  projectId: string; session: string; skill: SkillEntry; readOnly: boolean; close: () => void;
}) {
  const endpoint = "/projects/" + projectId + "/skills/" + skill.scope + "/" + skill.name + scopeQuery(session);
  const [text, setText] = useState<string | null>(null), [saved, setSaved] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = readOnly || skill.scope === "external" || skill.scope === "provider";
  useEffect(() => {
    const controller = new AbortController();
    void api<{ text: string }>(endpoint, { signal: controller.signal })
      .then(({ text }) => { if (!controller.signal.aborted) { setText(text); setSaved(text); } })
      .catch((error) => { if (!controller.signal.aborted) setNotice(errorMessage(error)); });
    return () => controller.abort();
  }, [endpoint]);
  const save = async () => {
    if (locked || busy || text === null || text === saved) return;
    setBusy(true); setNotice("");
    try { await api(endpoint, json("PUT", { text })); setSaved(text); }
    catch (error) { setNotice(errorMessage(error)); } finally { setBusy(false); }
  };
  return <section className="skill-document" aria-label="技能预览">
    <header className="extension-actions"><strong>/{skill.name}</strong><div className="toolbar-spacer"/>
      {!locked && <button className="button" type="button" disabled={busy || text === null || text === saved} onClick={() => void save()}>保存</button>}
      <button type="button" className="button" onClick={close}>关闭</button></header>
    {notice && <Feedback error={notice}/>}
    {text !== null && <MarkdownEditor value={text} readOnly={locked} onChange={setText} onSave={() => void save()}/>}
  </section>;
}
