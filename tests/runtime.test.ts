import type { BlobStore } from "../lib/studio/storage";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support";
import { Store } from "../lib/studio/store";
import { advanceRun } from "../lib/studio/engine";
import { createAgentModel, type AgentFunction } from "../lib/studio/providers";
import { DEFAULT_SETTINGS, type AgentMessage } from "../lib/studio/types";
import { readModelStream } from "../lib/studio/model-stream";
import { controlRun } from "../lib/studio/control";
import { executeFileTool } from "../lib/studio/file-tools";

const settings = { ...DEFAULT_SETTINGS, videoModel: "doubao-seedance-2-5-260628" as const, textApiKey: "model-test", arkApiKey: "ark-test", minimaxApiKey: "minimax-test" };
async function setup(text = "完成这段动画") {
  const store = fixture(), project = await store.createProject("alice", {});
  await store.addMessage(project.id, "user", text);
  const run = await store.createRun(project.id, { instruction: text, sourceVersions: {} });
  await store.addMessage(project.id, "assistant", "", "main", run.id);
  return { store, project, run };
}
function call(id: string, name: string, args: unknown): AgentMessage {
  return { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}
const done = (content: string): AgentMessage => ({ role: "assistant", content });
function currentRole(messages: AgentMessage[]) {
  const context = messages.findLast((message) => message.source?.kind === "runtime-context")?.source;
  assert.ok(context?.kind === "runtime-context");
  return JSON.parse(context.sections.find((section) => section.name === "identity")!.text).self.role;
}
function stream(records: unknown[], chunkSize = 9) {
  const text = records.map((r) => "data: " + (typeof r === "string" ? r : JSON.stringify(r)) + "\r\n\r\n").join("");
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize)); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
}
const delta = (value: unknown, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta: value, finish_reason }] });

test("streaming joins fragmented Chinese text and parallel tool arguments without executing partial calls", async () => {
  const visible: string[] = [];
  const result = await readModelStream(stream([
    delta({ content: "开始🎬" }), delta({ content: "创作。" }),
    delta({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "read_file", arguments: '{"file_path":' } }, { index: 0, id: "a", type: "function", function: { name: "list_files", arguments: "{" } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: "}" } }, { index: 1, function: { arguments: '"/01_创作/剧本.md"}' } }] }),
    delta({}, "tool_calls"), "[DONE]",
  ], 1), { onText: async (text) => { visible.push(text); } });
  assert.deepEqual(visible, ["开始🎬", "开始🎬创作。"]);
  assert.deepEqual(result.tool_calls?.map((c) => [c.id, JSON.parse(c.function.arguments)]), [["a", {}], ["b", { file_path: "/01_创作/剧本.md" }]]);
});
test("a cut-off stream preserves text callbacks and rejects incomplete tool arguments", async () => {
  let visible = "";
  await assert.rejects(readModelStream(stream([delta({ content: "已输出的文字" }), delta({ tool_calls: [{ index: 0, id: "a", function: { name: "write_file", arguments: '{"content":' } }] })]), { onText: async (text) => { visible = text; } }), /意外结束/);
  assert.equal(visible, "已输出的文字");
});
test("aborting a blocked response cancels the stream and preserves the delivered text", async () => {
  const controller = new AbortController(); let cancelled = false, visible = "";
  const response = new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"保留这句。"},"finish_reason":null}]}\n\n')); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readModelStream(response, { signal: controller.signal, onText: async (text) => { visible = text; controller.abort(new Error("用户已暂停")); } }), /用户已暂停/);
  assert.equal(visible, "保留这句。"); assert.equal(cancelled, true);
});
test("DeepSeek agent calls request streaming and surface content before completion", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)); assert.equal(body.stream, true); assert.equal(body.model, "deepseek-flash");
    return stream([delta({ content: "第一句。" }), delta({ content: "第二句。" }), delta({}, "stop"), "[DONE]"]);
  });
  const visible: string[] = [];
  const result = await createAgentModel(settings)("system", [{ role: "user", content: "开始" }], [], { onText: async (text) => { visible.push(text); } });
  assert.equal(result.content, "第一句。第二句。"); assert.deepEqual(visible, ["第一句。", "第一句。第二句。"]);
});
test("writer and director run independent recoverable contexts and the parent waits for both", async () => {
  const { store, project, run } = await setup("ROOT_ONLY_PRIVATE_CONTEXT");
  let mainCalls = 0, writerCalls = 0, directorCalls = 0;
  const model: AgentFunction = async (_system, messages, tools) => {
    const role = currentRole(messages);
    if (role === "writer") {
      writerCalls++; assert.ok(!messages.some((m) => m.content?.includes("ROOT_ONLY_PRIVATE_CONTEXT")));
      assert.ok(tools.some((t) => t.function.name === "delegate"));
      assert.ok(messages.some((m) => m.content?.includes("remaining levels 0")));
      return writerCalls === 1 ? call("writer-file", "write_file", { file_path: "/01_创作/剧本.md", content: "# 开场\n\n她推开门。" }) : done("剧本已保存。");
    }
    if (role === "director") {
      directorCalls++; assert.ok(!messages.some((m) => m.content?.includes("ROOT_ONLY_PRIVATE_CONTEXT")));
      return directorCalls === 1 ? call("director-file", "write_file", { file_path: "/01_创作/分镜.md", content: "# 镜头\n\n固定机位，门慢慢打开。" }) : done("分镜已保存。");
    }
    mainCalls++;
    if (mainCalls === 1) return { role: "assistant", content: null, tool_calls: [...call("writer", "delegate", { role: "writer", instruction: "写开场并保存" }).tool_calls!, ...call("director", "delegate", { role: "director", instruction: "设计开场镜头并保存" }).tool_calls!] };
    if (mainCalls === 2) {
      const taskIds = messages.filter((message) => message.role === "tool" && ["writer", "director"].includes(message.tool_call_id || ""))
        .map((message) => JSON.parse(message.content!).task_id);
      assert.equal(taskIds.length, 2);
      return call("wait", "wait_for_tasks", { task_ids: taskIds, wait: true });
    }
    return done("剧本与分镜已完成。");
  };
  for (let i = 0; i < 5; i++) await advanceRun(store, project, run.id, settings, undefined, model);
  assert.equal((await store.run(run.id, project.id)).status, "waiting");
  let children = await store.children(run); assert.equal(children.length, 2);
  const restarted = new Store(store.db);
  for (const child of children) for (let i = 0; i < 3; i++) await advanceRun(restarted, project, child.id, settings, undefined, model);
  children = await restarted.children(run); assert.ok(children.every((c) => c.status === "done"));
  await restarted.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id=?").bind(run.id).run();
  await advanceRun(restarted, project, run.id, settings, undefined, model);
  assert.equal((await restarted.run(run.id, project.id)).status, "done");
  assert.equal((await restarted.artifacts(project.id)).length, 2); assert.equal(mainCalls, 3);
});
test("delegation is idempotent per call and the same role can run independent instances", async () => {
  const { store, project, run } = await setup(); await store.claimRun(run.id, project.id);
  const parent = await store.run(run.id, project.id);
  const first = await store.startChild(parent, "first", "writer", "写第一场");
  assert.deepEqual(await store.startChild(parent, "first", "writer", "写第一场"), first);
  const child = await store.run(String(first.task_id), project.id);
  await advanceRun(store, project, child.id, settings, undefined, async () => done("第一场完成。"));
  const next = await store.startChild(parent, "next", "writer", "独立写第二场");
  assert.notEqual(next.task_id, first.task_id); assert.equal(next.generation, 1);
  const nextId = String(next.task_id);
  await advanceRun(store, project, nextId, settings, undefined, async (_system, messages) => {
    assert.ok(!messages.some((m) => m.content === "第一场完成。"));
    assert.ok(messages.some((m) => m.content === "独立写第二场"));
    return done("第二场独立完成。");
  });
  assert.equal((await store.run(nextId, project.id)).resultText, "第二场独立完成。");
  await store.sendAgentMessage(parent, "continue", child.id, "继续修改第一场");
  await advanceRun(new Store(store.db), project, child.id, settings, undefined, async (_system, messages) => {
    assert.ok(messages.some((m) => m.content === "第一场完成。"));
    assert.ok(messages.some((m) => m.content?.includes("继续修改第一场")));
    assert.ok(!messages.some((m) => m.content === "第二场独立完成。"));
    return done("第一场已修改。");
  });
  assert.equal((await store.children(parent)).length, 2);
  assert.equal((await store.run(child.id, project.id)).generation, 2);
  assert.equal((await store.run(child.id, project.id)).resultText, "第一场已修改。");
});
test("new turns carry main history and a new delegation starts with its own assignment", async () => {
  const { store, project, run } = await setup("MAIN_CONTEXT_FIRST_TURN");
  let mainCalls = 0;
  const first: AgentFunction = async (_system, messages) => {
    if (currentRole(messages) === "writer") return done("WRITER_CONTEXT_FIRST_TURN");
    return ++mainCalls === 1 ? call("writer", "delegate", { role: "writer", instruction: "WRITER_ASSIGNMENT_FIRST_TURN" }) : done("第一场已完成。");
  };
  for (let i = 0; i < 2; i++) await advanceRun(store, project, run.id, settings, undefined, first);
  const writer = (await store.children(run))[0];
  await advanceRun(store, project, writer.id, settings, undefined, first);
  await advanceRun(store, project, run.id, settings, undefined, first);
  assert.equal((await store.run(run.id, project.id)).status, "done");
  await store.addMessage(project.id, "user", "继续第二场");
  const next = await store.createRun(project.id, { instruction: "继续第二场", sourceVersions: {} });
  await store.addMessage(project.id, "assistant", "", "main", next.id);
  const delegate: AgentFunction = async (_system, messages) => {
    assert.ok(messages.some((m) => m.content === "MAIN_CONTEXT_FIRST_TURN"));
    assert.ok(messages.some((m) => m.role === "tool" && m.tool_call_id === "writer"));
    return call("writer-next", "delegate", { role: "writer", instruction: "WRITER_ASSIGNMENT_SECOND_TURN" });
  };
  for (let i = 0; i < 2; i++) await advanceRun(store, project, next.id, settings, undefined, delegate);
  const nextWriter = (await store.children(next))[0]; assert.notEqual(nextWriter.id, writer.id);
  await advanceRun(new Store(store.db), project, nextWriter.id, settings, undefined, async (_system, messages) => {
    assert.ok(!messages.some((m) => m.content === "WRITER_CONTEXT_FIRST_TURN"));
    assert.ok(messages.some((m) => m.content === "WRITER_ASSIGNMENT_SECOND_TURN"));
    assert.ok(!messages.some((m) => m.content?.includes("MAIN_CONTEXT_FIRST_TURN")));
    return done("第二场已完成。");
  });
  assert.equal((await store.run(nextWriter.id, project.id)).status, "done");
});
test("parent cancellation stops its descendants and late child output cannot write a file", async () => {
  const { store, project, run } = await setup(); await store.claimRun(run.id, project.id); const parent = await store.run(run.id, project.id);
  const child = await store.startChild(parent, "delegate", "writer", "写开场");
  await advanceRun(store, project, String(child.task_id), settings, undefined, async (_system, _messages, _tools, options) => {
    await options?.onText?.("开场先从门外开始。"); await controlRun(store, parent, "cancel", settings);
    return call("late-write", "write_file", { file_path: "/01_创作/late.md", content: "late" });
  });
  assert.equal((await store.run(run.id, project.id)).status, "cancelled");
  assert.equal((await store.run(String(child.task_id), project.id)).status, "cancelled");
  assert.equal((await store.artifacts(project.id)).length, 0);
});
test("new chat input aborts an obsolete response, retains its visible prefix and handles the new request", async () => {
  const { store, project, run } = await setup("先写悲剧");
  await advanceRun(store, project, run.id, settings, undefined, async (_system, _messages, _tools, options) => {
    await options!.onText!("旧方向的开头。");
    await store.addMessage(project.id, "user", "改成喜剧，先别写文件"); await store.wakeRun(run.id, project.id);
    await new Promise((_, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }));
    return done("unreachable");
  });
  const interrupted = await store.run(run.id, project.id); assert.equal(interrupted.status, "queued"); assert.equal(interrupted.streamText, "旧方向的开头。");
  await advanceRun(store, project, run.id, settings, undefined, async (_system, messages) => {
    assert.ok(messages.some((m) => m.content === "改成喜剧，先别写文件")); return done("按喜剧方向继续讨论。");
  });
  assert.equal((await store.run(run.id, project.id)).status, "done"); assert.equal((await store.artifacts(project.id)).length, 0);
});
test("pausing a live response preserves the prefix and resume includes the interrupted text", async () => {
  const { store, project, run } = await setup();
  await advanceRun(store, project, run.id, settings, undefined, async (_system, _messages, _tools, options) => {
    await options!.onText!("已交付的半段文字"); await store.controlTree(run, "pause");
    await new Promise((_, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true })); return done("unreachable");
  });
  const paused = await store.run(run.id, project.id); assert.equal(paused.status, "paused"); assert.equal(paused.streamText, "已交付的半段文字");
  await controlRun(store, paused, "resume", settings);
  await advanceRun(store, project, run.id, settings, undefined, async (_system, messages) => { assert.ok(messages.some((m) => m.role === "assistant" && m.content === "已交付的半段文字")); return done("继续完成。"); });
  assert.equal((await store.run(run.id, project.id)).status, "done");
});
test("a user can pause generation through the parent while a video task is still waiting", async (t) => {
  const { store, project, run } = await setup("生成视频");
  await store.putArtifact(project.id, { path: "/frame.png", kind: "image", content: "", url: "/frame", metadata: { providerUrl: "https://media.example.com/frame.png" } });
  let mainCalls = 0, externalCreates = 0;
  const model: AgentFunction = async (_system, messages) => {
    mainCalls++;
    if (mainCalls === 1) return call("video", "generate_video", { file_path: "/04_视频/a.mp4", image_path: "/frame.png", prompt: "Open door", duration: 8 });
    const queued = messages.find((m) => m.role === "tool" && m.tool_call_id === "video")!;
    const id = JSON.parse(queued.content!).task_id;
    if (messages.some((m) => m.content === "先停下视频生成")) return call("pause", "control_task", { task_id: id, action: "pause" });
    return call("wait", "wait_for_tasks", { task_ids: [id], wait: true });
  };
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { if (init.method === "POST") externalCreates++; return Response.json({ id: "provider-task" }); });
  await advanceRun(store, project, run.id, settings, undefined, model);
  await advanceRun(store, project, run.id, settings, undefined, model);
  const child = (await store.children(run))[0];
  await advanceRun(store, project, child.id, settings, {} as BlobStore);
  for (let i = 0; i < 2; i++) await advanceRun(store, project, run.id, settings, undefined, model);
  await store.addMessage(project.id, "user", "先停下视频生成"); await store.wakeRun(run.id, project.id);
  await advanceRun(store, project, run.id, settings, undefined, model);
  await advanceRun(store, project, run.id, settings, undefined, model);
  const paused = await store.run(child.id, project.id);
  assert.equal(paused.status, "paused"); assert.equal(paused.payload.providerTaskId, "provider-task"); assert.equal(externalCreates, 1);
});
test("parallel agents cannot overwrite a user's newer file after observing an earlier version", async () => {
  const { store, project, run } = await setup();
  const original = await store.putArtifact(project.id, { path: "/01_创作/剧本.md", kind: "script", content: "# 第一版" });
  await store.claimRun(run.id, project.id); const parent = await store.run(run.id, project.id);
  await store.putArtifact(project.id, { path: original.path, kind: original.kind, content: "# 用户修改", expectedVersion: 1 });
  parent.payload.agent = { messages: [], seenUserIds: [], step: 0, toolIndex: 0, artifactIds: [], observedVersions: { [original.id]: 1 } };
  await assert.rejects(executeFileTool(store, parent, "stale-write", "write_file", { file_path: original.path, content: "# 模型旧稿" }), /新版本/);
  assert.equal((await store.artifact(original.id, project.id)).content, "# 用户修改");
});
test("duplicate media jobs for the same path are rejected before any paid submission", async () => {
  const { store, project, run } = await setup(); await store.claimRun(run.id, project.id); const parent = await store.run(run.id, project.id);
  const payload = { instruction: "image", sourceVersions: {}, operation: { toolCallId: "image", name: "generate_image" as const, path: "/03_图片/角色.png", prompt: "character" } };
  await store.startChild(parent, "first", "media", "image", { stage: "media", payload });
  const child = (await store.children(parent))[0]; await store.controlTree(child, "pause");
  await assert.rejects(store.startChild(parent, "second", "media", "image", { stage: "media", payload }), /已有制作任务/);
  assert.equal((await store.children(parent)).length, 1);
});
test("concurrent parent and director submissions reserve an output path atomically", async () => {
  const { store, project, run } = await setup(); await store.claimRun(run.id, project.id); const parent = await store.run(run.id, project.id);
  const delegated = await store.startChild(parent, "director", "director", "负责制作");
  await store.claimRun(String(delegated.task_id), project.id); const director = await store.run(String(delegated.task_id), project.id);
  const payload = { instruction: "image", sourceVersions: {}, operation: { toolCallId: "image", name: "generate_image" as const, path: "/03_图片/角色.png", prompt: "character" } };
  const results = await Promise.allSettled([store.startChild(parent, "main-image", "media", "image", { stage: "media", payload }), store.startChild(director, "director-image", "media", "image", { stage: "media", payload })]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "OUTPUT_BUSY");
  assert.equal((await store.treeRuns(parent)).filter((r) => r.agentRole === "media").length, 1);
});
test("a full media queue cannot hide a new main conversation from the scheduler", async () => {
  const store = fixture(), payload = { instruction: "work", sourceVersions: {} };
  for (let i = 0; i < 5; i++) { const project = await store.createProject("alice", {}); const job = await store.createRun(project.id, payload); await store.updateRun(job, { stage: "media" }, true); }
  const project = await store.createProject("alice", {}), main = await store.createRun(project.id, payload);
  const due = await store.dueRuns(2);
  assert.equal(due.filter((r) => r.interactive).length, 1); assert.equal(due.find((r) => r.interactive)?.id, main.id);
  assert.equal(due.filter((r) => !r.interactive).length, 2);
});
