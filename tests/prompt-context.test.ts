import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./support";
import { Store } from "../lib/studio/store";
import { advanceRun } from "../lib/studio/engine";
import { createAgentModel, type AgentFunction } from "../lib/studio/providers";
import { projectContextSections, projectRuntimeContext, summaryInput, summaryMessage } from "../lib/studio/runtime-context";
import { estimateMessageTokens, estimateRequestTokens, pricedTokens } from "../lib/studio/context-tokens";
import { deepSeekVisionTokens, requestImagePricing } from "../lib/studio/vision-tokens";
import { loadAgentRoles } from "../lib/studio/agent-roles";
import { CONTEXT_OVERFLOW } from "../lib/studio/model-stream";
import { AppError } from "../lib/studio/security";
import { DEFAULT_SETTINGS, type AgentMessage, type ChatSubmission } from "../lib/studio/types";
import { configureRuntime } from "../server/runtime";
import { PATCH, POST } from "../app/api/studio/[...path]/route";
import { POST as workerPost } from "../app/api/worker/[...path]/route";
import type { BlobStore } from "../lib/studio/storage";

const settings = { ...DEFAULT_SETTINGS, textApiKey: "test-key" };
const done = (content = "已处理当前要求。"): AgentMessage => ({ role: "assistant", content });
const call = (id: string, name: string, args: unknown): AgentMessage => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
async function setup() {
  const store = fixture(), project = await store.createProject("alice", {});
  await store.addMessage(project.id, "user", "只处理当前文字。");
  const run = await store.createRun(project.id, { instruction: "只处理当前文字。", sourceVersions: {} });
  await store.addMessage(project.id, "assistant", "", "main", run.id);
  return { store, project, run };
}

async function chatSetup() {
  const store = fixture(), project = await store.createProject("alice", {});
  const encryptionSecret = "fixture-chat-settings-secret-32-bytes";
  configureRuntime({ database: store.db, media: {} as BlobStore, encryptionSecret, workerSecret: "test", userId: "alice" });
  await store.saveSettings("alice", { textApiKey: settings.textApiKey }, encryptionSecret);
  const send = (input: ChatSubmission) => POST(new Request("http://localhost/api/studio/projects/" + project.id + "/chat", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  }), { params: Promise.resolve({ path: ["projects", project.id, "chat"] }) });
  return { store, project, send };
}

test("pending turns survive reopen, can be edited or cancelled, and promote once in FIFO order", async () => {
  const { store, project, send } = await chatSetup();
  const running = await store.createRun(project.id, { instruction: "当前任务", sourceVersions: {} });
  const firstFile = await store.putArtifact(project.id, { path: "/02_参考/素材.md", kind: "document", content: "# 原文" });
  const input = (text: string, attachmentIds: string[] = []): ChatSubmission => ({ requestId: crypto.randomUUID(), text, attachmentIds, mode: "next-turn" });
  const first = input("排队第一条", [firstFile.id]), cancelled = input("会撤回"), last = input("排队第二条");
  const opening = await store.snapshot(project.id, "alice");
  for (const message of [first, cancelled, last]) assert.ok((await send(message)).ok);
  const after = store.workspaceFrame(project.id, "alice", opening.cursor).frame;
  assert.deepEqual(after?.type === "delta" && after.chatQueue?.map((item) => item.text), ["排队第一条", "会撤回", "排队第二条"]);
  const reopened = new Store(store.db);
  await reopened.dueRuns();
  assert.equal((await reopened.messages(project.id)).length, 0);
  assert.equal((await reopened.run(running.id, project.id)).inputVersion, running.inputVersion);
  await store.putArtifact(project.id, { path: firstFile.path, kind: "document", content: "# 新版本", expectedVersion: 1 });
  const edit = (requestId: string, body: unknown) => PATCH(new Request("http://localhost/chat-queue", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ path: ["projects", project.id, "chat-queue", requestId] }) });
  assert.equal((await edit(first.requestId, { action: "replace", version: 1, text: "修改后发送", attachmentIds: [firstFile.id] })).status, 200);
  assert.equal((await edit(first.requestId, { action: "cancel", version: 1 })).status, 409);
  assert.equal((await edit(cancelled.requestId, { action: "cancel", version: 1 })).status, 200);
  assert.equal((await send(cancelled)).status, 200);

  await store.updateRun(running, { status: "done" }, true);
  await Promise.all([reopened.dueRuns(), new Store(store.db).dueRuns()]);
  const active = (await reopened.snapshot(project.id, "alice"));
  const delivered = active.messages.filter((message) => message.role === "user");
  assert.deepEqual(delivered.map((message) => message.content), ["修改后发送"]);
  assert.equal(delivered[0].attachments?.[0].version, 1);
  assert.deepEqual(active.chatQueue?.map((item) => item.requestId), [last.requestId]);
  const firstRun = active.runs.find((run) => run.status === "queued")!;
  assert.equal((await edit(first.requestId, { action: "cancel", version: 2 })).status, 409);
  assert.equal((await send(first)).status, 200);
  await store.updateRun(firstRun, { status: "done" }, true);
  await reopened.dueRuns();
  const completed = await reopened.snapshot(project.id, "alice");
  assert.deepEqual(completed.messages.filter((message) => message.role === "user").map((message) => message.content), ["修改后发送", "排队第二条"]);
  assert.deepEqual(completed.chatQueue, []);
});

test("moving queued input into the current turn waits for the open step, then delivers the latest edits in move order", async () => {
  const { store, project, run } = await setup();
  const first: ChatSubmission = { requestId: crypto.randomUUID(), text: "先排队的", attachmentIds: [], mode: "next-turn" };
  const second: ChatSubmission = { requestId: crypto.randomUUID(), text: "后排队的", attachmentIds: [], mode: "next-turn" };
  await store.enqueueChat(project.id, first);
  await store.enqueueChat(project.id, second);
  const opened = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const openStep = advanceRun(store, project, run.id, settings, undefined, async (_system, _input, _tools, options) => {
    opened.resolve();
    await release.promise;
    assert.equal(options?.signal?.aborted, false);
    return call("current-work", "write_file", { file_path: "/01_创作/本步.md", content: "当前步骤正常结束。" });
  });
  await opened.promise;
  try {
    const running = await store.run(run.id, project.id);
    await store.editQueuedChat(project.id, second.requestId, { action: "steer", version: 1, runId: run.id });
    await store.editQueuedChat(project.id, first.requestId, { action: "steer", version: 1, runId: run.id });
    await store.editQueuedChat(project.id, first.requestId, { action: "replace", version: 2, text: "编辑后的补充", attachmentIds: [] });
    assert.equal((await store.run(run.id, project.id)).inputVersion, running.inputVersion);
    assert.equal((await store.messages(project.id)).filter((item) => item.requestId).length, 0);
    assert.deepEqual((await store.snapshot(project.id, "alice")).chatQueue?.map((item) => [item.requestId, item.targetRunId]),
      [[second.requestId, run.id], [first.requestId, run.id]]);
  } finally { release.resolve(); await openStep; }
  const reopened = new Store(store.db);
  await advanceRun(reopened, project, run.id, settings);
  assert.equal((await reopened.artifacts(project.id))[0]?.path, "/01_创作/本步.md");
  assert.equal((await reopened.messages(project.id)).filter((item) => item.requestId).length, 0);
  await advanceRun(reopened, project, run.id, settings);
  await advanceRun(new Store(store.db), project, run.id, settings, undefined, async (_system, input) => {
    const contents = input.map((item) => item.content);
    assert.deepEqual(contents.filter((content) => content === "后排队的" || content === "编辑后的补充"), ["后排队的", "编辑后的补充"]);
    assert.ok(!contents.includes("先排队的"));
    assert.ok(input.some((item) => item.role === "tool" && item.tool_call_id === "current-work"));
    return done("已处理补充。");
  });
  assert.equal((await store.run(run.id, project.id)).status, "done");
  assert.equal((await store.messages(project.id)).filter((item) => item.requestId).length, 2);
  assert.deepEqual((await store.snapshot(project.id, "alice")).chatQueue, []);
});

test("cancelling the main turn clears both queues without rerunning the accepted user input", async () => {
  const { store, project, run } = await setup();
  const item = { requestId: crypto.randomUUID(), text: "后续补充", attachmentIds: [] };
  await store.enqueueChat(project.id, item);
  await store.editQueuedChat(project.id, item.requestId, { action: "steer", version: 1, runId: run.id });
  const followup = { requestId: crypto.randomUUID(), text: "下一轮", attachmentIds: [] };
  await store.enqueueChat(project.id, followup);
  await store.controlTree(run, "cancel");
  assert.deepEqual((await store.snapshot(project.id, "alice")).chatQueue, []);
  await new Store(store.db).dueRuns();
  assert.equal((await store.messages(project.id)).filter((message) => message.requestId === item.requestId || message.requestId === followup.requestId).length, 0);
  assert.equal((await store.run(run.id, project.id)).status, "cancelled");
});

test("provider context overflow forces a smaller persisted request even below the configured token threshold", async (t) => {
  const { store, project, run } = await setup();
  const inputs = await store.inputs(run);
  const earlier = "旧决定。" + "角色和场景。".repeat(300);
  const latest = inputs[0].content;
  const messages: AgentMessage[] = [
    { role: "user", content: earlier },
    { role: "assistant", content: "收到旧要求。" },
    { role: "user", content: latest },
  ];
  await store.updateRun(run, { payload: { ...run.payload, agent: {
    messages, seenUserIds: inputs.map((input) => input.id), step: 1, toolIndex: 0, artifactIds: [],
  } } }, true);
  const requests: { messages: AgentMessage[] }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    requests.push(request);
    if (requests.length === 1) return Response.json({ error: { code: "context_length_exceeded", message: "request rejected" } }, { status: 400 });
    const message = done(requests.length === 2 ? "保留旧决定。" : "已处理当前要求。");
    return Response.json({ choices: [{ message, finish_reason: "stop" }] });
  });
  await advanceRun(store, project, run.id, settings);
  assert.equal((await store.run(run.id, project.id)).status, "queued");
  await advanceRun(new Store(store.db), project, run.id, settings);
  await advanceRun(new Store(store.db), project, run.id, settings);
  assert.equal(requests.length, 3);
  assert.match(requests[1].messages[0].content!, /总结此前工作/);
  assert.ok(requests[2].messages.some((message) => message.content === latest));
  assert.ok(!requests[2].messages.some((message) => message.content === earlier));
  assert.equal((await store.modelCalls(project.id)).find((request) => request.status === "failed")?.error_code, CONTEXT_OVERFLOW);
  assert.equal((await store.run(run.id, project.id)).status, "done");
});

test("context overflow retries once from a shortened receipt if the summary fails", async () => {
  const { store, project, run } = await setup();
  const inputs = await store.inputs(run);
  const long = JSON.stringify({ content: "旧工具结果".repeat(3000), path: "/01_创作/旧稿.md" });
  const messages: AgentMessage[] = [
    { role: "user", content: inputs[0].content },
    call("old", "read_file", { file_path: "/01_创作/旧稿.md" }),
    { role: "tool", tool_call_id: "old", content: long },
    call("recent", "list_files", {}),
    { role: "tool", tool_call_id: "recent", content: "{}" },
  ];
  await store.updateRun(run, { payload: { ...run.payload, agent: {
    messages, seenUserIds: inputs.map((input) => input.id), step: 2, toolIndex: 1, artifactIds: [],
  } } }, true);
  const requests: string[] = [];
  const model: AgentFunction = async (system, transcript) => {
    const isSummary = system.startsWith("总结此前工作");
    requests.push(isSummary ? "summary" : "creation");
    const old = transcript.find((message) => message.tool_call_id === "old")!;
    assert.equal(requests.length === 1 ? old.content : JSON.parse(old.content!).context_excerpt, requests.length === 1 ? long : true);
    if (isSummary) throw new AppError("摘要不可用", 401, "MODEL_AUTH");
    throw new AppError("超限", 400, CONTEXT_OVERFLOW);
  };
  for (let tick = 0; tick < 4; tick++) await advanceRun(new Store(store.db), project, run.id, settings, undefined, model);
  assert.deepEqual(requests, ["creation", "summary", "creation"]);
  const failed = await store.run(run.id, project.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, CONTEXT_OVERFLOW);
});

test("independent file reads overlap while the following write and read obey the batch barrier", { timeout: 4500 }, async (t) => {
  const { store, project, run } = await setup();
  const file = await store.putArtifact(project.id, { path: "/01_创作/稿件.md", kind: "document", content: "旧内容" });
  const make = (id: string, name: string, args: unknown) => call(id, name, args).tool_calls![0];
  await advanceRun(store, project, run.id, settings, undefined, async () => ({ role: "assistant", content: null, tool_calls: [
    make("before-a", "read_file", { file_path: file.path }),
    make("before-b", "read_file", { file_path: file.path }),
    make("edit", "write_file", { file_path: file.path, content: "新内容" }),
    make("after", "read_file", { file_path: file.path }),
  ] }));
  const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = store.artifacts.bind(store);
  let reads = 0;
  const mock = t.mock.method(store, "artifacts", async (id: string) => {
    if (++reads === 2) reached.resolve();
    await release.promise;
    return original(id);
  });
  const reading = advanceRun(store, project, run.id, settings);
  try {
    await reached.promise;
    assert.deepEqual((await store.executionHistory(project.id, run.id)).map((step) => step.callId), ["before-a", "before-b"]);
    assert.equal((await store.artifact(file.id, project.id)).version, 1);
  } finally { release.resolve(); await reading; mock.mock.restore(); }
  const state = (await store.run(run.id, project.id)).payload.agent;
  assert.deepEqual(state?.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id), ["before-a", "before-b"]);
  const reopened = new Store(store.db);
  await advanceRun(reopened, project, run.id, settings);
  await advanceRun(reopened, project, run.id, settings);
  assert.match(String((await reopened.toolResult(run.id, "after"))?.content), /新内容/);
  assert.equal((await reopened.artifact(file.id, project.id)).version, 2);
});

test("chat admission rolls back on a missing reply anchor and duplicate requests keep one accepted message", async () => {
  const { store, project, send } = await chatSetup();
  const input = { requestId: crypto.randomUUID(), text: "给我改一下这段对白", attachmentIds: [] };
  await store.db.prepare("CREATE TEMP TRIGGER reject_reply BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'fixture reply failure'); END").run();
  assert.equal((await send(input)).status, 500);
  const rolledBack = await store.snapshot(project.id, "alice");
  assert.deepEqual(rolledBack.messages, []);
  assert.deepEqual(rolledBack.runs, []);
  assert.equal(rolledBack.cursor, 0);
  await store.db.prepare("DROP TRIGGER reject_reply").run();
  assert.deepEqual((await Promise.all([send(input), send(input)])).map((result) => result.status), [200, 200]);
  const admitted = await store.snapshot(project.id, "alice");
  assert.equal(admitted.runs.length, 1);
  assert.equal(admitted.runs[0].inputVersion, 0);
  assert.deepEqual(admitted.messages.map((m) => [m.role, m.requestId, m.runId]), [
    ["user", input.requestId, null], ["assistant", undefined, admitted.runs[0].id],
  ]);
  await advanceRun(store, project, admitted.runs[0].id, settings, undefined, async () => done());
  assert.equal((await send(input)).status, 200);
  const reused = await send({ ...input, text: "另一条消息" });
  assert.equal(reused.status, 409);
  assert.equal((await reused.json()).code, "CHAT_REQUEST_CONFLICT");
  const final = await store.snapshot(project.id, "alice");
  assert.equal(final.runs.length, 1);
  assert.equal(final.runs[0].status, "done");
  assert.equal(final.messages.filter((m) => m.role === "user").length, 1);
});

test("chat attachments follow each message into an active turn and stay project-scoped", async () => {
  const { store, project, send } = await chatSetup();
  const otherProject = await store.createProject("alice", {});
  const first = await store.putArtifact(project.id, { path: "/01_创作/甲.md", kind: "document", content: "甲" });
  const second = await store.putArtifact(project.id, { path: "/01_创作/乙.md", kind: "document", content: "乙" });
  const foreign = await store.putArtifact(otherProject.id, { path: "/02_参考/其他项目.md", kind: "document", content: "不应引用" });
  const rejected = await send({ requestId: crypto.randomUUID(), text: "试着引用", attachmentIds: [first.id, foreign.id] });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, "CHAT_ATTACHMENT_UNAVAILABLE");
  assert.equal((await store.messages(project.id)).length, 0);
  assert.equal((await send({ requestId: crypto.randomUUID(), text: "先看这份", attachmentIds: [first.id] })).status, 200);
  const run = (await store.snapshot(project.id, "alice")).runs[0];
  await advanceRun(store, project, run.id, settings, undefined, async (_system, messages) => {
    const content = messages.find((m) => m.content?.startsWith("先看这份"))?.content;
    assert.ok(content);
    assert.ok(content.includes(first.path));
    assert.ok(!content.includes(second.path));
    return call("list", "list_files", {});
  });
  const input = { requestId: crypto.randomUUID(), text: "现在改这份", attachmentIds: [second.id] };
  assert.equal((await send(input)).status, 200);
  await store.putArtifact(project.id, { path: second.path, kind: second.kind, content: "乙的新版本" });
  assert.equal((await send(input)).status, 200);
  const before = await store.snapshot(project.id, "alice");
  assert.equal(before.runs[0].inputVersion, run.inputVersion);
  assert.deepEqual(before.messages.filter((m) => m.role === "user").map((m) => m.attachments?.map((file) => [file.id, file.version])), [[[first.id, 1]]]);
  assert.deepEqual(before.chatQueue?.map(({ targetRunId, attachments }) => [targetRunId, attachments.map(({ id, version }) => [id, version])]), [[run.id, [[second.id, 1]]]]);
  await advanceRun(store, project, run.id, settings, undefined, async () => assert.fail("当前步先结算工具"));
  await advanceRun(store, project, run.id, settings, undefined, async () => assert.fail("下一步先领取排队输入"));
  let modelCalls = 0;
  await advanceRun(store, project, run.id, settings, undefined, async (_system, messages) => {
    modelCalls++;
    const content = messages.find((m) => m.content?.startsWith("现在改这份"))?.content;
    assert.ok(content);
    assert.ok(messages.findIndex(({ tool_call_id }) => tool_call_id === "list") < messages.findIndex((m) => m.content === content));
    assert.ok(content.includes(second.path));
    assert.ok(!content.includes(first.path));
    assert.ok(content.includes('"currentVersion":2'));
    return done();
  });
  assert.equal(modelCalls, 1);
});

test("the main agent and delegated agents share the directory prompt and use their available tools", async () => {
  const { store, project, run } = await setup();
  const check = (id: string): AgentFunction =>
    async (system, _messages, tools) => {
      const names = tools.map((tool) => tool.function.name);
      assert.equal(names.includes("delegate"), id === run.id);
      assert.ok(!names.includes("web_search")); assert.ok(!system.includes("web_search")); assert.ok(!system.includes("web_fetch"));
      assert.ok(!names.includes("start_production"));
      assert.match(system, /结束本轮，等待用户下一条消息/);
      assert.doesNotMatch(system, /重点处理|运镜|场景和对白/);
      return id === run.id ? call("writer", "delegate", { role: "writer", instruction: "修改人物对白" }) : done();
    };
  await advanceRun(store, project, run.id, { ...settings, webSearchEnabled: false }, undefined, check(run.id));
  await advanceRun(store, project, run.id, settings);
  const child = (await store.children(run))[0];
  await advanceRun(store, project, child.id, { ...settings, webSearchEnabled: false }, undefined, check(child.id));
});

test("restored conversations exclude retired built-in guide text while retaining requested project guides", async () => {
  const { store, project, run } = await setup();
  const userIds = (await store.inputs(run)).map((input) => input.id);
  const legacy = JSON.stringify({ name: "visual", source: "builtin", revision: "builtin:visual:hash", content: "每个镜头按默认标签编写。" });
  const own = JSON.stringify({ name: "visual", source: "project", revision: "project:visual:1", content: "用户为当前项目保存的指南。" });
  await store.updateRun(run, { status: "queued", payload: { ...run.payload, agent: {
    messages: [
      { role: "user", content: "只处理当前文字。" },
      call("legacy-guide", "read_guide", { name: "visual" }),
      { role: "tool", tool_call_id: "legacy-guide", content: legacy },
      call("own-guide", "read_guide", { name: "visual" }),
      { role: "tool", tool_call_id: "own-guide", content: own },
    ],
    seenUserIds: userIds, step: 2, toolIndex: 1, artifactIds: [],
  } } }, true);
  let called = false;
  await advanceRun(new Store(store.db), project, run.id, settings, undefined, async (_system, messages) => {
    called = true;
    assert.doesNotMatch(JSON.stringify(messages), /每个镜头按默认标签编写/);
    assert.equal(JSON.parse(messages.find((message) => message.tool_call_id === "legacy-guide")!.content!).status, "unavailable");
    assert.equal(messages.find((message) => message.tool_call_id === "own-guide")?.content, own);
    return done();
  });
  assert.ok(called);
});

test("native inspection doesn't normalize unrelated editable Markdown or call the creative model", async () => {
  const { store, project, run } = await setup();
  const document = await store.putArtifact(project.id, { path: "/01_创作/随笔.md", kind: "script", content: "# 自由文字\n这里只记录一个动作，无固定场景结构。" });
  await store.updateRun(run, { stage: "inspecting" }, true);
  await advanceRun(store, project, run.id, settings, undefined, async () => { throw new Error("不应因检查视频而请求文字转 JSON"); });
  const current = await store.run(run.id, project.id);
  assert.notEqual(current.status, "failed");
  assert.deepEqual(await store.artifact(document.id, project.id), document);
  assert.equal((await store.modelCalls(project.id)).length, 0);
});

test("saving free Markdown preserves independent media and the worker composes explicit clips without a text model", async () => {
  const { store, project, run } = await setup();
  const board = await store.putArtifact(project.id, { path: "/01_创作/分镜.md", kind: "storyboard", content: "一行自由分镜" });
  const secret = "w".repeat(64);
  configureRuntime({
    database: store.db, media: { put: async () => {}, get: async () => null },
    encryptionSecret: "test", workerSecret: secret, userId: "alice",
  });
  const form = new FormData();
  form.set("file", new File(["fixture"], "现有片段.mp4", { type: "video/mp4" }));
  const uploaded = await POST(new Request("http://localhost/api/studio/projects/" + project.id + "/upload", {
    method: "POST", body: form,
  }), { params: Promise.resolve({ path: ["projects", project.id, "upload"] }) });
  assert.equal(uploaded.status, 200);
  const video = await uploaded.json();
  assert.equal(video.path, "/02_参考/视频/现有片段.mp4");
  assert.equal(video.version, 1);
  assert.equal((await store.versions(video.id, project.id)).length, 1);
  const saved = await PATCH(new Request("http://localhost/api/studio/projects/" + project.id + "/artifacts/" + board.id, {
    method: "PATCH", body: JSON.stringify({ version: board.version, content: "用户修改的自由分镜" }),
  }), { params: Promise.resolve({ path: ["projects", project.id, "artifacts", board.id] }) });
  assert.equal(saved.status, 200);
  assert.equal((await store.artifact(video.id, project.id)).status, "ready");
  const updated = await store.updateRun(run, {
    stage: "composing", payload: { ...run.payload, sourceVersions: { [video.id]: video.version },
      operation: { toolCallId: "compose", name: "compose_video", path: "/07_成片/输出.mp4" },
      composition: { ratio: "9:16", shots: [{ id: "clip", videoId: video.id, duration: 5, dialogue: "" }] },
    },
  }, true);
  const response = await workerPost(new Request("http://localhost/api/worker/jobs/" + updated.id + "/compose", {
    method: "POST", headers: { Authorization: "Bearer " + secret },
  }), { params: Promise.resolve({ path: ["jobs", updated.id, "compose"] }) });
  assert.equal(response.status, 200);
  const plan = await response.json();
  assert.equal(plan.shots[0].video, "/api/worker/media/" + video.id + "?version=1");
  assert.equal(plan.project.ratio, "9:16");
});

test("composition rejects a same-version replacement at the output path during publication", async () => {
  const { store, project, run } = await setup();
  const path = "/07_成片/输出.mp4";
  const original = await store.putArtifact(project.id, { path, kind: "final", content: "", serveMedia: true });
  const clip = await store.putArtifact(project.id, {
    path: "/02_参考/视频/片段.mp4", kind: "video", content: "", serveMedia: true,
  });
  await store.updateRun(run, {
    stage: "composing",
    payload: {
      ...run.payload, sourceVersions: { [clip.id]: clip.version },
      operation: { toolCallId: "compose", name: "compose_video", path },
      composition: { ratio: "16:9", shots: [{ id: "clip", videoId: clip.id, duration: 5, dialogue: "" }] },
    },
  }, true);
  const secret = "w".repeat(64);
  let replacement: Awaited<ReturnType<Store["putArtifact"]>> | undefined;
  configureRuntime({
    database: store.db, encryptionSecret: "test", workerSecret: secret, userId: "alice",
    media: {
      get: async () => null,
      put: async () => {
        await store.moveArtifact(await store.run(run.id, project.id), "move-during-upload", original, "/07_成片/旧成片.mp4");
        replacement = await store.putArtifact(project.id, { path, kind: "final", content: "", serveMedia: true });
      },
    },
  });
  const endpoint = (name: string, body?: FormData) => workerPost(new Request("http://localhost/api/worker/jobs/" + run.id + "/" + name, {
    method: "POST", headers: { Authorization: "Bearer " + secret }, body,
  }), { params: Promise.resolve({ path: ["jobs", run.id, name] }) });
  const planResponse = await endpoint("compose");
  assert.equal(planResponse.status, 200);
  const plan = await planResponse.json();
  const form = new FormData();
  form.set("file", new File(["fixture"], "result.mp4", { type: "video/mp4" }));
  form.set("leaseToken", plan.leaseToken);
  form.set("previousVersion", String(plan.previousVersion));
  if (plan.previousArtifactId) form.set("previousArtifactId", plan.previousArtifactId);
  const completed = await endpoint("complete", form);
  assert.ok(replacement);
  assert.equal(replacement.version, original.version);
  assert.equal(completed.status, 409);
  assert.equal((await completed.json()).code, "VERSION_CONFLICT");
  assert.deepEqual(await store.artifact(replacement.id, project.id), replacement);
});

test("public API cannot start the removed fixed production workflow or schema normalization", async () => {
  const { store, project } = await setup(), before = (await store.snapshot(project.id, "alice")).runs.length;
  configureRuntime({ database: store.db, media: {} as BlobStore, encryptionSecret: "test", workerSecret: "test", userId: "alice" });
  for (const endpoint of ["runs", "normalize", "compose"]) {
    const response = await POST(new Request("http://localhost/api/studio/projects/" + project.id + "/" + endpoint, { method: "POST", body: JSON.stringify({ intent: "produce" }) }), { params: Promise.resolve({ path: ["projects", project.id, endpoint] }) });
    assert.equal(response.status, 404);
  }
  assert.equal((await store.snapshot(project.id, "alice")).runs.length, before);
});

test("changed snapshots append without altering the stable prompt or re-copying unchanged state", async () => {
  const { store, project, run } = await setup();
  const memoryText = "记忆正文不是每次状态变化都需要重复注入。".repeat(1000);
  await store.putArtifact(project.id, { path: "/01_创作/项目记忆.md", kind: "document", content: memoryText });
  const requests: { system: string; messages: AgentMessage[] }[] = [];
  const model: AgentFunction = async (system, messages) => {
    requests.push({ system, messages: structuredClone(messages) });
    if (requests.length === 1) return call("write", "write_file", { file_path: "/01_创作/对白.md", content: "# 对白\n下雨了。" });
    if (requests.length === 2) return call("read", "read_file", { file_path: "/01_创作/对白.md" });
    return done();
  };
  for (let i = 0; i < 5; i++) await advanceRun(new Store(store.db), project, run.id, settings, undefined, model);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].system, requests[2].system);
  assert.equal(requests[0].messages.filter((m) => m.source?.kind === "runtime-context").length, 1);
  assert.equal(requests[2].messages.filter((m) => m.source?.kind === "runtime-context").length, 2);
  assert.deepEqual(requests[2].messages.slice(0, requests[1].messages.length), requests[1].messages);
  assert.ok(!JSON.stringify(requests).includes(memoryText));
  const latest = requests[2].messages.findLast((m) => m.source?.kind === "runtime-context")!;
  assert.match(latest.content!, /包括摘要中保留的旧状态/);
  assert.match(latest.content!, /对白.md/);
  assert.match(latest.content!, /项目记忆.md/);
  assert.equal((await store.run(run.id, project.id)).status, "done");
});

test("context describes the current collaboration tree, with no historical run or six-task cap", async () => {
  const { store, project, run: old } = await setup();
  await store.updateRun(old, { status: "done", stage: "done", error: "旧会话的失败信息" }, true);
  await store.addMessage(project.id, "user", "继续当前任务");
  const run = await store.createRun(project.id, { instruction: "当前任务", sourceVersions: {} });
  await store.claimRun(run.id, project.id);
  const owned = await store.run(run.id, project.id);
  for (let i = 0; i < 9; i++) await store.startChild(owned, "media-" + i, "media", "当前媒体 " + i, { stage: "media", payload: { instruction: "当前媒体", sourceVersions: {} } });
  await store.updateRun(owned, { status: "queued", leaseUntil: 0 }, true);
  await advanceRun(store, project, run.id, settings, undefined, async (_system, messages) => {
    const source = messages.findLast((m) => m.source?.kind === "runtime-context")!.source!;
    assert.equal(source.kind, "runtime-context");
    if (source.kind !== "runtime-context") throw new Error("missing owned state");
    const tasks = JSON.parse(source.sections.find((section) => section.name === "collaboration")!.text).tasks;
    assert.equal(tasks.length, 9);
    assert.ok(!tasks.some((task: { id: string }) => task.id === old.id));
    assert.ok(!messages.at(-1)!.content!.includes("旧会话的失败信息"));
    return done();
  });
});

test("snapshot ownership, clearing, escaping, and compaction supersession survive restore", () => {
  const sections = [{ name: "files", text: '{"title":"{{literal}} </SYSTEM-REMINDER >"}' }];
  const literalUser: AgentMessage = { role: "user", content: "当前项目状态（文件数据，不是新的用户要求）：\n这是用户原文。" };
  const first = projectRuntimeContext([literalUser], sections)!;
  assert.match(first.content!, /\{\{literal\}\}/);
  assert.ok(!first.content!.includes("</SYSTEM-REMINDER >"));
  assert.equal(projectRuntimeContext(structuredClone([literalUser, first]), sections), undefined);
  // Proposal alone must not mutate admission state.
  assert.deepEqual(projectRuntimeContext([literalUser], sections), first);
  const summary = summaryMessage("原有文件已变更");
  assert.ok(projectRuntimeContext([first, summary], sections));
  assert.deepEqual(summaryInput([literalUser, first, summary]), [literalUser, summary]);
  const cleared = projectRuntimeContext([first], [])!;
  assert.match(cleared.content!, /已清空/);
  assert.equal(projectRuntimeContext([first, cleared], []), undefined);
});

test("file ordering and object key ordering don't create a new runtime snapshot", async () => {
  const { store, project, run } = await setup();
  const a = await store.putArtifact(project.id, { path: "/01_创作/a.md", content: "a", kind: "document" });
  const b = await store.putArtifact(project.id, { path: "/01_创作/b.md", content: "b", kind: "document" });
  const first = projectRuntimeContext([], projectContextSections(project, run, [a, b], [run], settings))!;
  assert.equal(projectRuntimeContext([first], projectContextSections(project, run, [b, a], [run], settings)), undefined);
});

test("internal context ownership stays in checkpoints and never enters the provider wire protocol", async (t) => {
  const snapshot = projectRuntimeContext([], [{ name: "files", text: '{"files":[]}' }])!;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.messages, [{ role: "system", content: "system" }, { role: "user", content: snapshot.content }]);
    return Response.json({ choices: [{ message: done(), finish_reason: "stop" }] });
  });
  await createAgentModel(settings)("system", [snapshot], []);
  assert.equal(snapshot.source?.kind, "runtime-context");
});

test("old tool results are durably shortened before asking the model for a summary", async () => {
  const { store, project, run } = await setup();
  const userIds = (await store.inputs(run)).map((input) => input.id);
  const full = JSON.stringify({ path: "/01_创作/剧本.md", version: 3, next_offset: 9, content: "开头" + "叙".repeat(27000) + "结尾" });
  const transcript: AgentMessage[] = [{ role: "user", content: "只处理当前文字。" }];
  for (let i = 0; i < 7; i++) {
    const id = "old-read-" + i;
    transcript.push(call(id, "read_file", { file_path: "/01_创作/剧本.md" }), { role: "tool", tool_call_id: id, content: full });
  }
  assert.ok(JSON.stringify(transcript).length > 160000);
  await store.updateRun(run, { status: "queued", payload: { ...run.payload, agent: {
    messages: transcript, seenUserIds: userIds, step: 7, toolIndex: 1, artifactIds: [],
  } } }, true);
  let modelCalls = 0;
  await advanceRun(new Store(store.db, { contextWindow: 64000 }), project, run.id, settings, undefined, async (system, messages) => {
    modelCalls++;
    assert.ok(!system.startsWith("总结此前"));
    const inputs = messages.filter((m) => m.role === "tool");
    assert.equal(inputs.length, 7);
    assert.equal(inputs.at(-1)?.content, full);
    const shortened = JSON.parse(inputs[0].content!);
    assert.equal(shortened.path, "/01_创作/剧本.md");
    assert.equal(shortened.version, 3);
    assert.equal(shortened.next_offset, 9);
    assert.equal(shortened.context_excerpt, true);
    assert.match(shortened.content, /^开头[\s\S]*省略中段[\s\S]*结尾$/);
    const restored = await new Store(store.db).run(run.id, project.id);
    assert.equal(restored.payload.agent?.messages.find((m) => m.tool_call_id === "old-read-0")?.content, inputs[0].content);
    return done();
  });
  assert.equal(modelCalls, 1);
  const records = await store.db.prepare("SELECT data FROM events WHERE project_id=? AND type='compaction/prune'").bind(project.id).all<{ data: string }>();
  assert.equal(records.results.length, 1);
  const saved = JSON.parse(records.results[0].data);
  assert.equal(saved.replacements.length, 6);
  assert.deepEqual(saved.replacements[0].original, full);
});

test("compaction recovery uses the original covered boundary after owned context is excluded", async () => {
  const { store, project, run } = await setup();
  const userIds = (await store.messages(project.id)).filter((message) => message.role === "user").map((message) => message.id);
  const messages: AgentMessage[] = [];
  for (let i = 0; i < 16; i++) {
    messages.push({ role: "user", content: "用户的实际要求 " + i + "。".repeat(11000) });
    messages.push(projectRuntimeContext([], [{ name: "files", text: '{"files":["旧路径-' + i + '"]}' }])!);
  }
  await store.updateRun(run, { payload: { ...run.payload, agent: { messages, seenUserIds: userIds, step: 16, toolIndex: 0, artifactIds: [] } } }, true);
  const bounded = new Store(store.db, { contextWindow: 64000 });
  await advanceRun(bounded, project, run.id, settings, undefined, async (_system, input) => {
    assert.ok(!input.some((message) => message.source?.kind === "runtime-context"));
    return done("压缩后的决定与用户要求");
  });
  const record = (await store.modelCalls(project.id))[0], request = JSON.parse(String(record.request));
  assert.ok(request.sourceCount > request.messages.length && request.sourceCount < messages.length);
  assert.deepEqual(request.messages, summaryInput(messages.slice(0, request.sourceCount)));
  // Recreate the persisted crash window: response committed, agent state not yet settled.
  const compacted = await store.run(run.id, project.id);
  await store.updateRun(compacted, { status: "queued", payload: { ...run.payload, agent: { messages, seenUserIds: userIds, step: 16, toolIndex: 0, artifactIds: [], pendingRequest: { id: String(record.id) } } } }, true);
  await advanceRun(new Store(store.db, { contextWindow: 64000 }), project, run.id, settings, undefined, async (_system, restored) => {
    assert.equal(restored[0].source?.kind, "compaction");
    assert.deepEqual(restored.filter((message) => !message.source), messages.slice(request.sourceCount).filter((message) => !message.source));
    assert.equal(restored.at(-1)!.source?.kind, "runtime-context");
    assert.match(restored.at(-1)!.content!, /包括摘要中保留的旧状态/);
    return done();
  });
  assert.equal((await store.run(run.id, project.id)).status, "done");
});

test("pressure compaction keeps the committed history when its summary increases the context", async () => {
  const { store, project, run } = await setup();
  const older = "前期角色与场景。".repeat(6000), recent = "近期改了角色的行动动机。".repeat(700);
  await store.updateRun(run, { payload: { ...run.payload, agent: { messages: [
    { role: "user", content: older }, { role: "user", content: recent },
  ], seenUserIds: (await store.inputs(run)).map((item) => item.id), step: 1, toolIndex: 0, artifactIds: [] } } }, true);
  const bounded = () => new Store(store.db, { contextWindow: 32000 });
  await advanceRun(bounded(), project, run.id, settings, undefined, async (system) => {
    assert.match(system, /^总结此前工作/);
    return done(older + " 更长的内容");
  });
  const journal = store.sessionEntries(run.id, project.id);
  assert.equal(journal.at(-1)?.kind, "context/unchanged");
  await advanceRun(bounded(), project, run.id, settings, undefined, async (system, input) => {
    assert.doesNotMatch(system, /^总结此前工作/);
    assert.deepEqual(input.filter(({ source }) => !source).map(({ content }) => content), [older, recent]);
    return done("已结合原始上下文。");
  });
  assert.equal((await store.run(run.id, project.id)).status, "done");
});

test("a large project sends only a bounded directory preview and can read omitted files on demand", async () => {
  const { store, project, run } = await setup();
  const latest = "/01_创作/第999组/目标稿.md";
  for (let index = 0; index < 120; index++) {
    await store.putArtifact(project.id, { path: "/01_创作/第" + String(index).padStart(3, "0") + "组/已有资料和设定.md", kind: "document", content: "大项目正文" });
  }
  await store.putArtifact(project.id, { path: latest, kind: "document", content: "目录预览外的原文" });
  await advanceRun(store, project, run.id, settings, undefined, async (_, messages) => {
    const snapshot = messages.findLast(({ source }) => source?.kind === "runtime-context")!;
    const source = snapshot.source;
    assert.equal(source?.kind, "runtime-context");
    const files = JSON.parse(source.sections.find(({ name }) => name === "files")!.text);
    assert.equal(files.total_files, 121);
    assert.equal(files.read_with, "list_files");
    assert.equal(files.directories.filter((dir: string) => dir.split("/").length === 2).length, 8);
    assert.ok(Buffer.byteLength(snapshot.content!) < 6500);
    assert.ok(!snapshot.content!.includes("大项目正文") && !snapshot.content!.includes(latest));
    return call("find-tail", "list_files", { directory: "/01_创作/第999组" });
  });
  await advanceRun(store, project, run.id, settings, undefined, async () => assert.fail("先结算文件工具"));
  await advanceRun(store, project, run.id, settings, undefined, async (_, messages) => {
    assert.ok(messages.find(({ tool_call_id }) => tool_call_id === "find-tail")?.content?.includes(latest));
    return done("找到目标稿。");
  });
  assert.equal((await store.run(run.id, project.id)).status, "done");
});

test("provider token usage survives reopen and calibrates the next request", async () => {
  const { store, project, run } = await setup();
  let estimated = 0;
  await advanceRun(store, project, run.id, settings, undefined, async (system, messages, tools, options) => {
    estimated = estimateRequestTokens(system, tools, messages);
    await options?.onUsage?.({ inputTokens: 7312, outputTokens: 12, totalTokens: 7324, cachedInputTokens: 2500 });
    return call("list", "list_files", {});
  });
  const reopened = new Store(store.db), updated = await reopened.run(run.id, project.id);
  const meter = updated.payload.agent?.contextMeasurement;
  const key = settings.textBaseUrl + "|" + settings.textModel + "|" + requestImagePricing(settings.textBaseUrl).key;
  assert.deepEqual(meter, { modelKey: key, inputTokens: 7312, estimatedTokens: estimated });
  assert.equal(pricedTokens(estimated + 300, key, meter), 7612);
  assert.equal(pricedTokens(estimated + 300, "new-provider", meter), estimated + 300);
});

test("a local role catalog drives the model's delegate schema and a resumed child keeps its identity", async () => {
  const { store, project, run } = await setup(), directory = await mkdtemp(join(tmpdir(), "doman-agent-roles-"));
  try {
    const path = join(directory, "agents.json");
    await writeFile(path, JSON.stringify([{ id: "editor", name: "剪辑师", description: "检查剪辑及素材衔接",
      textRoute: { provider: "messages", model: "deepseek-flash" } }]));
    const configured = new Store(store.db, { agents: loadAgentRoles(path) });
    await advanceRun(configured, project, run.id, settings, undefined, async (_system, _messages, tools) => {
      const role = tools.find((tool) => tool.function.name === "delegate")?.function.parameters.properties as { role: { enum: string[]; description: string } };
      assert.deepEqual(role.role.enum, ["writer", "director", "editor"]);
      assert.match(role.role.description, /剪辑师/);
      return call("delegate-editor", "delegate", { role: "editor", instruction: "检查当前镜头。" });
    });
    await advanceRun(configured, project, run.id, settings);
    const [child] = await configured.children(run);
    assert.equal(child.payload.agentDefinition?.name, "剪辑师");
    assert.equal(child.payload.childExecution?.route.baseUrl, "https://api.deepseek.com/anthropic");
    await advanceRun(new Store(store.db), project, child.id, settings, undefined, async (_system, messages, tools) => {
      assert.ok(messages.some((message) => message.content?.includes("检查当前镜头")));
      assert.match(messages.at(-1)?.content || "", /剪辑师/);
      assert.ok(tools.some((tool) => tool.function.name === "delegate"));
      assert.match(messages.at(-1)?.content || "", /remaining levels 0/);
      return done("已检查");
    });
    assert.equal((await store.run(child.id, project.id)).status, "done");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("manual compaction is a durable maintenance command and incoming chat keeps its queue order", async () => {
  const { store, project, send } = await chatSetup();
  const input = (text: string) => ({ text, requestId: crypto.randomUUID(), attachmentIds: [] });
  const startTurn = async (text: string, answer: string) => {
    assert.equal((await send(input(text))).status, 200);
    const root = (await store.snapshot(project.id, "alice")).runs.find((run) => run.status === "queued")!;
    assert.ok(root);
    await advanceRun(store, project, root.id, settings, undefined, async () => done(answer));
  };
  const earlier = "角色造型与剧本细节。".repeat(35);
  await startTurn(earlier, "第一轮已记录。");
  await startTurn("第二轮的近期要求", "第二轮完整回答。");

  const command = input("/compact"), during = input("整理中发送"), after = input("整理结束紧接着发送");
  assert.equal((await send(command)).status, 200);
  assert.equal((await send(command)).status, 200);
  assert.equal((await send(input("/compact"))).status, 409);
  let calls = 0;
  const reopened = new Store(store.db);
  await advanceRun(reopened, project, command.requestId, settings, undefined, async (_system, messages, tools) => {
    calls++;
    assert.deepEqual(tools, []);
    assert.ok(messages.some(({ content }) => content === earlier));
    assert.ok(!messages.some(({ content }) => content?.includes("/compact") || content?.includes("第二轮的近期要求")));
    assert.equal((await send(during)).status, 200);
    assert.deepEqual((await store.snapshot(project.id, "alice")).chatQueue?.map((row) => row.requestId), [during.requestId]);
    return done("已有角色造型和剧本。");
  });
  assert.equal(calls, 1);
  assert.equal((await reopened.run(command.requestId, project.id)).status, "done");
  assert.equal((await send(after)).status, 200);
  const snapshot = await reopened.snapshot(project.id, "alice");
  assert.deepEqual(snapshot.chatQueue?.map((row) => row.requestId), [during.requestId, after.requestId]);
  assert.ok(snapshot.messages.some((row) => row.content === earlier));
  assert.match(snapshot.messages.find((row) => row.requestId === command.requestId)?.content || "", /预计减少/);
  assert.ok(!snapshot.messages.some((row) => row.content === "/compact"));
  assert.ok(!snapshot.replies.some((row) => row.runId === command.requestId));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE project_id=? AND type='command/done'").bind(project.id).rows<{ n: number }>()[0].n, 1);
  const [next] = await reopened.dueRuns();
  await advanceRun(reopened, project, next.id, settings, undefined, async (_system, messages) => {
    assert.ok(messages.some((message) => message.source?.kind === "compaction" && message.content?.includes("已有角色造型和剧本")));
    assert.ok(messages.some(({ content }) => content === "第二轮完整回答。"));
    assert.ok(messages.some(({ content }) => content === during.text));
    assert.ok(!messages.some(({ content }) => content === earlier || content === after.text || content?.includes("预计减少")));
    return done();
  });
});

test("manual compaction with empty history needs no model call", async () => {
  const { store, project, send } = await chatSetup();
  const requestId = crypto.randomUUID();
  assert.equal((await send({ requestId, text: "/compact", attachmentIds: [] })).status, 200);
  await advanceRun(new Store(store.db), project, requestId, settings, undefined, async () => assert.fail("历史为空不应请求模型"));
  assert.equal((await store.run(requestId, project.id)).status, "done");
  assert.equal((await store.modelCalls(project.id)).length, 0);
});

test("bulk steering appends only the unchanged selected entries in FIFO order", async () => {
  const { store, project, run } = await setup();
  const entries = ["之前单独送入", "第一条", "第二条", "待编辑", "随后添加"].map((text) => ({ requestId: crypto.randomUUID(), text, attachmentIds: [] }));
  for (const entry of entries) await store.enqueueChat(project.id, entry);
  await store.editQueuedChat(project.id, entries[0].requestId, { action: "steer", version: 1, runId: run.id });
  await store.editQueuedChat(project.id, entries[3].requestId, { action: "replace", version: 1, text: "保留已编辑版本", attachmentIds: [] });
  const reopened = new Store(store.db), selected = entries.slice(1, 4).reverse().map(({ requestId }) => ({ requestId, version: 1 }));
  assert.equal(await reopened.steerQueuedChats(project.id, run.id, selected), 2);
  assert.equal(await reopened.steerQueuedChats(project.id, run.id, selected), 0);
  assert.equal(await store.claimRun(run.id, project.id), true);
  assert.equal(await store.claimStepQueue(await store.run(run.id, project.id)), true);
  assert.deepEqual((await store.messages(project.id)).filter((row) => row.requestId).map((row) => row.content), entries.slice(0, 3).map((row) => row.text));
  assert.deepEqual((await store.snapshot(project.id, "alice")).chatQueue?.map((row) => row.text), ["保留已编辑版本", "随后添加"]);
});

test("native DeepSeek prices actual request image geometry while compatible endpoints retain the estimate", () => {
  assert.equal(deepSeekVisionTokens({ width: 544, height: 544 }), 184);
  assert.equal(deepSeekVisionTokens({ width: 1280, height: 720 }), 578);
  assert.equal(deepSeekVisionTokens({ width: 2048, height: 2048 }), 994);
  const message: AgentMessage = { role: "user", content: "", images: [{
    id: "image", version: 1, path: "/03_图片/图.png", objectKey: "test/image", bytes: 10, mediaType: "image/png", width: 544, height: 544,
  }] };
  assert.equal(estimateMessageTokens(message, requestImagePricing(settings.textBaseUrl).price), 192);
  assert.equal(estimateMessageTokens(message, requestImagePricing("https://compatible.example.com/v1").price), 1032);
});

test("a settled manual summary survives loss of the cached checkpoint without reissuing the request", async () => {
  const { store, project, send } = await chatSetup();
  const earlier = "以前的内容。".repeat(50), recent = "近期内容。";
  const first = await store.addMessage(project.id, "user", earlier);
  const last = await store.addMessage(project.id, "user", recent);
  const id = crypto.randomUUID();
  assert.equal((await send({ requestId: id, text: "/compact", attachmentIds: [] })).status, 200);
  assert.equal(await store.claimRun(id, project.id), true);
  const held = await store.run(id, project.id), request = "settled-compaction";
  const messages: AgentMessage[] = [{ role: "user", content: earlier }, { role: "user", content: recent }];
  const admitted = await store.beginModelCall({ ...held, payload: { ...held.payload, agent: {
    messages, step: 0, toolIndex: 0, seenUserIds: [first, last], artifactIds: [], pendingRequest: { id: request },
  } } }, request, { purpose: "manual-compaction", sourceCount: 1, messages: messages.slice(0, 1) });
  await store.settleModelCall(admitted, request, { status: "completed", response: done("保留早期设定。") });
  await store.db.prepare("UPDATE runs SET lease_until=0,payload=json_remove(payload,'$.agent','$.agentRevision') WHERE id=?").bind(id).run();
  const reopened = new Store(store.db);
  await advanceRun(reopened, project, id, settings, undefined, async () => assert.fail("已有摘要不应重复请求"));
  const finished = await reopened.run(id, project.id);
  assert.equal(finished.status, "done");
  assert.deepEqual(finished.payload.agent?.messages, [summaryMessage("保留早期设定。"), messages[1]]);
  assert.equal((await reopened.modelCalls(project.id)).length, 1);
});
