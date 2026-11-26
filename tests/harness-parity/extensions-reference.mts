import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import { LlmAdapter, LlmError, ToolCallId, createMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { createScope, scopeOf } from "@deepseek-ai/dsh-scope";
import McpServerManager from "@deepseek-ai/dsh-mcp-manager";
import * as ScheduleTools from "@deepseek-ai/dsh-tool-schedule";
import { z } from "zod";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import * as SkillFileSystem from "@deepseek-ai/dsh-skill-filesystem";
import * as ToolSkill from "@deepseek-ai/dsh-tool-skill";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { mountAgentLoopTestDependencies } from "@deepseek-ai/dsh-agent-loop-testkit";
import * as JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import Storage from "@deepseek-ai/dsh-storage";
import * as StorageDomain from "@deepseek-ai/dsh-storage-domain";
import * as StorageJson from "@deepseek-ai/dsh-storage-json";
import SubagentRuntime from "@deepseek-ai/dsh-subagent";
import * as SubagentSpawn from "@deepseek-ai/dsh-subagent-spawn-in-process";
import * as ToolSubagent from "@deepseek-ai/dsh-tool-subagent";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import * as NativeToolExecutor from "@deepseek-ai/dsh-tool-executor-native";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import McpResources from "@deepseek-ai/dsh-mcp-resources";
import { defineContentToolFixture, executeToolFixture } from "@deepseek-ai/dsh-tool-testkit";
import { cutPrompt, cutToolId, futureReply, mcpScript, mcpServer, scheduleCases, skillFiles, skillRoot } from "./extension-cases.mjs";
import { largeSkillBody, mcpConcurrentRefresh, normalizeSkillBlock, resumePrompt, schedulePrompt, scheduleTimingFixture,
  scheduleTitle, scheduleTitleAfter, settledReply, sharedSkillBody, skillGesture, traceNoise, hooksQuery, hookResult } from "./extension-cases.mjs";
import { mcpAdmissionCases, mcpAdmissionServer } from "./extension-cases.mjs";

const source = (path) => pathToFileURL(join(process.cwd(), path)).href;
const text = (message) => message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
const blocks = (value) => [{ type: "text", text: value }];
const user = (value) => createUserMessage({ content: blocks(value), source: { kind: "user" } });
const route = { provider: "fixture", model: "fixture" };
class Adapter extends LlmAdapter {
  constructor(respond) { super(); this.respond = respond; }
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async *stream(request) {
    const answer = await this.respond(request);
    if (typeof answer === "string") {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: answer };
      yield { type: "block-end", index: 0, block: blocks(answer)[0] };
      yield { type: "finish", reason: { kind: "stop" } };
    } else {
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "block-end", index: 0, block: { type: "tool-call", id: ToolCallId(answer.id), name: answer.name, arguments: JSON.stringify(answer.args) } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
    }
  }
}
async function withLoop(root, setup, run) {
  const ctx = new Context();
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
    await ctx.plugin(JsonlSessionPersistence, { root, compression: "none" });
    await setup(ctx);
    await ctx.plugin(AgentLoop, { agents: [] });
    return await run(ctx);
  } finally { await ctx.fiber.dispose(); }
}
async function until(read, accepted) {
  let value;
  for (let i = 0; i < 150; i++) {
    value = await read();
    if (accepted(value)) return value;
    await delay(20);
  }
  assert.fail("Harness fixture did not converge: " + JSON.stringify(value));
}

async function referenceAlignment(root, ctx) {
  const result = {};
  const sessionId = SessionId("cold-continuation"), persisted = join(root, "journal");
  let writes = 0;
  const register = async (context) => context.tools.register(defineContentToolFixture({
    name: "write_file", description: "Store cut.md", parameters: {},
    async execute() { writes++; return blocks("cut.md committed"); },
  }));
  await withLoop(persisted, register, async (context) => {
    let attempt = 0;
    context.llm.registerAdapter([route.provider], new Adapter(() => attempt++ === 0
      ? { id: cutToolId, name: "write_file", args: {} } : futureReply));
    const agent = await context.agentLoop.create(sessionId, route);
    agent.followup(user(cutPrompt));
    await agent.whenIdle();
    assert.equal(writes, 1);
    assert.ok(await context.sessions.flush(agent.session));
  });
  await withLoop(persisted, register, async (context) => {
    context.llm.registerAdapter([route.provider], new Adapter(({ messages }) => {
      result["Cold conversation continuation includes its committed tool receipt"] = {
        user: messages.some((message) => text(message) === resumePrompt),
        reply: messages.some((message) => text(message) === futureReply),
        receipt: messages.some((message) => message.role === "tool" && message.toolCallId === cutToolId && text(message).includes("cut.md")),
      };
      return "continued";
    }));
    const { agent } = await context.agents.resume({ resumeSessionId: sessionId });
    agent.followup(user(resumePrompt));
    await agent.whenIdle();
    assert.equal(writes, 1);
  });

  const [{ registerTrajectoryAssistantDefinition }, { trajectoryViewDefinition }, { ConversationNodeAssembler }] = await Promise.all([
    import(source("packages/client/ui-trajectory/src/client/trajectory-assistant-definition.ts")),
    import(source("packages/client/ui-trajectory/src/client/trajectory-snapshot-builder.ts")),
    import(source("packages/client/ui-conversation/src/client/conversation/assembler.ts")),
  ]);
  const definitions = [];
  registerTrajectoryAssistantDefinition({ uiConversation: { events: { register: (definition) => definitions.push(definition) } } });
  const assembler = new ConversationNodeAssembler({ entries: () => definitions, fallbackEntry: () => undefined },
    { entries: () => [trajectoryViewDefinition] });
  const at = (seq, type, data) => ({ type: "event", event: { seq, time: 1_700_000_000_000 + seq, type, data } });
  assembler.replaceWindow([at(1, "turn/start", { turn: 1 }), at(2, "step/start", { turn: 1, step: 1 })], false);
  assembler.activateTarget("trajectory");
  const open = assembler.get("trajectory").requests[0];
  for (let i = 0; i < traceNoise; i++) assembler.append(at(i + 3, "turn/start", { turn: i + 2 }));
  assembler.flush();
  assert.equal(assembler.get("trajectory").requests[0].status, "running");
  assembler.append(at(traceNoise + 3, "assistant/message", { turn: 1, step: 1, stream: [],
    message: { id: "late", role: "assistant", content: blocks(settledReply), source: { kind: "model", ...route } } }));
  assembler.flush();
  const closed = assembler.get("trajectory").requests[0];
  result["Trajectory settles the original request after a 101-event gap"] = {
    wasRunning: open.status === "running", sameRow: closed.startSeq === open.startSeq, settled: closed.status === "complete",
  };

  await withLoop(join(root, "delegation"), async (context) => {
    const { TestSessionQuery } = await import(source("packages/subagent/subagent/tests/test-session-query.ts"));
    await context.plugin(TestSessionQuery);
    await context.plugin(SubagentRuntime);
    await context.plugin(SubagentSpawn, { providerName: "spawn" });
    await context.plugin(ToolSubagent, { provider: "spawn", toolName: "delegate", maxDepth: 1 });
  }, async (context) => {
    let attempt = 0;
    const depth = { offered: false, advised: false, denied: false, spawned: false };
    context.llm.registerAdapter([route.provider], new Adapter(({ messages, tools }) => {
      if (attempt++ === 0) {
        depth.offered = tools.some(({ name }) => name === "delegate");
        depth.advised = messages.some((message) => text(message).includes("current 1, maximum 1, remaining levels 0"));
        return { id: "at-cap", name: "delegate", args: { description: "Try an additional child", prompt: "Try an additional child" } };
      }
      depth.denied = messages.some((message) => message.role === "tool" && message.toolCallId === "at-cap" && message.isError && /depth/i.test(text(message)));
      return "completed directly";
    }));
    const lead = await context.agentLoop.create(SessionId("depth-lead"), route);
    const child = await context.subagents.startActivation({ provider: "spawn", label: "Assign a child", name: "child",
      prompt: blocks("Work at maximum depth."), parent: lead, signal: AbortSignal.timeout(3000), delivery: "caller", maxDepth: 1 });
    const agent = context.agents.get(child.childId);
    assert.ok(agent);
    await agent.whenIdle();
    depth.spawned = agent.session.snapshotEvents().some(({ type }) => type === "subagent/catalog");
    result["Delegation stays visible at the limit and refuses to spawn"] = depth;
  });

  const skillHome = join(root, "skill-home");
  for (const [name, content] of [["shared-skill", sharedSkillBody], ["large-skill", largeSkillBody]]) {
    const directory = join(skillHome, "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "---\nname: " + name + "\ndescription: Fixture\n---\n" + content);
  }
  await withLoop(join(root, "skills-log"), async (context) => {
    await context.plugin(SkillRegistry);
    await context.plugin(SkillFileSystem, { dshHome: skillHome, agentsHome: join(root, "skill-agents"), watch: false });
    await context.plugin(ToolSkill);
  }, async (context) => {
    const skill = { direct: "", tool: "", large: (await context.skills.get("large-skill", { cwd: skillHome })).content.length };
    let attempt = 0;
    context.llm.registerAdapter([route.provider], new Adapter(({ messages }) => {
      if (attempt++ === 0) {
        skill.direct = normalizeSkillBlock(messages.map(text).find((value) => value.startsWith("<skill_content")) ?? "");
        return { id: "skill-load", name: "skill", args: { name: "shared-skill" } };
      }
      const output = messages.find((message) => message.role === "tool" && message.toolCallId === "skill-load");
      skill.tool = normalizeSkillBlock(output ? text(output) : "");
      return "skill read";
    }));
    const agent = await context.agentLoop.create(SessionId("skills-alignment"), route);
    agent.followup(user(skillGesture));
    await agent.whenIdle();
    result["Skills return the same model block from user and tool and read a long source"] = skill;
  });

  const mcpConfig = (serverName, script) => ({ serverName, transport: "stdio", command: process.execPath, env: {},
    args: ["-e", script], startupTimeoutMs: 3000, closeTimeoutMs: 1500, failOnStartupError: true });
  const probe = await McpClient.probeServer(ctx, mcpConfig("list-failure", mcpScript(false, true)));
  assert.ok(!probe.ok);
  await ctx.plugin(McpClient, mcpConfig("changing", mcpConcurrentRefresh));
  const poke = ctx.tools.schemas().find(({ name }) => name.startsWith("mcp__changing__poke"));
  assert.ok(poke);
  const invoked = await executeToolFixture(ctx, { name: poke.name, arguments: {}, callId: ToolCallId("poke"), signal: AbortSignal.timeout(2000) });
  assert.equal(invoked.isError, false);
  const current = await until(() => ctx.tools.schemas().map(({ name }) => name),
    (names) => names.some((name) => name.startsWith("mcp__changing__latest")));
  result["MCP reports failed probe cleanup and serializes tool list changes"] = {
    failed: !probe.ok, stage: probe.stage, closed: probe.closeConfirmed, latest: true,
    overlapped: current.some((name) => name.startsWith("mcp__changing__overlapped")),
  };

  for (const action of mcpAdmissionCases) await withLoop(join(root, "mcp-admission-" + action), async (context) => {
    await context.plugin(McpClient, { ...mcpConfig("admission", mcpAdmissionServer), reconnect: { enabled: false } });
  }, async (context) => {
    const tool = context.tools.schemas().find(({ name }) => name.startsWith("mcp__admission__invoke"));
    const control = context.tools.schemas().find(({ name }) => name.startsWith("mcp__admission__poke"));
    assert.ok(tool && control);
    let calls = 0;
    context.llm.registerAdapter([route.provider], new Adapter(async () => {
      const step = calls++;
      if (step === 1 && action !== "disconnect") return { id: "reselected", name: tool.name, args: { value: action === "schema" ? 3 : "updated" } };
      if (step) return "settled";
      await executeToolFixture(context, { name: control.name, arguments: { action }, callId: ToolCallId("poke"), signal: AbortSignal.timeout(2000) });
      if (action === "disconnect") await delay(140);
      else await until(() => context.tools.schemas(), (tools) => tools.some(({ name }) => name.startsWith("mcp__admission__witness")));
      return { id: "admitted", name: tool.name, args: { value: "original" } };
    }));
    const session = await context.agentLoop.create(SessionId("mcp-admission"), route);
    session.followup(user("Call the admitted tool"));
    await session.whenIdle();
    const [receipt, reselected] = session.session.snapshotEvents().filter(({ type }) => type === "tool/result");
    assert.ok(receipt);
    assert.ok(!text(receipt.data.message).includes("runner accepted admitted call"));
    if (action !== "disconnect") assert.ok(reselected && text(reselected.data.message).includes("runner accepted admitted call"));
    result["MCP admission during " + action] = { executed: text(receipt.data.message).includes("runner accepted admitted call"),
      ...(action !== "disconnect" ? { reselected: Boolean(reselected && text(reselected.data.message).includes("runner accepted admitted call")) } : {}) };
  });

  await withLoop(join(root, "schedule-log"), async (context) => {
    const { default: Schedule } = await import(source("packages/schedule/schedule/src/index.ts"));
    await context.plugin(Storage);
    await context.plugin(StorageJson, { root: join(root, "schedule-db") });
    await context.plugin(StorageDomain, { backend: "json" });
    await context.plugin(Schedule);
    await context.plugin(ScheduleTools);
  }, async (context) => {
    const target = await context.agentLoop.create(SessionId("schedule-target"), route);
    const create = (id, selection) => executeToolFixture(context, { agent: target, name: "schedule_create",
      arguments: { title: scheduleTitle, prompt: schedulePrompt, rrule: scheduleTimingFixture.rrule, ...(selection ? { target: selection } : {}) },
      callId: ToolCallId(id), signal: AbortSignal.timeout(3000) });
    const omitted = await create("no-target");
    const selected = await create("with-target", "this_session");
    assert.equal(omitted.isError, true);
    assert.equal(selected.isError, false);
    result["Schedule requires a target and reports pruned history"] = { omitted: !omitted.isError, explicit: !selected.isError };
    const task = await context.schedule.create({ title: scheduleTitle, prompt: schedulePrompt, timing: scheduleTimingFixture,
      target: { kind: "session", sessionId: target.session.id } }, target.session.id);
    const idle = [], active = [];
    const notices = (messages) => messages.filter(({ source }) => source?.kind === "schedule")
      .map((message) => text(message).match(/^change: (.+)$/gm).at(-1).slice(8));
    context.llm.registerAdapter([route.provider], new Adapter(async ({ messages }) => {
      const latest = messages.filter(({ source }) => source?.kind === "user").at(-1);
      if (text(latest) === schedulePrompt) idle.push(notices(messages));
      if (text(latest) === schedulePrompt + " During the response.") {
        active.push(notices(messages));
        if (active.length === 1) {
          await context.schedule.edit({ id: task.id, action: "update", patch: { title: scheduleTitle } });
          await until(() => target.inbox.nextStep.length, (length) => length === 1);
        }
      }
      return "read edit";
    }));
    target.followup(user("Prime"));
    await target.whenIdle();
    const countTurns = () => target.session.snapshotEvents().filter(({ type }) => type === "turn/start").length;
    const before = countTurns();
    await context.schedule.edit({ id: task.id, action: "update", patch: { title: scheduleTitleAfter } });
    await until(() => target.inbox.nextStep.length, (length) => length === 1);
    const woke = countTurns() !== before;
    target.followup(user(schedulePrompt));
    await target.whenIdle();
    target.followup(user(schedulePrompt + " During the response."));
    await target.whenIdle();
    result["Schedule edits reach the next request without opening an idle turn"] = { woke, idle, active };
  });

  const { appendDelivery, deliveryHistoryPage } = await import(source("packages/schedule/schedule/src/delivery-history.ts"));
  let retained = { id: "audit", record: { prompt: schedulePrompt }, deliveryHistory: {
    records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false } };
  const bounds = { days: 30, records: 1 };
  for (let index = 0; index < 2; index++) {
    const timestamp = new Date(2_000_000_000_000 + index * 60_000).toISOString();
    retained = { ...retained, ...appendDelivery(retained, { messageId: "receipt-" + index, scheduledAt: timestamp,
      deliveredAt: timestamp, targetSessionId: "fixed" }, bounds) };
  }
  const page = deliveryHistoryPage(retained, { id: retained.id, limit: 20 }, bounds);
  Object.assign(result["Schedule requires a target and reports pruned history"], {
    retained: page.records.length, unavailable: page.earlierRecordsUnavailable, pruned: page.earlierRecordsPruned,
  });

  await withLoop(join(root, "hooks"), async (context) => {
    await context.sessionProjections.register({
      key: "audit/receipt", stateSchema: z.boolean(), init: () => false, stateVersion: 1,
      apply: (state, event) => state || event.type === "tool/result" && text(event.data.message) === hookResult,
      wire: { viewSchema: z.boolean(), view: (state) => state },
    });
  }, async (context) => {
    const metrics = { preStep: 0, retries: 0, denied: 0, ran: 0, projected: false, deniedSeen: false };
    const agent = await context.agentLoop.create(SessionId("scoped-hooks"), route);
    agent.ctx.on("agent/pre-step", async (_input, next) => { metrics.preStep++; return next(); });
    agent.ctx.on("agent/request-error", () => { metrics.retries++; return { kind: "retry" }; });
    agent.ctx.on("tools/pre-execute", (exec, next) => {
      if (exec.name !== "audit_block") return next();
      metrics.denied++;
      return { kind: "deny", reason: "audit denied" };
    });
    agent.ctx.on("tools/post-execute", (exec, _outcome, next) => exec.name === "audit_run"
      ? { kind: "accept", content: blocks(hookResult) } : next());
    for (const name of ["audit_block", "audit_run"]) context.tools.register(defineContentToolFixture({
      name, description: name, parameters: {}, async execute() { metrics.ran++; return blocks("before projection"); },
    }));
    let attempts = 0;
    context.llm.registerAdapter([route.provider], new Adapter(({ messages }) => {
      if (messages.some((message) => text(message) === "Outside witness")) return "finished";
      const replies = messages.filter(({ role }) => role === "tool").map(text);
      if (attempts++ === 0) throw new LlmError("fixture auth", "AUTH");
      if (!replies.length) return { id: "blocked", name: "audit_block", args: {} };
      metrics.deniedSeen = replies.some((reply) => reply.includes("audit denied"));
      if (replies.length === 1) return { id: "projected", name: "audit_run", args: {} };
      metrics.projected = replies.includes(hookResult);
      return "finished";
    }));
    agent.followup(user(hooksQuery));
    await agent.whenIdle();
    const outside = await context.agentLoop.create(SessionId("outside-hooks"), route);
    outside.followup(user("Outside witness"));
    await outside.whenIdle();
    result["Scoped execution hooks admit, deny, transform and retry"] = { ...metrics,
      durableProjection: context.sessionProjections.snapshot(agent.session).values["audit/receipt"] === true,
      isolated: context.sessionProjections.snapshot(outside.session).values["audit/receipt"] === false };
  });

  const { preflightChildLlmRoute } = await import(source("packages/subagent/tool-subagent/src/model-selection.ts"));
  let checked = false, rejected = false;
  try {
    await preflightChildLlmRoute({ async resolveCallConfig(config) {
      checked = config.provider === "messages" && config.model === "deepseek-flash";
      throw new Error("fixture route rejected");
    } }, { provider: "chat-completions", model: "deepseek-flash" }, { provider: "messages", model: "deepseek-flash" });
  } catch { rejected = true; }
  result["Delegation validates the selected adapter route before creation"] = { checked, rejected };
  return result;
}
export async function referenceExtensions() {
  const ctx = new Context();
  const root = await mkdtemp(join(tmpdir(), "harness-extensions-"));
  try {
    const workspace = join(root, skillRoot);
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(workspace, "nested"));
    for (const [name, body] of Object.entries(skillFiles)) {
      const target = join(workspace, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
    }
    await ctx.plugin(SkillRegistry);
    await ctx.plugin(SkillFileSystem, { dshHome: join(root, "dsh-home"), agentsHome: join(root, "agents"), watch: false });
    const skillScope = { cwd: join(workspace, "nested") };
    const snapshot = await ctx.skills.snapshot(skillScope);
    const { description, whenToUse, metadata, content, invocation } = await ctx.skills.get("notes", skillScope);
    const skills = { entries: snapshot.skills.map(({ name }) => name).sort(), description, whenToUse, metadata, content,
      userInvocable: invocation.userInvocable };
    const provider = (name, rank) => () => ({ name,
      async list() { return [{ name: "shadowed", description: name, provider: name, source: name,
        invocation: { modelInvocable: true, userInvocable: true }, rank, locator: null }]; },
      async get(candidate) { return { ...candidate, content: name }; } });
    ctx.skills.registerProvider(provider("global", 10));
    const scope = createScope(ctx, { preset: "audit" });
    scope.ctx.get("skills").registerProvider(provider("near", 900));
    const shadow = { global: (await ctx.skills.get("shadowed")).content,
      scoped: (await ctx.skills.get("shadowed", { scope: scopeOf(scope.ctx) })).content };
    await scope.dispose();

    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(NativeToolExecutor);
    await ctx.plugin(McpResources);
    const connect = (changed = false) => ctx.plugin(McpClient, { serverName: mcpServer, transport: "stdio", command: process.execPath,
      args: ["-e", mcpScript(changed)], toolCallTimeoutMs: 2300, startupTimeoutMs: 5000, failOnStartupError: true });
    const first = await connect();
    const publicName = () => ctx.tools.schemas().find(({ name }) => name.startsWith("mcp__")).name;
    const original = publicName();
    const call = async (name, args) => {
      const result = await executeToolFixture(ctx, { name, arguments: args, callId: ToolCallId("fixture-request"), signal: AbortSignal.timeout(3000) });
      assert.equal(result.isError, false, JSON.stringify(result));
      return result.value;
    };
    const mcp = {
      original, aggregate: await call("list_mcp_resources", { server: mcpServer }),
      page: await call("list_mcp_resources", { server: mcpServer, cursor: "page-2" }),
      templates: await call("list_mcp_resource_templates", { server: mcpServer }),
      resource: await call("read_mcp_resource", { server: mcpServer, uri: "fixture://notes" }),
      replaced: "",
    };
    const mixed = await executeToolFixture(ctx, { name: original, arguments: { query: "images" },
      callId: ToolCallId("mcp-image-batch"), signal: AbortSignal.timeout(3000) });
    const mcpBatch = { budget: McpServerManager.Config({ servers: { fixture: { transport: "stdio", command: "node" } } }).servers.get().fixture.startupTimeoutMs,
      accepted: !mixed.isError, projected: mixed.content.some(({ type }) => type === "image"),
      rejectedBatch: mixed.content.every(({ text }) => text?.includes("image unavailable")) };
    await first.dispose();
    await connect(true);
    mcp.replaced = publicName();

    const { createScheduleRecord } = await import(source("packages/schedule/schedule/src/update.ts"));
    const { isRecurringScheduleRecord, resolveRecurringOccurrence, ScheduleId } = await import(source("packages/schedule/schedule/src/domain.ts"));
    const schedules = Object.fromEntries(scheduleCases.map(({ name, timing, start, delivered }, index) => {
      const record = createScheduleRecord(ScheduleId("fixture-" + index), "fixture", "fixture reminder", timing, Date.parse(start));
      const due = isRecurringScheduleRecord(record) ? resolveRecurringOccurrence(record, Date.parse(delivered)) : { occurrenceAt: record.scheduledAt };
      return [name, { first: Date.parse(record.scheduledAt), occurrence: Date.parse(due.occurrenceAt),
        next: due.nextScheduledAt ? Date.parse(due.nextScheduledAt) : null }];
    }));

    await ctx.plugin(SessionStore);
    const session = ctx.sessions.create(SessionId("fixture-source"));
    const callId = ToolCallId(cutToolId);
    const assistant = (blocks) => ({ turn: 1, step: 1, stream: [], message: createMessage({
      role: "assistant", content: blocks, source: { kind: "model", provider: "mock", model: "mock" },
    }) });
    session.append("turn/start", { turn: 1 });
    session.append("user/message", createUserMessage({ content: [{ type: "text", text: cutPrompt }], source: { kind: "user" } }), { surfaceOp: "append" });
    session.append("step/start", { turn: 1, step: 1 });
    const before = session.append("assistant/message", assistant([{ type: "tool-call", id: callId, name: "write_file", arguments: "{}" }]), { surfaceOp: "append" }).seq;
    const started = session.append("tool/call", { turn: 1, step: 1, callId, name: "write_file", arguments: "{}" }).seq;
    const after = session.append("tool/result", { turn: 1, step: 1,
      message: createToolResultMessage({ callId, isError: false, content: [{ type: "text", text: "cut.md" }] }) }, { surfaceOp: "append" }).seq;
    const contextCut = session.append("request/context", { provider: "mock", model: "mock" }).seq;
    session.append("assistant/message", assistant([{ type: "text", text: futureReply }]), { surfaceOp: "append" });
    const fork = [before, started, after].map((boundary, index) => {
      const child = ctx.sessions.fork(session, boundary, SessionId("fixture-branch-" + index));
      const derived = child.deriveMessages();
      const result = child.snapshotEvents().find((event) => event.type === "tool/result");
      return { user: derived.some((message) => text(message) === cutPrompt), future: derived.some((message) => text(message) === futureReply),
        receipt: result?.data.error?.code ?? (result && text(result.data.message).includes("cut.md") ? "committed" : "missing") };
    });
    const cut = ctx.sessions.fork(session, contextCut, SessionId("fixture-context-branch"));
    const widerFork = { retained: cut.snapshotEvents().some(({ type }) => type === "request/context"),
      receipt: cut.deriveMessages().some((message) => message.role === "tool" && text(message).includes("cut.md")),
      future: cut.deriveMessages().some((message) => text(message) === futureReply) };
    return { "Skills project precedence and YAML": skills, "MCP stable names and cursor paging": mcp,
      "Skills nearest scope wins before numeric rank": shadow, "MCP startup budget and atomic image rejection": mcpBatch,
      "Fork at a committed request context excludes future messages": widerFork,
      ...Object.fromEntries(Object.entries(schedules).map(([name, value]) => ["Schedule " + name, value])),
      "Fork before dispatch, after dispatch and after settlement": fork, ...await referenceAlignment(root, ctx) };
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
