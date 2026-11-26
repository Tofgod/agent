import type { BlobStore } from "../lib/studio/storage";
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { fixture } from "./support";
import { Store } from "../lib/studio/store";
import { advanceRun } from "../lib/studio/engine";
import { boundImages, imageDataUrl, inspectImage } from "../lib/studio/images";
import { createAgentModel, retryAfter } from "../lib/studio/providers";
import { CONTEXT_OVERFLOW, readModelStream } from "../lib/studio/model-stream";
import { executeFileTool } from "../lib/studio/file-tools";
import { referencePath } from "../lib/studio/project-layout";
import { readWindow, serializedBytes, TOOL_RESULT_BYTES } from "../lib/studio/read-window";
import { DEFAULT_SETTINGS, type AgentMessage, type ModelUsage } from "../lib/studio/types";

const settings = { ...DEFAULT_SETTINGS, textApiKey: "private-model-key" };
const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAE0lEQVR4nGP8+/cvAwMDCwMYAAAjzAL962fXNwAAAABJRU5ErkJggg==", "base64"));
const done = (content: string): AgentMessage => ({ role: "assistant", content });
const call = (name: string, args: unknown): AgentMessage => ({ role: "assistant", content: null, tool_calls: [{ id: "call-" + name, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
async function setup() {
  const store = fixture(), project = await store.createProject("alice", {});
  const inputId = await store.addMessage(project.id, "user", "检查人物图片");
  const run = await store.createRun(project.id, { instruction: "检查人物图片", sourceVersions: {} });
  await store.addMessage(project.id, "assistant", "", "main", run.id);
  return { store, project, run, inputId };
}
function bucketFor(data: Uint8Array) {
  return { get: async (path: string) => path.includes("/vision/") ? null : ({
    size: data.byteLength, arrayBuffer: async () => Uint8Array.from(data).buffer,
  }) } as unknown as BlobStore;
}
function response(message: AgentMessage, usage?: unknown) { return Response.json({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage }, { headers: { "x-request-id": "request-from-provider" } }); }

test("read_image supplies actual immutable pixels to DeepSeek and records usage without credentials", async (t) => {
  const { store, project, run } = await setup(), key = project.id + "/uploads/first";
  const file = await store.putArtifact(project.id, { path: "/03_图片/角色.png", kind: "image", content: "", url: "/image", metadata: { objectKey: key } });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); calls++;
    if (calls === 1) return response(call("read_image", { file_path: file.path }));
    const tool = body.messages.find((m: { role: string; tool_call_id?: string }) => m.role === "tool" && m.tool_call_id === "call-read_image");
    assert.equal(tool.content[1].type, "image_url"); assert.equal(tool.content[1].image_url.url, "data:image/png;base64," + Buffer.from(png).toString("base64"));
    assert.ok(!JSON.stringify(body).includes("objectKey"));
    return response(done("已读取人物图片。"), { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 50 });
  });
  for (let i = 0; i < 3; i++) await advanceRun(store, project, run.id, settings, bucketFor(png));
  assert.equal((await store.run(run.id, project.id)).status, "done");
  const records = await store.modelCalls(project.id); assert.equal(records.length, 2);
  assert.deepEqual(JSON.parse(String(records[1].usage)), { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 50 });
  const loggedImage = JSON.parse(String(records[1].request)).messages.find((m: { images?: unknown[] }) => m.images?.length).images[0];
  assert.equal(loggedImage.objectKey, key); assert.equal(loggedImage.version, 1);
  assert.equal(records[1].provider_request_id, "request-from-provider");
  assert.ok(!JSON.stringify(records).includes(settings.textApiKey));
});
test("image history keeps the observed file version even after the user replaces the current image", async () => {
  const { store, project } = await setup();
  const file = await store.putArtifact(project.id, { path: "/人物.png", kind: "image", content: "", url: "/image", metadata: { objectKey: project.id + "/uploads/first" } });
  const image = await inspectImage(file, bucketFor(png));
  await store.putArtifact(project.id, { path: file.path, kind: "image", content: "", metadata: { objectKey: project.id + "/uploads/new" }, expectedVersion: 1 });
  let accessed = "";
  const bucket = { get: async (key: string) => { accessed = key; return { size: png.byteLength, arrayBuffer: async () => png.slice().buffer }; } } as unknown as BlobStore;
  await imageDataUrl(image, bucket, project.id); assert.equal(accessed, project.id + "/uploads/first"); assert.equal(image.version, 1);
  await assert.rejects(imageDataUrl(image, bucket, "another-project"), /不属于当前项目/);
  const changedBytes = png.slice();
  changedBytes[changedBytes.length - 1] ^= 1;
  await assert.rejects(imageDataUrl(image, bucketFor(changedBytes), project.id), /图片已不可用/);
});
test("unsupported and oversized image data is refused before entering durable model history", async () => {
  const { store, project } = await setup();
  const file = await store.putArtifact(project.id, { path: "/03_图片/角色.png", kind: "image", content: "", url: "/image", metadata: { objectKey: project.id + "/uploads/a" } });
  await assert.rejects(inspectImage(file, bucketFor(new TextEncoder().encode("this is not an image"))), /无法识别/);
  const damaged = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlqAAAAAASUVORK5CYII=", "base64");
  await assert.rejects(inspectImage(file, bucketFor(damaged)), /像素无法完整解码/);
  const large = png.slice(); new DataView(large.buffer).setUint32(16, 9000);
  await assert.rejects(inspectImage(file, bucketFor(large)), /8192/);
  const tooLarge = { get: async () => ({ size: 31 * 1024 * 1024, arrayBuffer: async () => { throw new Error("must refuse before reading"); } }) } as unknown as BlobStore;
  await assert.rejects(inspectImage(file, tooLarge), /30 MiB/);
});
test("large transparent project images use a reusable bounded visual derivative while the original stays intact", async () => {
  const { store, project } = await setup();
  const key = project.id + "/uploads/original";
  const original = await sharp({ create: { width: 2400, height: 1200, channels: 4, background: "rgba(255,255,255,0.5)" } }).png().toBuffer();
  const objects = new Map<string, Uint8Array>([[key, original]]);
  let writes = 0;
  const bucket = {
    get: async (path: string) => {
      const data = objects.get(path);
      return data ? { size: data.byteLength, arrayBuffer: async () => Uint8Array.from(data).buffer } : null;
    },
    put: async (path: string, data: Uint8Array) => { writes++; objects.set(path, data); },
  } as unknown as BlobStore;
  const file = await store.putArtifact(project.id, { path: "/03_图片/角色.png", kind: "image", content: "", url: "/image", metadata: { objectKey: key } });
  const image = await inspectImage(file, bucket);
  assert.deepEqual([image.sourceWidth, image.sourceHeight, image.width, image.height], [2400, 1200, 2048, 1024]);
  assert.ok(image.bytes <= 4 * 1024 * 1024);
  assert.equal(image.mediaType, "image/webp");
  const variant = objects.get(image.objectKey)!;
  const pixels = await sharp(variant).raw().toBuffer();
  assert.ok(pixels[3] > 0 && pixels[3] < 255);
  assert.deepEqual(await inspectImage(file, bucket), image);
  assert.equal(writes, 1);
  assert.equal(objects.get(key), original);
  assert.equal((await store.artifact(file.id, project.id)).version, file.version);
  assert.equal(await imageDataUrl(image, bucket, project.id), "data:image/webp;base64," + Buffer.from(variant).toString("base64"));
});
test("animated WebP projects the first rendered frame", async () => {
  const { store, project } = await setup();
  const original = await sharp(Buffer.concat([Buffer.alloc(4 * 4 * 3, 8), Buffer.alloc(4 * 4 * 3, 248)]),
    { raw: { width: 4, height: 8, channels: 3, pageHeight: 4 } }).webp({ lossless: true, delay: [200, 200] }).toBuffer();
  assert.equal((await sharp(original).metadata()).pages, 2);
  const key = project.id + "/uploads/motion";
  const file = await store.putArtifact(project.id, { path: "/02_参考/动作.webp", kind: "image", content: "", url: "/image", metadata: { objectKey: key } });
  let prepared: Uint8Array | undefined;
  const source = bucketFor(original);
  const bucket: BlobStore = {
    get: async (path) => path === key ? source.get(path) : null,
    put: async (_path, data) => { assert.ok(data instanceof Uint8Array); prepared = data; },
  };
  const frame = await inspectImage(file, bucket);
  assert.deepEqual([frame.width, frame.height], [4, 4]);
  assert.ok(prepared);
  assert.ok((await sharp(prepared).raw().toBuffer()).every((sample) => sample < 16));
});
test("a malformed tool argument is settled separately and replayed safely on the wire", async (t) => {
  const { store, project, run } = await setup();
  const first = call("write_file", { file_path: "/01_创作/剧本.md", content: "# 已执行" }).tool_calls![0];
  const broken = { ...first, id: "broken", function: { name: "list_files", arguments: "{" } };
  const requests: AgentMessage[][] = [];
  const mock = t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)).messages);
    return requests.length === 1 ? response({ role: "assistant", content: null, tool_calls: [first, broken] }) : response(done("已收到两个回执"));
  });
  for (let step = 0; step < 4; step++) await advanceRun(new Store(store.db), project, run.id, settings);
  assert.equal(mock.mock.callCount(), 2);
  assert.equal((await store.run(run.id, project.id)).status, "done");
  assert.equal((await store.artifacts(project.id))[0]?.content, "# 已执行");
  const batchIndex = requests[1].findIndex((message) => message.tool_calls?.length === 2);
  assert.equal(requests[1][batchIndex].tool_calls?.[1].function.arguments, "{}");
  assert.deepEqual(requests[1].slice(batchIndex + 1, batchIndex + 3).map((message) => message.tool_call_id), [first.id, broken.id]);
  assert.equal(JSON.parse(requests[1][batchIndex + 2].content!).code, "INVALID_ARGS");
  const original = (await store.modelCalls(project.id))[0];
  assert.equal(JSON.parse(String(original.response)).tool_calls[1].function.arguments, "{");
  assert.equal(store.toolStepDispatched(run.id, broken.id), false);
});
test("a stalled model stream retains delivered text and cancels even if transport cleanup hangs", async () => {
  let delivered = "", cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"已收到的内容"}}]}\n\n'));
    },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  });
  await assert.rejects(readModelStream(new Response(body), { idleMs: 15, onText: async (text) => { delivered = text; } }),
    (error: unknown) => (error as { code?: string }).code === "MODEL_TIMEOUT");
  assert.equal(delivered, "已收到的内容");
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("an in-stream context rejection has the same recoverable code as an HTTP context rejection", async () => {
  const frame = "data: " + JSON.stringify({ error: { type: "invalid_request_error", message: "maximum context length exceeded" } }) + "\n\n";
  await assert.rejects(readModelStream(new Response(frame)), (error: unknown) => (error as { code?: string }).code === CONTEXT_OVERFLOW);
});
test("retries recover the model's final saved text beyond the last live flush", async () => {
  const { store, project, run, inputId } = await setup();
  await store.claimRun(run.id, project.id);
  let owned = await store.run(run.id, project.id);
  owned.payload.agent = { messages: [{ role: "user", content: "继续" }], seenUserIds: [inputId],
    step: 0, toolIndex: 0, artifactIds: [], pendingRequest: { id: "stalled-request" } };
  owned = await store.beginModelCall(owned, "stalled-request", { purpose: "creation" });
  await store.publishStream(owned, "stalled-request", "已经显示。");
  await store.settleModelCall(owned, "stalled-request", { status: "failed", errorCode: "MODEL_TIMEOUT", text: "已经显示。最后一段也已收到。" });
  await store.releaseLease(owned);
  await advanceRun(store, project, run.id, settings, undefined, async (_system, messages) => {
    assert.ok(messages.some((message) => message.role === "assistant" && message.content === "已经显示。最后一段也已收到。"));
    assert.ok(messages.some((message) => message.role === "user" && message.content?.includes("上次响应已中断")));
    return done("继续处理。");
  });
  assert.equal((await store.run(run.id, project.id)).status, "done");
});
test("older image occurrences become explicit retained text when the request byte budget is exhausted", () => {
  const image = { id: "a", version: 1, path: "/人物.png", objectKey: "p/a", mediaType: "image/png", bytes: 20 * 1024 * 1024, width: 100, height: 100 };
  const messages = boundImages([{ role: "tool", content: "earlier", images: [image] }, { role: "tool", content: "recent", images: [{ ...image, version: 2 }] }]);
  assert.equal(messages[0].images, undefined); assert.match(messages[0].content!, /人物.png v1/); assert.match(messages[0].content!, /再次查看请调用 read_image/);
  assert.equal(messages[1].images![0].version, 2);
});
test("a completed model call recovers its tool dispatch after process loss without paying for another response", async () => {
  const { store, project, run, inputId } = await setup(); await store.claimRun(run.id, project.id); let owned = await store.run(run.id, project.id);
  owned.payload.agent = { messages: [{ role: "user", content: "write" }], seenUserIds: [inputId], step: 0, toolIndex: 0, artifactIds: [], pendingRequest: { id: "durable-request" } };
  owned = await store.beginModelCall(owned, "durable-request", { purpose: "creation", messages: owned.payload.agent.messages });
  await store.settleModelCall(owned, "durable-request", { status: "completed", response: call("write_file", { file_path: "/01_创作/剧本.md", content: "# 恢复后的剧本" }) });
  await store.releaseLease(owned);
  await advanceRun(new Store(store.db), project, run.id, settings, undefined, async () => { throw new Error("must not request another response"); });
  assert.equal((await store.artifacts(project.id))[0].content, "# 恢复后的剧本");
  assert.equal((await store.modelCalls(project.id)).length, 1);
});
test("a completed final response recovers without another model request", async () => {
  const { store, project, run, inputId } = await setup(); await store.claimRun(run.id, project.id); let owned = await store.run(run.id, project.id);
  owned.payload.agent = { messages: [{ role: "user", content: "question" }], seenUserIds: [inputId], step: 0, toolIndex: 0, artifactIds: [], pendingRequest: { id: "durable-final" } };
  owned = await store.beginModelCall(owned, "durable-final", { purpose: "creation", messages: owned.payload.agent.messages });
  await store.settleModelCall(owned, "durable-final", { status: "completed", response: done("已完成的回答") }); await store.releaseLease(owned);
  await advanceRun(new Store(store.db), project, run.id, settings, undefined, async () => { throw new Error("must not call model"); });
  assert.equal((await store.run(run.id, project.id)).status, "done"); assert.equal((await store.messages(project.id)).find((m) => m.role === "assistant")?.content, "已完成的回答");
});
test("Retry-After is persisted as a due time and failed requests retain safe provider diagnostics", async (t) => {
  const { store, project, run } = await setup(), start = Date.now();
  t.mock.method(globalThis, "fetch", async () => new Response(settings.textApiKey + " rate limited", { status: 429, headers: { "Retry-After": "2", "x-request-id": "rate-limit-request" } }));
  await advanceRun(store, project, run.id, settings);
  const failed = await store.run(run.id, project.id); assert.equal(failed.status, "waiting"); assert.ok(failed.nextAttemptAt >= start + 2000);
  const records = await store.modelCalls(project.id); assert.equal(records[0].status, "failed"); assert.equal(records[0].provider_request_id, "rate-limit-request"); assert.ok(!JSON.stringify(records).includes(settings.textApiKey));
  assert.equal(retryAfter(new Headers({ "Retry-After": "Wed, 01 Jan 2031 00:00:02 GMT" }), Date.parse("2031-01-01T00:00:00Z")), 2000);
});
test("stream usage survives complete SSE framing with CR newlines and comments", async () => {
  const text = ': heartbeat\rdata: {"choices":[{"delta":{"content":"好"},"finish_reason":null}]}\r\rdata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\r\rdata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\rdata: [DONE]\r\r\n';
  let usage: ModelUsage | undefined;
  const result = await readModelStream(new Response(text), { onUsage: async (value) => { usage = value; } });
  assert.equal(result.content, "好"); assert.equal(usage?.totalTokens, 4);
});
test("settled SSE keeps malformed arguments for a per-call diagnostic", async () => {
  const text = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"write_file","arguments":"{"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
  const parsed = await readModelStream(new Response(text));
  assert.equal(parsed.tool_calls?.[0].function.arguments, "{");
});
test("collaborators can message peers and parents durably, with receipt deduplication", async () => {
  const { store, project, run } = await setup(); await store.claimRun(run.id, project.id); const parent = await store.run(run.id, project.id);
  const writerId = String((await store.startChild(parent, "writer", "writer", "写剧本")).task_id), directorId = String((await store.startChild(parent, "director", "director", "做分镜")).task_id);
  await store.claimRun(writerId, project.id); const writer = await store.run(writerId, project.id);
  const result = await store.sendAgentMessage(writer, "peer", directorId, "请保留门后的停顿");
  assert.deepEqual(await store.sendAgentMessage(writer, "peer", directorId, "请保留门后的停顿"), result);
  await store.sendAgentMessage(writer, "parent", parent.id, "需要先确定结尾");
  const restarted = new Store(store.db);
  const received = await restarted.inputs(await restarted.run(directorId, project.id));
  const [assignment, peer] = received;
  assert.equal(received.length, 2);
  assert.deepEqual(assignment.source, { kind: "delegation", senderRunId: parent.id, senderRole: "main" });
  assert.deepEqual(peer, { id: result.message_id, content: "请保留门后的停顿", source: { kind: "agent-message", senderRunId: writer.id, senderRole: "writer" } });
  assert.ok((await restarted.inputs(await restarted.run(parent.id, project.id))).some((m) => m.content.includes("需要先确定结尾")));
  const tasks = await restarted.collaborators(writer); assert.equal(tasks.length, 3);
});
test("messages cannot cross project trees or silently resume paused collaborators", async () => {
  const { store, project, run } = await setup(); await store.claimRun(run.id, project.id); const parent = await store.run(run.id, project.id);
  const childId = String((await store.startChild(parent, "writer", "writer", "写剧本")).task_id);
  await store.controlTree(await store.run(childId, project.id), "pause");
  await assert.rejects(store.sendAgentMessage(parent, "paused", childId, "继续"), /已暂停/);
  const otherProject = await store.createProject("alice", {}), other = await store.createRun(otherProject.id, { instruction: "private", sourceVersions: {} });
  await assert.rejects(store.sendAgentMessage(parent, "cross-project", other.id, "不应投递"), /当前协作会话/);
  assert.equal((await store.inputs(other)).length, 0);
});
test("new projects expose only the eight agreed roots and create subfolders when files are actually written", async () => {
  const { store, project, run } = await setup(); await store.claimRun(run.id, project.id); const actor = await store.run(run.id, project.id);
  const empty = await executeFileTool(store, actor, "list-empty", "list_files", {});
  assert.deepEqual(empty.directories, ["/01_创作", "/02_参考", "/03_图片", "/04_视频", "/05_音频", "/06_字幕", "/07_成片", "/08_记录"]);
  assert.deepEqual(empty.files, []); assert.equal((await store.artifacts(project.id)).length, 0);
  await executeFileTool(store, actor, "write", "write_file", { file_path: "/01_创作/第三集/剧本.md", content: "# 第三集" });
  const next = await executeFileTool(store, actor, "list-next", "list_files", {});
  assert.ok((next.directories as string[]).includes("/01_创作/第三集"));
  assert.ok(!(next.directories as string[]).some((p) => p.includes("第01集")));
  await assert.rejects(executeFileTool(store, actor, "outside", "write_file", { file_path: "/随便建的目录/剧本.md", content: "no" }), /固定一级目录/);
  await assert.rejects(executeFileTool(store, actor, "move-outside", "move_file", { file_path: "/01_创作/第三集/剧本.md", new_path: "/其他/剧本.md" }), /固定一级目录/);
  assert.equal((await store.artifacts(project.id)).length, 1);
});
test("references follow their upload category and media jobs enforce their output category at creation", async () => {
  assert.equal(referencePath("主角.png", "image/png"), "/02_参考/图片/主角.png");
  assert.equal(referencePath("表演.mp4", "video/mp4"), "/02_参考/视频/表演.mp4");
  assert.equal(referencePath("背景.md", "text/markdown"), "/02_参考/资料/背景.md");
  const { store, project, run } = await setup(); await store.claimRun(run.id, project.id); const actor = await store.run(run.id, project.id);
  await assert.rejects(store.startChild(actor, "wrong-output", "media", "image", { stage: "media", payload: { instruction: "image", sourceVersions: {}, operation: { toolCallId: "image", name: "generate_image", path: "/04_视频/角色.png", prompt: "character" } } }), /03_图片/);
  assert.equal((await store.children(actor)).length, 0);
});
test("long Unicode lines can be continued without silently losing characters and every result stays bounded", async () => {
  const { store, project } = await setup(), content = '中文🎬"\\对白'.repeat(6000) + "末尾";
  const file = await store.putArtifact(project.id, { path: "/01_创作/长剧本.md", kind: "script", content });
  let offset: number | null = 1, column = 1, restored = "", pages = 0;
  while (offset !== null) {
    const result = readWindow(file, { offset, column, limit: 200 });
    assert.ok(serializedBytes(result) <= TOOL_RESULT_BYTES);
    restored += result.content.replace(/^1: (?:\[从第\d+个字符继续\] )?/, "");
    offset = result.next_offset; column = result.next_column || 1; assert.ok(++pages < 30);
  }
  assert.ok(pages > 1); assert.equal(restored, content);
});
test("file listings paginate without duplicates and search snippets include matches near the end of long lines", async () => {
  const { store, project, run } = await setup(); await store.claimRun(run.id, project.id); const actor = await store.run(run.id, project.id);
  for (let i = 0; i < 32; i++) await store.putArtifact(project.id, { path: "/01_创作/素材/文档" + i + ".md", kind: "document", content: ("开场".repeat(3000) + "目标词\n").repeat(10) });
  let offset: number | null = 0; const names: string[] = [];
  while (offset !== null) {
    const result = await executeFileTool(store, actor, "list-" + offset, "list_files", { offset, limit: 7 });
    assert.ok(serializedBytes(result) <= TOOL_RESULT_BYTES);
    names.push(...(result.files as { path: string }[]).map((f) => f.path)); offset = result.next_offset as number | null;
  }
  assert.equal(names.length, 32); assert.equal(new Set(names).size, 32);
  const result = await executeFileTool(store, actor, "search", "search_files", { query: "目标词" });
  assert.ok(serializedBytes(result) <= TOOL_RESULT_BYTES); assert.equal(result.truncated, true);
  assert.ok((result.matches as { text: string }[]).every((match) => match.text.includes("目标词")));
});
async function editSetup() {
  const { store, project, run } = await setup();
  const script = await store.putArtifact(project.id, { path: "/01_创作/剧本.md", kind: "script", content: "林夏走进旧宅。\r\n门后传来声音。" });
  const board = await store.putArtifact(project.id, { path: "/01_创作/分镜.md", kind: "storyboard", content: "镜头：林夏推门。" });
  await store.claimRun(run.id, project.id); const actor = await store.run(run.id, project.id);
  actor.payload.agent = { messages: [], seenUserIds: [], step: 0, toolIndex: 0, artifactIds: [], observedVersions: { [script.id]: 1, [board.id]: 1 } };
  return { store, project, actor, script, board };
}
test("batch edits update related documents once, preserve CRLF and replay the committed receipt", async () => {
  const { store, project, actor, script, board } = await editSetup();
  const args = { edits: [{ file_path: script.path, old_string: "林夏走进旧宅。\n门后传来声音。", new_string: "林秋走进旧宅。\n门后传来声音。" }, { file_path: board.path, old_string: "林夏", new_string: "林秋" }] };
  const result = await executeFileTool(store, actor, "batch", "edit_files", args);
  assert.deepEqual(await executeFileTool(store, actor, "batch", "edit_files", args), result);
  assert.equal((await store.artifact(script.id, project.id)).content, "林秋走进旧宅。\r\n门后传来声音。");
  assert.equal((await store.artifact(board.id, project.id)).content, "镜头：林秋推门。");
  assert.ok((await store.artifacts(project.id)).every((f) => f.version === 2));
});
test("a bad match in one batch file prevents changes to every other file", async () => {
  const { store, project, actor, script, board } = await editSetup();
  await assert.rejects(executeFileTool(store, actor, "batch", "edit_files", { edits: [{ file_path: script.path, old_string: "林夏", new_string: "林秋" }, { file_path: board.path, old_string: "不存在的台词", new_string: "别开门" }] }), /不存在/);
  assert.ok((await store.artifacts(project.id)).every((f) => f.version === 1)); assert.equal(await store.toolResult(actor.id, "batch"), null);
});
test("batch commit checks all current versions and locks before changing any file", async () => {
  const { store, project, actor, script, board } = await editSetup();
  await store.putArtifact(project.id, { path: board.path, kind: board.kind, content: "用户修改了镜头", expectedVersion: 1 });
  await assert.rejects(store.editArtifacts(actor, "stale", [{ file: script, version: 1, content: "不应写入" }, { file: board, version: 1, content: "不应写入" }]), /未写入/);
  assert.equal((await store.artifact(script.id, project.id)).version, 1);
  assert.equal((await store.artifact(board.id, project.id)).content, "用户修改了镜头");
  await store.lockArtifact(board.id, project.id, true);
  await assert.rejects(store.editArtifacts(actor, "locked", [{ file: script, version: 1, content: "不应写入" }, { file: board, version: 2, content: "不应写入" }]), /未写入/);
  assert.equal((await store.artifact(script.id, project.id)).version, 1);
});
test("a database failure halfway through a batch rolls back its files, versions and receipt", async () => {
  const { store, project, actor, script, board } = await editSetup();
  const sql = (store.db as unknown as { connection: { exec: (sql: string) => void } }).connection;
  sql.exec("CREATE TRIGGER fail_second_edit BEFORE UPDATE ON artifacts WHEN OLD.path='/01_创作/分镜.md' BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END");
  const args = { edits: [{ file_path: script.path, old_string: "林夏", new_string: "林秋" }, { file_path: board.path, old_string: "林夏", new_string: "林秋" }] };
  await assert.rejects(executeFileTool(store, actor, "batch", "edit_files", args), /simulated disk failure/);
  assert.ok((await store.artifacts(project.id)).every((f) => f.version === 1)); assert.equal((await store.versions(script.id, project.id)).length, 1); assert.equal(await store.toolResult(actor.id, "batch"), null);
  sql.exec("DROP TRIGGER fail_second_edit");
  await executeFileTool(store, actor, "batch", "edit_files", args);
  assert.ok((await store.artifacts(project.id)).every((f) => f.version === 2));
});
test("messages appended within the same millisecond keep insertion order instead of UUID sort order", async () => {
  const store = fixture(), project = await store.createProject("alice", {});
  const run = await store.createRun(project.id, { instruction: "order", sourceVersions: {} });
  const at = "2026-11-17T00:00:00.000Z";
  for (const [id, role, text] of [["z-user", "user", "先写悲剧"], ["m-assistant", "assistant", ""], ["a-user", "user", "改成喜剧"]])
    await store.db.prepare("INSERT INTO messages(id,project_id,role,agent,content,run_id,artifact_ids,created_at) VALUES(?,?,?,'main',?,?, '[]',?)").bind(id, project.id, role, text, role === "assistant" ? run.id : null, at).run();
  assert.deepEqual((await store.messages(project.id)).map((m) => m.id), ["z-user", "m-assistant", "a-user"]);
  assert.deepEqual((await store.inputs(run)).map((m) => m.content), ["先写悲剧", "改成喜剧"]);
});
