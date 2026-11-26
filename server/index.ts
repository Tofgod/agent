import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SQLiteDatabase, LocalMediaStore } from "./storage";
import { configureRuntime } from "./runtime";
import * as studio from "../app/api/studio/[...path]/route";
import * as worker from "../app/api/worker/[...path]/route";
import { errorResponse } from "../lib/studio/server";
import { ProjectDisk } from "./project-disk";
import { cleanDeletedProject } from "./project-deletion";
import { Store } from "../lib/studio/store";
import { AppError } from "../lib/studio/security";
import { STUDIO_NAME } from "../lib/studio/types";
import { loadAgentRoles } from "../lib/studio/agent-roles";
import { loadCompactionConfig } from "../lib/studio/compaction-policy";
import { SkillLibrary } from "../lib/studio/skills";
import { McpManager } from "../lib/studio/mcp";
import { PresetPlugins, readLocalPlugins } from "../lib/studio/preset-plugins";
import { Schedules } from "../lib/studio/schedules";
import { resolveLiveDeepSeekModel } from "../lib/studio/providers";
import { localConfig } from "../scripts/local-config.mjs";
import { createLocalWorker } from "../scripts/local-worker.mjs";
const mode = process.argv[2] || "dev", portArg = process.argv.indexOf("--port"), hostArg = process.argv.indexOf("--hostname");
const port = portArg === -1 ? 5179 : Number(process.argv[portArg + 1]), host = hostArg === -1 ? "127.0.0.1" : process.argv[hostArg + 1];
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !["127.0.0.1", "localhost"].includes(host)) throw new Error("请使用本机地址和有效端口");
const { workerSecret, env } = localConfig({ create: true });
const dataDir = path.resolve(process.env.STUDIO_DATA_DIR || "data");
const contextWindow = env.STUDIO_CONTEXT_WINDOW ? Number(env.STUDIO_CONTEXT_WINDOW) : undefined;
const compaction = loadCompactionConfig(path.join(dataDir, "compaction.json"));
const modelRetry = env.STUDIO_MODEL_RETRY_POLICIES ? JSON.parse(env.STUDIO_MODEL_RETRY_POLICIES) : undefined;
const database = new SQLiteDatabase(path.join(dataDir, "studio.sqlite"));
const mcp = new McpManager(database, env.SETTINGS_ENCRYPTION_KEY!);
const installed = await readLocalPlugins(path.resolve(env.STUDIO_EXTENSIONS_FILE || path.join(dataDir, "extensions.mjs")));
const presetPlugins = new PresetPlugins(database, mcp, installed.plugins);
const skills = new SkillLibrary(path.join(dataDir, "skills"), (env.STUDIO_SKILL_DIRS || "").split(path.delimiter).filter(Boolean), path.join(dataDir, "workspaces"), {
  user: path.join(env.DSH_HOME || homedir() + "/.dsh", "skills"),
  agents: path.join(env.DSH_AGENTS_HOME || homedir() + "/.agents", "skills"),
  bundled: env.DSH_BUNDLED_SKILL_DIR,
});
const runtimeOptions = {
  mcp, skills, presetPlugins, scheduleToolsEnabled: true, resolveModel: resolveLiveDeepSeekModel,
  schedulePolicy: { newSessionIntervalSeconds: env.STUDIO_NEW_SESSION_INTERVAL_SECONDS ? Number(env.STUDIO_NEW_SESSION_INTERVAL_SECONDS) : undefined,
    historyDays: env.STUDIO_SCHEDULE_HISTORY_DAYS ? Number(env.STUDIO_SCHEDULE_HISTORY_DAYS) : undefined,
    historyRecords: env.STUDIO_SCHEDULE_HISTORY_RECORDS ? Number(env.STUDIO_SCHEDULE_HISTORY_RECORDS) : undefined },
  agents: loadAgentRoles(path.join(dataDir, "agents.json")), contextWindow, compaction, modelRetry,
  maxParallelTools: env.STUDIO_MAX_PARALLEL_TOOLS ? Number(env.STUDIO_MAX_PARALLEL_TOOLS) : undefined,
  maxDelegationDepth: env.STUDIO_MAX_DELEGATION_DEPTH !== undefined ? Number(env.STUDIO_MAX_DELEGATION_DEPTH) : undefined,
  maxConsecutiveWakes: env.STUDIO_MAX_CONSECUTIVE_WAKES !== undefined ? Number(env.STUDIO_MAX_CONSECUTIVE_WAKES) : undefined,
  jobWaitTimeout: env.STUDIO_JOB_WAIT_TIMEOUT_MS !== undefined ? Number(env.STUDIO_JOB_WAIT_TIMEOUT_MS) : undefined,
  maxJobWaitTimeout: env.STUDIO_JOB_MAX_WAIT_TIMEOUT_MS !== undefined ? Number(env.STUDIO_JOB_MAX_WAIT_TIMEOUT_MS) : undefined,
  completionDelivery: env.STUDIO_JOB_COMPLETION_DELIVERY === "quiet" ? "quiet" as const : "wakeup" as const,
};
const recovery = new Store(database, runtimeOptions);
database.initialize(path.resolve("drizzle"));
await presetPlugins.start("local", installed.host);
mcp.start("local");
database.releaseAbandonedLeases({ interruptAgentTurns: true });
await recovery.recoverStoppedExecutions();
await recovery.resumeInterruptedAgentRuns();
const media = new LocalMediaStore(path.join(dataDir, "media"), database);
const disk = new ProjectDisk(path.join(dataDir, "workspaces"), recovery, media, "local");
for (const { project_id } of database.prepare("SELECT project_id FROM project_deletions").rows<{ project_id: string }>()) {
  await cleanDeletedProject(recovery, project_id, media, disk).catch((error) => {
    console.error("[清理已删除项目]", project_id, error instanceof Error ? error.name : String(error));
  });
}
disk.start();
configureRuntime({ database, media, disk, userId: "local", workerSecret, encryptionSecret: env.SETTINGS_ENCRYPTION_KEY!,
  ...runtimeOptions });
const lifecycle = new AbortController(); let vite: import("vite").ViteDevServer | undefined;
async function writeResponse(response: Response, output: ServerResponse, method: string) {
  output.writeHead(response.status, Object.fromEntries(response.headers)); output.flushHeaders();
  if (method === "HEAD" || !response.body) { await response.body?.cancel(); output.end(); return; }
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), output);
}
async function api(request: IncomingMessage, response: ServerResponse, url: URL) {
  const controller = new AbortController(); response.once("close", () => { if (!response.writableEnded) controller.abort(); });
  let size = 0;
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : (Readable.toWeb(request) as unknown as ReadableStream<Uint8Array>).pipeThrough(new TransformStream({ transform(chunk, stream) { size += chunk.byteLength; if (size > 300 * 1024 * 1024) throw new AppError("上传内容过大", 413); stream.enqueue(chunk); } }));
  const webRequest = new Request(url, { method: request.method, headers: new Headers(request.headers as Record<string, string>), body: body as BodyInit, signal: controller.signal, ...(body ? { duplex: "half" } : {}) } as RequestInit);
  const parts = url.pathname.split("/").filter(Boolean), handlers = parts[1] === "studio" ? studio : parts[1] === "worker" ? worker : null;
  const method = (request.method === "HEAD" ? "GET" : request.method) as keyof typeof studio;
  const handler = handlers && handlers[method as keyof typeof handlers];
  if (typeof handler !== "function") throw new AppError("接口不存在", 404);
  const result = await handler(webRequest, { params: Promise.resolve({ path: parts.slice(2).map(decodeURIComponent) }) });
  await writeResponse(result, response, request.method!);
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://" + request.headers.host);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new AppError("请求来源无效", 403);
    if (url.pathname.startsWith("/api/")) { await api(request, response, url); return; }
    if (/^\/(?:data|\.studio-runtime|\.sites-runtime|\.wrangler|\.env|\.dev.vars|\.git)(?:[/.]|$)/.test(decodeURIComponent(url.pathname))) throw new AppError("接口不存在", 404);
    if (vite) { vite.middlewares(request, response, async () => {
      try { const html = await vite!.transformIndexHtml(url.pathname, await readFile("index.html", "utf8")); response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); }
      catch (error) { vite!.ssrFixStacktrace(error as Error); response.writeHead(500); response.end("页面加载失败"); }
    }); return; }
    const root = path.resolve("dist/client"), candidate = path.resolve(root, "." + decodeURIComponent(url.pathname));
    if (candidate !== root && !candidate.startsWith(root + path.sep)) throw new AppError("接口不存在", 404);
    const file = await stat(candidate).then((s) => s.isFile() ? candidate : path.join(root, "index.html")).catch(() => path.join(root, "index.html"));
    const type: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm" };
    response.setHeader("Content-Type", type[path.extname(file)] || "application/octet-stream"); response.end(await readFile(file));
  } catch (error) {
    if (response.headersSent) { response.destroy(); return; }
    await writeResponse(errorResponse(error), response, request.method || "GET").catch(() => response.destroy());
  }
});
if (mode === "dev") {
  const { createServer: createVite } = await import("vite");
  vite = await createVite({ server: { middlewareMode: true, hmr: { server }, watch: { usePolling: process.env.CODEX_SANDBOX === "seatbelt", ignored: ["**/data/**", "**/.studio-runtime/**", "**/.sites-runtime/**", "**/.wrangler/**", "**/outputs/**"] } }, appType: "custom" });
}
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
console.log(STUDIO_NAME + " · http://" + host + ":" + port + "\n本地数据库：" + path.join(dataDir, "studio.sqlite") + "\n后台持续执行已启动");
const runner = createLocalWorker({ baseUrl: "http://127.0.0.1:" + port, token: workerSecret, onError: (error: Error) => console.error("[后台]", error.message) });
const running = runner.run(lifecycle.signal);
const schedules = new Schedules(recovery);
let backgroundTick: Promise<void> | undefined;
const dispatchSchedules = () => {
  backgroundTick ??= schedules.runDue().then(() => presetPlugins.sweep()).catch((error: Error) => {
    console.error("[定时任务]", error.name);
  }).finally(() => { backgroundTick = undefined; });
};
dispatchSchedules();
const scheduleTimer = setInterval(dispatchSchedules, 1000);
scheduleTimer.unref();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true; clearInterval(scheduleTimer); lifecycle.abort();
  skills.close();
  await running; await backgroundTick; await presetPlugins.close(); await mcp.close(); await disk.close(); await vite?.close();
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); database.close();
}
process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
