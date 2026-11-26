import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { AppError, decryptSecrets, encryptSecrets } from "./security";
import { tool } from "./file-tools";
import type { BlobStore, Database } from "./storage";
import { prepareImageBytes } from "./images";
import { resolveDeepSeekModel } from "./providers";
import type { AgentImage } from "./types";
import { runtimeToolBinding, type ToolContext, type ToolRegistration } from "./tool-registry";

const timerMs = z.number().int().min(1).max(2_147_483_647);
const callTimeout = (configuration: { toolCallTimeoutMs?: number }) => configuration.toolCallTimeoutMs ?? 60_000;
const instructionLimit = 32_768;
export const MCP_STARTUP_TIMEOUT_MS = 30_000;
const reconnectOptions = z.strictObject({ enabled: z.boolean().default(true), initialDelayMs: timerMs.default(500),
  maxDelayMs: timerMs.default(30_000), maxAttempts: z.number().int().nonnegative().safe().default(10) })
  .refine((policy) => policy.initialDelayMs <= policy.maxDelayMs, "重连上限小于初始等待时间");
const base = { name: z.string().trim().min(1).max(64), enabled: z.boolean().default(true),
  startupTimeoutMs: timerMs.optional(), toolCallTimeoutMs: timerMs.optional(),
  closeTimeoutMs: timerMs.optional(), failOnStartupError: z.boolean().optional(),
  maxInstructionBytes: z.number().int().positive().safe().optional(), reconnect: reconnectOptions.optional(),
  credentials: z.record(z.string().min(1).max(128), z.string().max(8192)).optional() };
export const mcpCredentialName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/);
const template = /\$\{credential:([A-Za-z_][A-Za-z0-9_.-]{0,79})\}/g;
const references = (text: string) => [...text.matchAll(template)].map((match) => match[1]);
const url = z.string().max(2000).url().refine((value) => {
  const endpoint = new URL(value);
  return !endpoint.username && !endpoint.password && !endpoint.hash && (endpoint.protocol === "https:" ||
    endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname));
}, "MCP 地址须为 HTTPS 或本机 HTTP");
const input = z.discriminatedUnion("transport", [
  z.strictObject({ ...base, transport: z.literal("stdio"), command: z.string().trim().min(1).max(500),
    args: z.array(z.string().max(4096)).max(50).default([]), cwd: z.string().trim().max(2000).optional() }),
  z.strictObject({ ...base, transport: z.literal("streamable-http"), url: z.string().max(2000).refine(
    (value) => references(value).length ? !value.replace(template, "reference").includes("${credential:") : url.safeParse(value).success,
    "MCP 地址须为 HTTPS 或本机 HTTP") }),
]);
type Configuration = Omit<Extract<z.output<typeof input>, { transport: "stdio" }>, "credentials">
  | Omit<Extract<z.output<typeof input>, { transport: "streamable-http" }>, "credentials">;
type Tool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type Row = { id: string; user_id: string; version: string; config: string; secrets: string;
  registered?: { scope?: string; credentials: Record<string, string> } };
interface Connection {
  version: string; client: Client; controller: AbortController; tools: Tool[];
  closeTimeoutMs?: number;
  connectedAt?: number;
  sync: Promise<void>;
  readyToSync: boolean;
  pending?: Promise<Connection>; expires: number; status: "connecting" | "ready" | "offline" | "waiting-credentials"; credentials: string[];
}
export type McpServerView = Configuration & { id: string; configured: boolean; hasCredentials: boolean;
  status: "disabled" | "connecting" | "ready" | "reconnecting" | "offline" | "waiting-credentials"; toolCount: number; failure?: string };
const parameters = z.record(z.unknown());
type CloseResult = { closeConfirmed: boolean; cleanupError?: string };
export type McpProbeView = CloseResult & { name: string; durationMs: number } & (
  { ok: true; toolCount: number; toolNames: string[]; truncated: boolean } |
  { ok: false; stage: "connect" | "list"; message: string; code: string });
const clientClosures = new WeakMap<Client, Promise<CloseResult>>();
function closeClient(client: Client, timeout = 5000): Promise<CloseResult> {
  const existing = clientClosures.get(client);
  if (existing) return existing;
  const closing = new Promise<CloseResult>((resolve) => {
    const timer = setTimeout(() => resolve({ closeConfirmed: false, cleanupError: "等待传输关闭超时" }), timeout);
    void Promise.resolve().then(() => client.close()).then(
      () => resolve({ closeConfirmed: true }), () => resolve({ closeConfirmed: false, cleanupError: "传输关闭失败" }),
    ).finally(() => clearTimeout(timer));
  });
  clientClosures.set(client, closing);
  return closing;
}
const identifier = (value: string) => value.replace(/[^a-z0-9]/gi, "_").toLowerCase();
const digest = (values: unknown) => createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 16);
export function publicMcpToolName(server: string, rawName: string) {
  const joined = `mcp__${server}__${rawName}`, normalized = joined.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (joined === normalized && normalized.length <= 64) return normalized;
  const hash = createHash("sha256").update(`${server}\0${rawName}`).digest("hex").slice(0, 12);
  return normalized.slice(0, 51) + "_" + hash;
}
export const mcpResourceTools = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"] as const;
export const isMcpTool = (name: string) => name.startsWith("mcp_") || mcpResourceTools.some((resource) => resource === name);

function checkedTools(tools: Tool[]) {
  if (new Set(tools.map(({ name }) => name)).size !== tools.length)
    throw new AppError("MCP 返回了重名工具", 409, "MCP_DUPLICATE_TOOL");
  return tools;
}

function configurationValues(config: Configuration) {
  return config.transport === "stdio" ? [config.command, ...config.args, config.cwd ?? ""] : [config.url];
}

function validateCredentialFields(config: Configuration, credentials: Record<string, string>) {
  if (Object.keys(credentials).length > 24) throw new AppError("最多配置 24 项连接凭据");
  for (const key of Object.keys(credentials)) {
    if (config.transport === "stdio" ? !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) :
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(key) || /^(host|cookie|connection|content-length|mcp-.*)$/i.test(key))
      throw new AppError("MCP 凭据名称无效");
  }
  if (config.transport === "streamable-http") {
    try { new Headers(credentials); } catch { throw new AppError("MCP 请求头无效"); }
  }
}

function scrub(value: unknown, credentials: readonly string[]): unknown {
  if (typeof value === "string") return credentials.reduce((text, secret) => text.split(secret).join("[凭据]"), value);
  if (Array.isArray(value)) return value.map((item) => scrub(item, credentials));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).map(([key,val]) => [key,
      (key === "data" && (record.type === "image" || record.type === "audio") || key === "blob") && typeof val === "string"
        ? "[二进制内容]" : scrub(val, credentials)]));
  }
  return value;
}

function makeTransport(config: Configuration, credentials: Record<string, string>) {
  return config.transport === "stdio" ? new StdioClientTransport({
          command: config.command, args: config.args, ...(config.cwd ? { cwd: config.cwd } : {}), stderr: "ignore",
          env: { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined &&
            ["PATH", "HOME", "USERPROFILE", "SystemRoot", "COMSPEC", "PATHEXT", "TMPDIR", "TEMP", "TMP", "LANG"].includes(key))) as Record<string, string>, ...credentials },
        }) : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: credentials },
          fetch: (destination, options) => {
            if (new URL(destination instanceof Request ? destination.url : destination).origin !== new URL(config.url).origin)
              throw new AppError("MCP 请求离开了配置的来源");
            return fetch(destination, { ...options, redirect: "error" });
          },
        });
}

async function resultImages(value: unknown, context: ToolContext & { signal: AbortSignal }) {
  if (!value || typeof value !== "object") return { images: [] };
  const blocks = (value as { content?: unknown[] }).content;
  if (!Array.isArray(blocks)) return { images: [] };
  const candidates = blocks.filter((block): block is { type: "image"; data?: unknown; mimeType?: unknown } =>
    Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "image"));
  if (!candidates.length) return { images: [] };
  const { bucket, project, signal, settings } = context;
  if (!bucket || !project) return { images: [], imageError: "当前调用没有可用的图片存储" };
  const root = project.id + "/mcp-images/" + crypto.randomUUID();
  const published: string[] = [];
  const staged = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const staging: BlobStore = { get: async () => null, async put(key, value, options) {
    if (!(value instanceof Uint8Array) || !options?.httpMetadata?.contentType) throw new Error("Invalid staged image");
    staged.set(key, { bytes: value, contentType: options.httpMetadata.contentType });
  } };
  try {
    const model = await (context.resolveModel ?? resolveDeepSeekModel)(settings, signal);
    if (!model.inputModalities.includes("image")) return { images: [], imageError: "当前模型未声明图片输入能力" };
    const images: AgentImage[] = [];
    let total = 0;
    for (const { data, mimeType } of candidates) {
      signal.throwIfAborted();
      if (typeof data !== "string" || typeof mimeType !== "string" || !/^image\/(png|jpeg|gif|webp)$/.test(mimeType) ||
          data.length > 40 * 1024 * 1024) throw new Error("Invalid MCP image");
      const bytes = Buffer.from(data, "base64");
      if (!bytes.length || bytes.toString("base64") !== data) throw new Error("Invalid base64 image");
      total += bytes.length;
      if (total > 30 * 1024 * 1024) throw new Error("MCP images exceed aggregate budget");
      const hash = createHash("sha256").update(bytes).digest("hex");
      const key = root + "/original/" + hash;
      const image = await prepareImageBytes(project.id, key, bytes, staging, root + "/normalized");
      if (image.objectKey === key) staged.set(key, { bytes, contentType: image.mediaType });
      images.push({ ...image, id: "mcp-" + hash, version: 1, path: "MCP 图片 " + (images.length + 1) });
    }
    signal.throwIfAborted();
    for (const [key, { bytes, contentType }] of staged) {
      signal.throwIfAborted();
      published.push(key);
      await bucket.put(key, bytes, { httpMetadata: { contentType } });
    }
    signal.throwIfAborted();
    return { images };
  } catch {
    if (bucket.remove) await Promise.allSettled(published.map((key) => bucket.remove!(key)));
    signal.throwIfAborted();
    return { images: [], imageError: "MCP 图片批次未通过校验或存储失败" };
  }
}

export class McpManager {
  private sessions = new Map<string, Connection>();
  private retries = new Map<string, { attempts: number; stopped?: "disabled" | "exhausted" | "startup"; timer?: ReturnType<typeof setTimeout> }>();
  private unclosed = new Set<string>();
  private closing = new Map<string, Promise<void>>();
  private catalogs = new Map<string, { version: string; connection: Connection }>();
  private registered = new Map<string, Row>();
  private readonly listeners = new Set<(userId?: string) => void>();
  private stopped = false;
  constructor(private db: Database, private secret: string) {}
  private rows(userId: string) {
    return [...this.db.prepare("SELECT * FROM mcp_servers WHERE user_id=? ORDER BY rowid").bind(userId).rows<Row>(),
      ...[...this.registered.values()].filter((row) => row.user_id === userId)];
  }
  private row(userId: string, id: string) {
    const local = this.registered.get(id);
    return local?.user_id === userId ? local : this.db.prepare("SELECT * FROM mcp_servers WHERE user_id=? AND id=?").bind(userId, id).rows<Row>()[0];
  }
  list(userId: string): McpServerView[] {
    return this.rows(userId).filter((row) => !row.registered?.scope).map((row) => {
      const connection = this.sessions.get(row.id);
      const config = JSON.parse(row.config) as Configuration, retry = this.retries.get(row.id);
      return { ...config, id: row.id, configured: !row.registered, hasCredentials: Boolean(row.secrets || Object.keys(row.registered?.credentials ?? {}).length),
        status: !config.enabled ? "disabled" : connection?.status === "ready" ? "ready" : retry?.timer ? "reconnecting" : connection?.status ?? "offline",
        ...(connection?.status !== "ready" && (retry?.attempts || retry?.stopped) ?
          { failure: retry.stopped === "exhausted" ? "重连次数已用完" : retry.stopped === "startup" ? "初次连接失败，服务未启用" : "服务暂不可用" } : {}),
        toolCount: this.catalogs.get(row.id)?.connection.tools.length ?? connection?.tools.length ?? 0 };
    });
  }
  async save(userId: string, value: unknown, id?: string) {
    const { credentials, ...config } = input.parse(value);
    if (credentials) validateCredentialFields(config, credentials);
    const current = id ? this.row(userId, id) : undefined;
    if (id && (!current || current.registered)) throw new AppError("MCP 服务不可编辑", 404);
    if (!id && this.rows(userId).filter((row) => !row.registered).length >= 32) throw new AppError("最多配置 32 个 MCP 服务", 409);
    if (this.rows(userId).some((row) => row.id !== id && !row.registered?.scope && JSON.parse(row.config).name === config.name))
      throw new AppError("此名称已被使用", 409);
    const previous = current && JSON.parse(current.config) as Configuration;
    const sameDestination = previous && previous.transport === config.transport &&
      (config.transport === "stdio" && previous.transport === "stdio" ? previous.command === config.command &&
        previous.cwd === config.cwd && JSON.stringify(previous.args) === JSON.stringify(config.args) :
        config.transport === "streamable-http" && previous.transport === "streamable-http" && previous.url === config.url);
    const secret = credentials ? Object.keys(credentials).length ? await encryptSecrets(credentials, this.secret) : "" :
      sameDestination ? current?.secrets ?? "" : "";
    const serverId = id ?? crypto.randomUUID(), version = crypto.randomUUID();
    const changed = await (current
      ? this.db.prepare("UPDATE mcp_servers SET config=?,secrets=?,version=? WHERE id=? AND user_id=? AND version=?")
        .bind(JSON.stringify(config), secret, version, serverId, userId, current.version)
      : this.db.prepare("INSERT INTO mcp_servers(id,user_id,version,config,secrets) VALUES(?,?,?,?,?)")
        .bind(serverId, userId, version, JSON.stringify(config), secret)).run();
    if (!changed.meta.changes) throw new AppError("连接配置已变更，请刷新后重新编辑", 409);
    await this.disconnect(serverId, true);
    const saved = this.row(userId, serverId);
    if (config.enabled && saved?.version === version) void this.connect(saved, config).catch(() => {});
    this.notify(userId);
    return this.list(userId).find((row) => row.id === serverId)!;
  }
  async remove(userId: string, id: string) {
    const result = await this.db.prepare("DELETE FROM mcp_servers WHERE user_id=? AND id=?").bind(userId, id).run();
    if (result.meta.changes) { await this.disconnect(id, true); this.notify(userId); }
  }
  register(userId: string, name: string, value: unknown, scope?: string) {
    if (this.stopped) throw new AppError("MCP 管理器已关闭", 503);
    const { credentials = {}, ...config } = input.parse({ ...parameters.parse(value), name, enabled: true });
    validateCredentialFields(config, credentials);
    const duplicate = this.rows(userId).some((row) => row.registered?.scope === scope && JSON.parse(row.config).name === config.name);
    if (duplicate) throw new AppError("MCP 服务重名 " + config.name, 409);
    const hash = createHash("sha256").update(JSON.stringify([userId, scope ?? "", config.name])).digest("hex");
    const id = hash.slice(0, 8) + "-" + hash.slice(8, 12) + "-5" + hash.slice(13, 16) + "-8" + hash.slice(17, 20) + "-" + hash.slice(20, 32);
    const row: Row = { id, user_id: userId, version: digest([config, credentials]), config: JSON.stringify(config), secrets: "", registered: { scope, credentials } };
    this.registered.set(id, row);
    const ready = this.connect(row, config);
    void ready.catch(() => {});
    this.notify(userId);
    const dispose = async () => {
      if (this.registered.get(id) !== row) return;
      this.registered.delete(id);
      await this.disconnect(id, true);
      this.notify(userId);
    };
    return { dispose, readiness: config.failOnStartupError ? ready.then(() => {}) : undefined };
  }
  credentialNames(userId: string) {
    return this.db.prepare("SELECT name FROM mcp_credentials WHERE user_id=? ORDER BY name").bind(userId).rows<{ name: string }>().map(({ name }) => name);
  }
  async putCredential(userId: string, name: string, value: string | null) {
    const key = mcpCredentialName.parse(name);
    const [previous] = this.db.prepare("SELECT secret FROM mcp_credentials WHERE user_id=? AND name=?")
      .bind(userId, key).rows<{ secret: string }>();
    if (value === null && !previous) return this.credentialNames(userId);
    if (value !== null && previous) {
      const original = await decryptSecrets(previous.secret, this.secret).catch(() => null);
      if (original?.value === value) return this.credentialNames(userId);
    }
    if (value === null) await this.db.prepare("DELETE FROM mcp_credentials WHERE user_id=? AND name=?").bind(userId, key).run();
    else {
      const secret = await encryptSecrets({ value }, this.secret);
      await this.db.prepare(`INSERT INTO mcp_credentials(user_id,name,secret) VALUES(?,?,?)
        ON CONFLICT(user_id,name) DO UPDATE SET secret=excluded.secret`).bind(userId, key, secret).run();
    }
    for (const row of this.rows(userId)) {
      const config = JSON.parse(row.config) as Configuration;
      if (!config.enabled) continue;
      const raw = await this.rawCredentials(row).catch(() => ({}));
      if (![...configurationValues(config), ...Object.values(raw)].some((text) => references(text).includes(key))) continue;
      if (!this.isCurrent(row)) continue;
      await this.disconnect(row.id, true);
      if (this.isCurrent(row)) void this.connect(row, config).catch(() => {});
    }
    this.notify(userId);
    return this.credentialNames(userId);
  }
  private rawCredentials(row: Row) {
    return row.registered ? Promise.resolve(row.registered.credentials) : decryptSecrets(row.secrets, this.secret);
  }
  private async resolved(row: Row, config: Configuration) {
    const raw = await this.rawCredentials(row);
    const names = [...new Set([...configurationValues(config), ...Object.values(raw)].flatMap(references))];
    const values = new Map<string, string>();
    for (const name of names) {
      const [record] = this.db.prepare("SELECT secret FROM mcp_credentials WHERE user_id=? AND name=?").bind(row.user_id, name).rows<{ secret: string }>();
      if (!record) throw new AppError("等待 MCP 凭据", 409, "MCP_CREDENTIALS_MISSING");
      values.set(name, (await decryptSecrets(record.secret, this.secret)).value);
    }
    const resolve = (text: string) => text.replace(template, (_match, name: string) => values.get(name)!);
    const credentials = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, resolve(value)]));
    const destination = config.transport === "stdio"
      ? { ...config, command: resolve(config.command), args: config.args.map(resolve), cwd: config.cwd && resolve(config.cwd) }
      : { ...config, url: url.parse(resolve(config.url)) };
    validateCredentialFields(destination, credentials);
    return { config: destination, credentials, secrets: [...Object.values(credentials), ...values.values()].filter((item) => item.length >= 4) };
  }
  private isCurrent(row: Row) {
    const current = this.row(row.user_id, row.id);
    return row.registered ? current === row : current?.version === row.version;
  }
  private notify(userId?: string) { for (const listener of this.listeners) listener(userId); }
  watch(userId: string, signal: AbortSignal) {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>, previous = "", stopped = false;
    let ping: ReturnType<typeof setInterval> | undefined;
    const publish = (changed?: string) => {
      if (this.stopped && !stopped) { end(); return; }
      if (stopped || (changed !== undefined && changed !== userId) || (controller.desiredSize ?? 0) <= 0) return;
      const snapshot = JSON.stringify(this.list(userId));
      if (snapshot !== previous) { previous = snapshot; controller.enqueue(encoder.encode("data: " + snapshot + "\n\n")); }
    };
    const close = () => {
      if (stopped) return;
      stopped = true; clearInterval(ping); this.listeners.delete(publish); signal.removeEventListener("abort", end);
    };
    const end = () => { if (!stopped) { close(); controller.close(); } };
    const body = new ReadableStream<Uint8Array>({
      start: (stream) => {
        controller = stream;
        if (this.stopped || signal.aborted) { stopped = true; stream.close(); return; }
        this.listeners.add(publish);
        signal.addEventListener("abort", end, { once: true });
        ping = setInterval(() => {
          if (this.stopped || signal.aborted) end();
          else if ((stream.desiredSize ?? 0) > 0) stream.enqueue(encoder.encode(": keepalive\n\n"));
        }, 15_000);
        ping.unref();
        publish();
      },
      pull: () => publish(),
      cancel: close,
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" } });
  }
  start(userId: string) {
    for (const row of this.rows(userId)) {
      const config = JSON.parse(row.config) as Configuration;
      if (config.enabled) void this.connect(row, config).catch(() => {});
    }
  }
  private retry(row: Row, config: Configuration, connectedAt?: number) {
    if (this.stopped || !this.isCurrent(row)) return;
    const current = this.retries.get(row.id);
    if (current?.timer || current?.stopped) return;
    if (config.failOnStartupError && connectedAt === undefined && !this.catalogs.has(row.id)) {
      this.retries.set(row.id, { attempts: 0, stopped: "startup" });
      this.notify(row.user_id);
      return;
    }
    const policy = config.reconnect ?? reconnectOptions.parse({});
    const attempts = (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs ? 0 : current?.attempts ?? 0) + 1;
    if (!policy.enabled) {
      this.retries.set(row.id, { attempts, stopped: "disabled" });
      this.notify(row.user_id);
      return;
    }
    if (attempts > policy.maxAttempts) {
      this.retries.set(row.id, { attempts, stopped: "exhausted" });
      this.catalogs.delete(row.id);
      this.notify(row.user_id);
      return;
    }
    const timer = setTimeout(() => {
      this.retries.set(row.id, { attempts });
      if (!this.stopped && this.isCurrent(row))
        void this.connect(row, config).catch(() => {});
    }, Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (attempts - 1)));
    timer.unref();
    this.retries.set(row.id, { attempts, timer });
    this.notify(row.user_id);
  }
  private async disconnect(id: string, forget = false) {
    const connection = this.sessions.get(id);
    this.sessions.delete(id);
    if (forget) {
      clearTimeout(this.retries.get(id)?.timer);
      this.retries.delete(id);
      this.catalogs.delete(id);
    }
    connection?.controller.abort();
    if (connection) {
      const closing = Promise.all([closeClient(connection.client, connection.closeTimeoutMs), connection.sync]).then(([result]) => {
        if (!result.closeConfirmed) this.unclosed.add(id);
      }).finally(() => this.closing.delete(id));
      this.closing.set(id, closing);
    }
    await this.closing.get(id);
  }
  close() {
    this.stopped = true;
    this.notify();
    return Promise.all([...new Set([...this.sessions.keys(), ...this.retries.keys()])].map((id) => this.disconnect(id, true)));
  }
  async restart(userId: string, id: string) {
    const row = this.row(userId, id);
    if (!row || row.registered?.scope) throw new AppError("MCP 服务不存在", 404);
    const config = JSON.parse(row.config) as Configuration;
    if (!config.enabled) throw new AppError("服务已停用");
    clearTimeout(this.retries.get(id)?.timer);
    this.retries.delete(id);
    await this.disconnect(id);
    await this.connect(row, config);
    return this.list(userId).find((entry) => entry.id === id)!;
  }
  private async connect(row: Row, config: Configuration): Promise<Connection> {
    const closing = this.closing.get(row.id);
    if (closing) await closing;
    if (this.stopped || !this.isCurrent(row)) throw new AppError("MCP 连接配置已更新", 409, "MCP_CHANGED");
    if (this.unclosed.has(row.id)) throw new AppError("旧的 MCP 传输尚未确认关闭，请重启本地服务", 503, "MCP_CLEANUP_PENDING");
    const old = this.sessions.get(row.id);
    if (old?.version === row.version && old.pending) return old.pending;
    if (old?.version === row.version && old.status === "ready") {
      if (old.expires > Date.now()) return old;
      old.pending = this.refresh(row, old, old.controller.signal, true).finally(() => {
        old.pending = undefined;
        this.notify(row.user_id);
      });
      return old.pending;
    }
    if (old?.version === row.version && old.status === "waiting-credentials")
      throw new AppError("等待 MCP 凭据", 409, "MCP_CREDENTIALS_MISSING");
    if (old) { await this.disconnect(row.id); return this.connect(row, config); }
    const controller = new AbortController();
    const client = new Client({ name: "doman-studio", version: "0.1.0" }, {
      inputRequired: { autoFulfill: false },
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: (error) => {
        if (!error && connection.readyToSync && this.sessions.get(row.id) === connection)
          void this.refresh(row, connection, controller.signal, true).then(() => this.notify(row.user_id), () => {});
      } } },
    });
    const connection: Connection = { version: row.version, client, controller, tools: [], expires: 0, status: "connecting", credentials: [],
      sync: Promise.resolve(), readyToSync: false, closeTimeoutMs: config.closeTimeoutMs };
    this.sessions.set(row.id, connection);
    this.notify(row.user_id);
    client.onclose = () => {
      controller.abort();
      if (connection.status === "waiting-credentials") return;
      connection.status = "offline";
      if (this.sessions.get(row.id) === connection) this.retry(row, config, connection.connectedAt);
    };
    connection.pending = (async () => {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.startupTimeoutMs ?? MCP_STARTUP_TIMEOUT_MS)]);
        const resolved = await this.resolved(row, config);
        signal.throwIfAborted();
        connection.credentials = resolved.secrets;
        const transport = makeTransport(resolved.config, resolved.credentials);
        await client.connect(transport, { signal });
        const instructions = client.getInstructions()?.trimEnd();
        const attributed = instructions ? "### MCP server: " + config.name + "\n\n" + instructions : "";
        if (Buffer.byteLength(attributed) > (config.maxInstructionBytes ?? instructionLimit))
          throw new AppError("MCP 服务指令超过配置的字节数", 502, "MCP_INSTRUCTIONS_LIMIT");
        connection.readyToSync = true;
        await this.refresh(row, connection, signal);
        signal.throwIfAborted();
        if (this.sessions.get(row.id) !== connection) throw new AppError("连接配置已更新");
        this.catalogs.set(row.id, { version: row.version, connection });
        connection.connectedAt = Date.now();
        this.notify(row.user_id);
        return connection;
      } catch (error) {
        const missing = error instanceof AppError && error.code === "MCP_CREDENTIALS_MISSING";
        connection.readyToSync = false;
        connection.status = missing ? "waiting-credentials" : "offline";
        const cleanup = await closeClient(client, connection.closeTimeoutMs);
        if (!cleanup.closeConfirmed) this.unclosed.add(row.id);
        if (this.sessions.get(row.id) === connection) {
          if (!missing) this.retry(row, config);
          this.notify(row.user_id);
        }
        if (missing) throw error;
        throw new AppError("无法连接 MCP 服务，请检查地址、命令和凭据", 502, "MCP_UNAVAILABLE");
      } finally { connection.pending = undefined; }
    })();
    return connection.pending;
  }
  private refresh(row: Row, connection: Connection, signal: AbortSignal, keepPrevious = false) {
    const current = () => !signal.aborted && this.sessions.get(row.id) === connection && this.isCurrent(row);
    const sync = connection.sync.then(async () => {
      if (!current()) throw new AppError("MCP 连接配置已更新", 409, "MCP_CHANGED");
      try {
        const listed = connection.client.getServerCapabilities()?.tools
          ? await connection.client.listTools(undefined, { signal, cacheMode: "refresh" }) : { tools: [] };
        if (!current()) throw new AppError("MCP 连接配置已更新", 409, "MCP_CHANGED");
        connection.tools = checkedTools(listed.tools).map((tool) => ({ ...tool }));
        connection.status = "ready";
        connection.expires = Date.now() + 60_000;
        return connection;
      } catch (error) {
        if (!current()) throw error;
        if (keepPrevious && connection.status === "ready") { connection.expires = Date.now() + 5000; return connection; }
        throw new AppError("无法读取 MCP 工具目录", 502, "MCP_UNAVAILABLE");
      }
    });
    connection.sync = sync.then(() => {}, () => {});
    return sync;
  }
  async test(userId: string, id: string, abort?: AbortSignal): Promise<McpProbeView> {
    const row = this.row(userId, id);
    if (!row || row.registered?.scope) throw new AppError("MCP 服务不存在", 404);
    const config = JSON.parse(row.config) as Configuration;
    const client = new Client({ name: "doman-probe", version: "0.1.0" });
    const started = Date.now(), timer = AbortSignal.timeout(10_000);
    const signal = abort ? AbortSignal.any([timer, abort]) : timer;
    const toolNames: string[] = [];
    let cursor: string | undefined, truncated = false, stage: "connect" | "list" = "connect";
    let failure: AppError | undefined;
    try {
      const resolved = await this.resolved(row, config);
      signal.throwIfAborted();
      await client.connect(makeTransport(resolved.config, resolved.credentials), { signal });
      stage = "list";
      if (client.getServerCapabilities()?.tools) for (let page = 0; page < 16; page++) {
        const response = await client.request({ method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
          { signal });
        cursor = response.nextCursor;
        const remaining = 512 - toolNames.length;
        toolNames.push(...response.tools.slice(0, remaining).map(({ name }) => name));
        truncated = response.tools.length > remaining || cursor !== undefined && (page === 15 || toolNames.length === 512);
        if (cursor === undefined || truncated) break;
      }
    } catch (error) {
      failure = error instanceof AppError && error.code === "MCP_CREDENTIALS_MISSING" ? error :
        new AppError("MCP 探测在" + (stage === "list" ? "读取工具列表" : "连接") + "时失败" +
          (timer.aborted ? "（超时）" : ""), 502, "MCP_UNAVAILABLE");
    }
    const durationMs = Date.now() - started;
    const cleanup = await closeClient(client, config.closeTimeoutMs);
    const result = { name: config.name, durationMs, ...cleanup };
    return failure ? { ...result, ok: false, stage, message: failure.message, code: failure.code } :
      { ...result, ok: true, toolCount: toolNames.length, toolNames, truncated };
  }
  private source(row: Row, config: Configuration, connection: Connection, admitted?: ReadonlySet<string>) {
    const registrations: ToolRegistration[] = [];
    const observed = connection.client.getServerCapabilities();
    const current = () => this.isCurrent(row);
    const formerName = (name: string, shape: unknown) => "mcp_" + identifier(config.name).slice(0, 14) + "_" +
      identifier(name).slice(0, 23) + "_" + digest([row.id, row.version, name, shape]);
    const register = (name: string, description: string, schema: ReturnType<typeof tool>["function"]["parameters"],
      execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>, available = current, legacyOnly = false, owner: object = connection) => {
      const previous = formerName(name, schema);
      if (legacyOnly && !admitted?.has(previous)) return;
      const stable = admitted?.has(previous) ? previous : publicMcpToolName(config.name, name);
      if (registrations.some((item) => item.name === stable)) return;
      registrations.push({ name: stable, label: config.name + " · " + name, schema: { type: "function", function: {
        name: stable, description, parameters: schema,
      } }, available, timeoutMs: callTimeout(config), matchAdmitted: true, binding: runtimeToolBinding(owner),
      execute: async (context, _call, args) => {
        const { signal } = context;
        if (!available()) throw new AppError("MCP 工具目录已更新", 409, "MCP_CHANGED");
        if (connection.status !== "ready" || this.sessions.get(row.id) !== connection)
          throw new AppError("MCP 服务暂不可用", 503, "MCP_UNAVAILABLE");
        try {
          const result = await execute(parameters.parse(args), AbortSignal.any([signal, connection.controller.signal]));
          const normalized = scrub(result, connection.credentials);
          if (normalized && typeof normalized === "object" && (normalized as { isError?: boolean }).isError)
            return { result: { error: "MCP 工具返回失败", code: "MCP_TOOL_ERROR", data: normalized } };
          const { images, imageError } = await resultImages(result, context);
          return { result: { external: true, data: normalized, ...(images.length ? { attached_images: images.length } : {}),
              ...(imageError ? { image_error: imageError } : {}) },
            ...(images.length ? { images } : {}) };
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof AppError && error.code === "MCP_TASK_REQUIRED") throw error;
          if (error instanceof z.ZodError) throw new AppError("MCP 参数无效");
          throw new AppError("MCP 工具调用失败，请检查连接和参数", 502, "MCP_TOOL_ERROR");
        }
      } });
    };
    for (const remote of connection.tools) {
      register(remote.name, remote.description ?? remote.name, remote.inputSchema, (args, signal) => {
        if (remote.execution?.taskSupport === "required")
          throw new AppError("MCP 工具 " + remote.name + " 要求任务模式，当前连接桥接尚未支持该模式", 409, "MCP_TASK_REQUIRED");
        return connection.client.callTool({ name: remote.name, arguments: args }, { signal, timeout: callTimeout(config), toolDefinition: remote });
      }, () =>
        current() && this.sessions.get(row.id) === connection && connection.tools.includes(remote), false, remote);
    }
    const meta = (name: string, description: string, properties: Record<string, unknown>, required: string[],
      execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>) =>
      register("$" + name, description, tool(name, description, properties, required).function.parameters, execute, current, true);
    const string = { type: "string" };
    if (observed?.resources) {
      meta("list_resources", "列出此 MCP 服务的资源与 URI 模板。", {}, [], async (_args, signal) => {
        const [resources, templates] = await Promise.all([connection.client.listResources(undefined, { signal }),
          connection.client.listResourceTemplates(undefined, { signal })]);
        return { ...resources, ...templates };
      });
      meta("read_resource", "读取此 MCP 服务的指定资源。", { uri: string }, ["uri"], (args, signal) =>
        connection.client.readResource({ uri: z.string().max(4000).parse(args.uri) }, { signal }));
    }
    if (observed?.prompts) {
      meta("list_prompts", "列出此 MCP 服务提供的提示模板。", {}, [], (_args, signal) => connection.client.listPrompts(undefined, { signal }));
      meta("get_prompt", "获取指定 MCP 提示模板的内容。", { name: string, arguments: { type: "object", additionalProperties: string } }, ["name"],
        (args, signal) => connection.client.getPrompt({ name: z.string().parse(args.name),
          arguments: z.record(z.string()).optional().parse(args.arguments) }, { signal }));
    }
    const instruction = connection.client.getInstructions()?.trimEnd();
    return { registrations, ...(instruction ? { instruction: { server: config.name, content: scrub(instruction, connection.credentials) } } : {}) };
  }
  async tools(userId: string, allow: readonly string[] | null | undefined, scope?: string, calls?: readonly string[]) {
    const visibleServers = new Map<string, { row: Row; config: Configuration }>();
    for (const row of this.rows(userId)) {
      const config = JSON.parse(row.config) as Configuration;
      const visible = row.registered?.scope ? row.registered.scope === scope : allow == null || allow.includes(row.id);
      if (config.enabled && visible && (!visibleServers.has(config.name) || row.registered?.scope))
        visibleServers.set(config.name, { row, config });
    }
    const entries = [...visibleServers.values()], admitted = calls && new Set(calls);
    const sources = await Promise.allSettled(entries.map(async ({ row, config }) => {
      const cached = this.catalogs.get(row.id), retry = this.retries.get(row.id);
      if (retry?.timer || retry?.stopped) {
        if (cached?.version !== row.version) throw new Error("MCP unavailable");
        return this.source(row, config, cached.connection, admitted);
      }
      try { return this.source(row, config, await this.connect(row, config), admitted); }
      catch (error) {
        if (cached?.version === row.version) return this.source(row, config, cached.connection, admitted);
        throw error;
      }
    }));
    const registrations = sources.flatMap((source) => source.status === "fulfilled" ? source.value.registrations : []);
    const resourceServers = [...visibleServers.keys()].sort();
    if (resourceServers.length) registrations.push(...this.resources(visibleServers));
    return { registrations, resourceServers,
      instructions: sources.flatMap((source) => source.status === "fulfilled" && source.value.instruction ? [source.value.instruction] : []) };
  }

  private resources(servers: ReadonlyMap<string, { row: Row; config: Configuration }>): ToolRegistration[] {
    const string = { type: "string" };
    const binding = "mcp-resources:" + digest([...servers.values()].map(({ row }) => [row.id, row.version]).sort());
    return mcpResourceTools.map((name, index) => {
      const read = index === 2;
      return { schema: tool(name, ["列出指定 MCP 服务的资源。", "列出指定 MCP 服务的资源 URI 模板。", "按 URI 读取指定 MCP 服务的资源。"][index],
        { server: string, ...(read ? { uri: string } : { cursor: { ...string, description: "上一页返回的 nextCursor" } }) },
        read ? ["server", "uri"] : ["server"]), label: "MCP · " + name, binding, mode: "parallel", execute: async ({ signal }, _id, args) => {
        const { server, cursor, uri } = z.object({ server: z.string(), cursor: z.string().optional(), uri: z.string().optional() }).parse(args);
        const selected = servers.get(server);
        if (!selected || !this.isCurrent(selected.row)) throw new AppError("当前会话没有此 MCP 服务", 404, "MCP_SERVER_NOT_FOUND");
        const connection = this.sessions.get(selected.row.id);
        if (!connection || connection.version !== selected.row.version || connection.status !== "ready")
          throw new AppError("MCP 服务暂不可用", 503, "MCP_UNAVAILABLE");
        const { client } = connection;
        const options = { signal: AbortSignal.any([signal, connection.controller.signal]), timeout: callTimeout(selected.config) };
        const page = cursor === undefined ? undefined : { cursor };
        const capability = client.getServerCapabilities()?.resources;
        const data = read ? await client.readResource({ uri: z.string().min(1).parse(uri) }, options) :
          index === 0 ? capability ? await client.listResources(page, options) : { resources: [] } :
          capability ? await client.listResourceTemplates(page, options) : { resourceTemplates: [] };
        return { result: { external: true, data: scrub(data, connection.credentials) } };
      } };
    });
  }
}
