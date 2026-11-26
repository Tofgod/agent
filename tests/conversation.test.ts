import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixture } from "./support";
import { Store } from "../lib/studio/store";
import { advanceRun } from "../lib/studio/engine";
import { conversationNodes, descendantRunIds, groupAssistantProcess, projectChatFlow, type ConversationNode } from "../lib/studio/conversation";
import { AssistantTurn } from "../components/studio/assistant-turn";
import { mergeChatEchoes, showsInTranscript, type ChatEcho } from "../components/studio/chat-echoes";
import { AppError } from "../lib/studio/security";
import { DEFAULT_SETTINGS, type AgentMessage, type WorkspaceSnapshot } from "../lib/studio/types";
import type { AgentFunction } from "../lib/studio/providers";
const settings = { ...DEFAULT_SETTINGS, textApiKey: "test" };
async function setup() {
  const store = fixture(), project = await store.createProject("alice", {});
  await store.addMessage(project.id, "user", "查看目录后说明结果");
  const run = await store.createRun(project.id, { instruction: "查看目录", sourceVersions: {} });
  await store.addMessage(project.id, "assistant", "", "main", run.id);
  return { store, project, run };
}
function markup(snapshot: WorkspaceSnapshot, runId: string) {
  return renderToStaticMarkup(createElement(AssistantTurn, { run: snapshot.runs.find((r) => r.id === runId), content: snapshot.messages.find((m) => m.runId === runId)?.content || "", control: () => {}, controlBackground: () => {}, runs: snapshot.runs, steps: snapshot.steps, replies: snapshot.replies, count: snapshot.stepCounts[runId] || 0, files: snapshot.artifacts, onOpen: () => {} }));
}
test("delivered project links open in preview while citations retain their external destination", async () => {
  const { store, project, run } = await setup();
  await store.putArtifact(project.id, { path: "/01_创作/雨夜 分镜.md", kind: "storyboard", content: "一镜" });
  await advanceRun(store, project, run.id, settings, undefined, async () => ({
    role: "assistant", content: "已保存 [分镜](</01_创作/雨夜 分镜.md>)。参见 [来源](https://example.com/source)。",
  }));
  const html = markup(await store.snapshot(project.id, "alice"), run.id);
  assert.match(html, /<button class="document-link" title="\/01_创作\/雨夜 分镜.md">分镜<\/button>/);
  assert.match(html, /href="https:\/\/example.com\/source"[^>]*target="_blank"/);
});
test("intermediate replies, actual tools and final text remain ordered after streaming, completion and reload", async () => {
  const { store, project, run } = await setup(); let calls = 0, firstReplyId = "";
  const model: AgentFunction = async (_system, _messages, _tools, options) => {
    calls++;
    if (calls === 1) {
      await options?.onText?.("先查看项目目录，再说明结果。");
      return { role: "assistant", content: "先查看项目目录，再说明结果。", tool_calls: [{ id: "directory", type: "function", function: { name: "list_files", arguments: "{}" } }] };
    }
    await options?.onText?.("正在整理实际结果");
    const streaming = await store.snapshot(project.id, "alice"), html = markup(streaming, run.id);
    assert.equal(streaming.replies[0].id, firstReplyId); assert.match(html, /先查看项目目录/); assert.match(html, /正在整理实际结果/);
    assert.ok(html.indexOf("先查看项目目录") < html.indexOf('data-tool-id="directory"'));
    assert.ok(html.indexOf('data-tool-id="directory"') < html.indexOf("正在整理实际结果"));
    return { role: "assistant", content: "项目目前为空，可以从你的想法开始。" };
  };
  await advanceRun(store, project, run.id, settings, undefined, model);
  firstReplyId = (await store.snapshot(project.id, "alice")).replies[0].id;
  await advanceRun(store, project, run.id, settings, undefined, model);
  await advanceRun(store, project, run.id, settings, undefined, model);
  const reopened = await new Store(store.db).snapshot(project.id, "alice"), html = markup(reopened, run.id);
  assert.equal(reopened.runs[0].status, "done"); assert.equal(reopened.runs[0].streamText, "");
  assert.equal(reopened.replies.length, 2); assert.equal(reopened.replies[0].id, firstReplyId);
  assert.ok(html.indexOf("先查看项目目录") < html.indexOf('data-tool-id="directory"'));
  assert.ok(html.indexOf('data-tool-id="directory"') < html.indexOf("项目目前为空"));
  assert.equal((html.match(/项目目前为空/g) || []).length, 1); assert.ok(!html.includes("已完成"));
  // Durable event anchors determine order even when every operation has the same timestamp.
  for (const reply of reopened.replies) reply.createdAt = "2026-01-01T00:00:00.000Z";
  for (const step of reopened.steps) step.startedAt = "2026-01-01T00:00:00.000Z";
  assert.deepEqual(conversationNodes(descendantRunIds(run.id, reopened.runs), reopened.replies, reopened.steps).map((n) => n.kind), ["reply", "tool", "reply"]);
});
test("an interrupted streamed prefix remains beside the next attempt instead of being overwritten", async () => {
  const { store, project, run } = await setup();
  await advanceRun(store, project, run.id, settings, undefined, async (_system, _messages, _tools, options) => {
    await options?.onText?.("已经说明的中途内容。"); throw new AppError("连接中断", 502, "MODEL_UNAVAILABLE");
  });
  const failed = await store.run(run.id, project.id); await store.updateRun(failed, { status: "queued", nextAttemptAt: 0 }, true);
  await advanceRun(store, project, run.id, settings, undefined, async (): Promise<AgentMessage> => ({ role: "assistant", content: "恢复后继续说明。" }));
  const snapshot = await new Store(store.db).snapshot(project.id, "alice"), html = markup(snapshot, run.id);
  assert.equal(snapshot.replies[0].status, "interrupted"); assert.match(html, /已经说明的中途内容/); assert.match(html, /恢复后继续说明/);
  assert.equal((html.match(/已经说明的中途内容/g) || []).length, 1);
});
test("a delegated reply stays inline and live waiting follows child work while settled waiting anchors at completion", async () => {
  const { store, project, run } = await setup();
  await store.claimRun(run.id, project.id);
  const parent = await store.run(run.id, project.id);
  const { task_id: childId } = await store.startChild(parent, "delegate", "writer", "写一段剧本。") as { task_id: string };
  const wait = { id: "wait-children", type: "function" as const, function: { name: "wait_for_tasks", arguments: "{}" } };
  await store.beginStep(parent, wait);
  await store.updateRun(parent, { status: "waiting", label: "等待子任务" });
  await advanceRun(store, project, childId, settings, undefined, async () => ({
    role: "assistant", content: "先确认项目内容。", tool_calls: [{
      id: "child-file", type: "function", function: { name: "list_files", arguments: "{}" },
    }],
  }));
  await advanceRun(store, project, childId, settings);
  const active = await store.snapshot(project.id, "alice"), activeHtml = markup(active, run.id);
  assert.match(activeHtml, /class="subagent-reply"[^>]*>.*先确认项目内容/);
  assert.doesNotMatch(activeHtml, /<details|等待子任务/);
  assert.equal((activeHtml.match(/role="status"/g) || []).length, 1);
  assert.ok(activeHtml.indexOf('data-tool-id="child-file"') < activeHtml.indexOf('role="status"'));
  const visible = projectChatFlow(active.messages, active.runs, active.replies, active.steps);
  assert.ok(!visible.some((item) => item.nodes?.some((node) => node.kind === "tool" && node.step.callId === wait.id)));

  await advanceRun(store, project, childId, settings, undefined, async (_system, _messages, _tools, options) => {
    await options?.onText?.("正在写的剧本正文");
    const streaming = markup(await store.snapshot(project.id, "alice"), run.id);
    assert.match(streaming, /正在写的剧本正文/);
    assert.doesNotMatch(streaming, /role="status"|<details/);
    return { role: "assistant", content: "剧本正文已保留。" };
  });
  await store.settleSteps(parent, [{ role: "tool", tool_call_id: wait.id, content: '{"status":"settled"}' }]);
  const completed = await new Store(store.db).snapshot(project.id, "alice");
  assert.ok(markup(completed, run.id).indexOf("剧本正文已保留。") < markup(completed, run.id).indexOf("已结束等待"));
  const delta = store.workspaceFrame(project.id, "alice", active.cursor).frame;
  assert.equal(delta?.type === "delta" && delta.steps?.find((step) => step.callId === wait.id)?.eventSeq,
    completed.steps.find((step) => step.callId === wait.id)?.eventSeq);
});
test("compaction summaries stay internal and only their durable marker is shown", async () => {
  const { store, project, run } = await setup();
  await store.claimRun(run.id, project.id); let own = await store.run(run.id, project.id);
  own.payload.agent = { messages: [], seenUserIds: [], step: 0, toolIndex: 0, artifactIds: [], pendingRequest: { id: "compaction" } };
  own = await store.beginModelCall(own, "compaction", { purpose: "compaction", messages: [] });
  await store.settleModelCall(own, "compaction", { status: "completed", response: { role: "assistant", content: "internal summary must stay out of the visible transcript" } });
  const snapshot = await store.snapshot(project.id, "alice"), html = markup(snapshot, run.id);
  assert.match(html, /上下文已自动整理/); assert.ok(!JSON.stringify(snapshot).includes("internal summary must stay out"));
});
test("steering messages split the visible flow so the next reply stays below the new user request", async () => {
  const { store, project, run } = await setup();
  await advanceRun(store, project, run.id, settings, undefined, async (): Promise<AgentMessage> => ({ role: "assistant", content: "先查看现有目录。", tool_calls: [{ id: "before-steering", type: "function", function: { name: "list_files", arguments: "{}" } }] }));
  await store.addMessage(project.id, "user", "改成只讨论人物。");
  await advanceRun(store, project, run.id, settings, undefined, async (): Promise<AgentMessage> => ({ role: "assistant", content: "按新要求讨论人物。" }));
  const snapshot = await new Store(store.db).snapshot(project.id, "alice");
  const flow = projectChatFlow(snapshot.messages, snapshot.runs, snapshot.replies, snapshot.steps);
  assert.deepEqual(flow.map((item) => item.message.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(flow[2].message.content, "改成只讨论人物。");
  assert.equal(flow[1].nodes?.[0].kind, "reply"); assert.equal(flow[3].nodes?.[0].kind, "reply");
  assert.match(JSON.stringify(flow[1].nodes), /先查看现有目录/); assert.ok(!JSON.stringify(flow[1].nodes).includes("按新要求"));
  assert.match(JSON.stringify(flow[3].nodes), /按新要求讨论人物/);
  assert.equal(flow[1].last, false); assert.equal(flow[3].first, false);
});

test("an outgoing bubble keeps one identity through local echo, steering and the durable message", async () => {
  const { store, project, run } = await setup();
  const snapshot = await store.snapshot(project.id, "alice");
  const echo: ChatEcho = { requestId: crypto.randomUUID(), text: "追加这个细节", attachmentIds: [], createdAt: new Date().toISOString(), status: "sending" };
  const projectFlow = (source: WorkspaceSnapshot) => mergeChatEchoes(
    projectChatFlow(source.messages, source.runs, source.replies, source.steps), source, [echo],
  ).filter(({ message }) => message.requestId === echo.requestId);
  const [local] = projectFlow(snapshot);
  assert.equal(local.pending?.echo, echo);
  const input = { ...snapshot, chatQueue: [{ requestId: echo.requestId, text: "后改的细节", attachments: [], targetRunId: run.id, version: 2 }] };
  const admitted = projectFlow(input);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].key, local.key);
  assert.equal(admitted[0].message.content, "后改的细节");
  assert.equal(admitted[0].pending?.steer?.version, 2);
  const finalized = projectFlow({ ...input, messages: [...input.messages, { ...admitted[0].message, id: crypto.randomUUID(), runId: run.id }] });
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].key, local.key);
  assert.equal(finalized[0].pending, undefined);
  const nextTurn = { ...input, chatQueue: [{ ...input.chatQueue[0], targetRunId: undefined }] };
  assert.deepEqual(projectFlow(nextTurn), []);
  assert.equal(showsInTranscript({ ...echo, mode: "next-turn" }), false);
  assert.equal(showsInTranscript({ ...echo, text: "/compact" }), false);
});

test("assistant process groups consecutive tools without absorbing replies", () => {
  const reply = (id: string): ConversationNode => ({ kind: "reply", reply: {
    id, runId: "turn", kind: "reply", content: id, createdAt: "", status: "settled",
  } });
  const tool = (seq: number): ConversationNode => ({ kind: "tool", step: {
    seq, runId: "turn", callId: String(seq), name: "read_file", summary: "", status: "done", startedAt: "", finishedAt: "",
  } });
  const opening = reply("阶段回复"), final = reply("最终答复");
  const first = groupAssistantProcess([opening, tool(1)]);
  const later = groupAssistantProcess([opening, tool(1), tool(2), final, tool(3)]);
  assert.deepEqual(later.map((block) => block.kind === "reply" ? block.reply.content : block.steps.map(({ seq }) => seq)),
    ["阶段回复", [1, 2], "最终答复", [3]]);
  assert.ok(first[1].kind === "process" && later[1].kind === "process");
  assert.equal(first[1].key, later[1].key);
});

test("background tasks put the pause and cancel text after the status", async () => {
  const { store, project, run } = await setup();
  await store.claimRun(run.id, project.id);
  const job = await store.startChild(await store.run(run.id, project.id), "picture", "media", "生成图片", {
    stage: "media", background: true,
    payload: { instruction: "生成图片", sourceVersions: {},
      operation: { toolCallId: "picture", name: "generate_image", path: "/03_图片/云海.png", prompt: "云海" } },
  });
  const html = markup(await store.snapshot(project.id, "alice"), run.id);
  assert.match(html, /<span class="history-target"[^>]*>云海.png<\/span>/);
  assert.match(html, /class="history-state"[^>]*>[^<]+<\/span><div class="background-task-actions"><button[^>]+>暂停<\/button><button[^>]+>取消<\/button>/);
  assert.doesNotMatch(html, /aria-haspopup="menu"|lucide-square/);
  await store.controlTree(await store.run(String(job.task_id), project.id), "pause");
  assert.match(markup(await store.snapshot(project.id, "alice"), run.id), /background-task-actions"><button[^>]+>继续<\/button><button[^>]+>取消<\/button>/);
});
