import type { BlobStore } from "./storage";
import { z } from "zod";
import { imageSize } from "image-size";
import { assertCurrent } from "./engine";
import type { Store } from "./store";
import { uid } from "./store";
import type { AgentImage, Run } from "./types";
import { AppError } from "./security";

export async function inspectionPlan(store: Store, run: Run) {
  await assertCurrent(store, run);
  const input = run.payload.inspection;
  if (!input) throw new AppError("缺少视频读取参数");
  const video = await store.artifact(input.sourceId, run.projectId);
  if (!["video", "final"].includes(video.kind) || video.status !== "ready" || typeof video.metadata.objectKey !== "string") throw new AppError("视频尚不可读", 409, "VIDEO_UNAVAILABLE");
  return { video: "/api/worker/media/" + video.id + "?version=" + input.sourceVersion, timestamps: input.timestamps, leaseToken: run.leaseToken };
}
const inspectionMetadata = z.object({ duration: z.number().positive().max(86400), width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().nonnegative().nullable(), hasAudio: z.boolean(), timestamps: z.array(z.number().nonnegative()).min(1).max(12) });
export async function completeInspection(store: Store, run: Run, form: FormData, bucket: BlobStore) {
  if (form.get("leaseToken") !== run.leaseToken || run.stage !== "inspecting" || run.status !== "running") throw new AppError("任务已停止", 409, "RUN_STOPPED");
  await assertCurrent(store, run);
  const meta = inspectionMetadata.parse(JSON.parse(String(form.get("metadata"))));
  if (meta.timestamps.some((t) => t >= meta.duration) || new Set(meta.timestamps).size !== meta.timestamps.length) throw new AppError("抽帧时间无效");
  const source = await store.artifact(run.payload.inspection!.sourceId, run.projectId);
  const basename = source.path.split("/").pop()!.replace(/\.[^.]+$/, "");
  const folder = basename + "_v" + source.version + "_检查" + String(await store.inspectionSequence(run)).padStart(2, "0");
  const frames: (AgentImage & { timestamp: number })[] = [], prepared: { frame: File; image: AgentImage & { timestamp: number } }[] = [];
  for (const [i, timestamp] of meta.timestamps.entries()) {
    const frame = form.get("frame" + i);
    if (!(frame instanceof File) || frame.type !== "image/jpeg" || !frame.size || frame.size > 2 * 1024 * 1024) throw new AppError("视频帧文件无效");
    const size = imageSize(new Uint8Array(await frame.arrayBuffer()));
    if (size.type !== "jpg" || !size.width || !size.height || size.width > 1280 || size.height > 1280) throw new AppError("视频帧尺寸无效");
    const id = uid(), image = { id, version: 1, path: "/03_图片/检查/" + folder + "/" + String(i + 1).padStart(2, "0") + "_" + timestamp.toFixed(3) + "s.jpg", objectKey: run.projectId + "/inspection/" + run.id + "/" + id, mediaType: "image/jpeg", bytes: frame.size, width: size.width, height: size.height, timestamp };
    prepared.push({ frame, image }); frames.push(image);
  }
  for (const { frame, image } of prepared) {
    await assertCurrent(store, run);
    await bucket.put(image.objectKey, frame.stream(), { httpMetadata: { contentType: image.mediaType } });
  }
  const { timestamps: _, ...metadata } = meta;
  return store.finishInspection(run, { source: { id: source.id, path: source.path, version: source.version }, ...metadata, frames,
    limitation: "已读取抽取点附近的视频帧，时间标记为请求秒数；没有听取音频或完整播放视频，不能据此确认口型、语音或全部连续动作。" });
}
