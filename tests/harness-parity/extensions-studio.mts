import assert from "node:assert/strict";
import { mcpAdmissionCases, mcpAdmissionServer } from "./extension-cases.mjs";
import { scheduleWakeProbe } from "./extension-cases.mjs";
import { observeSkillCatalog, skillCatalogProbe, skillLookupPrompt, skillPhasePrompt } from "./extension-cases.mjs";
import { observeSkillLifecycle, observeSkillStep, skillLifecycle, skillStepProbe } from "./extension-cases.mjs";
import { startScheduleDriver } from "../../server/schedule-driver";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { trajectoryChanges } from "../../components/studio/trajectory-refresh";
import { advanceRun } from "../../lib/studio/engine";
import { McpManager, MCP_STARTUP_TIMEOUT_MS } from "../../lib/studio/mcp";
import { PresetPlugins } from "../../lib/studio/preset-plugins";
import { AppError } from "../../lib/studio/security";
import { ModelRequestError } from "../../lib/studio/providers";
import { tool } from "../../lib/studio/file-tools";
import { Schedules } from "../../lib/studio/schedules";
import { SkillLibrary } from "../../lib/studio/skills";
import { projectArchive, restoreProjectArchive } from "../../lib/studio/project-archive";
import { Store } from "../../lib/studio/store";
import { trajectory } from "../../lib/studio/trajectory";
import { DEFAULT_SETTINGS } from "../../lib/studio/types";
import { SQLiteDatabase } from "../../server/storage";
import { cutPrompt, cutToolId, futureReply, mcpScript, mcpServer, scheduleCases, skillFiles, skillRoot } from "./extension-cases.mjs";
import { largeSkillBody, mcpConcurrentRefresh, normalizeSkillBlock, resumePrompt, schedulePrompt, scheduleTimingFixture,
  scheduleTitle, scheduleTitleAfter, settledReply, sharedSkillBody, skillGesture, traceNoise, hooksQuery, hookResult } from "./extension-cases.mjs";

const fixtureSettings = { ...DEFAULT_SETTINGS, textApiKey: "fixture" };
const responseText = (content) => ({ role: "assistant", content });
const callTool = (id, name, args) => ({ ...responseText(null), tool_calls: [{ type: "function", id,
  function: { name, arguments: JSON.stringify(args) } }] });
async function send(store, project, text, sessionId = "") {
  const requestId = crypto.randomUUID();
  await store.acceptChat(project.id, { requestId, text, attachmentIds: [] }, undefined, sessionId);
  const [{ run_id }] = store.db.prepare("SELECT run_id FROM messages WHERE project_id=? AND request_id=?").bind(project.id, requestId).rows();
  return run_id;
}
async function finish(store, project, runId, model) {
  for (let i = 0; i < 12; i++) {
    const run = await advanceRun(store, project, runId, fixtureSettings, undefined, model);
    if (run.status === "done") return;
    assert.notEqual(run.status, "failed", run.error);
  }
  assert.fail("do漫 fixture did not settle");
}

async function studioSkillCatalog(db, manager, library) {
  const probe = skillCatalogProbe, trace = [];
  let current = probe.phases[0], invalidate = () => {}, reads = 0;
  const plugin = {
    id: "skill-probe", name: "Skill catalog fixture", setup(host) {
      host.registerExecutionHooks({ preStep: () => current.action === "veto" ? { kind: "reject", reason: "fixture rejects input" } : undefined });
      host.registerSkillProvider((context) => {
        invalidate = context.invalidate;
        const entry = (name, description, modelInvocable) => ({ name, description, modelInvocable, provider: "fixture", read() {
          reads++;
          return name === probe.manual ? probe.manualBody :
            current.action === "direct" ? probe.direct : current.action === "load" ? probe.edited : probe.original;
        } });
        return { complete: current.complete !== false, candidates: [
          ...(current.installed ? [entry(probe.skill, current.renamed ? probe.renamed : probe.description, true)] : []),
          entry(probe.manual, "Manual invocation", false),
        ] };
      });
    },
  };
  const presetPlugins = new PresetPlugins(db, manager, [plugin]);
  await presetPlugins.start("local", [plugin.id]);
  try {
    const store = new Store(db, { skills: library, presetPlugins });
    let project = await store.createProject("local", {});
    for (const phase of probe.phases) {
      current = phase;
      invalidate();
      if (phase.id === "unrelated-update") project = await store.updateProject(project.id, "local", { title: "Updated project state" });
      let observed, modelStep = 0;
      await finish(store, project, await send(store, project, skillPhasePrompt(probe, phase)), async (_system, messages, tools) => {
        assert.notEqual(current.action, "veto");
        const catalog = observeSkillCatalog(messages.map(({ source }) => source));
        const bodyBlocks = messages.filter(({ source }) => source?.kind === "skill-invocation").map(({ content }) => content);
        const currentCatalog = messages.findLast(({ source }) => source?.kind === "skill-catalog");
        assert.ok(!messages.some(({ source }) => source?.kind === "runtime-context" && source.sections.some(({ name }) => name === "skills")));
        if (current.action === "load" && modelStep++ === 0) {
          assert.equal(reads, 0);
          assert.ok(tools.some(({ function: definition }) => definition.name === "skill"));
          return callTool("catalog-load", "skill", { name: probe.skill });
        }
        const receipt = messages.findLast(({ tool_call_id }) => tool_call_id === "catalog-load");
        observed = { ...catalog, body: current.action === "load" ? (receipt?.content.includes(probe.edited) ? probe.edited : "") :
          current.action === "direct" ? bodyBlocks.filter((block) => block.includes(probe.direct)).length :
          current.action === "manual" ? bodyBlocks.filter((block) => block.includes(probe.manualBody)).length : "",
        reuse: current.action === "direct" && Boolean(currentCatalog?.content.includes("不要再用 skill 读取同一份正文")) };
        return responseText("finished");
      });
      trace.push({ phase: phase.id, ...observed, reads });
    }
    return trace;
  } finally { await presetPlugins.close(); }
}

async function studioSkillSteps(db, manager, library) {
  const probe = skillStepProbe, trace = [];
  let description = "Initial description", reads = 0, invalidate = () => {}, phase;
  const change = (value) => { description = value; invalidate(); };
  const plugin = { id: "skill-steps", name: "Skill step fixture", setup(host) {
    host.registerSkillProvider((context) => {
      invalidate = context.invalidate;
      return [{ name: probe.skill, description, read() { reads++; return probe.body; } }];
    });
    host.registerExecutionHooks({
      preStep({ messages }) {
        if (phase.admittedDescription) change(phase.admittedDescription);
        if (phase.text) return { kind: "accept", messages: messages.map((message) => message.source || message.role !== "user" ? message :
          { ...message, content: phase.text, ...(phase.external ? { source: { kind: "tool-context" } } : {}) }) };
      },
      requestError({ code }) { return phase.retry && code === "MODEL_AUTH" ? "retry" : undefined; },
    });
  } };
  const plugins = new PresetPlugins(db, manager, [plugin]);
  await plugins.start("local", [plugin.id]);
  try {
    const store = new Store(db, { skills: library, presetPlugins: plugins }), project = await store.createProject("local", {});
    for (phase of probe.phases) {
      const requests = [];
      await finish(store, project, await send(store, project, phase.input), async (_system, messages) => {
        requests.push(observeSkillStep(messages.map(({ source }) => source), reads));
        if (requests.length === 1 && phase.nextDescription) change(phase.nextDescription);
        if (requests.length === 1 && phase.tool) return callTool("catalog-barrier", "list_files", {});
        if (requests.length === 1 && phase.retry) throw new ModelRequestError("Fixture retry", 401, "MODEL_AUTH");
        return responseText("Completed");
      });
      trace.push({ phase: phase.id, requests });
    }
    return trace;
  } finally { await plugins.close(); }
}

async function studioSkillLifecycle(root) {
  const probe = skillLifecycle, trace = {};
  const filename = join(root, "skill-lifecycle.sqlite");
  let reads = 0, restarted = false, project;
  const useStore = async (work) => {
    const db = new SQLiteDatabase(filename);
    db.initialize("drizzle");
    const library = new SkillLibrary(join(root, "lifecycle-skills"));
    const manager = new McpManager(db, "skill-lifecycle-fixture".repeat(3));
    const plugins = new PresetPlugins(db, manager, ["first", "second"].map((preset) => ({ id: preset, name: preset, setup(host) {
      const first = preset === "first";
      host.registerSkillProvider(() => [probe.shared, first ? probe.firstOnly : probe.secondOnly].map((name) => ({ name,
        description: name === probe.shared ? (first ? "First" : "Second") : restarted ? "Updated after restart" : "Preset entry",
        read() { reads++; return first ? probe.before : restarted ? probe.refreshed : probe.after; },
      })));
    } })));
    try { await work(new Store(db, { skills: library, presetPlugins: plugins }), library, plugins); }
    finally { await plugins.close(); await manager.close(); library.close(); db.close(); }
  };
  const ask = async (store, phase, prompt) => finish(store, project, await send(store, project, prompt), async (_system, messages) => {
    if (phase) trace[phase] = observeSkillLifecycle(messages.map(({ source }) => source),
      messages.filter(({ source }) => source?.kind === "skill-invocation").map(({ content }) => content), reads);
    return responseText("Completed");
  });
  await useStore(async (store, library, plugins) => {
    project = await store.createProject("local", {});
    const makePreset = (name) => store.presets.save("local", { name, instructions: "", plugins: [name] });
    const first = await makePreset("first"), second = await makePreset("second");
    await store.presets.select("local", project.id, "", first.id);
    const scope = await plugins.acquire("local", first);
    try { trace.warm = (await library.discover(project.id, scope.providers, undefined, scope.scopedProviders)).entries.map(({ entry }) => entry.name).sort(); }
    finally { await scope.release(); }
    await store.presets.select("local", project.id, "", second.id);
    await ask(store, "selected", probe.initial);
    await ask(store, "invoked", probe.invocation);
    await ask(store, "", probe.older); await ask(store, "", probe.recent);
    const compact = crypto.randomUUID();
    await store.requestCompaction(project.id, compact);
    let summarized = false;
    await finish(store, project, compact, async (_system, messages) => {
      assert.ok(messages.some(({ content }) => content === probe.older));
      assert.ok(!messages.some(({ source }) => source?.kind === "skill-catalog"));
      summarized = true;
      return responseText(probe.summary);
    });
    assert.ok(summarized);
    await ask(store, "compacted", probe.initial);
  });
  restarted = true;
  await useStore(async (store) => {
    await ask(store, "restarted", probe.initial);
    await ask(store, "reinvoked", probe.invocation);
    await ask(store, "unchanged", probe.initial);
    const first = store.presets.list("local").find(({ name }) => name === "first");
    await store.presets.select("local", project.id, "", first.id);
    await finish(store, project, await send(store, project, probe.invocation), async (_system, messages) => {
      const result = observeSkillLifecycle(messages.map(({ source }) => source),
        messages.filter(({ source }) => source?.kind === "skill-invocation").map(({ content }) => content), reads);
      assert.deepEqual(result.entries.map(([name]) => name), [probe.firstOnly, probe.shared]);
      assert.equal(result.blocks.at(-1), probe.before);
      assert.equal(result.reads, 3);
      return responseText("Completed");
    });
  });
  return trace;
}

async function studioAlignment(db, manager, library, store, project, root) {
  const result = {};
  result[skillLifecycle.name] = await studioSkillLifecycle(root);
  result[skillStepProbe.name] = await studioSkillSteps(db, manager, library);
  const zip = await new Response(projectArchive(store, project.id, undefined)).arrayBuffer();
  const imported = await restoreProjectArchive(store, "local", zip, undefined, new AbortController().signal);
  const followup = await send(store, imported, resumePrompt);
  await finish(store, imported, followup, async (_system, messages) => {
    result["Cold conversation continuation includes its committed tool receipt"] = {
      user: messages.some(({ content }) => content === resumePrompt),
      reply: messages.some(({ content }) => content === futureReply),
      receipt: messages.some(({ tool_call_id, content }) => tool_call_id === cutToolId && content.includes("cut.md")),
    };
    return responseText("continued");
  });
  assert.equal((await store.artifacts(imported.id)).find(({ path }) => path.endsWith("/cut.md")).version, 1);

  const inspected = await store.createProject("local", {});
  const inspectedRun = await send(store, inspected, "Open trajectory");
  const requestId = crypto.randomUUID(), stamp = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO model_calls(id,run_id,request,status,created_at) VALUES(?,?,?,'started',?)")
      .bind(requestId, inspectedRun, JSON.stringify({ purpose: "creation", turn: 1, step: 1, model: "fixture" }), stamp),
    store.event(inspected.id, "request", { runId: inspectedRun, requestId, turn: 1, step: 1 }),
  ]);
  const trace = (before = Number.MAX_SAFE_INTEGER, after?, watch?) => trajectory(store, inspected.id, "", before, "", after, watch);
  const open = trace().rows.find(({ detailId }) => detailId === requestId);
  assert.equal(open?.status, "started");
  await db.batch(Array.from({ length: traceNoise }, (_, i) => store.event(inspected.id, "turn/start", { runId: inspectedRun, turn: i + 2 })));
  const page = trace();
  const all = await trajectoryChanges(page, open.seq, [open.seq], async (...args) => trace(...args));
  assert.equal([...all.values()].filter(({ kind }) => kind === "turn/start").length, traceNoise);
  assert.equal(all.get(open.seq)?.status, "started");
  await db.batch([
    db.prepare("UPDATE model_calls SET status='completed',visible_text=?,settled_at=? WHERE id=?").bind(settledReply, stamp, requestId),
    store.event(inspected.id, "step/end", { runId: inspectedRun, turn: 1, step: 1 }),
  ]);
  const late = trace();
  assert.ok(!late.rows.some(({ seq }) => seq === open.seq));
  const changes = await trajectoryChanges(late, page.rows[0].seq, [open.seq], async (...args) => trace(...args));
  const closed = changes.get(open.seq);
  result["Trajectory settles the original request after a 101-event gap"] = {
    wasRunning: open.status === "started", sameRow: closed?.seq === open.seq, settled: closed?.status === "completed",
  };
  assert.equal(trajectory(store, project.id, "", Number.MAX_SAFE_INTEGER, "", undefined, [open.seq]).rows.length, 0);

  const delegation = await store.createProject("local", {});
  const lead = await send(store, delegation, "Assign a child");
  assert.ok(await store.claimRun(lead, delegation.id));
  const child = await store.startChild(await store.run(lead, delegation.id), "one-child", "writer", "Work at maximum depth.");
  let attempt = 0;
  const depth = { offered: false, advised: false, denied: false, spawned: false };
  await finish(store, delegation, child.task_id, async (_system, messages, tools) => {
    if (attempt++ === 0) {
      depth.offered = tools.some(({ function: fn }) => fn.name === "delegate");
      depth.advised = messages.some(({ content }) => content?.includes("current 1, maximum 1, remaining levels 0"));
      return callTool("at-cap", "delegate", { role: "writer", instruction: "Try an additional child" });
    }
    depth.denied = messages.some(({ tool_call_id, content }) => tool_call_id === "at-cap" && JSON.parse(content).code === "AGENT_DEPTH_LIMIT");
    return responseText("completed directly");
  });
  depth.spawned = (await store.children(await store.run(child.task_id, delegation.id))).length > 0;
  result["Delegation stays visible at the limit and refuses to spawn"] = depth;

  const skillProject = await store.createProject("local", {});
  const skillDoc = (name, content) => "---\nname: " + name + "\ndescription: Fixture\n---\n" + content;
  library.save(skillProject.id, "project", skillDoc("shared-skill", sharedSkillBody));
  library.save(skillProject.id, "project", skillDoc("large-skill", largeSkillBody));
  const skilled = new Store(db, { skills: library });
  const skillRun = await send(skilled, skillProject, skillGesture);
  const skill = { direct: "", tool: "", large: library.load(skillProject.id, "large-skill", null, "model").length };
  await finish(skilled, skillProject, skillRun, async (_system, messages) => {
    skill.direct = normalizeSkillBlock(messages.find(({ content }) => content?.startsWith("<skill_content"))?.content ?? "");
    return responseText("direct skill read");
  });
  let skillStep = 0;
  await finish(skilled, skillProject, await send(skilled, skillProject, skillLookupPrompt), async (_system, messages) => {
    if (skillStep++ === 0) {
      return callTool("skill-load", "skill", { name: "shared-skill" });
    }
    skill.tool = normalizeSkillBlock(messages.find(({ tool_call_id }) => tool_call_id === "skill-load")?.content ?? "");
    return responseText("skill read");
  });
  result["Skills return the same model block from user and tool and read a long source"] = skill;
  result[skillCatalogProbe.name] = await studioSkillCatalog(db, manager, library);

  const probeRow = await manager.save("local", { name: "list-failure", transport: "stdio", command: process.execPath,
    args: ["-e", mcpScript(false, true)], enabled: false, closeTimeoutMs: 1500 });
  const probe = await manager.test("local", probeRow.id);
  assert.ok(!probe.ok);
  const evolving = await manager.save("local", { name: "changing", transport: "stdio", command: process.execPath,
    args: ["-e", mcpConcurrentRefresh], startupTimeoutMs: 3000 });
  const evolved = async () => (await manager.tools("local", [evolving.id])).registrations;
  const poke = (await evolved()).find(({ label }) => label === "changing · poke");
  assert.ok(poke);
  await poke.execute({ signal: AbortSignal.timeout(2000) } as never, "poke", {});
  let current = [];
  for (let i = 0; i < 100; i++) {
    current = (await evolved()).map(({ label }) => label);
    if (current.includes("changing · latest")) break;
    await delay(20);
  }
  result["MCP reports failed probe cleanup and serializes tool list changes"] = {
    failed: !probe.ok, stage: probe.stage, closed: probe.closeConfirmed,
    latest: current.includes("changing · latest"), overlapped: current.includes("changing · overlapped"),
  };

  for (const action of mcpAdmissionCases) {
    const name = "admission-" + action;
    const boundStore = new Store(db, { mcp: manager });
    const server = await manager.save("local", { name, transport: "stdio", command: process.execPath,
      args: ["-e", mcpAdmissionServer], reconnect: { enabled: false } });
    const available = async () => (await manager.tools("local", [server.id])).registrations;
    const control = (await available()).find(({ label }) => label === name + " · poke");
    const invoke = (await available()).find(({ label }) => label === name + " · invoke");
    assert.ok(control && invoke);
    const toolName = invoke.schema.function.name;
    const project = await boundStore.createProject("local", {});
    const run = await send(boundStore, project, "Call the admitted tool");
    let calls = 0;
    await finish(boundStore, project, run, async (_system, messages, offered) => {
      const step = calls++;
      if (step === 1 && action !== "disconnect") return callTool("reselected", toolName, { value: action === "schema" ? 3 : "updated" });
      if (step) {
        const receipt = messages.find(({ tool_call_id }) => tool_call_id === "admitted");
        assert.ok(receipt);
        const reselected = messages.find(({ tool_call_id }) => tool_call_id === "reselected");
        assert.ok(!receipt.content.includes("runner accepted admitted call"));
        if (action !== "disconnect") assert.ok(reselected?.content.includes("runner accepted admitted call"));
        result["MCP admission during " + action] = { executed: receipt.content.includes("runner accepted admitted call"),
          ...(action !== "disconnect" ? { reselected: Boolean(reselected?.content.includes("runner accepted admitted call")) } : {}) };
        return responseText("settled");
      }
      assert.ok(offered.some(({ function: fn }) => fn.name === toolName));
      await control.execute({ signal: AbortSignal.timeout(2000) }, "poke", { action });
      if (action === "disconnect") await delay(140);
      else {
        let seen = false;
        for (let i = 0; i < 100; i++) {
          if ((await available()).some(({ label }) => label === name + " · witness")) { seen = true; break; }
          await delay(20);
        }
        assert.ok(seen);
      }
      return callTool("admitted", toolName, { value: "original" });
    });
  }

  const scheduled = await store.createProject("local", {});
  const target = await store.createSession(scheduled.id, "Schedule target");
  const scheduler = new Schedules(store);
  {
    const { name, later, earlier } = scheduleWakeProbe, errors = [];
    const timerSession = await store.createSession(scheduled.id, "Timed schedule");
    const stop = startScheduleDriver(db, scheduler, (error) => errors.push(error));
    try {
      const schedule = ({ prompt, ms }) => scheduler.save(scheduled.id, { title: prompt, prompt,
        timing: { kind: "at", at: new Date(Date.now() + ms).toISOString() }, target: { kind: "session", id: timerSession.id } });
      const future = await schedule(later), soon = await schedule(earlier);
      const seen = () => [soon, future].flatMap((task) => scheduler.history(scheduled.id, task.id).rows.map(({ prompt }) => prompt));
      const quietBeforeDue = seen().length === 0;
      for (let i = 0; i < 150 && seen().length === 0 && errors.length === 0; i++) await delay(20);
      assert.deepEqual(errors, []);
      const delivered = seen();
      assert.deepEqual(delivered, [earlier.prompt]);
      result[name] = { quietBeforeDue, seen: delivered, earlierOnly: delivered[0] === earlier.prompt && delivered.length === 1 };
    } finally { await stop(); }
  }
  const configuration = { title: scheduleTitle, prompt: schedulePrompt, timing: scheduleTimingFixture, target: { kind: "session", id: target.id } };
  let task = await scheduler.save(scheduled.id, configuration);
  await finish(store, scheduled, await send(store, scheduled, "Prime", target.id), async () => responseText("ready"));
  const notices = (messages) => messages.filter(({ source }) => source?.kind === "schedule-change")
    .map(({ content }) => content.match(/^change: (.+)$/gm).at(-1).slice(8));
  const idle = [];
  task = await scheduler.save(scheduled.id, { ...configuration, title: scheduleTitleAfter }, task);
  const woke = (await store.snapshot(scheduled.id, "local", target.id)).runs.some(({ status }) => status === "queued");
  await finish(store, scheduled, await send(store, scheduled, schedulePrompt, target.id), async (_system, messages) => {
    idle.push(notices(messages)); return responseText("read idle edit");
  });
  const active = [];
  await finish(store, scheduled, await send(store, scheduled, schedulePrompt + " During the response.", target.id), async (_system, messages) => {
    active.push(notices(messages));
    if (active.length === 1) task = await scheduler.save(scheduled.id, configuration, task);
    return responseText("read active edit");
  });
  result["Schedule edits reach the next request without opening an idle turn"] = { woke, idle, active };

  const scheduleStore = new Store(db, { scheduleToolsEnabled: true, schedulePolicy: { historyRecords: 1 } });
  const toolScheduler = new Schedules(scheduleStore);
  const scheduleRun = await send(scheduleStore, scheduled, "Check explicit schedule targeting", target.id);
  let scheduleCalls = 0;
  const scheduleResult = { omitted: false, explicit: false, retained: 0, unavailable: false, pruned: false };
  const args = { title: "Explicit target fixture", prompt: schedulePrompt, rrule: scheduleTimingFixture.rrule };
  await finish(scheduleStore, scheduled, scheduleRun, async (_system, messages) => {
    if (scheduleCalls++ === 0) return callTool("no-target", "schedule_create", args);
    if (scheduleCalls === 2) {
      scheduleResult.omitted = Boolean(JSON.parse(messages.find(({ tool_call_id }) => tool_call_id === "no-target")!.content!).id);
      return callTool("target", "schedule_create", { ...args, target: "this_session" });
    }
    scheduleResult.explicit = Boolean(JSON.parse(messages.find(({ tool_call_id }) => tool_call_id === "target")!.content!).id);
    return responseText("done");
  });
  const retain = await toolScheduler.save(scheduled.id, { ...configuration, target: { kind: "new" } });
  await toolScheduler.runNow(retain, 2_000_000_000_000);
  await toolScheduler.runNow(toolScheduler.get(scheduled.id, retain.id), 2_000_000_060_000);
  const historyPage = toolScheduler.history(scheduled.id, retain.id);
  result["Schedule requires a target and reports pruned history"] = { ...scheduleResult, retained: historyPage.rows.length,
    unavailable: historyPage.earlierRecordsUnavailable, pruned: historyPage.earlierRecordsPruned };

  const metrics = { preStep: 0, retries: 0, denied: 0, ran: 0, projected: false, deniedSeen: false };
  const plugins = new PresetPlugins(db, manager, [{ id: "audit", name: "Audit", setup(scope) {
    scope.registerExecutionHooks({
      preStep() { metrics.preStep++; },
      requestError() { metrics.retries++; return "retry"; },
      preTool({ call }) {
        if (call.function.name === "audit_block") { metrics.denied++; return { kind: "deny", reason: "audit denied" }; }
      },
      postTool({ call, outcome }) {
        if (call.function.name === "audit_run" && "result" in outcome) return { ...outcome, result: { text: hookResult } };
      },
      project({ kind }) { if (kind === "tools/settled") return { name: "audit", label: "Audit receipt committed" }; },
    });
    for (const name of ["audit_block", "audit_run"]) scope.registerTool({
      schema: tool(name, name, {}), label: name, async execute() { metrics.ran++; return { result: { text: "before projection" } }; },
    });
  } }]);
  await plugins.start("local", []);
  let durableProjection = false, isolatedProjection = false;
  try {
    const hooked = new Store(db, { presetPlugins: plugins });
    const project = await hooked.createProject("local", {});
    const preset = await hooked.presets.save("local", { name: "Audit fixture", instructions: "", plugins: ["audit"] });
    const selected = await hooked.createSession(project.id, "Audit scope", preset.id);
    const runId = await send(hooked, project, hooksQuery, selected.id);
    let attempts = 0;
    const model = async (_system, messages) => {
      const receipts = messages.filter(({ role }) => role === "tool").map(({ content }) => content);
      if (attempts++ === 0) throw new AppError("fixture auth", 401, "MODEL_AUTH");
      if (!receipts.length) return callTool("blocked", "audit_block", {});
      metrics.deniedSeen = receipts.some((value) => value.includes("audit denied"));
      if (receipts.length === 1) return callTool("projected", "audit_run", {});
      metrics.projected = receipts.some((value) => JSON.parse(value).text === hookResult);
      return responseText("finished");
    };
    assert.equal((await advanceRun(hooked, project, runId, fixtureSettings, undefined, model)).status, "queued");
    await finish(hooked, project, runId, model);
    const observed = trajectory(new Store(db), project.id, selected.id, Number.MAX_SAFE_INTEGER, "").rows;
    durableProjection = observed.some(({ kind }) => kind === "extension/audit");
    await finish(hooked, project, await send(hooked, project, "Outside witness"), async () => responseText("finished"));
    isolatedProjection = !trajectory(new Store(db), project.id, "", Number.MAX_SAFE_INTEGER, "").rows.some(({ kind }) => kind === "extension/audit");
  } finally { await plugins.close(); }
  result["Scoped execution hooks admit, deny, transform and retry"] = { ...metrics,
    durableProjection, isolated: isolatedProjection };

  let checked = false, rejected = false;
  const routing = new Store(db, { resolveModel: async (settings) => {
    checked = settings.textBaseUrl.endsWith("/anthropic") && settings.textModel === "deepseek-flash";
    throw new AppError("fixture route rejected", 409, "AGENT_ROUTE_UNAVAILABLE");
  } });
  const routeProject = await routing.createProject("local", {}), routeRun = await send(routing, routeProject, "Audit child route");
  let delegate = false;
  await finish(routing, routeProject, routeRun, async (_system, messages) => {
    if (!delegate) {
      delegate = true;
      return callTool("rejected-route", "delegate", { role: "writer", instruction: "Inspect", provider: "messages", model: "deepseek-flash" });
    }
    rejected = messages.some(({ content, tool_call_id }) => tool_call_id === "rejected-route" && content.includes("AGENT_ROUTE_UNAVAILABLE"));
    return responseText("finished");
  });
  assert.equal((await routing.children(await routing.run(routeRun, routeProject.id))).length, 0);
  result["Delegation validates the selected adapter route before creation"] = { checked, rejected };
  return result;
}

export async function studioExtensions() {
  const db = new SQLiteDatabase(":memory:");
  db.initialize("drizzle");
  const root = await realpath(await mkdtemp(join(tmpdir(), "doman-extensions-")));
  const manager = new McpManager(db, "mcp-fixture-only".repeat(3));
  const library = new SkillLibrary(join(root, "managed"), [], root);
  try {
    const workspace = join(root, skillRoot);
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(workspace, "nested"));
    for (const [name, body] of Object.entries(skillFiles)) {
      const target = join(workspace, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
    }
    const { entries } = await library.discover(skillRoot, [], "/nested");
    const notes = entries.find(({ entry }) => entry.name === "notes")!;
    const { description, whenToUse, metadata, userInvocable } = notes.entry;
    const skills = { entries: entries.map(({ entry }) => entry.name).sort(), description, whenToUse, metadata, userInvocable, content: await notes.read() };
    const provider = (description, rank) => () => [{ name: "shadowed", description, rank, read: () => description }];
    const global = provider("global", 10), near = provider("near", 900);
    const shadow = { global: await (await library.discover(skillRoot, [global])).entries.find(({ entry }) => entry.name === "shadowed").read(),
      scoped: await (await library.discover(skillRoot, [global], "/", [near])).entries.find(({ entry }) => entry.name === "shadowed").read() };

    const connect = (changed = false, id?: string) => manager.save("local", { name: mcpServer, transport: "stdio",
      command: process.execPath, args: ["-e", mcpScript(changed)], startupTimeoutMs: 5000, toolCallTimeoutMs: 2300 }, id);
    const server = await connect();
    const { registrations } = await manager.tools("local", [server.id]);
    const publicName = (tools) => tools.find(({ name }) => name?.startsWith("mcp__")).name;
    const call = async (name, args) => {
      const entry = registrations.find(({ schema }) => schema.function.name === name)!;
      const out = await entry.execute({ signal: AbortSignal.timeout(3000) } as never, "fixture-request", args);
      assert.ok("result" in out && out.result.external);
      return out.result.data;
    };
    const mcp = {
      original: publicName(registrations), aggregate: await call("list_mcp_resources", { server: mcpServer }),
      page: await call("list_mcp_resources", { server: mcpServer, cursor: "page-2" }),
      templates: await call("list_mcp_resource_templates", { server: mcpServer }),
      resource: await call("read_mcp_resource", { server: mcpServer, uri: "fixture://notes" }),
      replaced: "",
    };
    const store = new Store(db);
    const imageProject = await store.createProject("local", {});
    let writes = 0;
    const mcpTool = registrations.find(({ schema }) => schema.function.name === mcp.original);
    const mixed = await mcpTool.execute({ project: imageProject, settings: fixtureSettings,
      signal: AbortSignal.timeout(3000), bucket: { get: async () => null, put: async () => { writes++; } } }, "mcp-image-batch", { query: "images" });
    const mcpBatch = { budget: MCP_STARTUP_TIMEOUT_MS, accepted: mixed.result.external === true, projected: Boolean(mixed.images?.length),
      rejectedBatch: Boolean(mixed.result.image_error) && writes === 0 };
    await connect(true, server.id);
    mcp.replaced = publicName((await manager.tools("local", [server.id])).registrations);
    const service = new Schedules(store);
    const schedules = {};
    for (const { name, timing, start, delivered } of scheduleCases) {
      const project = await store.createProject("local", {});
      const task = await service.save(project.id, { title: "fixture", prompt: "fixture reminder", timing,
        target: { kind: "new" } }, undefined, undefined, Date.parse(start));
      await service.runDue(Date.parse(delivered));
      const result = service.get(project.id, task.id);
      schedules["Schedule " + name] = { first: task.nextAt, occurrence: result.last!.scheduledFor, next: result.nextAt };
      await service.change(result, "delete");
    }

    const project = await store.createProject("local", {});
    await store.acceptChat(project.id, { requestId: crypto.randomUUID(), text: cutPrompt, attachmentIds: [] });
    const run = (await store.snapshot(project.id, "local")).runs.find(({ status }) => status === "queued")!;
    const settings = { ...DEFAULT_SETTINGS, textApiKey: "fixture" };
    await advanceRun(store, project, run.id, settings, undefined, async () => ({ role: "assistant", content: null,
      tool_calls: [{ type: "function", id: cutToolId, function: { name: "write_file",
        arguments: JSON.stringify({ file_path: "/01_创作/cut.md", content: "committed", kind: "document" }) } }] }));
    await advanceRun(store, project, run.id, settings, undefined, async () => assert.fail("tool step"));
    await db.prepare("INSERT INTO events(project_id,type,data,created_at) VALUES(?,'request/context',?,?)")
      .bind(project.id, JSON.stringify({ runId: run.id }), new Date().toISOString()).run();
    await advanceRun(store, project, run.id, settings, undefined, async () => ({ role: "assistant", content: futureReply }));
    const rows = trajectory(store, project.id, "", Number.MAX_SAFE_INTEGER, "").rows;
    const anchors = [rows.findLast(({ label }) => label === "model/accepted")!,
      rows.find(({ kind }) => kind === "tool/dispatched")!, rows.find(({ label }) => label === "tools/settled")!];
    const fork = [];
    for (const [index, anchor] of anchors.entries()) {
      const child = await store.forkSession(project.id, "", anchor.runId, "fixture-branch-" + index, anchor.seq);
      const { messages } = store.sessionSeed(project.id, child.id)!;
      const result = messages.find(({ tool_call_id }) => tool_call_id === cutToolId);
      const receipt = result ? JSON.parse(result.content!) : undefined;
      fork.push({ user: messages.some(({ content }) => content === cutPrompt), future: messages.some(({ content }) => content === futureReply),
        receipt: receipt?.code ?? (result?.content?.includes("cut.md") ? "committed" : "missing") });
    }
    const extra = rows.find(({ kind }) => kind === "request/context");
    const isolated = await store.forkSession(project.id, "", run.id, "fixture-context-branch", extra.seq);
    const context = store.sessionSeed(project.id, isolated.id).messages;
    const widerFork = { retained: trajectory(store, project.id, isolated.id, Number.MAX_SAFE_INTEGER, "").rows.some(({ kind }) => kind === "request/context"),
      receipt: context.some(({ tool_call_id, content }) => tool_call_id === cutToolId && content.includes("cut.md")),
      future: context.some(({ content }) => content === futureReply) };
    const zip = await new Response(projectArchive(store, project.id, undefined)).arrayBuffer();
    const imported = await restoreProjectArchive(store, "local", zip, undefined, AbortSignal.timeout(3000));
    const importedEvent = trajectory(store, imported.id, "", Number.MAX_SAFE_INTEGER, "").rows.find(({ kind }) => kind === "request/context");
    assert.ok(importedEvent?.forkable);
    const importedFork = await store.forkSession(imported.id, "", importedEvent.runId, "Imported context branch", importedEvent.seq);
    const restored = store.sessionSeed(imported.id, importedFork.id).messages;
    assert.ok(restored.some(({ tool_call_id, content }) => tool_call_id === cutToolId && content.includes("cut.md")));
    assert.ok(!restored.some(({ content }) => content === futureReply));
    return { "Skills project precedence and YAML": skills, "MCP stable names and cursor paging": mcp,
      "Skills nearest scope wins before numeric rank": shadow, "MCP startup budget and atomic image rejection": mcpBatch,
      "Fork at a committed request context excludes future messages": widerFork,
      ...schedules, "Fork before dispatch, after dispatch and after settlement": fork, ...await studioAlignment(db, manager, library, store, project, root) };
  } finally {
    library.close();
    await manager.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}
