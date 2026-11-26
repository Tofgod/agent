import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { mediaCommand, downloadMedia, mediaError } from "./media-process.mjs";
export async function inspectVideo(plan, options) {
  const { signal, onProgress = async () => {}, onOutput = async () => {} } = options;
  await mkdir(".studio-runtime/inspections", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".studio-runtime/inspections/job-"));
  try {
    await downloadMedia(plan.video, path.join(cwd, "source"), options);
    const probe = JSON.parse(await mediaCommand(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-show_entries", "format=duration:stream=codec_type,width,height,avg_frame_rate", "-of", "json", "source"], cwd, signal));
    const video = probe.streams?.find((s) => s.codec_type === "video"), duration = Number(probe.format?.duration);
    if (!video || !Number.isFinite(duration) || duration <= 0) throw mediaError("视频内容无效", "INVALID_VIDEO");
    const timestamps = plan.timestamps?.length ? [...new Set(plan.timestamps)].sort((a, b) => a - b) : Array.from({ length: 6 }, (_, i) => duration * (i + 0.5) / 6);
    if (timestamps.length > 12 || timestamps.some((t) => !Number.isFinite(t) || t < 0 || t >= duration)) throw mediaError("抽帧时间必须在视频时长内，最多 12 帧", "INVALID_TIMESTAMPS");
    const frames = [];
    for (const [index, timestamp] of timestamps.entries()) {
      await onProgress(10 + index / timestamps.length * 80, "正在读取视频画面 " + (index + 1) + "/" + timestamps.length);
      const name = "frame-" + index + ".jpg";
      await mediaCommand(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", String(timestamp), "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-i", "source", "-frames:v", "1", "-vf", "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease", "-q:v", "3", "-threads", "1", name], cwd, signal);
      frames.push({ timestamp, file: new File([await readFile(path.join(cwd, name))], name, { type: "image/jpeg" }) });
    }
    await onOutput("已提取 " + frames.length + " 帧 · 原视频 " + video.width + "×" + video.height + " · " + duration.toFixed(2) + " 秒");
    const [numerator, denominator] = String(video.avg_frame_rate).split("/").map(Number), fps = denominator ? numerator / denominator : null;
    return { duration, width: video.width, height: video.height, fps: Number.isFinite(fps) ? fps : null, hasAudio: probe.streams.some((s) => s.codec_type === "audio"), frames };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
