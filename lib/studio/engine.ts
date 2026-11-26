import type { BlobStore } from "./storage";
import { fetchWithoutRedirect } from "./http";
import type { Store } from "./store";
import { now, uid } from "./store";
import type { Artifact, Project, ProviderSettings, Run, VideoReferences } from "./types";
import { AppError } from "./security";
import { submitImage, submitVideo, queryMediaTask, imageProvider, mediaBaseUrl, requireMedia, videoProvider, videoTaskOutput, MediaRequestError, type MediaResult, type AgentFunction } from "./providers";
import { advanceAgent } from "./agent";
import { childModelSettings } from "./child-execution";
import { applyToolSettings } from "./tool-registry";
import { productionFinished } from "./agent-state";
import { failRun } from "./jobs";
import { generatedImage } from "./images";
import { isVideoReferenceUrl, videoRequestOptions } from "./video-input";

async function assertLease(store: Store, run: Run) {
  const current = await store.run(run.id, run.projectId);
  if (["paused", "cancelled"].includes(current.status) || current.leaseToken !== run.leaseToken)
    throw new AppError("任务已停止", 409, "RUN_STOPPED");
}

export async function assertCurrent(store: Store, run: Run) {
  await assertLease(store, run);
  if (run.payload.operation?.referenceVersions) return;
  for (const [id, version] of Object.entries(run.payload.sourceVersions)) {
    const artifact = await store.artifact(id, run.projectId);
    if (artifact.version !== version) throw new AppError("源文件已修改，旧任务已停止以保留你的修改。请基于新版本继续。", 409, "SOURCE_CHANGED");
  }
}

function bytesToB64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(out);
}
async function referenceUri(file: Artifact, bucket: BlobStore, maxBytes = 15 * 1024 * 1024, fallbackType = "image/png"): Promise<string | null> {
  const key = file.metadata.objectKey;
  if (typeof key === "string") {
    const object = await bucket.get(key);
    if (object && object.size <= maxBytes)
      return "data:" + (object.contentType || fallbackType) + ";base64," + bytesToB64(await object.arrayBuffer());
  }
  return typeof file.metadata.providerUrl === "string" ? file.metadata.providerUrl : null;
}
async function pendingMedia(store: Store, bucket: BlobStore, run: Run, settings: ProviderSettings): Promise<Artifact | null> {
  await assertLease(store, run);
  const { operation, pendingArtifactId, pendingArtifactVersion, submissionId } = run.payload;
  const old = pendingArtifactId ? await store.artifact(pendingArtifactId, run.projectId)
    : (await store.artifacts(run.projectId)).find((file) => file.path === operation?.path);
  if (!operation && !old) throw new AppError("缺少原生成任务的输出文件", 409, "MEDIA_RESPONSE_INVALID");
  const path = operation?.path ?? old!.path;
  const kind = operation ? operation.name === "generate_image" ? "image" : "video" : old!.kind;
  if (submissionId && old?.status === "ready" && old.metadata.submissionId === submissionId) return old;
  if (old && old.path !== path || (old?.version ?? 0) !== (pendingArtifactVersion ?? old?.version ?? 0))
    throw new AppError("目标文件已有新版本，生成结果未覆盖你的修改", 409, "VERSION_CONFLICT");
  if (!run.payload.outputUrl) {
    if (!run.payload.mediaProvider || !run.payload.providerTaskId)
      throw new AppError("缺少生成服务记录，请核对供应商任务", 409, "MEDIA_RESPONSE_INVALID");
    const task = await queryMediaTask(settings, run.payload.mediaProvider, run.payload.providerTaskId, run.payload.providerBaseUrl);
    if (task.status === "failed" || task.status === "cancelled") {
      if (old?.status === "generating") await store.putArtifact(run.projectId, {
        path, kind, content: old.content, status: "failed", metadata: old.metadata, expectedVersion: old.version, expectedArtifactId: old.id, lease: run,
      });
      throw new AppError("生成失败：" + task.error, 502, "PROVIDER_TASK_FAILED");
    }
    if (task.status !== "succeeded") {
      await store.updateRun(run, { status: "waiting", nextAttemptAt: Date.now() + 10000, label: "视频 · 供应商" + (task.status === "queued" ? "排队中" : "生成中") });
      return null;
    }
    const updated = await store.updateRun(run, { payload: { ...run.payload, ...videoTaskOutput(task) }, leaseUntil: run.leaseUntil });
    if (updated.leaseToken !== run.leaseToken) throw new AppError("任务已停止", 409, "RUN_STOPPED");
    run = updated;
  }
  await assertLease(store, run);
  const url = run.payload.outputUrl;
  if (!url || new URL(url).protocol !== "https:") throw new AppError("生成服务返回了无效素材地址", 502, "MEDIA_RESPONSE_INVALID");
  const response = await fetchWithoutRedirect(url, { signal: AbortSignal.timeout(90000) }).catch(() => {
    throw new AppError("下载生成素材失败", 502, "MEDIA_DOWNLOAD_FAILED");
  });
  if (!response.ok || !response.body) throw new AppError("保存生成素材失败，可重试下载", 502, "MEDIA_DOWNLOAD_FAILED");
  const contentType = response.headers.get("Content-Type");
  const mime = contentType?.split(";")[0].trim().toLowerCase();
  const imageFormat = /\.jpe?g$/i.test(path) ? "jpeg" : "png";
  const videoType = /\.mov$/i.test(path) ? "video/quicktime" : "video/mp4";
  const prepared = kind === "image" && (run.payload.mediaProvider === "aiclub" || (mime && mime !== "image/" + imageFormat))
    ? await generatedImage(response.body, imageFormat) : undefined;
  const gatewayVideo = kind === "video" && run.payload.mediaProvider === "aiclub";
  if (gatewayVideo && mime && ![videoType, "application/octet-stream"].includes(mime)) {
    await response.body.cancel().catch(() => {});
    throw new AppError("下载地址未返回请求的视频格式，可重试下载原结果", 502, "MEDIA_DOWNLOAD_FAILED");
  }
  const type = kind === "image" ? "image/" + imageFormat : videoType;
  const objectKey = run.projectId + "/generated/" + uid();
  await bucket.put(objectKey, prepared?.data ?? response.body, { httpMetadata: { contentType: type } });
  await assertLease(store, run);
  return store.putArtifact(run.projectId, {
    path, kind, content: "", serveMedia: true, expectedVersion: old?.version ?? 0, expectedArtifactId: old?.id, lease: run,
    metadata: { ...(operation ? {} : old?.metadata), objectKey, providerUrl: url, contentType: type, generatedAt: now(),
      provider: run.payload.mediaProvider, model: run.payload.providerModel, providerBaseUrl: run.payload.providerBaseUrl, providerTaskId: run.payload.providerTaskId,
      providerRequestId: run.payload.providerRequestId, submissionId,
      ...(prepared ? { width: prepared.info.width, height: prepared.info.height } : {}),
      ...(kind === "image" ? { requestedSize: operation?.imageOptions?.size, generationOptions: operation?.imageOptions } : {
        draft: operation?.videoOptions?.draft, requestedRatio: operation?.ratio, requestedResolution: operation?.videoOptions?.resolution,
        generationOptions: operation?.videoOptions, ratio: run.payload.outputRatio, resolution: run.payload.outputResolution, fps: run.payload.outputFps,
      }),
      sourceVersions: run.payload.sourceVersions, prompt: operation?.prompt ?? old?.metadata.prompt,
      duration: run.payload.outputDuration ?? (operation?.duration === -1 ? undefined : operation?.duration ?? old?.metadata.duration), dialogue: operation?.dialogue ?? old?.metadata.dialogue },
  });
}

async function saveLastFrame(store: Store, bucket: BlobStore, run: Run, video: Artifact) {
  const completed = await store.run(run.id, run.projectId);
  const url = completed.payload.outputLastFrameUrl;
  if (!url) return { warning: "供应商未返回尾帧，视频已保存" };
  await assertLease(store, run);
  const stem = video.path.split("/").pop()!.replace(/\.[^.]+$/, "");
  const path = "/03_图片/尾帧/" + Array.from(stem).slice(0, 48).join("") + "_" + run.id + "_尾帧.jpg";
  const previous = (await store.artifacts(run.projectId)).find((file) => file.path === path);
  if (previous && previous.metadata.submissionId !== completed.payload.submissionId)
    throw new AppError("尾帧路径已有其他文件，视频已保存", 409, "VERSION_CONFLICT");
  if (previous) return { last_frame: { id: previous.id, path: previous.path, version: previous.version } };
  const response = await fetchWithoutRedirect(url, { signal: AbortSignal.timeout(90000) }).catch(() => null);
  if (!response?.ok || !response.body) throw new AppError("尾帧下载失败，可重试下载原结果", 502, "MEDIA_DOWNLOAD_FAILED");
  const image = await generatedImage(response.body, "jpeg");
  const objectKey = run.projectId + "/generated/" + uid();
  await bucket.put(objectKey, image.data, { httpMetadata: { contentType: "image/jpeg" } });
  await assertLease(store, run);
  const frame = await store.putArtifact(run.projectId, { path, kind: "image", content: "", serveMedia: true, expectedVersion: 0, lease: run,
    metadata: { objectKey, contentType: "image/jpeg", width: image.info.width, height: image.info.height,
      submissionId: completed.payload.submissionId, sourceVersions: { [video.id]: video.version } } });
  return { last_frame: { id: frame.id, path: frame.path, version: frame.version } };
}

function clearPending(run: Run) {
  return { ...run.payload, providerTaskId: undefined, outputUrl: undefined, outputDuration: undefined, mediaProvider: undefined, providerModel: undefined, providerBaseUrl: undefined, providerRequestId: undefined,
    outputLastFrameUrl: undefined, outputRatio: undefined, outputResolution: undefined, outputFps: undefined,
    pendingArtifactId: undefined, pendingArtifactVersion: undefined, pendingType: undefined, submissionId: undefined, submittedAt: undefined, submissionUnknown: false };
}
async function submitPending(store: Store, run: Run, submit: () => Promise<MediaResult>, submissionId: string, path: string) {
  let result: MediaResult;
  try { result = await submit(); }
  catch (error) {
    if (error instanceof MediaRequestError && error.submissionRejected) {
      await store.rejectMediaSubmission(run, submissionId);
    }
    throw error;
  }
  const attached = await store.attachMediaResult(run, submissionId, result, path.split("/").pop() + (result.outputUrl ? " · 等待保存" : " · 生成中"));
  if (!attached) await store.event(run.projectId, "unattached_media", { runId: run.id, submissionId, ...result }).run();
}
async function mediaToolStep(store: Store, bucket: BlobStore, project: Project, run: Run, files: Artifact[], currentSettings: ProviderSettings) {
  const operation = run.payload.operation;
  if (!operation) throw new AppError("缺少媒体工具调用", 409);
  const image = operation.name === "generate_image";
  const imageModel = operation.imageModel ?? currentSettings.imageModel, videoModel = operation.videoModel ?? currentSettings.videoModel;
  const provider = image ? imageProvider(imageModel) : videoProvider(videoModel);
  const settings = applyToolSettings(currentSettings, {
    imageModel, videoModel,
    ...(operation.mediaBaseUrl && provider === "volcengine" ? { arkBaseUrl: operation.mediaBaseUrl } : {}),
    ...(operation.mediaBaseUrl && provider === "minimax" ? { minimaxBaseUrl: operation.mediaBaseUrl } : {}),
  });
  if (run.payload.providerTaskId || run.payload.outputUrl) {
    const file = await pendingMedia(store, bucket, run, settings);
    if (!file) return;
    const result = { id: file.id, path: file.path, version: file.version, status: file.status,
      ...(operation.videoOptions?.return_last_frame ? await saveLastFrame(store, bucket, run, file) : {}),
      ...(file.metadata.resolution ? { resolution: file.metadata.resolution } : {}), ...(file.metadata.ratio ? { ratio: file.metadata.ratio } : {}),
      ...(file.metadata.duration ? { duration: file.metadata.duration } : {}) };
    const payload = productionFinished(clearPending(run), result, file.id);
    await store.updateRun(run, run.payload.agent ? { status: "queued", stage: "agent", progress: 0, label: "继续创作", payload } :
      { status: "done", stage: "done", progress: 100, label: "素材已保存", resultText: JSON.stringify(result), payload });
    if (run.parentRunId) await store.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=? AND status IN ('queued','waiting')").bind(run.parentRunId).run();
    return;
  }
  if (run.payload.submissionUnknown) throw new AppError("本次生成提交结果未知，请先到供应商核对，避免重复计费", 409, "SUBMISSION_UNKNOWN");
  requireMedia(settings, provider);
  const prompt = [operation.prompt, !image && operation.dialogue?.trim() ? "对白：" + operation.dialogue : undefined].filter(Boolean).join("\n");
  const video = operation.videoReferences ?? { first: operation.imagePath };
  if (!image) videoRequestOptions(settings.videoModel, prompt, video, operation.duration, operation.ratio,
    project.ratio, operation.videoOptions, operation.draftTaskId);
  const sources: Record<string, number> = operation.draftTaskId ? { ...run.payload.sourceVersions } : {};
  let bodySize = 0;
  const includeReference = (uri: string) => {
    bodySize += uri.length;
    if (bodySize > 60_000_000) throw new AppError("参考素材总体积过大，请压缩后重试", 409);
    return uri;
  };
  const resolve = async (path: string, kind: "image" | "video" | "audio") => {
    const pinned = operation.referenceVersions?.find((entry) => entry.path === path && (entry.kind === kind || kind === "video" && entry.kind === "final"));
    const file = operation.referenceVersions
      ? pinned && await store.artifactVersion(project.id, pinned.id, pinned.version)
      : files.find((entry) => entry.path === path && (entry.kind === kind || kind === "video" && entry.kind === "final") && entry.status === "ready");
    if (!file || file.status !== "ready") throw new AppError("缺少可用参考素材：" + path, 409, "REFERENCE_UNAVAILABLE");
    let uri: string | null;
    if (kind === "video") {
      const remote = typeof file.metadata.providerUrl === "string" ? file.metadata.providerUrl : file.url;
      if (!isVideoReferenceUrl(remote)) throw new AppError("参考视频需要供应商可访问的公网地址：" + path, 409, "REFERENCE_UNAVAILABLE");
      uri = remote;
    } else {
      const limit = provider === "aiclub" ? (image ? 10_000_000 : kind === "image" ? 29_999_999 : 15_000_000) : undefined;
      const audioType = /\.mp3$/i.test(path) ? "audio/mpeg" : /\.wav$/i.test(path) ? "audio/wav" : undefined;
      if (kind === "audio" && !audioType) throw new AppError("视频参考音频使用 WAV 或 MP3：" + path, 409, "REFERENCE_UNAVAILABLE");
      uri = await referenceUri(file, bucket, limit, kind === "audio" ? audioType : undefined);
    }
    if (!uri) throw new AppError("参考素材无法读取或超过接口大小限制：" + path, 409, "REFERENCE_UNAVAILABLE");
    sources[file.id] = file.version;
    return includeReference(uri);
  };
  const resolveList = async (paths: string[] | undefined, kind: "image" | "video" | "audio") => {
    const result: string[] = [];
    for (const path of paths ?? []) result.push(await resolve(path, kind));
    return result;
  };
  const resolveVideos = async () => {
    const urls: string[] = [];
    for (const [index, reference] of (video.videos ?? []).entries()) {
      if (typeof reference === "string" || reference.type === "project_file") {
        urls.push(await resolve(typeof reference === "string" ? reference : reference.path, "video"));
      } else {
        if (!isVideoReferenceUrl(reference.url))
          throw new AppError("第 " + (index + 1) + " 个参考视频需要公网 HTTPS 地址", 400, "INVALID_REFERENCE_VIDEO_URL");
        // Preserve the original string, including the encoding and order of signed query parameters.
        urls.push(includeReference(reference.url));
      }
    }
    return urls;
  };
  const refs = image ? (await resolveList(operation.references, "image")).map((uri, i) => ({ uri, tag: operation.references![i] })) : [];
  const videoInput: VideoReferences = image ? {} : {
    first: video.first ? await resolve(video.first, "image") : undefined,
    last: video.last ? await resolve(video.last, "image") : undefined,
    images: await resolveList(video.images, "image"), videos: await resolveVideos(), audio: await resolveList(video.audio, "audio"),
  };
  const imageRatio = operation.ratio && operation.ratio !== "adaptive" ? operation.ratio : project.ratio;
  const videoRatio = operation.draftTaskId ? undefined : operation.ratio ?? project.ratio;
  const submit = image ? () => submitImage(settings, prompt, imageRatio, refs, operation.imageOptions) :
    () => submitVideo(settings, prompt, videoInput, videoRatio, operation.duration, operation.generateAudio, operation.videoOptions, operation.draftTaskId);
  await assertCurrent(store, { ...run, payload: { ...run.payload, sourceVersions: sources } });
  const old = files.find((f) => f.path === operation.path);
  if (old?.locked) throw new AppError("目标文件已锁定，请先解锁", 409, "ARTIFACT_LOCKED");
  const submissionId = uid();
  const submitting = await store.updateRun(run, { status: "running", label: image ? "提交图片生成" : "提交视频生成", leaseUntil: run.leaseUntil,
    payload: { ...run.payload, sourceVersions: sources, pendingArtifactId: old?.id, pendingArtifactVersion: old?.version ?? 0, pendingType: image ? "image" : "video", submissionId, submissionUnknown: true,
      mediaProvider: provider, providerModel: image ? settings.imageModel : settings.videoModel, providerBaseUrl: mediaBaseUrl(settings, provider), submittedAt: now() } });
  if (["paused", "cancelled"].includes(submitting.status) || submitting.leaseToken !== run.leaseToken) return;
  await submitPending(store, submitting, submit, submissionId, operation.path);
}
/** Historical batch jobs may collect one acknowledged result, without scheduling further work. */
async function recoverRetiredMedia(store: Store, bucket: BlobStore, run: Run, settings: ProviderSettings) {
  const file = await pendingMedia(store, bucket, run, settings);
  if (!file) return;
  const result = { id: file.id, path: file.path, version: file.version, status: file.status };
  await store.updateRun(run, {
    status: "done", stage: "done", progress: 100, label: "已保存原生成结果",
    resultText: JSON.stringify(result), payload: clearPending(run),
  });
  if (run.parentRunId) await store.wakeForChildResult(run.parentRunId, run.projectId);
}

export async function advanceRun(store: Store, project: Project, runId: string, settings: ProviderSettings, bucket?: BlobStore,
  agentOverride?: AgentFunction, liveSettings?: () => Promise<ProviderSettings>) {
  if (!await store.claimRun(runId, project.id)) return store.run(runId, project.id);
  const run = await store.run(runId, project.id);
  let releasePlugins: (() => Promise<void>) | undefined;
  try {
    if (run.stage === "agent" || run.stage === "maintenance") {
      const sessionId = run.sessionId ?? "";
      const pluginScope = store.presetPlugins && await store.presetPlugins.acquire((await store.jobContext(run.id)).userId,
        run.payload.childExecution?.preset ?? store.presets.get(project.id, sessionId),
        { projectId: project.id, sessionId, runId: run.parentRunId ? run.id : undefined });
      releasePlugins = pluginScope?.release;
      await advanceAgent({ store, project, run, pluginScope, settings: childModelSettings(run, settings), bucket, model: agentOverride, liveSettings, ensureCurrent: () => assertCurrent(store, run) });
    } else if (run.stage === "media") {
      if (!bucket) throw new AppError("素材存储未配置", 503);
      if (!run.payload.providerTaskId && !run.payload.outputUrl) await assertCurrent(store, run);
      await mediaToolStep(store, bucket, project, run, await store.artifacts(project.id), settings);
    } else if (!["composing", "inspecting"].includes(run.stage)) {
      if (run.payload.pendingArtifactId && (run.payload.providerTaskId || run.payload.outputUrl)) {
        if (!bucket) throw new AppError("素材存储未配置", 503);
        await recoverRetiredMedia(store, bucket, run, settings);
      } else if (run.payload.submissionUnknown) {
        throw new AppError("原生成任务的提交结果未知，请到供应商核对", 409, "SUBMISSION_UNKNOWN");
      } else {
        throw new AppError("旧制作流程已停用。已有文件可继续使用，请在聊天中说明要处理的内容。", 409, "WORKFLOW_RETIRED");
      }
    }
    const current = await store.run(run.id, project.id);
    if (current.leaseToken === run.leaseToken && current.status !== "failed" && (current.attempts || current.error))
      await store.updateRun(current, { attempts: 0, error: null, errorCode: current.status === "done" ? current.errorCode : null, nextAttemptAt: current.nextAttemptAt });
  } catch (error) {
    if (error instanceof AppError && error.code === "AGENT_STEER") {
      const current = await store.run(runId, project.id);
      if (current.leaseToken === run.leaseToken && !["paused", "cancelled"].includes(current.status))
        await store.updateRun(current, { status: "queued", label: "处理新消息", nextAttemptAt: 0 });
    } else if (!(error instanceof AppError && error.code === "RUN_STOPPED")) {
      await failRun(store, run, error);
    }
  } finally {
    try { await store.releaseLease(run); } finally { await releasePlugins?.(); }
  }
  return store.run(runId, project.id);
}
