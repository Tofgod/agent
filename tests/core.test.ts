import type { BlobStore } from "../lib/studio/storage";
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { fixture } from "./support";
import { Store } from "../lib/studio/store";
import { encryptSecrets, decryptSecrets, validateProviderUrl } from "../lib/studio/security";
import { publicSettings } from "../lib/studio/contracts";
import { AICLUB_VIDEO_MODELS, DEFAULT_SETTINGS, IMAGE_MODELS, VIDEO_MODELS, type ProviderSettings, type AgentMessage } from "../lib/studio/types";
import { textZip } from "../lib/studio/zip";
import { advanceRun } from "../lib/studio/engine";
import { createModel, createAgentModel, submitImage, submitVideo, queryMediaTask, cancelMediaTask, videoDurationLimits, type AgentFunction } from "../lib/studio/providers";
import { executeFileTool } from "../lib/studio/file-tools";
import { settingsInput, mergeSettings } from "../lib/studio/settings";
import { AppError } from "../lib/studio/security";
import { failRun } from "../lib/studio/jobs";
import { compositionPlan } from "../lib/studio/composition";
import { controlRun, reconcileCancellation } from "../lib/studio/control";
import { authorizeLocalWorker } from "../lib/studio/local-worker-auth";
import { documentDraft, refreshDraft } from "../lib/studio/draft";
import { linkedArtifact } from "../lib/studio/file-links";

const composeOperation = { name: "compose_video" as const, toolCallId: "compose-test", path: "/07_成片/测试成片.mp4" };
const config = { ...DEFAULT_SETTINGS, textApiKey: "test-key" };
async function createRun(store: Store) {
  const p = await store.createProject("alice", { title: "测试" });
  const run = await store.createRun(p.id, { instruction: "写一段完整动画短剧", sourceVersions: {} });
  return { p, run };
}
test("project ownership is enforced", async () => {
  const store = fixture(), p = await store.createProject("alice", {});
  await assert.rejects(store.project(p.id, "bob"), /项目不存在/);
  assert.equal((await store.listProjects("bob")).length, 0);
});
test("artifact optimistic version conflicts preserve user edits and version history", async () => {
  const store = fixture(), p = await store.createProject("alice", {});
  const first = await store.putArtifact(p.id, { path: "/draft.json", kind: "document", content: "first" });
  const second = await store.putArtifact(p.id, { path: first.path, kind: first.kind, content: "user edit", expectedVersion: 1 });
  await assert.rejects(store.putArtifact(p.id, { path: first.path, kind: first.kind, content: "stale worker", expectedVersion: 1 }), /新版本/);
  assert.equal((await store.artifact(first.id, p.id)).content, "user edit");
  assert.equal(second.version, 2);
  assert.equal((await store.versions(first.id, p.id)).length, 2);
});
test("locked files cannot be overwritten by model output", async () => {
  const store = fixture(), p = await store.createProject("alice", {});
  const file = await store.putArtifact(p.id, { path: "/locked", kind: "document", content: "approved" });
  await store.lockArtifact(file.id, p.id, true);
  await assert.rejects(store.putArtifact(p.id, { path: file.path, kind: file.kind, content: "replacement" }), /锁定/);
  assert.equal((await store.artifact(file.id, p.id)).content, "approved");
});
test("credentials are encrypted and omitted from public settings", async () => {
  const secret = "a".repeat(64), encoded = await encryptSecrets({ textApiKey: "private-test-key" }, secret);
  assert.ok(!encoded.includes("private-test-key"));
  assert.equal((await decryptSecrets(encoded, secret)).textApiKey, "private-test-key");
  const visible = publicSettings({ ...DEFAULT_SETTINGS, textApiKey: "private-test-key" });
  assert.equal(visible.textConnected, true);
  assert.ok(!JSON.stringify(visible).includes("private-test-key"));
  await assert.rejects(decryptSecrets(encoded, "b".repeat(64)), /无法读取/);
});
test("provider URL blocks local and non-HTTPS destinations", () => {
  for (const url of ["http://api.example.com", "https://127.0.0.1/v1", "https://192.168.1.1/v1", "https://localhost/v1", "https://u:p@api.example.com"])
    assert.throws(() => validateProviderUrl(url));
  assert.equal(validateProviderUrl("https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1");
});
test("only one worker can claim a run, and a stale lease cannot clear a newer lease", async () => {
  const store = fixture(), { p, run } = await createRun(store);
  assert.equal(await store.claimRun(run.id, p.id), true);
  const old = await store.run(run.id, p.id);
  assert.equal(await store.claimRun(run.id, p.id), false);
  await store.db.prepare("UPDATE runs SET lease_until=0 WHERE id=?").bind(run.id).run();
  assert.equal(await store.claimRun(run.id, p.id), true);
  const current = await store.run(run.id, p.id);
  await store.releaseLease(old);
  assert.equal((await store.run(run.id, p.id)).leaseUntil, current.leaseUntil);
  await store.updateRun(old, { status: "done" });
  assert.notEqual((await store.run(run.id, p.id)).status, "done");
});
test("a changed source prevents an outdated job from making any external request", async () => {
  const store = fixture(), { p, run } = await createRun(store);
  const source = await store.putArtifact(p.id, { path: "/01_创作/笔记.md", kind: "document", content: "原稿" });
  await store.updateRun(run, { payload: { ...run.payload, sourceVersions: { [source.id]: 1 } } }, true);
  await store.putArtifact(p.id, { path: source.path, kind: source.kind, content: "用户修改", expectedVersion: 1 });
  let calls = 0;
  await advanceRun(store, p, run.id, config, undefined, async () => { calls++; return { role: "assistant", content: "不应调用" }; });
  assert.equal(calls, 0);
  assert.equal((await store.run(run.id, p.id)).errorCode, "SOURCE_CHANGED");
});
test("pending fixed stages cannot start a new model request or media submission", async (t) => {
  const store = fixture(), { p, run } = await createRun(store);
  for (const stage of ["writing", "reviewing", "directing", "frames", "videos"] as const) {
    await store.updateRun(await store.run(run.id, p.id), { status: "queued", stage }, true);
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected outbound request"); });
    const result = await advanceRun(store, p, run.id, config);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "WORKFLOW_RETIRED");
    assert.equal(fetch.mock.callCount(), 0);
    fetch.mock.restore();
  }
  assert.deepEqual(await store.artifacts(p.id), []);
});
test("project ZIP uses UTF-8 names and contains text rather than JSON", () => {
  const zip = textZip([{ name: "01_剧本/第01集/剧本.md", content: "第一场\n你好。" }]);
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true), 0x800);
  const nameLength = view.getUint16(26, true);
  assert.equal(new TextDecoder().decode(zip.slice(30, 30 + nameLength)), "01_剧本/第01集/剧本.md");
  assert.ok(new TextDecoder().decode(zip).includes("第一场\n你好。"));
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
});
test("concurrent creation cannot start duplicate runs for one project", async () => {
  const store = fixture(), p = await store.createProject("alice", {});
  const payload = { instruction: "创作", sourceVersions: {} };
  const attempts = await Promise.allSettled([store.createRun(p.id, payload), store.createRun(p.id, payload)]);
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((attempts.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code, "PROJECT_BUSY");
});
test("background queue finds work across projects without a selected page", async () => {
  const store = fixture(), a = await createRun(store), b = await createRun(store);
  assert.equal((await store.dueRuns()).length, 2);
  await store.updateRun(a.run, { status: "paused" }, true);
  await store.updateRun(b.run, { status: "waiting", nextAttemptAt: Date.now() + 60000 }, true);
  assert.equal((await store.dueRuns()).length, 0);
  assert.equal(await store.claimRun(b.run.id, b.p.id), false);
  await store.updateRun(await store.run(b.run.id, b.p.id), { nextAttemptAt: 0 }, true);
  assert.equal((await store.dueRuns())[0].id, b.run.id);
});
test("model transport failures back off and stop after five automatic retries", async () => {
  const store = fixture(), { p, run } = await createRun(store);
  for (let i = 1; i <= 6; i++) {
    const current = await store.run(run.id, p.id);
    await store.updateRun(current, { nextAttemptAt: 0 }, true);
    assert.equal(await store.claimRun(run.id, p.id), true);
    const lease = await store.run(run.id, p.id);
    await failRun(store, lease, new AppError("连接失败", 502, "MODEL_UNAVAILABLE"));
    const failed = await store.run(run.id, p.id);
    assert.equal(failed.attempts, i);
    assert.equal(failed.status, i <= 5 ? "waiting" : "failed");
    if (i <= 5) assert.ok(failed.nextAttemptAt > Date.now());
  }
});
test("uncertain paid submissions are never retried automatically", async () => {
  const store = fixture(), { p, run } = await createRun(store);
  await store.updateRun(run, { payload: { ...run.payload, submissionUnknown: true } }, true);
  await store.claimRun(run.id, p.id);
  await failRun(store, await store.run(run.id, p.id), new AppError("连接失败", 502, "MODEL_UNAVAILABLE"));
  assert.equal((await store.run(run.id, p.id)).status, "failed");
  assert.equal((await store.dueRuns()).length, 0);
});
test("a failed old worker cannot fail a replacement worker or release its lease", async () => {
  const store = fixture(), { p, run } = await createRun(store);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => { entered = r; }), blocked = new Promise<void>((r) => { release = r; });
  const work = advanceRun(store, p, run.id, config, undefined, async () => { entered(); await blocked; throw new AppError("暂时失败", 502, "MODEL_UNAVAILABLE"); });
  await started;
  await store.db.prepare("UPDATE runs SET lease_until=0 WHERE id=?").bind(run.id).run();
  await store.claimRun(run.id, p.id);
  const replacement = await store.run(run.id, p.id);
  release(); await work;
  const after = await store.run(run.id, p.id);
  assert.equal(after.leaseToken, replacement.leaseToken); assert.equal(after.leaseUntil, replacement.leaseUntil);
  assert.equal(after.attempts, 0); assert.equal(after.status, "running");
});
test("local worker endpoints require both loopback and a private token", () => {
  const secret = "x".repeat(64);
  authorizeLocalWorker(new Request("http://127.0.0.1:5179/api/worker/jobs", { headers: { Authorization: "Bearer " + secret } }), secret);
  for (const request of [new Request("http://127.0.0.1/api/worker/jobs"), new Request("https://example.com/api/worker/jobs", { headers: { Authorization: "Bearer " + secret } }),
    new Request("http://localhost/api/worker/jobs", { headers: { Authorization: "Bearer " + secret, Origin: "https://example.com" } })]) assert.throws(() => authorizeLocalWorker(request, secret));
});
test("composition completion atomically saves one final and its version", async () => {
  const store = fixture(), { p, run } = await createRun(store);
  await store.updateRun(run, { stage: "composing", payload: { ...run.payload, operation: composeOperation } }, true); await store.claimRun(run.id, p.id);
  const lease = await store.run(run.id, p.id);
  const final = await store.finishComposition(lease, "test/final.mp4", 0);
  assert.equal(final.kind, "final"); assert.equal(final.version, 1);
  assert.equal((await store.versions(final.id, p.id)).length, 1);
  assert.equal((await store.run(run.id, p.id)).status, "done");
  await assert.rejects(store.finishComposition(lease, "duplicate.mp4", 0));
  assert.equal((await store.versions(final.id, p.id)).length, 1);
});
test("late composition cannot overwrite output after cancellation or source edits", async () => {
  for (const action of ["cancel", "edit"]) {
    const store = fixture(), { p, run } = await createRun(store);
    const doc = await store.putArtifact(p.id, { path: "/01_创作/原稿.md", kind: "document", content: "# 原始" });
    await store.updateRun(run, { stage: "composing", payload: { ...run.payload, operation: composeOperation, sourceVersions: { [doc.id]: 1 } } }, true);
    await store.claimRun(run.id, p.id); const lease = await store.run(run.id, p.id);
    if (action === "cancel") await store.updateRun(lease, { status: "cancelled" }, true);
    else await store.putArtifact(p.id, { path: doc.path, kind: doc.kind, content: "# 用户修改", expectedVersion: 1 });
    await assert.rejects(store.finishComposition(lease, "late.mp4", 0));
    assert.equal((await store.artifacts(p.id)).filter((f) => f.kind === "final").length, 0);
  }
});
test("composition refuses missing clips before calling FFmpeg", async () => {
  const store = fixture(), { p, run } = await createRun(store);
  await store.updateRun(run, { stage: "composing", payload: { ...run.payload, operation: composeOperation, composition: { ratio: "16:9", shots: [{ id: "clip", videoId: "missing", duration: 5, dialogue: "" }] } } }, true);
  await store.claimRun(run.id, p.id);
  await assert.rejects(compositionPlan(store, p, await store.run(run.id, p.id)), /缺少.*视频/);
});
test("an unsaved draft keeps its original version when the agent updates the document", async () => {
  const store = fixture(), p = await store.createProject("alice", {});
  const original = await store.putArtifact(p.id, { path: "/说明.md", kind: "document", content: "# 初稿" });
  const draft = { ...documentDraft(original.content, original.version), value: "# 用户修改" };
  const generated = await store.putArtifact(p.id, { path: original.path, kind: original.kind, content: "# 后台新稿", expectedVersion: 1 });
  const preserved = refreshDraft(draft, generated.content, generated.version);
  assert.equal(preserved.value, "# 用户修改"); assert.equal(preserved.baseVersion, 1);
  await assert.rejects(store.putArtifact(p.id, { path: original.path, kind: original.kind, content: preserved.value, expectedVersion: preserved.baseVersion }), /新版本/);
  assert.equal((await store.artifact(original.id, p.id)).content, "# 后台新稿");
  assert.equal(refreshDraft(documentDraft(original.content, 1), generated.content, 2).value, "# 后台新稿");
});
test("late provider acknowledgements preserve cancellation and cannot replace a newer submission", async () => {
  const store = fixture(), { p, run } = await createRun(store);
  await store.updateRun(run, { status: "cancelled", payload: { ...run.payload, submissionId: "first", submissionUnknown: true } }, true);
  assert.equal(await store.attachMediaResult(run, "first", { provider: "volcengine", model: DEFAULT_SETTINGS.videoModel, baseUrl: DEFAULT_SETTINGS.arkBaseUrl, taskId: "provider-first" }, "生成中"), true);
  let current = await store.run(run.id, p.id);
  assert.equal(current.status, "cancelled"); assert.equal(current.payload.providerTaskId, "provider-first"); assert.equal(current.payload.submissionUnknown, false);
  await store.updateRun(current, { status: "queued", payload: { ...run.payload, submissionId: "second", submissionUnknown: true } }, true);
  assert.equal(await store.attachMediaResult(run, "first", { provider: "volcengine", model: DEFAULT_SETTINGS.videoModel, baseUrl: DEFAULT_SETTINGS.arkBaseUrl, taskId: "late-first" }, "生成中"), false);
  current = await store.run(run.id, p.id);
  assert.equal(current.payload.submissionId, "second"); assert.equal(current.payload.providerTaskId, undefined);
});

const providerConfig: ProviderSettings = { ...DEFAULT_SETTINGS, imageModel: IMAGE_MODELS[0], videoModel: VIDEO_MODELS[0], textApiKey: "deepseek-private", arkApiKey: "ark-private", minimaxApiKey: "minimax-private", aiclubApiKey: "aiclub-fixture-key" };
test("DeepSeek calls use Flash and disable thinking for structured creative output", async (t) => {
  let count = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    count++; assert.equal(url, "https://api.deepseek.com/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "deepseek-flash"); assert.deepEqual(body.thinking, { type: "disabled" });
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer deepseek-private");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] });
  });
  assert.deepEqual(await createModel(providerConfig)({ system: "test", input: { test: true } }), { ok: true });
  assert.equal(count, 1);
});
const aiclubImageUrl = "https://aiclub.zimaocloud.com/model/openApi/v1/images/generations";
test("Seedream 5.5 uses AI Club and Seedream 5.0 Pro keeps its official Ark route", async (t) => {
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const aggregate = requests.length === 1;
    assert.equal(url, aggregate ? aiclubImageUrl : providerConfig.arkBaseUrl + "/images/generations");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer " + (aggregate ? providerConfig.aiclubApiKey : providerConfig.arkApiKey));
    requests.push(JSON.parse(String(init.body)));
    return Response.json({ ...(aggregate ? { requestId: "gateway-request" } : {}),
      data: [{ url: "https://media.example.com/generated?signature=example" }] });
  });
  for (const model of IMAGE_MODELS) {
    const result = await submitImage({ ...providerConfig, imageModel: model }, "character", "9:16", [{ uri: "data:image/png;base64,AAAA", tag: "C1" }]);
    assert.equal(result.provider, model === IMAGE_MODELS[1] ? "aiclub" : "volcengine");
    assert.equal(result.requestId, model === IMAGE_MODELS[1] ? "gateway-request" : undefined);
    assert.equal(result.taskId, undefined);
    assert.equal(result.outputUrl, "https://media.example.com/generated?signature=example");
  }
  assert.deepEqual(requests, [
    { model: IMAGE_MODELS[0], prompt: "character", size: "1152x2048", response_format: "url", output_format: "png", watermark: false, image: ["data:image/png;base64,AAAA"] },
    { model: IMAGE_MODELS[1], prompt: "character", size: "1440x2560", response_format: "url", watermark: false, image: ["data:image/png;base64,AAAA"] },
  ]);
  await assert.rejects(submitImage({ ...providerConfig, imageModel: IMAGE_MODELS[1], aiclubApiKey: "" }, "character", "16:9", []), /AI Club API Key/);
  assert.equal(requests.length, 2);
});
test("Seedance 2.0, 2.5 and MiniMax H3 variants send their own endpoint and parameters", async (t) => {
  let count = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    count++;
    const body = JSON.parse(String(init.body)), ark = body.model.startsWith("doubao");
    assert.equal(url, ark ? providerConfig.arkBaseUrl + "/contents/generations/tasks" : providerConfig.minimaxBaseUrl + "/v2/video_generation");
    assert.equal((init.headers as Record<string, string>).Authorization, ark ? "Bearer ark-private" : "Bearer minimax-private");
    assert.equal(body.duration, 8); assert.equal(body.resolution, ark ? "720p" : "768P");
    assert.equal(body.ratio, body.model === "doubao-seedance-2-0-260128" ? "16:9" : "adaptive");
    assert.deepEqual(body.content[1], { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" }, role: "first_frame" });
    if (ark) assert.equal(body.generate_audio, true);
    return Response.json(ark ? { id: "ark-task" } : { task_id: "minimax-task" });
  });
  for (const model of VIDEO_MODELS.filter((id) => !id.startsWith("zimao-"))) {
    const result = await submitVideo({ ...providerConfig, videoModel: model }, "animation with speech", "data:image/png;base64,AAAA", "16:9", 8);
    assert.equal(result.model, model); assert.equal(result.taskId, model.startsWith("doubao") ? "ark-task" : "minimax-task");
  }
  for (const [model, duration] of [["MiniMax-H3-Max", 4], ["MiniMax-H3", 16], ["doubao-seedance-2-0-260128", 16], ["doubao-seedance-2-5-260628", 31]] as const) {
    await assert.rejects(submitVideo({ ...providerConfig, videoModel: model }, "test", "image", "16:9", duration), /要求单镜头/);
  }
  assert.equal(count, 4);
  assert.deepEqual(videoDurationLimits("doubao-seedance-2-0-260128"), { min: 4, max: 15 });
  assert.deepEqual(videoDurationLimits("doubao-seedance-2-5-260628"), { min: 4, max: 30 });
});
const aiclubVideoBase = "https://aiclub.zimaocloud.com/model/openApi/doubao/v1";
test("AI Club Seedance sends each gateway model ID, frame roles and multimodal inputs", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, aiclubVideoBase + "/video");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer " + providerConfig.aiclubApiKey);
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ id: "seedance-task" });
  });
  for (const model of AICLUB_VIDEO_MODELS) {
    const settings = { ...providerConfig, videoModel: model };
    const result = await submitVideo(settings, "a shot", { first: "first", last: "last" }, "9:16", 8, false);
    assert.equal(result.provider, "aiclub");
    assert.equal(result.model, model);
    assert.equal(result.taskId, "seedance-task");
    assert.deepEqual(bodies.at(-1), { model, content: [
      { type: "text", text: "a shot" }, { type: "image_url", image_url: { url: "first" }, role: "first_frame" },
      { type: "image_url", image_url: { url: "last" }, role: "last_frame" },
    ], duration: 8, resolution: "720p", ratio: model === "zimao-2.5" ? "adaptive" : "9:16", generate_audio: false,
    ...(model === "zimao-2.5" ? { output_format: "mp4" } : {}) });
  }
  const long = { ...providerConfig, videoModel: "zimao-2.5" as const }, standard = { ...providerConfig, videoModel: "zimao-2.0" as const };
  await submitVideo(long, "", { images: ["image"], videos: ["video"], audio: ["audio"] }, "16:9", 30);
  assert.deepEqual(bodies.at(-1)?.content, [
    { type: "image_url", image_url: { url: "image" }, role: "reference_image" },
    { type: "video_url", video_url: { url: "video" }, role: "reference_video" },
    { type: "audio_url", audio_url: { url: "audio" }, role: "reference_audio" },
  ]);
  await submitVideo(long, "", { audio: ["audio"] }, "16:9", -1);
  await assert.rejects(submitVideo(standard, "", { audio: ["audio"] }, "16:9", 5), /搭配参考图片或视频/);
  await assert.rejects(submitVideo(standard, "shot", { last: "last" }, "16:9", 5), /同时指定首帧/);
  await assert.rejects(submitVideo(standard, "", { first: "first", images: ["image"] }, "16:9", 5), /分别提交/);
  await assert.rejects(submitVideo(standard, "shot", {}, "16:9", 16), /要求单镜头/);
  assert.equal(bodies.length, 5);
});
test("Ark and AI Club use identical Seedance payloads apart from model IDs", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const { model: _, ...body } = JSON.parse(String(init.body));
    bodies.push(body);
    return Response.json({ id: "seedance-task" });
  });
  const same = () => assert.deepEqual(bodies.at(-1), bodies.at(-2));
  for (const mode of ["reference", "edit", "extend"] as const) {
    for (const model of ["doubao-seedance-2-5-260628", "zimao-2.5"] as const) {
      await submitVideo({ ...providerConfig, videoModel: model }, "按素材制作", { videos: ["https://example.com/source.mp4"] },
        mode === "reference" ? "1:1" : "adaptive", mode === "edit" ? -1 : 7, false,
        { resolution: "4k", output_format: "mov", omni_reference_task_type: mode, return_last_frame: true, watermark: true,
          priority: 3, execution_expires_after: 3600 });
    }
    same();
    assert.equal(bodies.at(-1)?.omni_reference_task_type, mode);
    assert.equal(bodies.at(-1)?.resolution, "4k");
    assert.equal(bodies.at(-1)?.generate_audio, false);
  }
  for (const model of ["doubao-seedance-2-0-260128", "zimao-2.0"] as const) {
    await submitVideo({ ...providerConfig, videoModel: model }, "文字出片", {}, "21:9", -1, false,
      { resolution: "1080p", tools: [{ type: "web_search" }] });
  }
  same();
  assert.equal(bodies.at(-1)?.ratio, "21:9");
  for (const model of ["doubao-seedance-2-5-260628", "zimao-2.5"] as const) {
    await submitVideo({ ...providerConfig, videoModel: model }, "", {}, undefined, undefined, undefined,
      { resolution: "1080p", return_last_frame: true }, "existing-draft");
  }
  same();
  assert.deepEqual(bodies.at(-1), { content: [{ type: "draft_task", draft_task: { id: "existing-draft" } }], resolution: "1080p", return_last_frame: true });
  const count = bodies.length;
  await assert.rejects(submitVideo({ ...providerConfig, videoModel: "zimao-2.0-fast" }, "shot", {}, "9:16", 6, false, { resolution: "4k" }), /可用分辨率/);
  await assert.rejects(submitVideo({ ...providerConfig, videoModel: "zimao-2.5" }, "shot", { videos: ["video"] }, "1:1", -1, false,
    { omni_reference_task_type: "edit" }), /ratio.*adaptive/);
  assert.equal(bodies.length, count);
});
test("MiniMax and Seedream submit model-specific size, ratio and audio choices", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ task_id: "h3-task", data: [{ url: "https://example.com/image.jpg" }] });
  });
  const h3 = { ...providerConfig, videoModel: "MiniMax-H3" as const };
  const max = { ...providerConfig, videoModel: "MiniMax-H3-Max" as const };
  await submitVideo(h3, "shot", { images: ["ref"] }, "4:3", 8, false, { resolution: "2K" });
  assert.deepEqual(bodies.at(-1), { model: "MiniMax-H3", content: [{ type: "text", text: "shot" },
    { type: "image_url", image_url: { url: "ref" }, role: "reference_image" }], ratio: "4:3", duration: 8, resolution: "2K", generate_audio: false });
  await submitVideo(max, "shot", { last: "last" }, "9:16", 5, false, { resolution: "480P" });
  assert.equal(bodies.at(-1)?.ratio, "adaptive");
  await assert.rejects(submitVideo(max, "shot", {}, "9:16", 5, false, { resolution: "2K" }), /可用分辨率/);
  await assert.rejects(submitVideo(h3, "", { images: ["ref"] }, "1:1", 5), /需要提示词/);
  for (const imageModel of IMAGE_MODELS) {
    await submitImage({ ...providerConfig, imageModel }, "clean photo", "16:9", [], { size: "2048X2048", output_format: "jpeg", watermark: true, background: "opaque" });
    assert.deepEqual(bodies.at(-1), { model: imageModel, prompt: "clean photo", size: "2048x2048", output_format: "jpeg", response_format: "url", watermark: true, background: "opaque" });
  }
  await assert.rejects(submitImage(providerConfig, "portrait", "1:1", [], { size: "512x512" }), /size/);
  assert.equal(bodies.length, 4);
});
test("provider queries and cancellation keep the original provider regardless of the current model", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push(init.method + " " + url);
    if (init.method === "DELETE") return Response.json({ id: "task", status: "cancelled" });
    return Response.json(url.includes("minimax") ? { task: { status: "succeeded", content: { url: "https://media.example.com/h3.mp4" } } } :
      { status: "succeeded", content: { video_url: "https://media.example.com/seedance.mp4" } });
  });
  assert.equal((await queryMediaTask(providerConfig, "minimax", "h3")).outputUrl, "https://media.example.com/h3.mp4");
  assert.equal((await queryMediaTask({ ...providerConfig, videoModel: "MiniMax-H3" }, "volcengine", "seedance")).outputUrl, "https://media.example.com/seedance.mp4");
  await cancelMediaTask(providerConfig, "minimax", "h3");
  await cancelMediaTask(providerConfig, "volcengine", "seedance");
  assert.deepEqual(requests, [
    "GET https://api.minimax.cn/v2/query/video_generation/h3",
    "GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/seedance",
    "GET https://api.minimax.cn/v2/query/video_generation/h3",
    "GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/seedance",
  ]);
});
test("a restarted Seedance job keeps its video specification and retries tail-frame download without submitting again", async (t) => {
  const { store, p, run } = await agentFixture("生成一段 1080p 方形无声视频，保存尾帧");
  const routed = { ...providerConfig, videoModel: "zimao-2.5" as const };
  const videoPath = "/04_视频/方形片段.mov", videoUrl = "https://media.example.com/shot.mov", frameUrl = "https://media.example.com/tail.jpg";
  const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#272727" } }).jpeg().toBuffer();
  let submits = 0, polls = 0, videoDownloads = 0, frameDownloads = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      submits++;
      assert.equal(url, aiclubVideoBase + "/video");
      assert.deepEqual(JSON.parse(String(init.body)), { model: "zimao-2.5", content: [{ type: "text", text: "长廊静景" }],
        resolution: "1080p", ratio: "1:1", duration: 6, generate_audio: false, return_last_frame: true, output_format: "mov" });
      return Response.json({ id: "tail-task" });
    }
    if (url.endsWith("/tasks/tail-task")) {
      polls++;
      return Response.json({ status: "succeeded", resolution: "1080p", ratio: "1:1", framespersecond: 24, duration: 6,
        content: { video_url: videoUrl, last_frame_url: frameUrl } });
    }
    if (url === videoUrl) {
      videoDownloads++;
      return new Response(new Uint8Array([0, 0, 0, 24]), { headers: { "Content-Type": "video/quicktime" } });
    }
    assert.equal(url, frameUrl);
    return ++frameDownloads === 1 ? new Response("temporary failure", { status: 502 }) : new Response(new Uint8Array(jpeg));
  });
  const types: unknown[] = [];
  const bucket: BlobStore = { get: async () => null, put: async (_key, _body, options) => { types.push(options?.httpMetadata?.contentType); } };
  const launch: AgentFunction = async () => call("make-with-tail", "generate_video", {
    file_path: videoPath, prompt: "长廊静景", ratio: "1:1", resolution: "1080p", duration: 6,
    generate_audio: false, return_last_frame: true, output_format: "mov",
  });
  await advanceRun(store, p, run.id, routed, bucket, launch);
  await advanceRun(store, p, run.id, routed, bucket, launch);
  const [job] = await store.children(run);
  assert.equal(job.payload.operation?.videoOptions?.resolution, "1080p");
  const reopened = new Store(store.db);
  const changed = { ...providerConfig, videoModel: "MiniMax-H3" as const };
  const advance = async () => {
    await reopened.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=?").bind(job.id).run();
    return advanceRun(reopened, p, job.id, changed, bucket);
  };
  await advance();
  assert.equal((await advance()).errorCode, "MEDIA_DOWNLOAD_FAILED");
  const video = (await reopened.artifacts(p.id)).find((file) => file.path === videoPath)!;
  assert.equal(video.metadata.ratio, "1:1"); assert.equal(video.metadata.fps, 24);
  const done = await advance();
  assert.equal(done.status, "done");
  const { last_frame: tail } = JSON.parse(done.resultText);
  assert.match(tail.path, /^\/03_图片\/尾帧\/.*\.jpg$/);
  const frame = await reopened.artifact(tail.id, p.id);
  assert.deepEqual(frame.metadata.sourceVersions, { [video.id]: video.version });
  assert.deepEqual(types, ["video/quicktime", "image/jpeg"]);
  assert.deepEqual([submits, polls, videoDownloads, frameDownloads], [1, 1, 1, 2]);
});
test("Seedance draft promotion is scoped to the matching project asset and inherits its generation inputs", async (t) => {
  const { store, p, run } = await agentFixture("用已有样片生成高清镜头");
  const settings = { ...providerConfig, videoModel: "zimao-2.5" as const };
  const draftPath = "/04_视频/样片.mp4";
  const draft = await store.putArtifact(p.id, { path: draftPath, kind: "video", content: "", metadata: {
    draft: true, provider: "aiclub", model: settings.videoModel, providerBaseUrl: "https://aiclub.zimaocloud.com/model", providerTaskId: "draft-original",
  } });
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, aiclubVideoBase + "/video");
    assert.deepEqual(JSON.parse(String(init.body)), { model: "zimao-2.5", content: [{ type: "draft_task", draft_task: { id: "draft-original" } }], resolution: "1080p" });
    posts++;
    return Response.json({ id: "promoted" });
  });
  const bucket: BlobStore = { get: async () => null, put: async () => {} };
  const launch: AgentFunction = async () => call("promote-draft", "generate_video", { file_path: "/04_视频/高清镜头.mp4", draft_video_path: draftPath, resolution: "1080p" });
  await advanceRun(store, p, run.id, settings, bucket, launch);
  await advanceRun(store, p, run.id, settings, bucket, launch);
  const [job] = await store.children(run);
  assert.equal(job.payload.operation?.draftTaskId, "draft-original");
  assert.deepEqual(job.payload.sourceVersions, { [draft.id]: draft.version });
  await advanceRun(store, p, job.id, settings, bucket);
  assert.equal((await store.run(job.id, p.id)).payload.providerTaskId, "promoted");
  assert.equal(posts, 1);
});
test("video references keep order and signed URLs through SQLite and the Seedance request", async (t) => {
  const projectPath = "/04_视频/项目参考.mp4";
  const projectUrl = "https://assets.example.test/project.mp4?sig=p%2fq&label=it's";
  const signedUrl = "https://media.example.test/external.mp4?sig=a%2fb%2Bc%3D&part=1&part=2&name=a+b&label=it's";
  const secondUrl = "https://media.example.test/second.mp4?token=c%2fd";
  const local = { type: "project_file", path: projectPath };
  const external = { type: "url", url: signedUrl };
  const second = { type: "url", url: secondUrl };
  const cases = [
    { name: "public URLs only", args: { reference_videos: [external, second] }, refs: [external, second], urls: [signedUrl, secondUrl] },
    { name: "project paths only", args: { reference_videos: [local] }, refs: [local], urls: [projectUrl] },
    { name: "mixed public URLs and project paths", args: { reference_videos: [external, local, second] },
      refs: [external, local, second], urls: [signedUrl, projectUrl, secondUrl] },
    { name: "legacy field and already queued string paths", args: { reference_video_paths: [projectPath] },
      refs: [local], urls: [projectUrl], legacyPayload: true },
    { name: "legacy paths follow the new array", args: { reference_videos: [external], reference_video_paths: [projectPath] },
      refs: [external, local], urls: [signedUrl, projectUrl] },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (subtest) => {
    const { store, p, run } = await agentFixture("生成一段参考视频");
    const settings = { ...providerConfig, videoModel: "zimao-2.0" as const };
    const source = await store.putArtifact(p.id, { path: projectPath, kind: "video", content: "", metadata: { providerUrl: projectUrl } });
    const outputPath = "/04_视频/结果.mp4", outputUrl = "https://media.example.test/result.mp4";
    const taskUrl = aiclubVideoBase + "/tasks/reference-test";
    const saved: (string | undefined)[] = [];
    const requests: string[] = [];
    const requestBodies: unknown[] = [];
    const bucket: BlobStore = { get: async () => { throw new Error("reference videos should use their resolved URLs"); },
      put: async (_key, _body, options) => { saved.push(options?.httpMetadata?.contentType); } };
    subtest.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      requests.push((init?.method ?? "GET") + " " + url);
      if (url === aiclubVideoBase + "/video" && init?.method === "POST") {
        requestBodies.push(JSON.parse(String(init.body)));
        return Response.json({ id: "reference-test" });
      }
      if (url === taskUrl) return Response.json({ status: "succeeded", content: { video_url: outputUrl } });
      assert.equal(url, outputUrl);
      return new Response(new Uint8Array([0, 0, 0, 24]), { headers: { "Content-Type": "video/mp4" } });
    });
    const launch: AgentFunction = async (_system, _messages, tools) => {
      const properties = tools.find((tool) => tool.function.name === "generate_video")?.function.parameters.properties;
      assert.ok(properties && typeof properties === "object" && Object.hasOwn(properties, "reference_videos"));
      return call("submit-references", "generate_video", { file_path: outputPath, prompt: "参考输入顺序", duration: 5, ...scenario.args });
    };
    await advanceRun(store, p, run.id, settings, bucket, launch);
    await advanceRun(store, p, run.id, settings, bucket, launch);
    const [job] = await store.children(run);
    const sourceVersions = scenario.refs.includes(local) ? { [source.id]: source.version } : {};
    assert.deepEqual(job.payload.operation?.videoReferences?.videos, scenario.refs);
    assert.deepEqual(job.payload.sourceVersions, sourceVersions);
    if (scenario.legacyPayload) {
      await store.db.prepare("UPDATE runs SET payload=json_set(payload,'$.operation.videoReferences.videos',json(?)) WHERE id=?")
        .bind(JSON.stringify([projectPath]), job.id).run();
    }
    if (scenario.refs.includes(local)) {
      await store.putArtifact(p.id, { path: projectPath, kind: "video", content: "", metadata: { providerUrl: "https://assets.example.test/new-version.mp4" } });
    }
    const reopened = new Store(store.db);
    const submitted = await advanceRun(reopened, p, job.id, settings, bucket);
    assert.equal(submitted.payload.providerTaskId, "reference-test");
    await reopened.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=?").bind(job.id).run();
    assert.equal((await advanceRun(reopened, p, job.id, settings, bucket)).status, "done");
    assert.deepEqual(requestBodies, [{ model: "zimao-2.0", content: [
      { type: "text", text: "参考输入顺序" },
      ...scenario.urls.map((url) => ({ type: "video_url", video_url: { url }, role: "reference_video" })),
    ], duration: 5, ratio: p.ratio, resolution: "720p", generate_audio: true }]);
    assert.deepEqual(requests, ["POST " + aiclubVideoBase + "/video", "GET " + taskUrl, "GET " + outputUrl]);
    assert.deepEqual(saved, ["video/mp4"]);
    const output = (await reopened.artifacts(p.id)).find((file) => file.path === outputPath)!;
    assert.equal(output.status, "ready");
    assert.deepEqual(output.metadata.sourceVersions, sourceVersions);
  });
});
test("saved provider keys stay encrypted and blank edits preserve their values", async () => {
  const store = fixture(), secret = "local-test-encryption-secret".repeat(3);
  const parsed = settingsInput.parse(providerConfig);
  await store.saveSettings("alice", parsed, secret);
  const read = await store.getSettings("alice", secret);
  assert.equal(read.arkApiKey, providerConfig.arkApiKey); assert.equal(read.minimaxApiKey, providerConfig.minimaxApiKey);
  assert.equal(read.aiclubApiKey, providerConfig.aiclubApiKey);
  const updated = await store.saveSettings("alice", { ...DEFAULT_SETTINGS, textApiKey: "", arkApiKey: "", minimaxApiKey: "", videoModel: "MiniMax-H3-Max" }, secret);
  assert.equal(updated.textApiKey, providerConfig.textApiKey); assert.equal(updated.videoModel, "MiniMax-H3-Max");
  const visible = publicSettings(updated);
  for (const key of [providerConfig.textApiKey, providerConfig.arkApiKey, providerConfig.minimaxApiKey, providerConfig.aiclubApiKey]) {
    assert.ok(!JSON.stringify(visible).includes(key));
    const raw = await store.db.prepare("SELECT config,secrets FROM settings WHERE user_id=?").bind("alice").first();
    assert.ok(!JSON.stringify(raw).includes(key));
  }
  assert.equal(visible.arkConnected, true); assert.equal(visible.minimaxConnected, true);
  assert.equal(visible.aiclubConnected, true);
  assert.equal(mergeSettings(read, { arkApiKey: "" }).arkApiKey, providerConfig.arkApiKey);
});
async function mediaFixture(stage: "frames" | "videos") {
  const store = fixture(), { p, run } = await createRun(store);
  const dialogue = "里面的信呢？";
  if (stage === "videos") await store.putArtifact(p.id, { path: "/03_图片/首帧.png", kind: "image", content: "", url: "/frame", metadata: { providerUrl: "https://media.example.com/frame.png" } });
  const operation = stage === "frames"
    ? { name: "generate_image" as const, toolCallId: "image", path: "/03_图片/新图.png", prompt: "Rainy street" }
    : { name: "generate_video" as const, toolCallId: "video", path: "/04_视频/新视频.mp4", prompt: "Animate the character asking a question", imagePath: "/03_图片/首帧.png", dialogue, duration: 5 };
  await store.updateRun(run, { stage: "media", payload: { ...run.payload, operation } }, true);
  return { store, p, run };
}
test("synchronous image output is persisted before download and is not regenerated after failure or restart", async (t) => {
  const { store, p, run } = await mediaFixture("frames");
  const previous = await store.putArtifact(p.id, {
    path: "/03_图片/新图.png", kind: "image", content: "", metadata: { objectKey: "prior-image" }, serveMedia: true,
  });
  let posts = 0, downloads = 0, writes = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posts++; return Response.json({ data: [{ url: "https://media.example.com/paid-image.png" }] }); }
    assert.equal(url, "https://media.example.com/paid-image.png"); downloads++;
    return downloads === 1 ? new Response("temporary", { status: 503 }) : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
  });
  const bucket = { put: async () => { writes++; } } as unknown as BlobStore;
  await advanceRun(store, p, run.id, providerConfig, bucket);
  let current = await store.run(run.id, p.id);
  assert.equal(current.payload.outputUrl, "https://media.example.com/paid-image.png");
  assert.equal(current.payload.submissionUnknown, false); assert.equal(downloads, 0);
  assert.deepEqual(await store.artifact(previous.id, p.id), previous);
  await advanceRun(store, p, run.id, providerConfig, bucket);
  current = await store.run(run.id, p.id);
  assert.equal(current.errorCode, "MEDIA_DOWNLOAD_FAILED"); assert.equal(current.status, "waiting");
  assert.equal(current.payload.outputUrl, "https://media.example.com/paid-image.png");
  assert.deepEqual(await store.artifact(previous.id, p.id), previous);
  await assert.rejects(controlRun(store, current, "resubmit", providerConfig), /已有供应商任务或生成结果/);
  await store.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=?").bind(run.id).run();
  const restarted = new Store(store.db);
  await advanceRun(restarted, p, run.id, { ...providerConfig, imageModel: IMAGE_MODELS[1] }, bucket);
  assert.equal(posts, 1); assert.equal(downloads, 2); assert.equal(writes, 1);
  current = await restarted.run(run.id, p.id);
  assert.equal(current.status, "done"); assert.equal(current.payload.outputUrl, undefined);
  const image = (await restarted.artifacts(p.id)).find((f) => f.kind === "image");
  assert.equal(image?.status, "ready"); assert.equal(image?.metadata.model, IMAGE_MODELS[0]);
  assert.equal(image?.version, previous.version + 1);
});
test("AI Club downloads the acknowledged JPEG as PNG after reconnecting without a second generation request", async (t) => {
  const { store, p, run } = await mediaFixture("frames");
  const posted = { ...providerConfig, imageModel: DEFAULT_SETTINGS.imageModel };
  assert.equal(posted.imageModel, IMAGE_MODELS[1]);
  const jpeg = await sharp({ create: { width: 24, height: 16, channels: 3, background: "#b77210" } }).jpeg().toBuffer();
  const signedResult = "https://media.example.com/seedream.jpg?signature=fixture";
  let posts = 0, downloads = 0, saved = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      assert.equal(url, aiclubImageUrl);
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer " + providerConfig.aiclubApiKey);
      assert.deepEqual(JSON.parse(String(init.body)), {
        model: IMAGE_MODELS[1], prompt: "Rainy street", size: "2560x1440", response_format: "url", watermark: false,
      });
      posts++;
      return Response.json({ data: [{ url: signedResult }], model: IMAGE_MODELS[1], requestId: "image-5-5", usage: { generated_images: 1 } });
    }
    downloads++;
    assert.equal(url, signedResult);
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return downloads === 1 ? new Response("<html>Unavailable</html>", { headers: { "Content-Type": "text/html" } }) :
      new Response(new Uint8Array(jpeg), { headers: { "Content-Type": "image/jpeg" } });
  });
  const bucket: BlobStore = { get: async () => null, put: async (_key, bytes, options) => {
    assert.ok(Buffer.isBuffer(bytes));
    const decoded = await sharp(bytes).metadata();
    assert.equal(decoded.format, "png");
    assert.deepEqual([decoded.width, decoded.height], [24, 16]);
    assert.equal(options?.httpMetadata?.contentType, "image/png");
    saved++;
  } };
  await advanceRun(store, p, run.id, posted, bucket);
  const first = await store.run(run.id, p.id);
  assert.equal(first.payload.providerRequestId, "image-5-5");
  assert.equal(first.payload.outputUrl, signedResult);
  assert.equal(first.payload.submissionUnknown, false);
  await advanceRun(store, p, run.id, posted, bucket);
  assert.equal((await store.run(run.id, p.id)).errorCode, "MEDIA_DOWNLOAD_FAILED");
  assert.equal(saved, 0);
  await store.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=?").bind(run.id).run();
  const reopened = new Store(store.db);
  await advanceRun(reopened, p, run.id, { ...providerConfig, aiclubApiKey: "" }, bucket);
  assert.deepEqual([posts, downloads, saved], [1, 2, 1]);
  assert.equal((await reopened.run(run.id, p.id)).status, "done");
  const [image] = await reopened.artifacts(p.id);
  assert.equal(image.path, "/03_图片/新图.png");
  assert.equal(image.version, 1);
  assert.equal(image.metadata.provider, "aiclub");
  assert.equal(image.metadata.model, IMAGE_MODELS[1]);
  assert.equal(image.metadata.providerRequestId, "image-5-5");
  assert.equal(image.metadata.contentType, "image/png");
});
test("a downloaded generation cannot overwrite a different file at the same path and version", async (t) => {
  const { store, p, run } = await mediaFixture("frames");
  const original = await store.putArtifact(p.id, {
    path: "/03_图片/新图.png", kind: "image", content: "", metadata: { objectKey: "original" },
  });
  const outputUrl = "https://media.example.com/ready.png";
  let submissions = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      submissions++;
      return Response.json({ data: [{ url: outputUrl }] });
    }
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
  });
  let replacement: Awaited<ReturnType<Store["putArtifact"]>> | undefined;
  const bucket: BlobStore = {
    get: async () => null,
    put: async () => {
      await store.moveArtifact(await store.run(run.id, p.id), "move-during-download", original, "/03_图片/旧图.png");
      replacement = await store.putArtifact(p.id, {
        path: original.path, kind: "image", content: "", metadata: { objectKey: "replacement" },
      });
    },
  };
  await advanceRun(store, p, run.id, providerConfig, bucket);
  const completed = await advanceRun(store, p, run.id, providerConfig, bucket);
  assert.ok(replacement);
  assert.equal(replacement.version, original.version);
  assert.equal(completed.errorCode, "VERSION_CONFLICT");
  assert.equal(completed.payload.outputUrl, outputUrl);
  assert.deepEqual(await store.artifact(replacement.id, p.id), replacement);
  assert.equal(submissions, 1);
});

test("native-audio video generation records the task and exact dialogue before polling the original service", async (t) => {
  const { store, p, run } = await mediaFixture("videos");
  const dialogue = "里面的信呢？";
  let posts = 0, polls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts++; assert.equal(url, "https://api.minimax.cn/v2/video_generation");
      const body = JSON.parse(String(init.body));
      assert.equal(body.content[0].text, "Animate the character asking a question\n对白：" + dialogue);
      return Response.json({ task_id: "h3-original" });
    }
    if (url.includes("/query/")) {
      polls++; assert.equal(url, "https://api.minimax.cn/v2/query/video_generation/h3-original");
      return Response.json({ task: { status: "succeeded", content: { url: "https://media.example.com/native-audio.mp4" } } });
    }
    assert.equal(url, "https://media.example.com/native-audio.mp4");
    return new Response(new Uint8Array([0, 0, 0, 20]), { headers: { "Content-Type": "video/mp4" } });
  });
  const bucket = { put: async () => {} } as unknown as BlobStore;
  await advanceRun(store, p, run.id, { ...providerConfig, videoModel: "MiniMax-H3-Max" }, bucket);
  let current = await store.run(run.id, p.id);
  assert.equal(current.payload.providerTaskId, "h3-original"); assert.equal(current.payload.mediaProvider, "minimax");
  const source = (await store.artifacts(p.id)).find((f) => f.kind === "image")!;
  await store.putArtifact(p.id, { path: source.path, kind: "image", content: "", expectedVersion: source.version });
  await store.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=?").bind(run.id).run();
  await advanceRun(store, p, run.id, providerConfig, bucket);
  current = await store.run(run.id, p.id);
  assert.equal(posts, 1); assert.equal(polls, 1);
  const generated = (await store.artifacts(p.id)).find((f) => f.kind === "video");
  assert.equal(generated?.metadata.model, "MiniMax-H3-Max");
  assert.deepEqual(generated?.metadata.sourceVersions, { [source.id]: source.version });
  await advanceRun(store, p, run.id, providerConfig, bucket);
  assert.equal((await store.run(run.id, p.id)).stage, "done");
});
test("AI Club video resumes the original query and saves one MP4 after a download failure", async (t) => {
  const { store, p, run } = await agentFixture("用文字直接生成视频");
  const configured = { ...providerConfig, videoModel: "zimao-2.5" as const };
  const outputPath = "/04_视频/雨夜.mp4", taskId = "cgt-fixture";
  let submits = 0, polls = 0, downloads = 0, saved = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      assert.equal(url, aiclubVideoBase + "/video");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "zimao-2.5");
      assert.equal(body.duration, -1);
      assert.equal(body.ratio, "9:16");
      assert.deepEqual(body.content, [{ type: "text", text: "雨夜街道" }]);
      submits++;
      return Response.json({ id: taskId });
    }
    if (url.startsWith(aiclubVideoBase)) {
      assert.equal(url, aiclubVideoBase + "/tasks/" + taskId);
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer " + configured.aiclubApiKey);
      polls++;
      return polls === 1 ? Response.json({ id: taskId, status: "running" }) :
        Response.json({ id: taskId, status: "succeeded", duration: 12,
          content: { video_url: "https://media.example.com/video?signature=example" } });
    }
    downloads++;
    assert.equal(url, "https://media.example.com/video?signature=example");
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return downloads === 1 ? new Response("bad gateway", { status: 502 }) :
      new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { "Content-Type": "application/octet-stream" } });
  });
  const bucket: BlobStore = { get: async () => null, put: async (_key, _body, options) => {
    assert.equal(options?.httpMetadata?.contentType, "video/mp4"); saved++;
  } };
  const launch: AgentFunction = async (_system, _messages, tools) => {
    const schema = tools.find((tool) => tool.function.name === "generate_video")!;
    assert.deepEqual(schema.function.parameters.required, ["file_path"]);
    return call("gateway-video", "generate_video", { file_path: outputPath, duration: -1, ratio: "9:16", prompt: "雨夜街道" });
  };
  await advanceRun(store, p, run.id, configured, bucket, launch);
  await advanceRun(store, p, run.id, configured, bucket, launch);
  const [job] = await store.children(run);
  assert.equal(job.payload.operation?.videoModel, "zimao-2.5");
  const otherSettings = { ...configured, videoModel: "MiniMax-H3" as const };
  const restarted = new Store(store.db);
  const wake = () => store.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=?").bind(job.id).run();
  await advanceRun(restarted, p, job.id, otherSettings, bucket);
  const accepted = await restarted.run(job.id, p.id);
  assert.equal(accepted.payload.providerTaskId, taskId);
  assert.equal(accepted.payload.mediaProvider, "aiclub");
  await wake(); await advanceRun(restarted, p, job.id, otherSettings, bucket);
  await wake(); await advanceRun(restarted, p, job.id, otherSettings, bucket);
  const failed = await restarted.run(job.id, p.id);
  assert.equal(failed.errorCode, "MEDIA_DOWNLOAD_FAILED");
  assert.equal(failed.payload.outputDuration, 12);
  await wake(); await advanceRun(new Store(store.db), p, job.id, otherSettings, bucket);
  const [file] = await restarted.artifacts(p.id);
  assert.equal(file.path, outputPath);
  assert.equal(file.metadata.model, "zimao-2.5");
  assert.equal(file.metadata.duration, 12);
  assert.equal(file.metadata.providerTaskId, taskId);
  assert.equal((await restarted.run(job.id, p.id)).status, "done");
  assert.deepEqual([submits, polls, downloads, saved], [1, 2, 2, 1]);
});
test("AI Club cancellation reconciles the existing task through GET and keeps a late result", async (t) => {
  const { store, p, run } = await mediaFixture("videos");
  await store.claimRun(run.id, p.id);
  const held = await store.run(run.id, p.id);
  await store.updateRun(held, { status: "waiting", payload: { ...held.payload, mediaProvider: "aiclub", providerTaskId: "existing" } });
  const settings = { ...providerConfig, videoModel: "zimao-2.0" as const };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    assert.equal(url, aiclubVideoBase + "/tasks/existing");
    assert.equal(init?.method, "GET");
    return ++calls === 1 ? Response.json({ status: "queued" }) :
      Response.json({ status: "succeeded", duration: 9, content: { video_url: "https://media.example.com/late.mp4" } });
  });
  await controlRun(store, held, "cancel", settings);
  await reconcileCancellation(store, await store.run(run.id, p.id), settings);
  const stopped = await store.run(run.id, p.id);
  assert.equal(stopped.status, "cancelled");
  assert.match(stopped.payload.cancellation?.detail ?? "", /AI Club 任务仍在排队/);
  await store.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=?").bind(run.id).run();
  await reconcileCancellation(store, stopped, settings);
  const complete = await store.run(run.id, p.id);
  assert.equal(complete.payload.cancellation?.state, "completed");
  assert.equal(complete.payload.outputUrl, "https://media.example.com/late.mp4");
  assert.equal(complete.payload.outputDuration, 9);
  assert.equal(calls, 2);
});
test("video generation sends the supplied prompt verbatim when no dialogue was supplied", async (t) => {
  const { store, p, run } = await mediaFixture("videos");
  const current = await store.run(run.id, p.id), prompt = "Un plan fixe au crépuscule.";
  await store.updateRun(current, { payload: { ...current.payload, operation: { ...current.payload.operation!, prompt, dialogue: undefined } } }, true);
  let sent = false;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    assert.equal(init?.method, "POST");
    assert.equal(JSON.parse(String(init?.body)).content[0].text, prompt);
    sent = true;
    return Response.json({ task_id: "raw-video-prompt" });
  });
  await advanceRun(store, p, run.id, { ...providerConfig, videoModel: "MiniMax-H3-Max" }, {} as BlobStore);
  assert.equal(sent, true);
});
test("an acknowledged historical batch collects only its existing result after restart", async (t) => {
  const store = fixture(), { p, run } = await createRun(store);
  const pending = await store.putArtifact(p.id, { path: "/03_图片/历史提交.png", kind: "image", content: "", status: "generating" });
  await store.updateRun(run, { stage: "frames", payload: {
    ...run.payload, pendingArtifactId: pending.id, pendingArtifactVersion: pending.version, submissionId: "existing",
    outputUrl: "https://media.example.com/already-generated.png",
  } }, true);
  const request = t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    assert.equal(url, "https://media.example.com/already-generated.png");
    assert.equal(init?.method, undefined);
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
  });
  const restarted = new Store(store.db);
  const bucket = { put: async () => {} } as unknown as BlobStore;
  const result = await advanceRun(restarted, p, run.id, providerConfig, bucket);
  assert.equal(result.status, "done");
  assert.equal((await restarted.artifact(pending.id, p.id)).status, "ready");
  assert.equal((await advanceRun(restarted, p, run.id, providerConfig, bucket)).status, "done");
  assert.equal(request.mock.callCount(), 1);
});
async function agentFixture(text = "先写一段剧本") {
  const store = fixture();
  const p = await store.createProject("alice", {});
  await store.addMessage(p.id, "user", text);
  const run = await store.createRun(p.id, { instruction: text, sourceVersions: {} });
  await store.addMessage(p.id, "assistant", "", "main", run.id);
  return { store, p, run };
}
function call(id: string, name: string, args: unknown): AgentMessage {
  return { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}
test("file tools accept free Markdown, create directories, edit literally and reuse committed receipts", async () => {
  const { store, p, run } = await agentFixture(); await store.claimRun(run.id, p.id);
  const lease = await store.run(run.id, p.id);
  const write = { file_path: "/01_创作/第三集/草稿.md", content: "# 夜归\n\n她打开门，灯还亮着。\n\n“你回来了。”" };
  const first = await executeFileTool(store, lease, "write-1", "write_file", write);
  assert.equal(first.version, 1);
  assert.deepEqual(await executeFileTool(new Store(store.db), lease, "write-1", "write_file", write), first);
  assert.equal((await store.versions(String(first.id), p.id)).length, 1);
  await executeFileTool(store, lease, "edit-1", "edit_file", { file_path: write.file_path, old_string: "灯还亮着", new_string: "桌上留着热饭" });
  assert.equal((await store.artifact(String(first.id), p.id)).content, write.content.replace("灯还亮着", "桌上留着热饭"));
  const read = await executeFileTool(store, lease, "read-1", "read_file", { file_path: write.file_path });
  assert.ok(String(read.content).includes("桌上留着热饭")); assert.equal(read.version, 2);
  await assert.rejects(executeFileTool(store, lease, "escape", "write_file", { file_path: "../other-project/剧本.md", content: "x" }), /项目内/);
  const moved = await executeFileTool(store, lease, "move-1", "move_file", { file_path: write.file_path, new_path: "/01_创作/第三集/剧本.md" });
  assert.equal(moved.id, first.id); assert.equal(moved.version, 3);
  assert.equal((await store.artifacts(p.id)).length, 1);
});
test("cancelled and replaced agent leases cannot write files", async () => {
  for (const action of ["cancel", "replace"]) {
    const { store, p, run } = await agentFixture(); await store.claimRun(run.id, p.id); const old = await store.run(run.id, p.id);
    if (action === "cancel") await store.updateRun(old, { status: "cancelled" }, true);
    else { await store.releaseLease(old); await store.claimRun(run.id, p.id); }
    await assert.rejects(executeFileTool(store, old, "write", "write_file", { file_path: "/01_创作/late.md", content: "late output" }));
    assert.equal((await store.artifacts(p.id)).length, 0);
  }
});
test("the file agent completes a tool loop without fixed creative schemas or forced review stages", async () => {
  const { store, p, run } = await agentFixture();
  const responses: AgentMessage[] = [
    call("write", "write_file", { file_path: "/01_创作/自由剧本.md", content: "# 夜归\n\n门打开了。\n\n母亲：饭还热着。", kind: "script" }),
    call("memory", "write_file", { file_path: "/01_创作/项目记忆.md", content: "# 项目记忆\n\n温暖、克制；先写剧本，暂不生成视频。" }),
    { role: "assistant", content: "剧本已保存。" },
  ];
  let count = 0;
  const agent: AgentFunction = async (_system, _messages, tools) => { count++; assert.ok(tools.some((t) => t.function.name === "edit_file")); return responses.shift()!; };
  for (let i = 0; i < 5; i++) await advanceRun(store, p, run.id, config, undefined, agent);
  assert.equal((await store.run(run.id, p.id)).status, "done"); assert.equal(count, 3);
  const files = await store.artifacts(p.id);
  assert.equal(files.length, 2); assert.ok(files.find((f) => f.path.endsWith("自由剧本.md"))?.content.includes("母亲：饭还热着。"));
  assert.equal((await store.messages(p.id)).find((m) => m.runId === run.id)?.content, "剧本已保存。");
});
test("pending tools resume after restart and a committed write is not repeated", async () => {
  const { store, p, run } = await agentFixture(); let modelCalls = 0;
  const agent: AgentFunction = async () => { modelCalls++; return call("write-once", "write_file", { file_path: "/01_创作/草稿.md", content: "# 草稿" }); };
  await advanceRun(store, p, run.id, config, undefined, agent);
  const checkpoint = await store.run(run.id, p.id);
  await advanceRun(new Store(store.db), p, run.id, config, undefined, agent);
  let current = await store.run(run.id, p.id);
  await store.updateRun(current, { payload: checkpoint.payload }, true);
  await advanceRun(new Store(store.db), p, run.id, config, undefined, agent);
  current = await store.run(run.id, p.id);
  assert.equal(modelCalls, 1); assert.equal(current.payload.agent?.toolIndex, 1);
  assert.equal((await store.artifacts(p.id))[0].version, 1);
});
test("new user input arriving during a model call prevents premature completion and is handled next", async () => {
  const { store, p, run } = await agentFixture("先讨论故事"); let count = 0;
  const agent: AgentFunction = async (_system, messages) => {
    count++;
    if (count === 1) { await store.addMessage(p.id, "user", "改成动画喜剧"); return { role: "assistant", content: "第一版想法。" }; }
    assert.ok(messages.some((m) => m.role === "user" && m.content === "改成动画喜剧"));
    return { role: "assistant", content: "已按动画喜剧调整。" };
  };
  await advanceRun(store, p, run.id, config, undefined, agent);
  assert.notEqual((await store.run(run.id, p.id)).status, "done");
  await advanceRun(store, p, run.id, config, undefined, agent);
  assert.equal((await store.run(run.id, p.id)).status, "done");
  assert.equal((await store.messages(p.id)).find((m) => m.runId === run.id)?.content, "已按动画喜剧调整。");
});
test("media completion resumes the agent with a tool result and supports freely named Markdown files", async () => {
  const { store, p, run } = await agentFixture("合成已有镜头");
  const board = await store.putArtifact(p.id, { path: "/01_创作/第3集/导演笔记.md", kind: "document", content: "# 自由分镜" });
  const video = await store.putArtifact(p.id, { path: "/04_视频/任意片段.mp4", kind: "video", content: "", url: "/video" });
  let count = 0;
  const agent: AgentFunction = async (_system, messages) => {
    count++;
    if (count === 1) return call("compose", "compose_video", { file_path: "/07_成片/成片.mp4", clips: [{ video_path: video.path, duration: 3 }] });
    assert.ok(messages.some((m) => m.content?.includes("/07_成片/成片.mp4")));
    return { role: "assistant", content: "成片已保存。" };
  };
  await advanceRun(store, p, run.id, config, undefined, agent);
  await advanceRun(store, p, run.id, config, undefined, agent);
  const child = (await store.children(run))[0]; assert.equal(child.stage, "composing");
  await store.claimRun(child.id, p.id); const lease = await store.run(child.id, p.id);
  await store.finishComposition(lease, "final-object", 0);
  assert.equal((await store.run(child.id, p.id)).status, "done");
  await advanceRun(store, p, run.id, config, undefined, agent);
  assert.equal((await store.run(run.id, p.id)).status, "done"); assert.equal(count, 2);
  assert.equal((await store.artifact(board.id, p.id)).content, "# 自由分镜");
});
test("DeepSeek agent requests use native tools and normal text instead of JSON-only responses", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "deepseek-flash"); assert.equal(body.response_format, undefined);
    assert.equal(body.tools[0].function.name, "list_files");
    return Response.json({ choices: [{ finish_reason: "tool_calls", message: call("list", "list_files", {}) }] });
  });
  const result = await createAgentModel(providerConfig)("system", [{ role: "user", content: "查看项目" }], [
    { type: "function", function: { name: "list_files", description: "List files", parameters: { type: "object", properties: {} } } },
  ]);
  assert.equal(result.tool_calls?.[0].function.name, "list_files");
});

test("the agent can generate one image without a script, storyboard or mandatory creative stages", async (t) => {
  const { store, p, run } = await agentFixture("画一张主角参考图"); let posts = 0, requests = 0;
  const agent: AgentFunction = async (_system, messages) => {
    requests++;
    if (requests === 1) return call("portrait", "generate_image", { file_path: "/03_图片/角色/主角.png", prompt: "A hand-drawn animated character", ratio: "9:16" });
    assert.ok(messages.some((m) => m.content?.includes("主角.png")));
    return { role: "assistant", content: "主角参考图已保存。" };
  };
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posts++; return Response.json({ data: [{ url: "https://media.example.com/portrait.png" }] }); }
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
  });
  const bucket = { put: async () => {} } as unknown as BlobStore;
  await advanceRun(store, p, run.id, providerConfig, bucket, agent);
  await advanceRun(store, p, run.id, providerConfig, bucket, agent);
  const child = (await store.children(run))[0];
  await advanceRun(store, p, child.id, providerConfig, bucket);
  await advanceRun(store, p, child.id, providerConfig, bucket);
  await advanceRun(store, p, run.id, providerConfig, bucket, agent);
  assert.equal((await store.run(run.id, p.id)).status, "done"); assert.equal(posts, 1);
  const files = await store.artifacts(p.id); assert.equal(files.length, 1); assert.equal(files[0].kind, "image");
  assert.equal(files[0].path, "/03_图片/角色/主角.png");
});
test("composition tools use explicit clips and freely chosen output paths instead of requiring a storyboard", async () => {
  const { store, p, run } = await agentFixture("把这段视频导出成竖屏");
  const video = await store.putArtifact(p.id, { path: "/04_视频/镜头.mp4", kind: "video", content: "", url: "/video", metadata: {} });
  let requests = 0;
  const agent: AgentFunction = async (_system, messages, tools) => {
    requests++;
    if (requests === 1) {
      const composition = tools.find(({ function: fn }) => fn.name === "compose_video")?.function;
      assert.match(composition?.description ?? "", /裁短.*duration=15.*拼接/);
      assert.match(JSON.stringify(composition?.parameters), /从该素材的 0 秒开始保留的时长/);
      return call("compose-free", "compose_video", { file_path: "/07_成片/竖屏终版.mp4", ratio: "9:16", resolution: "1080p", fps: 30,
        clips: [{ video_path: video.path, duration: 8, dialogue: "欢迎回家。" }] });
    }
    assert.ok(messages.some((m) => m.content?.includes("竖屏终版.mp4")));
    return { role: "assistant", content: "竖屏成片已保存。" };
  };
  await advanceRun(store, p, run.id, config, undefined, agent);
  await advanceRun(store, p, run.id, config, undefined, agent);
  const child = (await store.children(run))[0]; await store.claimRun(child.id, p.id);
  const lease = await store.run(child.id, p.id), plan = await compositionPlan(store, p, lease);
  assert.equal(plan.project.ratio, "9:16"); assert.equal(plan.shots[0].dialogue, "欢迎回家。");
  assert.deepEqual(plan.output, { ratio: "9:16", resolution: "1080p", width: 1080, height: 1920, fps: 30 });
  assert.equal(lease.payload.sourceVersions[video.id], 1);
  const final = await store.finishComposition(lease, "vertical-final", 0);
  assert.equal(final.path, "/07_成片/竖屏终版.mp4");
  assert.equal(final.metadata.fps, 30); assert.equal(final.metadata.height, 1920);
  await advanceRun(store, p, run.id, config, undefined, agent);
  assert.equal((await store.run(run.id, p.id)).status, "done");
});
test("paid submission rejection and an unknown network outcome have different retry behavior", async (t) => {
  for (const rejection of [true, false]) {
    const { store, p, run } = await agentFixture("生成图片");
    await store.updateRun(run, { stage: "media", payload: { ...run.payload, agent: { messages: [call("img", "generate_image", {})], step: 1, seenUserIds: [], toolIndex: 0, artifactIds: [] },
      operation: { name: "generate_image", toolCallId: "img", path: "/03_图片/test.png", prompt: "test" } } }, true);
    const mock = t.mock.method(globalThis, "fetch", async () => {
      if (rejection) return Response.json({ error: { message: "invalid key ark-private" } }, { status: 401 });
      throw new TypeError("connection lost");
    });
    await advanceRun(store, p, run.id, providerConfig, { put: async () => {} } as unknown as BlobStore);
    const current = await store.run(run.id, p.id);
    assert.equal(current.status, "failed"); assert.equal(current.payload.submissionUnknown, !rejection);
    assert.ok(!current.error?.includes("ark-private"));
    if (!rejection) assert.ok(current.error?.includes("重复计费"));
    mock.mock.restore();
  }
});

test("Markdown links resolve project media relative to their source document", async () => {
  const store = fixture(), p = await store.createProject("alice", {});
  const file = await store.putArtifact(p.id, { path: "/03_图片/第01集/角色 图.png", kind: "image", content: "", url: "/api/studio/image" });
  const files = [file], source = "/01_创作/第01集/分镜.md";
  assert.equal(linkedArtifact(files, source, "../../03_图片/第01集/角色%20图.png")?.id, file.id);
  assert.equal(linkedArtifact(files, source, file.path + "?preview=1#image")?.id, file.id);
  assert.equal(linkedArtifact(files, source, "/api/studio/image")?.id, file.id);
  assert.equal(linkedArtifact(files, source, "../../../03_图片/第01集/角色%20图.png"), undefined);
  assert.equal(linkedArtifact(files, source, "https://example.com/image.png"), undefined);
});
test("long tool history compacts into a durable summary without splitting tool result pairs", async () => {
  const { store, p, run } = await agentFixture("继续创作"), history = await store.messages(p.id);
  const messages: AgentMessage[] = [{ role: "user", content: "写剧本" }];
  for (let i = 0; i < 12; i++) {
    messages.push(call("read-" + i, "read_file", { file_path: "/素材.md" }));
    messages.push({ role: "tool", tool_call_id: "read-" + i, content: "文本".repeat(9000) });
  }
  await store.updateRun(run, { payload: { ...run.payload, agent: { messages, seenUserIds: history.filter((m) => m.role === "user").map((m) => m.id), step: 12, toolIndex: 1, artifactIds: [] } } }, true);
  const agent: AgentFunction = async (_system, compacted, tools) => {
    assert.equal(tools.length, 0);
    assert.equal(compacted.at(-1)?.role, "tool");
    return { role: "assistant", content: "已确认温暖、克制的风格，继续写第二场。" };
  };
  await advanceRun(new Store(store.db, { contextWindow: 64000 }), p, run.id, config, undefined, agent);
  const current = await store.run(run.id, p.id);
  assert.ok(current.payload.agent?.summary?.includes("第二场"));
  assert.ok(JSON.stringify(current.payload.agent?.messages).length < JSON.stringify(messages).length);
});
