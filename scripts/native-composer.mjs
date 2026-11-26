import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { mediaCommand as command, downloadMedia } from "./media-process.mjs";
import path from "node:path";

function composeError(message, code = "COMPOSE_ERROR") { const error = new Error(message); error.code = code; return error; }
const timestamp = (seconds) => {
  const ms = Math.round(seconds * 1000);
  return [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60].map((v) => String(v).padStart(2, "0")).join(":") + "," + String(ms % 1000).padStart(3, "0");
};
export async function composeVideo(plan, { baseUrl, token, signal, fetchImpl = fetch, onProgress = async () => {}, onOutput = async () => {} }) {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", ffprobe = process.env.FFPROBE_PATH || "ffprobe";
  await mkdir(".studio-runtime/compositions", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".studio-runtime/compositions/job-"));
  async function download(uri, name) {
    await downloadMedia(uri, path.join(cwd, name), { baseUrl, token, signal, fetchImpl });
  }
  async function probe(name) {
    return JSON.parse(await command(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", name], cwd, signal));
  }
  try {
    await command(ffmpeg, ["-version"], cwd, signal);
    const { width, height, fps } = plan.output ?? { width: plan.project.ratio === "16:9" ? 1280 : 720, height: plan.project.ratio === "16:9" ? 720 : 1280, fps: 24 };
    const clips = [];
    for (let i = 0; i < plan.shots.length; i++) {
      signal?.throwIfAborted();
      const shot = plan.shots[i], video = "source" + i + ".mp4", audio = "speech" + i + ".mp3", clip = "clip" + i + ".mp4";
      await onProgress(95 + i / plan.shots.length * 3, "正在合成 " + (i + 1) + "/" + plan.shots.length);
      await download(shot.video, video);
      const source = await probe(video);
      if (!Number.isFinite(Number(source.format?.duration)) || !source.streams?.some((s) => s.codec_type === "video")) throw composeError("镜头 " + shot.id + " 的视频无效", "INVALID_VIDEO");
      if (Number(source.format?.duration) + 0.12 < shot.duration) throw composeError("镜头 " + shot.id + " 视频不足 " + shot.duration + "秒，请重新生成或调整分镜", "CLIP_TOO_SHORT");
      const hasSourceAudio = source.streams.some((s) => s.codec_type === "audio");
      const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", video];
      let audioIndex = 0;
      if (shot.audio) {
        await download(shot.audio, audio);
        const speech = await probe(audio);
        if (!Number.isFinite(Number(speech.format?.duration)) || !speech.streams?.some((s) => s.codec_type === "audio")) throw composeError("镜头 " + shot.id + " 的音频无效", "INVALID_AUDIO");
        if (Number(speech.format?.duration) > shot.duration + 0.25) throw composeError("镜头 " + shot.id + " 的配音超过镜头时长，请调整分镜或重新配音", "SPEECH_TOO_LONG");
        args.push("-i", audio); audioIndex = 1;
      } else if (!hasSourceAudio) {
        if (shot.dialogue.trim()) throw composeError("镜头 " + shot.id + " 有台词但缺少音轨，请重新生成或上传配音", "MISSING_AUDIO");
        args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"); audioIndex = 1;
      }
      let filter = "scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease:force_divisible_by=2,pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2,setsar=1,fps=" + fps;
      if (shot.dialogue.trim()) {
        const subtitle = "subtitle" + i + ".srt";
        await writeFile(path.join(cwd, subtitle), "1\n00:00:00,000 --> " + timestamp(shot.duration) + "\n" + shot.dialogue.trim() + "\n");
        filter += ",subtitles=filename=" + subtitle + ":force_style='Fontsize=22,Outline=2,Shadow=0,MarginV=25'";
      }
      args.push("-map", "0:v:0", "-map", audioIndex + ":a:0", "-vf", filter, "-af", "apad", "-t", String(shot.duration),
        "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-threads", "2", "-filter_threads", "1",
        "-c:a", "aac", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", clip);
      await command(ffmpeg, args, cwd, signal); clips.push(clip);
      await onOutput("已合成镜头 " + (i + 1) + " · " + shot.duration + " 秒");
    }
    await onProgress(99, "正在封装成片");
    await writeFile(path.join(cwd, "clips.txt"), clips.map((name) => "file '" + name + "'").join("\n"));
    await command(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", "clips.txt", "-c", "copy", "-movflags", "+faststart", "final.mp4"], cwd, signal);
    const final = await probe("final.mp4"), expected = plan.shots.reduce((time, s) => time + s.duration, 0);
    if (!Number.isFinite(Number(final.format?.duration)) || Math.abs(Number(final.format.duration) - expected) > 0.15 + plan.shots.length * 0.05) throw composeError("成片时长与分镜不符", "DURATION_MISMATCH");
    return new File([await readFile(path.join(cwd, "final.mp4"))], plan.project.title.replace(/[\/\\]/g, "_") + ".mp4", { type: "video/mp4" });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
