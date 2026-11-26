import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
const base = "http://127.0.0.1:" + (process.env.STUDIO_TEST_PORT || "5179");
mkdirSync(".studio-runtime/media-check", { recursive: true });
async function api(path: string, body?: unknown, method = body ? "POST" : "GET") {
  const r = await fetch(base + "/api/studio" + path, {
    method, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(path + " " + r.status + " " + await r.text());
  return r.json() as Promise<Record<string, unknown>>;
}
async function verifyBackground(projectId: string, runId: string) {
  const started = Date.now();
  while (Date.now() - started < 90000) {
    const snapshot = await api("/projects/" + projectId) as { artifacts: Record<string, unknown>[]; runs: { id: string; status: string; error?: string }[] };
    const run = snapshot.runs.find((r) => r.id === runId)!;
    if (run.status === "failed") throw new Error(run.error);
    if (run.status === "done") {
      const final = snapshot.artifacts.find((a) => a.kind === "final")!;
      if (!final?.url || final.version !== 1) throw new Error("Final artifact missing or duplicated");
      const response = await fetch(base + String(final.url));
      const output = ".studio-runtime/media-check/background-final.mp4";
      writeFileSync(output, new Uint8Array(await response.arrayBuffer()));
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height", "-of", "json", output], { encoding: "utf8" });
      const info = JSON.parse(probe.stdout);
      if (Math.abs(Number(info.format.duration) - 15) > 0.15 || !info.streams.some((s: { codec_name: string; width: number; height: number }) => s.codec_name === "h264" && s.width === 1280 && s.height === 720)) throw new Error("Invalid composed MP4");
      console.log(JSON.stringify({ ok: true, background: true, projectId, runId, finalVersion: final.version, ...info })); return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("Background task did not complete");
}
if (process.argv.includes("--resume")) {
  const context = JSON.parse(readFileSync(".studio-runtime/media-check/restart-context.json", "utf8"));
  const snapshot = await api("/projects/" + context.projectId) as { runs: { id: string; status: string }[] };
  if (snapshot.runs.find((r) => r.id === context.runId)?.status !== "paused") throw new Error("Paused task did not survive restart");
  await api("/projects/" + context.projectId + "/runs/" + context.runId, { action: "resume" }, "PATCH");
  await verifyBackground(context.projectId, context.runId); process.exit(0);
}
const project = await api("/projects", { title: "后台制作检查", brief: "开发检查：无浏览器后台制作、进程重启后继续、实际 MP4 合成。", style: "黑白测试图形", duration: 15, ratio: "16:9" });
const id = String(project.id), t = new Date().toISOString();
const imagePath = ".studio-runtime/media-check/预览检查.png", videoPath = ".studio-runtime/media-check/clip.mp4";
const image = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=white:s=640x360", "-vf", "drawbox=x=180:y=80:w=280:h=200:color=black:t=3", "-frames:v", "1", imagePath], { encoding: "utf8" });
if (image.status !== 0) throw new Error(image.stderr);
const video = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=white:s=640x360:r=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-vf", "drawbox=x=180:y=80:w=280:h=200:color=black:t=3", "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", videoPath], { encoding: "utf8" });
if (video.status !== 0) throw new Error(video.stderr);
const uploaded: Record<string, unknown>[] = [];
for (const [name, file, type] of [["预览检查.png", imagePath, "image/png"], ["QA_01.mp4", videoPath, "video/mp4"], ["QA_02.mp4", videoPath, "video/mp4"]]) {
  const form = new FormData();
  form.set("file", new File([readFileSync(file)], name, { type }));
  const response = await fetch(base + "/api/studio/projects/" + id + "/upload", { method: "POST", body: form });
  if (!response.ok) throw new Error(await response.text());
  const artifact = await response.json() as Record<string, unknown>;
  uploaded.push(artifact);
  const media = await fetch(base + String(artifact.url));
  if (!media.ok || (await media.arrayBuffer()).byteLength === 0) throw new Error("Saved media not readable");
}
writeFileSync(".studio-runtime/media-check/result.json", JSON.stringify({ projectId: id, artifacts: uploaded.map((a) => ({ id: a.id, path: a.path })) }, null, 2));
console.log(JSON.stringify({ ok: true, projectId: id, mediaPaths: uploaded.map((a) => a.path) }));
if (process.argv.includes("--background")) {
  // Enqueue an explicit generic composition fixture without requesting any model or paid media API.
  const run = { id: crypto.randomUUID() }, clips = uploaded.filter((artifact) => artifact.kind === "video");
  const payload = { instruction: "合成测试片段",
    sourceVersions: Object.fromEntries(clips.map((artifact) => [String(artifact.id), Number(artifact.version)])),
    operation: { name: "compose_video", path: "/07_成片/后台检查.mp4", toolCallId: "local-fixture" },
    composition: { ratio: "16:9", shots: clips.map((artifact, index) => ({ id: "clip-" + index, videoId: artifact.id, duration: index ? 8 : 7, dialogue: index ? "" : "后台合成字幕检查。" })) } };
  const database = new DatabaseSync(path.join(process.env.STUDIO_DATA_DIR || "data", "studio.sqlite"));
  try {
    database.prepare("INSERT INTO runs(id,project_id,intent,status,stage,progress,label,payload,lease_until,lease_token,created_at,updated_at,agent_role,generation,input_version) VALUES(?,?,'agent',?,'composing',0,'准备合成',?,0,'',?,?,'media',1,1)")
      .run(run.id, id, process.argv.includes("--pause-for-restart") ? "paused" : "queued", JSON.stringify(payload), t, t);
  } finally { database.close(); }
  if (process.argv.includes("--pause-for-restart")) {
    writeFileSync(".studio-runtime/media-check/restart-context.json", JSON.stringify({ projectId: id, runId: run.id }));
    console.log(JSON.stringify({ ok: true, pausedForRestart: true, projectId: id, runId: run.id }));
  } else await verifyBackground(id, run.id);
}
