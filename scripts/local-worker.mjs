import { inspectVideo } from "./native-inspector.mjs";
import { composeVideo } from "./native-composer.mjs";

export function createLocalWorker({ baseUrl, token, concurrency = 2, fetchImpl = fetch, compose = composeVideo, inspect = inspectVideo, onError = (...args) => {} }) {
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("后台仅连接本机工作室");
  const active = new Map();
  const slots = () => [...active.values()].reduce((counts, entry) => { counts[entry.interactive ? "chat" : "work"]++; return counts; }, { chat: 0, work: 0 });
  async function request(path, body, signal) {
    const form = body instanceof FormData;
    const response = await fetchImpl(new URL(path, base), { method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { Authorization: "Bearer " + token, ...(body === undefined || form ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body), signal });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(data.error || "后台请求失败（" + response.status + "）"); error.code = data.code; error.status = response.status; throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }
  async function execute(job, signal) {
    if (job.cancellation) { await request("/api/worker/jobs/" + job.id + "/cancel-check", {}, signal); return; }
    if (!["composing", "inspecting"].includes(job.stage)) { await request("/api/worker/jobs/" + job.id + "/advance", {}, signal); return; }
    const inspecting = job.stage === "inspecting";
    const plan = await request("/api/worker/jobs/" + job.id + (inspecting ? "/inspect" : "/compose"), {}, signal);
    if (!plan) return;
    const controller = new AbortController();
    const stop = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    let renewing = false;
    const heartbeat = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try { await request("/api/worker/jobs/" + job.id + "/heartbeat", { leaseToken: plan.leaseToken }, AbortSignal.timeout(8000)); }
      catch (error) { controller.abort(error); }
      finally { renewing = false; }
    }, 2000);
    try {
      const progress = (progress, label) => request("/api/worker/jobs/" + job.id + "/heartbeat", { leaseToken: plan.leaseToken, progress, label }, controller.signal);
      const form = new FormData(); form.set("leaseToken", plan.leaseToken);
      const output = (line) => request("/api/worker/jobs/" + job.id + "/output", { leaseToken: plan.leaseToken, lines: [line] }, controller.signal);
      if (inspecting) {
        const { frames, ...metadata } = await inspect(plan, { baseUrl, token, signal: controller.signal, fetchImpl, onProgress: progress, onOutput: output });
        form.set("metadata", JSON.stringify({ ...metadata, timestamps: frames.map((f) => f.timestamp) }));
        frames.forEach((frame, i) => form.set("frame" + i, frame.file));
      } else {
        form.set("file", await compose(plan, { baseUrl, token, signal: controller.signal, fetchImpl, onProgress: progress, onOutput: output }));
        form.set("previousVersion", String(plan.previousVersion));
        if (plan.previousArtifactId) form.set("previousArtifactId", plan.previousArtifactId);
      }
      await request("/api/worker/jobs/" + job.id + (inspecting ? "/inspect-complete" : "/complete"), form, controller.signal);
    } catch (error) {
      if (!signal?.aborted) await request("/api/worker/jobs/" + job.id + "/fail", { leaseToken: plan.leaseToken, error: error.message, code: error.code || (inspecting ? "INSPECT_ERROR" : "COMPOSE_ERROR") }, AbortSignal.timeout(8000)).catch(() => {});
      throw error;
    } finally {
      clearInterval(heartbeat); signal?.removeEventListener("abort", stop);
      await request("/api/worker/jobs/" + job.id + "/release", { leaseToken: plan.leaseToken }, AbortSignal.timeout(5000)).catch(() => {});
    }
  }
  async function tick(signal) {
    const available = slots();
    if (signal?.aborted || available.work >= concurrency && available.chat >= 1) return;
    const { jobs } = await request("/api/worker/jobs", undefined, signal);
    for (const job of jobs) {
      if (active.has(job.id)) continue;
      const interactive = Boolean(job.interactive), used = slots();
      if (interactive ? used.chat >= 1 : used.work >= concurrency) continue;
      const task = execute(job, signal).catch((error) => { if (!signal?.aborted) onError(error, job); }).finally(() => active.delete(job.id));
      active.set(job.id, { task, interactive });
    }
  }
  async function run(signal) {
    let delay = 700;
    while (!signal.aborted) {
      try { await tick(signal); } catch (error) { if (error.status === 401) { onError(error); throw error; } }
      delay = active.size ? 700 : Math.min(3000, delay * 1.5);
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, delay); signal.addEventListener("abort", done, { once: true });
      });
    }
    await Promise.allSettled([...active.values()].map((entry) => entry.task));
  }
  return { tick, run, idle: () => Promise.allSettled([...active.values()].map((entry) => entry.task)), activeCount: () => active.size };
}
