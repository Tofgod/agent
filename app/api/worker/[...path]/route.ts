import { getRuntime } from "@/server/runtime";
import { z } from "zod";
import { Store, uid } from "@/lib/studio/store";
import { AppError } from "@/lib/studio/security";
import { bodyJson, errorResponse } from "@/lib/studio/server";
import { authorizeLocalWorker } from "@/lib/studio/local-worker-auth";
import { advanceRun, assertCurrent } from "@/lib/studio/engine";
import { inspectionPlan, completeInspection } from "@/lib/studio/inspection";
import { compositionPlan } from "@/lib/studio/composition";
import { reconcileCancellation } from "@/lib/studio/control";
import { failRun } from "@/lib/studio/jobs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };

async function handle(request: Request, context: Context) {
  const { store, media: bucket, encryptionSecret, workerSecret } = getRuntime();
  authorizeLocalWorker(request, workerSecret);
  const { path: p } = await context.params;
  if (p[0] === "jobs" && p.length === 1 && request.method === "GET") {
    return Response.json({ jobs: await store.dueRuns() });
  }
  if (p[0] === "media" && p[1] && request.method === "GET") {
    const file = await store.mediaArtifact(p[1], new URL(request.url).searchParams.has("version") ? z.coerce.number().int().positive().parse(new URL(request.url).searchParams.get("version")) : undefined);
    if (!bucket || typeof file.metadata.objectKey !== "string") throw new AppError("素材不存在", 404);
    const object = await bucket.get(file.metadata.objectKey);
    if (!object) throw new AppError("素材不存在", 404);
    const headers = new Headers({ "Cache-Control": "no-store", "Content-Length": String(object.size) });
    object.writeHeaders(headers);
    return new Response(object.body, { headers });
  }
  if (p[0] !== "jobs" || !p[1] || request.method !== "POST") throw new AppError("接口不存在", 404);
  const { project, userId, run: initial } = await store.jobContext(p[1]);
  if (p[2] === "cancel-check") {
    const settings = await store.getSettings(userId, encryptionSecret);
    await reconcileCancellation(store, initial, settings);
    return Response.json({ ok: true });
  }
  if (p[2] === "advance") {
    if (["composing", "inspecting"].includes(initial.stage)) throw new AppError("请使用本地媒体处理队列", 409);
    const settings = await store.getSettings(userId, encryptionSecret);
    return Response.json(await advanceRun(store, project, initial.id, settings, bucket, undefined, () => store.getSettings(userId, encryptionSecret)));
  }
  if (p[2] === "inspect") {
    if (initial.stage !== "inspecting" || !await store.claimRun(initial.id, project.id)) return new Response(null, { status: 204 });
    const run = await store.run(initial.id, project.id);
    try { return Response.json(await inspectionPlan(store, run)); }
    catch (error) { await failRun(store, run, error); await store.releaseLease(run); throw error; }
  }
  if (p[2] === "inspect-complete") {
    if (!bucket) throw new AppError("素材存储未配置", 503);
    return Response.json(await completeInspection(store, initial, await request.formData(), bucket));
  }
  if (p[2] === "compose") {
    if (initial.stage !== "composing" || !await store.claimRun(initial.id, project.id)) return new Response(null, { status: 204 });
    const run = await store.run(initial.id, project.id);
    try {
      const plan = await compositionPlan(store, project, run);
      await store.updateRun(run, { label: "正在合成成片", leaseUntil: run.leaseUntil });
      return Response.json(plan);
    } catch (error) { await failRun(store, run, error); await store.releaseLease(run); throw error; }
  }
  if (p[2] === "complete") {
    const form = await request.formData(), file = form.get("file"), token = form.get("leaseToken");
    if (!(file instanceof File) || file.type !== "video/mp4" || file.size > 240 * 1024 * 1024) throw new AppError("成片文件无效");
    if (token !== initial.leaseToken || initial.stage !== "composing" || initial.status !== "running") throw new AppError("任务已停止", 409, "RUN_STOPPED");
    await assertCurrent(store, initial);
    if (!bucket) throw new AppError("素材存储未配置", 503);
    const operation = initial.payload.operation;
    if (operation?.name !== "compose_video") throw new AppError("缺少合成任务的输出路径", 409, "MISSING_COMPOSITION");
    const revision = form.get("previousVersion"), artifactId = form.get("previousArtifactId");
    const version = Number(revision);
    if (typeof revision !== "string" || !/^\d+$/.test(revision) || !Number.isSafeInteger(version) ||
        (version === 0 ? artifactId !== null : typeof artifactId !== "string" || !artifactId))
      throw new AppError("缺少有效的合成目标版本");
    const expectedArtifactId = typeof artifactId === "string" ? artifactId : undefined;
    const previous = (await store.artifacts(project.id)).find((f) => f.path === operation.path);
    if (previous?.id !== expectedArtifactId || (previous?.version ?? 0) !== version)
      throw new AppError("成片目标文件已变化，未覆盖现有文件", 409, "VERSION_CONFLICT");
    const key = project.id + "/final/" + uid();
    await bucket.put(key, file.stream(), { httpMetadata: { contentType: "video/mp4" } });
    await assertCurrent(store, initial);
    const saved = await store.finishComposition(initial, key, version, expectedArtifactId);
    return Response.json(saved);
  }
  if (p[2] === "output") {
    const leaseToken = z.string(), text = z.string().min(1).max(1000);
    const output = z.union([
      z.strictObject({ leaseToken, lines: z.array(text).min(1).max(32) }),
      z.strictObject({ leaseToken, chunks: z.array(z.strictObject({ line: text, channel: z.enum(["stdout", "stderr", "log"]) })).min(1).max(32) }),
    ]).parse(await bodyJson(request));
    if (output.leaseToken !== initial.leaseToken) throw new AppError("任务已停止", 409, "RUN_STOPPED");
    if ("lines" in output) await store.appendBackgroundOutput(initial, output.lines, "lines");
    else await store.appendBackgroundOutput(initial, output.chunks);
    return new Response(null, { status: 204 });
  }
  const input = z.object({ leaseToken: z.string(), progress: z.number().min(0).max(99).optional(), label: z.string().max(120).optional(), error: z.string().max(1000).optional(), code: z.string().max(80).optional() }).parse(await bodyJson(request));
  if (p[2] === "release" && input.leaseToken === initial.leaseToken) {
    await store.releaseLease(initial); return Response.json({ ok: true });
  }
  if (input.leaseToken !== initial.leaseToken || !["composing", "inspecting"].includes(initial.stage) || initial.status !== "running") throw new AppError("任务已停止", 409, "RUN_STOPPED");
  if (p[2] === "fail") {
    await failRun(store, initial, new AppError(input.error || "成片合成失败", 502, input.code || "COMPOSE_ERROR"));
    return Response.json({ ok: true });
  }
  if (p[2] === "heartbeat") {
    try { await assertCurrent(store, initial); }
    catch (error) { await failRun(store, initial, error); throw error; }
    await store.updateRun(initial, { leaseUntil: Date.now() + 240000, progress: input.progress ?? initial.progress, label: input.label || initial.label });
    return Response.json({ ok: true });
  }
  throw new AppError("接口不存在", 404);
}
export async function GET(request: Request, context: Context) { try { return await handle(request, context); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request, context: Context) { try { return await handle(request, context); } catch (error) { return errorResponse(error); } }
