import test from "node:test";
import assert from "node:assert/strict";
import { createLocalWorker } from "../scripts/local-worker.mjs";
const baseUrl = "http://127.0.0.1:5179", token = "test-token";

test("background driver runs with no browser and limits concurrent jobs", async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; }), calls = [];
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.Authorization, "Bearer " + token);
    const path = new URL(url).pathname;
    if (path === "/api/worker/jobs") return Response.json({ jobs: [1, 2, 3].map((id) => ({ id: String(id), stage: "writing" })) });
    calls.push(path); await barrier; return Response.json({ status: "done" });
  };
  const worker = createLocalWorker({ baseUrl, token, fetchImpl, concurrency: 2 });
  await worker.tick(); assert.equal(worker.activeCount(), 2);
  await worker.tick(); assert.equal(calls.length, 2);
  release(); await worker.idle(); assert.equal(worker.activeCount(), 0);
});
test("background composition saves MP4 and releases its lease", async () => {
  const paths = [], plan = { leaseToken: "owned-lease", previousVersion: 1, previousArtifactId: "existing-final" };
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname; paths.push(path);
    if (path.endsWith("/jobs")) return Response.json({ jobs: [{ id: "job", stage: "composing" }] });
    if (path.endsWith("/compose")) return Response.json(plan);
    if (path.endsWith("/complete")) {
      assert.equal(init.body.get("leaseToken"), "owned-lease");
      assert.equal(init.body.get("previousVersion"), "1");
      assert.equal(init.body.get("previousArtifactId"), "existing-final");
      assert.equal(init.body.get("file").type, "video/mp4");
    }
    return Response.json({ ok: true });
  };
  const worker = createLocalWorker({ baseUrl, token, fetchImpl, compose: async (_, { onProgress }) => {
    await onProgress(98, "合成 1/1"); return new File(["fixture"], "final.mp4", { type: "video/mp4" });
  } });
  await worker.tick(); await worker.idle();
  assert.ok(paths.includes("/api/worker/jobs/job/heartbeat")); assert.ok(paths.includes("/api/worker/jobs/job/complete"));
  assert.equal(paths.at(-1), "/api/worker/jobs/job/release");
});
test("long media requests cannot occupy the slot reserved for new chat instructions", async () => {
  let release, listCalls = 0; const barrier = new Promise((resolve) => { release = resolve; }), calls = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/worker/jobs") return Response.json({ jobs: ++listCalls === 1 ? [1, 2, 3].map((id) => ({ id: "media" + id, stage: "media", interactive: false })) : [{ id: "main", stage: "agent", interactive: true }, { id: "other-main", stage: "agent", interactive: true }] });
    calls.push(path); await barrier; return Response.json({ status: "done" });
  };
  const worker = createLocalWorker({ baseUrl, token, fetchImpl, concurrency: 2 });
  await worker.tick(); assert.equal(worker.activeCount(), 2);
  await worker.tick(); assert.equal(worker.activeCount(), 3);
  assert.ok(calls.includes("/api/worker/jobs/main/advance")); assert.ok(!calls.includes("/api/worker/jobs/other-main/advance"));
  release(); await worker.idle(); assert.equal(worker.activeCount(), 0);
});
test("background driver never sends local credentials to an external origin", () => {
  for (const url of ["https://example.com", "http://example.com", "https://localhost"]) assert.throws(() => createLocalWorker({ baseUrl: url, token }));
});

test("cancelled external work is reconciled without advancing or resubmitting generation", async () => {
  const paths = [];
  const worker = createLocalWorker({ baseUrl, token, fetchImpl: async (url) => {
    const path = new URL(url).pathname; paths.push(path);
    return Response.json(path.endsWith("/jobs") ? { jobs: [{ id: "cancelled", stage: "media", cancellation: true }] } : { ok: true });
  } });
  await worker.tick(); await worker.idle(); assert.deepEqual(paths, ["/api/worker/jobs", "/api/worker/jobs/cancelled/cancel-check"]);
});
test("background inspection uploads actual frame files and metadata through its own endpoint", async () => {
  const paths = [];
  const worker = createLocalWorker({ baseUrl, token, fetchImpl: async (url, init) => {
    const path = new URL(url).pathname; paths.push(path);
    if (path.endsWith("/jobs")) return Response.json({ jobs: [{ id: "inspect", stage: "inspecting" }] });
    if (path.endsWith("/inspect")) return Response.json({ leaseToken: "inspection-lease" });
    if (path.endsWith("/inspect-complete")) { assert.equal(init.body.get("frame0").type, "image/jpeg"); assert.deepEqual(JSON.parse(init.body.get("metadata")).timestamps, [1]); assert.equal(init.body.get("leaseToken"), "inspection-lease"); }
    return Response.json({ ok: true });
  }, inspect: async (_, { onProgress }) => { await onProgress(50, "读取画面"); return { duration: 2, width: 160, height: 90, fps: 10, hasAudio: true, frames: [{ timestamp: 1, file: new File(["fixture"], "frame.jpg", { type: "image/jpeg" }) }] }; } });
  await worker.tick(); await worker.idle(); assert.ok(paths.includes("/api/worker/jobs/inspect/inspect-complete")); assert.equal(paths.at(-1), "/api/worker/jobs/inspect/release");
});
test("native inspector extracts distinct real JPEG frames and measured video metadata", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), path = await import("node:path");
  const { mediaCommand, downloadMedia } = await import("../scripts/media-process.mjs"), { inspectVideo } = await import("../scripts/native-inspector.mjs");
  const cwd = await mkdtemp(path.join(tmpdir(), "mujian-inspect-"));
  try {
    await mediaCommand(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=2", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", "sample.mp4"], cwd);
    const bytes = await readFile(path.join(cwd, "sample.mp4")); let requests = 0;
    const options = { baseUrl, token, fetchImpl: async (url, init) => { requests++; assert.equal(new URL(url).origin, baseUrl); assert.equal(init.redirect, "error"); return new Response(bytes); } };
    const result = await inspectVideo({ video: "/api/worker/media/source?version=1", timestamps: [0.2, 1.2] }, options);
    assert.equal(result.hasAudio, true); assert.equal(result.width, 160); assert.equal(result.height, 90); assert.equal(result.fps, 10); assert.ok(Math.abs(result.duration - 2) < 0.1);
    assert.deepEqual(result.frames.map((f) => f.timestamp), [0.2, 1.2]);
    const first = Buffer.from(await result.frames[0].file.arrayBuffer()), second = Buffer.from(await result.frames[1].file.arrayBuffer());
    assert.equal(first.readUInt16BE(0), 0xffd8); assert.notDeepEqual(first, second);
    await assert.rejects(inspectVideo({ video: "/api/worker/media/source", timestamps: [3] }, options), /抽帧时间/);
    await assert.rejects(inspectVideo({ video: "/api/worker/media/source" }, { ...options, fetchImpl: async () => new Response("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,\nclip.ts\n#EXT-X-ENDLIST\n") }), (error) => error.code === "MEDIA_PROCESS_ERROR");
    const before = requests; await assert.rejects(downloadMedia("https://example.com/video", path.join(cwd, "bad"), options), /地址无效/); assert.equal(requests, before);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test("native process cancellation settles only after the child releases its resources", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), path = await import("node:path");
  const { mediaCommand } = await import("../scripts/media-process.mjs"); const cwd = await mkdtemp(path.join(tmpdir(), "mujian-stop-")); const controller = new AbortController();
  try {
    const script = 'process.on("SIGTERM",()=>setTimeout(()=>{require("node:fs").writeFileSync("closed","yes");process.exit(0)},80));require("node:fs").writeFileSync("ready","yes");setInterval(()=>{},100)';
    const command = mediaCommand(process.execPath, ["-e", script], cwd, controller.signal);
    for (let i = 0; i < 100; i++) { if (await readFile(path.join(cwd, "ready")).then(() => true, () => false)) break; await new Promise((r) => setTimeout(r, 10)); }
    controller.abort(new Error("stopped")); await assert.rejects(command, /stopped/); assert.equal(await readFile(path.join(cwd, "closed"), "utf8"), "yes");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("native composition encodes the requested 1080p vertical canvas at 30 fps", async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { mediaCommand } = await import("../scripts/media-process.mjs");
  const { composeVideo } = await import("../scripts/native-composer.mjs");
  const cwd = await mkdtemp(path.join(tmpdir(), "doman-compose-spec-"));
  try {
    await mediaCommand(process.env.FFMPEG_PATH || "ffmpeg",
      ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=162x94:rate=24:duration=1", "-c:v", "libx264", "-threads", "1", "source.mp4"], cwd);
    const source = await readFile(path.join(cwd, "source.mp4"));
    const file = await composeVideo({
      project: { title: "高清竖屏", ratio: "9:16" },
      output: { width: 1080, height: 1920, fps: 30 },
      shots: [{ video: "/api/worker/media/fixture?version=1", id: "clip", duration: 1, dialogue: "" }],
    }, { baseUrl, token, fetchImpl: async () => new Response(source) });
    await writeFile(path.join(cwd, "vertical.mp4"), Buffer.from(await file.arrayBuffer()));
    const probe = await mediaCommand(process.env.FFPROBE_PATH || "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", "vertical.mp4"], cwd);
    assert.deepEqual(JSON.parse(probe).streams, [{ width: 1080, height: 1920, r_frame_rate: "30/1" }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
