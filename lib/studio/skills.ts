import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, closeSync, fstatSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, rmSync, constants, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { AppError } from "./security";
import { skillName } from "./session-presets";
import type { AgentMessage } from "./types";

const resourceBaseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("directory"), path: z.string().min(1) }),
  z.object({ kind: z.literal("url"), url: z.string().url() }),
  z.object({ kind: z.literal("opaque"), description: z.string().min(1) }),
]);
type SkillResourceBase = z.infer<typeof resourceBaseSchema>;
const invocationFlag = z.preprocess((value) => {
  if (value === 0 || value === 1) return Boolean(value);
  if (typeof value !== "string") return value;
  const word = value.toLowerCase();
  if (["true", "yes", "on", "1"].includes(word)) return true;
  if (["false", "no", "off", "0"].includes(word)) return false;
  return value;
}, z.boolean().optional());
const skillHeader = z.object({
  name: z.string().trim().pipe(skillName),
  description: z.string().trim().min(1),
  whenToUse: z.string().trim().min(1).optional().catch(undefined),
  metadata: z.record(z.unknown()).optional().catch(undefined),
  "disable-model-invocation": invocationFlag,
  "user-invocable": invocationFlag,
});
export type ManagedSkillScope = "project" | "global";
export type SkillScope = ManagedSkillScope | "external" | "provider";
export interface SkillEntry {
  name: string;
  description: string;
  whenToUse?: string;
  metadata?: Record<string, unknown>;
  scope: SkillScope;
  modelInvocable: boolean;
  userInvocable: boolean;
}
interface SkillFile extends SkillEntry { filename: string; root: string; rank: number; follow: boolean }
export interface ProvidedSkill {
  name: string; description: string; rank?: number;
  modelInvocable?: boolean; userInvocable?: boolean;
  whenToUse?: string; metadata?: Record<string, unknown>;
  provider?: string; resourceBase?: SkillResourceBase;
  read(resource: string | undefined, signal: AbortSignal): string | Promise<string>;
}
export interface SkillProviderObservation { candidates: readonly ProvidedSkill[]; complete: boolean }
type SkillProviderResult = readonly ProvidedSkill[] | SkillProviderObservation;
export type SkillProvider = (context: { projectId: string; cwd?: string; signal: AbortSignal; invalidate: () => void }) => SkillProviderResult | Promise<SkillProviderResult>;
interface DiscoverableSkill {
  entry: SkillEntry;
  rank: number;
  provider: string;
  resourceBase?: SkillResourceBase;
  read(resource?: string, mode?: "model" | "user", signal?: AbortSignal): Promise<string>;
}
export interface SkillDiscovery { entries: DiscoverableSkill[]; complete: boolean }
export const canInvokeSkill = (entry: SkillEntry, allowed: readonly string[] | null | undefined, mode: "model" | "user") =>
  (allowed == null || allowed.includes(entry.name)) && (mode === "model" ? entry.modelInvocable : entry.userInvocable);

export function renderSkillContent(name: string, content: string, provider: string, base?: SkillResourceBase) {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const hint = base?.kind === "directory" ? [
    "Base directory for this skill: " + escape(base.path),
    "Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.",
  ] : base?.kind === "url" ? [
    "Base URL for this skill: " + escape(base.url),
    "Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.",
  ] : [
    base ? "Resources for this skill: " + escape(base.description) : 'Resources for this skill are managed by provider "' + escape(provider) + '".',
    "Load referenced resources only as needed.",
  ];
  return ['<skill_content name="' + name + '">', "<skill_resources>", ...hint, "</skill_resources>", "",
    "<skill_instructions>", content, "</skill_instructions>", "</skill_content>"].join("\n");
}

/** The SQLite receipt stays structured. The provider receives the same text as an explicit user invocation. */
export function renderSkillToolMessages(messages: AgentMessage[]): AgentMessage[] {
  let calls = new Set<string>();
  return messages.map((message) => {
    if (message.role === "assistant") calls = new Set(message.tool_calls?.filter(({ function: fn }) => fn.name === "skill").map(({ id }) => id));
    if (message.role !== "tool" || !message.tool_call_id || !calls.has(message.tool_call_id) || !message.content?.startsWith("{")) return message;
    try {
      const { content } = JSON.parse(message.content);
      if (typeof content === "string" && content.startsWith("<skill_content name=")) return { ...message, content };
    } catch { /* A shortened or unavailable receipt stays in its original form. */ }
    return message;
  });
}

function resourcePath(resource: string) {
  if (!resource || resource.includes("\\") || resource.split("/").some((part) => !part || part === "." || part === ".."))
    throw new AppError("技能资源路径无效");
  return resource;
}

async function withSkillDeadline<T>(work: (signal: AbortSignal) => T | Promise<T>, caller?: AbortSignal) {
  const timeout = AbortSignal.timeout(2500), signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
  signal.throwIfAborted();
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const abort = () => reject(caller?.aborted ? caller.reason : new AppError("技能来源响应超时", 504, "SKILL_SOURCE_TIMEOUT"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal); }), aborted]);
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener("abort", abort); }
}

function document(text: string) {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!header) throw new AppError("SKILL.md 需要包含 name 和 description 的 YAML 文件头");
  try {
    const value = parse(header[1], { maxAliasCount: 0 });
    if (Object.hasOwn(value ?? {}, "disableModelInvocation") || Object.hasOwn(value ?? {}, "userInvocable")) throw new Error("unsupported fields");
    const meta = skillHeader.parse(value);
    const body = text.slice(header[0].length).trim();
    return { name: meta.name, description: meta.description, modelInvocable: !meta["disable-model-invocation"],
      userInvocable: meta["user-invocable"] !== false, whenToUse: meta.whenToUse, metadata: meta.metadata, body };
  } catch { throw new AppError("技能文件头无效。请使用小写字母、数字和连字符命名，并填写描述。"); }
}

type SkillRoots = { user?: string; agents?: string; bundled?: string };

export class SkillLibrary {
  private readonly root: string;
  private readonly cache = new Map<string, { files: SkillFile[]; watcher: FSWatcher }>();
  private readonly listeners = new Set<() => void>();
  private readonly discoveries = new Map<string, SkillDiscovery>();
  private readonly providerIds = new WeakMap<SkillProvider, string>();
  private discoveryVersion = 0;
  constructor(root: string, private readonly custom: readonly string[] = [], private readonly workspaces?: string,
    private readonly roots: SkillRoots = {}) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
  }
  private directory(projectId: string, scope: ManagedSkillScope) {
    if (scope === "project" && !z.string().uuid().safeParse(projectId).success) throw new AppError("项目不存在", 404);
    return scope === "global" ? path.join(this.root, "global") : path.join(this.root, "projects", projectId);
  }
  private readInside(root: string, filename: string, follow = false) {
    const real = realpathSync(filename);
    if (!real.startsWith(root + path.sep) || !follow && real !== filename) throw new AppError("技能文件须在其本地目录内");
    const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new AppError("技能文件须为普通文本文件");
      return readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
  }
  private invalidate(root: string) {
    this.cache.get(root)?.watcher.close();
    this.cache.delete(root);
  }
  close() {
    for (const root of this.cache.keys()) this.invalidate(root);
    this.discoveries.clear();
    this.discoveryVersion++;
  }
  private invalidateDiscovery() {
    this.discoveryVersion++;
    this.discoveries.clear();
    for (const notify of this.listeners) notify();
  }
  private providerId(provider: SkillProvider) {
    let id = this.providerIds.get(provider);
    if (!id) { id = crypto.randomUUID(); this.providerIds.set(provider, id); }
    return id;
  }
  private changed(root: string) {
    this.invalidate(root);
    this.invalidateDiscovery();
  }
  observe(signal: AbortSignal) {
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (text: string) => {
          if ((controller.desiredSize ?? 0) > 0) controller.enqueue(encoder.encode(text));
        };
        const update = () => send("data: {}\n\n");
        const abort = () => { cleanup(); controller.close(); };
        const timer = setInterval(() => send(": ping\n\n"), 15_000);
        timer.unref();
        cleanup = () => { clearInterval(timer); this.listeners.delete(update); signal.removeEventListener("abort", abort); };
        if (signal.aborted) { abort(); return; }
        this.listeners.add(update);
        signal.addEventListener("abort", abort, { once: true });
        send(": ready\n\n");
      },
      cancel: () => cleanup(),
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" } });
  }
  private cacheDirectory(root: string, files: SkillFile[], anchor = root) {
    const recursive = anchor === root;
    const next = path.relative(anchor, root).split(path.sep)[0];
    try {
      const watcher = watch(anchor, { recursive, persistent: false }, (_event, name) => {
        if (recursive || !name || name === next) this.changed(root);
      });
      watcher.on("error", () => this.changed(root));
      this.cache.set(root, { files, watcher });
      if (this.cache.size > 384) this.invalidate(this.cache.keys().next().value!);
    } catch { /* Discovery remains on demand where the directory cannot be watched. */ }
  }
  private scanDirectory(root: string, scope: Exclude<SkillScope, "provider">, rank: number, follow = false): SkillFile[] {
    const cached = this.cache.get(root);
    if (cached) {
      this.cache.delete(root); this.cache.set(root, cached);
      return cached.files;
    }
    let entries;
    try { if (realpathSync(root) !== root) return []; entries = readdirSync(root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let anchor = path.dirname(root);
      while (!existsSync(anchor) && anchor !== path.dirname(anchor)) anchor = path.dirname(anchor);
      if (existsSync(anchor)) this.cacheDirectory(root, [], anchor);
      return [];
    }
    const skills: SkillFile[] = [];
    let linked = false;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      try {
        const locator = path.join(root, entry.name);
        if (entry.isSymbolicLink() && !follow) continue;
        linked ||= entry.isSymbolicLink();
        const identity = entry.isSymbolicLink() ? lstatSync(realpathSync(locator)) : entry;
        const filename = identity.isDirectory() ? path.join(locator, "SKILL.md")
          : identity.isFile() && entry.name.endsWith(".md") ? locator : undefined;
        if (!filename) continue;
        const { body: _body, ...parsed } = document(this.readInside(root, filename, follow));
        if (!skills.some((item) => item.name === parsed.name)) skills.push({ ...parsed, filename, root, scope, rank, follow });
      } catch (error) {
        if (error instanceof AppError || ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        throw error;
      }
    }
    if (!linked) this.cacheDirectory(root, skills);
    return skills;
  }
  private scan(projectId: string, scope: Exclude<SkillScope, "provider">, cwd?: string, incomplete?: () => void): SkillFile[] {
    if (scope !== "external" && !incomplete)
      return this.scanDirectory(this.directory(projectId, scope), scope, scope === "project" ? 100 : 400);
    const collected = new Map<string, SkillFile>();
    const add = (directory: string, rank: number, follow = false) => {
      try {
        for (const item of this.scanDirectory(directory, scope, rank, follow))
          if (!collected.has(item.name)) collected.set(item.name, item);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") incomplete?.(); }
    };
    if (scope !== "external") {
      add(this.directory(projectId, scope), scope === "project" ? 100 : 400);
      return [...collected.values()];
    }
    if (this.workspaces && z.string().uuid().safeParse(projectId).success) {
      try {
        const workspace = path.join(realpathSync(this.workspaces), projectId);
        const directory = path.resolve(workspace, "." + (cwd ?? "/"));
        let root = workspace;
        if (directory.startsWith(workspace + path.sep)) {
          let candidate = directory;
          while (candidate !== workspace && !existsSync(path.join(candidate, ".git"))) candidate = path.dirname(candidate);
          root = existsSync(path.join(candidate, ".git")) ? candidate : directory;
        }
        add(path.join(root, ".dsh", "skills"), 100, true);
        add(path.join(root, ".agents", "skills"), 200, true);
      }
      catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) incomplete?.(); }
    }
    for (const [directory, rank] of [...this.custom.map((dir) => [dir, 300] as const), [this.roots.user, 400],
      [this.roots.agents, 500], [this.roots.bundled, 600]] as const) {
      if (!directory) continue;
      const root = path.resolve(directory);
      try { add(realpathSync(root), rank, true); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") add(root, rank, true);
        else if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") incomplete?.();
      }
    }
    return [...collected.values()];
  }
  private resolve(projectId: string, name: string, scope?: Exclude<SkillScope, "provider">, cwd?: string) {
    skillName.parse(name);
    for (const source of scope ? [scope] : ["project", "external", "global"] as const) {
      const found = this.scan(projectId, source, cwd, () => {}).find((item) => item.name === name);
      if (found) return found;
    }
    throw new AppError("技能不存在或无效", 404, "SKILL_NOT_FOUND");
  }
  list(projectId: string, scopes: readonly Exclude<SkillScope, "provider">[] = ["global", "external", "project"], cwd?: string) {
    return scopes.flatMap((scope) => this.scan(projectId, scope, cwd, () => {}).map(({ filename: _filename, root: _root, rank: _rank, follow: _follow, ...entry }) => entry))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  catalog(projectId: string, allowed: readonly string[] | null | undefined, mode: "model" | "user") {
    const winners = new Map<string, SkillEntry>();
    for (const entry of this.list(projectId, ["project", "external", "global"])) if (!winners.has(entry.name)) winners.set(entry.name, entry);
    return [...winners.values()].filter((entry) => canInvokeSkill(entry, allowed, mode));
  }
  async discover(projectId: string, providers: readonly SkillProvider[] = [], cwd?: string,
    scopedProviders: readonly SkillProvider[] = [], signal?: AbortSignal, retries = 2): Promise<SkillDiscovery> {
    signal?.throwIfAborted();
    const key = JSON.stringify([projectId, cwd, providers.map((provider) => this.providerId(provider)),
      scopedProviders.map((provider) => this.providerId(provider))]);
    const cached = this.discoveries.get(key);
    if (cached && (providers.length || scopedProviders.length)) return cached;
    const discoveryVersion = this.discoveryVersion;
    let complete = true;
    const local = (["project", "external", "global"] as const).flatMap((scope) => this.scan(projectId, scope, cwd, () => { complete = false; }))
      .map(({ rank, filename, root, follow, ...entry }): DiscoverableSkill => ({ entry, rank, provider: "filesystem",
        resourceBase: { kind: "directory", path: path.dirname(filename) }, read: async (resource, mode, caller) => {
        caller?.throwIfAborted();
        const current = document(this.readInside(root, filename, follow));
        if (current.name !== entry.name || mode && !canInvokeSkill({ ...entry, ...current }, null, mode))
          throw new AppError("当前对话不能调用该技能", 403, "SKILL_UNAVAILABLE");
        return resource === undefined ? current.body : this.readResource({ filename, root, follow }, resource);
      } }));
    const supplied = await Promise.allSettled([...providers, ...scopedProviders].map((provider) =>
      withSkillDeadline((signal) => provider({ projectId, cwd, signal, invalidate: () => this.invalidateDiscovery() }), signal)));
    signal?.throwIfAborted();
    const entries = [...local], scoped: DiscoverableSkill[] = [];
    for (const [index, source] of supplied.entries()) {
      if (source.status === "rejected") { complete = false; continue; }
      const observation = Array.isArray(source.value) ? { candidates: source.value, complete: true } : source.value as SkillProviderObservation;
      if (!observation || !Array.isArray(observation.candidates) || typeof observation.complete !== "boolean")
        throw new AppError("技能提供者返回了无效目录", 502, "SKILL_PROVIDER_INVALID");
      if (!observation.complete) complete = false;
      const layer = index < providers.length ? entries : scoped;
      for (const item of observation.candidates) {
        if (!item || !skillName.safeParse(item.name).success || typeof item.description !== "string" ||
            !item.description.trim() || typeof item.read !== "function" ||
            item.modelInvocable !== undefined && typeof item.modelInvocable !== "boolean" ||
            item.userInvocable !== undefined && typeof item.userInvocable !== "boolean")
          throw new AppError("技能提供者返回了无效技能条目", 502, "SKILL_PROVIDER_INVALID");
        layer.push({ entry: { name: item.name, scope: "provider", description: item.description.trim(),
          whenToUse: item.whenToUse, metadata: item.metadata,
          modelInvocable: item.modelInvocable !== false, userInvocable: item.userInvocable !== false },
        provider: item.provider || "extension", resourceBase: resourceBaseSchema.safeParse(item.resourceBase).data,
        rank: Number.isFinite(item.rank) ? item.rank! : 250, async read(resource, _mode, caller) {
          const content = await withSkillDeadline((signal) => item.read(resource === undefined ? undefined : resourcePath(resource), signal), caller);
          if (typeof content !== "string" || !content.trim()) throw new AppError("技能来源返回了无效文本");
          return content;
        } });
      }
    }
    const winners = new Map<string, DiscoverableSkill>();
    for (const skill of [...scoped.sort((a, b) => a.rank - b.rank), ...entries.sort((a, b) => a.rank - b.rank)])
      if (!winners.has(skill.entry.name)) winners.set(skill.entry.name, skill);
    if (discoveryVersion !== this.discoveryVersion) {
      if (retries > 0) return this.discover(projectId, providers, cwd, scopedProviders, signal, retries - 1);
      complete = false;
    }
    const result = { entries: [...winners.values()].sort((a, b) => a.entry.name.localeCompare(b.entry.name)), complete };
    if (complete && (providers.length || scopedProviders.length)) {
      this.discoveries.set(key, result);
      if (this.discoveries.size > 128) this.discoveries.delete(this.discoveries.keys().next().value!);
    }
    return result;
  }
  source(projectId: string, scope: Exclude<SkillScope, "provider">, name: string, cwd?: string) {
    const found = this.resolve(projectId, name, scope, cwd);
    return this.readInside(found.root, found.filename, found.follow);
  }
  save(projectId: string, scope: ManagedSkillScope, text: string, existing?: string) {
    const { name } = document(text);
    if (existing && existing !== name) throw new AppError("编辑时请保留技能名称，另存可新建一个技能");
    const root = this.directory(projectId, scope);
    mkdirSync(root, { recursive: true });
    if (realpathSync(root) !== root) throw new AppError("技能目录无效");
    const current = this.scan(projectId, scope).find((item) => item.name === name);
    if (Boolean(current) !== Boolean(existing)) throw new AppError(current ? "技能已存在" : "技能已被移除", 409);
    const directory = path.join(root, name);
    if (!current) {
      mkdirSync(directory, { recursive: true });
      if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new AppError("技能目录无效");
    }
    const target = current?.filename ?? path.join(directory, "SKILL.md");
    if (!current) {
      try { writeFileSync(target, text, { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AppError("技能文件已存在", 409); throw error; }
    } else {
      const temp = target + "." + randomUUID() + ".tmp";
      writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
      try { renameSync(temp, target); } catch (error) { unlinkSync(temp); throw error; }
    }
    this.changed(root);
    return { name, scope };
  }
  importBundle(projectId: string, scope: ManagedSkillScope, files: ReadonlyMap<string, Uint8Array>) {
    const rootFile = files.get("SKILL.md");
    if (!rootFile) throw new AppError("技能包根目录需要 SKILL.md");
    const { name } = document(new TextDecoder("utf-8", { fatal: true }).decode(rootFile));
    const root = this.directory(projectId, scope);
    mkdirSync(root, { recursive: true });
    if (realpathSync(root) !== root) throw new AppError("技能目录无效");
    if (this.scan(projectId, scope).some((skill) => skill.name === name)) throw new AppError("技能已存在", 409);
    const target = path.join(root, name), staging = path.join(root, "." + randomUUID() + ".pending");
    mkdirSync(staging);
    try {
      for (const [relative, bytes] of files) {
        if (relative.length > 255 || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === ".." || /[\x00-\x1f:]/.test(part)))
          throw new AppError("技能包文件路径无效");
        const filename = path.join(staging, relative);
        mkdirSync(path.dirname(filename), { recursive: true });
        writeFileSync(filename, bytes, { flag: "wx", mode: 0o600 });
      }
      try { lstatSync(target); throw new AppError("技能目录已存在", 409); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      renameSync(staging, target);
      this.changed(root);
      return { name, scope };
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  remove(projectId: string, scope: ManagedSkillScope, name: string) {
    const found = this.resolve(projectId, name, scope);
    const root = this.directory(projectId, scope), folder = path.dirname(found.filename);
    const target = path.basename(found.filename) === "SKILL.md" && path.dirname(folder) === root ? folder : found.filename;
    const trash = path.join(root, ".trash");
    mkdirSync(trash, { recursive: true });
    if (realpathSync(trash) !== trash) throw new AppError("技能回收目录无效");
    renameSync(target, path.join(trash, randomUUID() + "-" + path.basename(target)));
    this.changed(root);
  }
  removeProject(projectId: string) {
    const root = this.directory(projectId, "project"), parent = path.dirname(root);
    const info = lstatSync(parent, { throwIfNoEntry: false });
    if (!info) return;
    if (!info.isDirectory()) throw new AppError("项目技能目录无效");
    rmSync(root, { recursive: true, force: true });
    this.changed(root);
  }
  load(projectId: string, name: string, allowed: readonly string[] | null | undefined, mode: "model" | "user", resource?: string) {
    const entry = this.resolve(projectId, name);
    if ((allowed != null && !allowed.includes(name)) || !(mode === "model" ? entry.modelInvocable : entry.userInvocable))
      throw new AppError("当前对话不能调用该技能", 403, "SKILL_UNAVAILABLE");
    const current = document(this.readInside(entry.root, entry.filename, entry.follow));
    if (current.name !== name || !canInvokeSkill({ ...entry, ...current }, allowed, mode))
      throw new AppError("当前对话不能调用该技能", 403, "SKILL_UNAVAILABLE");
    if (!resource) return current.body;
    return this.readResource(entry, resource);
  }
  private readResource(entry: Pick<SkillFile, "root" | "filename" | "follow">, resource: string) {
    const base = path.dirname(entry.filename), target = path.join(base, resourcePath(resource));
    try {
      const relative = path.relative(realpathSync(base), realpathSync(target));
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
        throw new AppError("技能资源须在其本地目录内");
      if (!relative || relative.split(path.sep).some((part) => part.startsWith(".")) || path.basename(relative) === "SKILL.md")
        throw new AppError("技能资源路径无效");
      const content = this.readInside(entry.root, target, entry.follow);
      if (base === entry.root && relative.endsWith(".md") && /^---\r?\n/.test(content)) throw new AppError("请按名称调用技能");
      return content;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError("技能资源不存在", 404); throw error; }
  }
}
