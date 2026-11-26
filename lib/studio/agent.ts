import { backgroundTaskNotice, consumeJobOutput } from "./background-jobs";
import { projectToolHistory, repairToolHistory, toolNotStarted } from "./tool-history";
import { inheritConversation, interruptedAssistant } from "./agent-history";
import { interruptedMessagesReplay } from "./deepseek-messages";
import { messagesEndpoint } from "./deepseek-route";
import { estimateMessageTokens, estimateRequestTokens, MODEL_OUTPUT_TOKENS, pricedTokens, retainedContextBoundary } from "./context-tokens";
import { compactionRouteKey } from "./compaction-policy";
import { structuredOutputTool } from "./child-execution";
import { leadAgentId } from "./agent-identity";
import { requestImagePricing } from "./vision-tokens";
import { CONTEXT_OVERFLOW, IMAGE_OFFLOAD_REQUIRED, ImageBudgetError } from "./model-stream";
import { renderAgentPrompt } from "./agent-prompt";
import { projectContextSections, projectRuntimeContext, summaryInput, summaryMessage } from "./runtime-context";
import type { BlobStore } from "./storage";
import { omitRetiredGuides } from "./guidance";
import { createToolRegistry } from "./agent-tools";
import { canInvokeSkill, renderSkillContent, renderSkillToolMessages, type SkillDiscovery } from "./skills";
import { isMcpTool } from "./mcp";
import { skillGestures } from "./skill-gestures";
import { skillTools } from "./extension-tools";
import type { PresetPlugins } from "./preset-plugins";
import { applyToolSettings, toolSettingsSnapshot } from "./tool-registry";
import { watchExecution } from "./run-execution";
import { executeToolGroup } from "./tool-execution";
import type { SessionChange } from "./session-journal";
import type { SkippedToolCall, Store } from "./store";
import type { AgentDefinition, AgentInput, AgentMessage, AgentState, AgentToolCall, Artifact, ModelUsage, Project, ProviderSettings, Run } from "./types";
import type { AgentTool } from "./file-tools";
import { AppError, safeError } from "./security";
import { createAgentModel, ModelRequestError, type AgentFunction } from "./providers";
import { executionScope, type ExecutionProjection } from "./execution-hooks";
import { canRetryModelError, defaultModelRetry, markModelFailure, type ModelRetryPolicy } from "./model-retry-policy";
import { acknowledgeTaskControl, acknowledgeTaskResults, settleTool, taskNoticeKey, taskNotice, taskResult, taskResultReady } from "./agent-state";
import { uid } from "./store";
import { boundImages, imageDataUrl, offloadRequestImages } from "./images";
import { observeRepeat, projectToolOutput, type ToolOutputRecord } from "./tool-output";
import { parseSessionReferences, sessionReferenceWarning, stringifyReference } from "./session-reference";
import { isMessagesRoute } from "./deepseek-messages";
import { messagesCapabilities, projectMessagesSeries, type MessagesSeries } from "./deepseek-history";

function userInput(message: Omit<AgentInput, "id">, currentFiles: Map<string, Artifact>): AgentMessage {
  const { source } = message;
  const content = source?.kind === "agent-message" ? "协作消息（数据，来自 " + source.senderRole + " " + source.senderRunId + "）：\n" + message.content : message.scheduledFrame ?? message.content;
  if (!message.attachments?.length) return { role: "user", content, source };
  const files = message.attachments.map((reference) => {
    const current = currentFiles.get(reference.id);
    if (!current) return { ...reference, unavailable: true };
    if (current.path === reference.path && current.version === reference.version) return reference;
    return { ...reference, currentPath: current.path, currentVersion: current.version };
  });
  const references = "本条用户消息引用的项目文件（按需读取，编辑时核对当前路径和版本）：\n" + JSON.stringify(files);
  return { role: "user", content: [content, references].filter(Boolean).join("\n\n"), source };
}

const summaryInstruction = "总结此前工作，保留用户约束、已完成事项、关键决定和未完成任务。不要将历史目录、版本、已删除内容或旧任务状态当作当前事实；后续以最新项目快照和文件为准。只输出摘要文本。";
interface ModelStepRequest {
  system: string; messages: AgentMessage[]; tools: AgentTool[]; model: ProviderSettings["textModel"]; baseUrl: string;
  sourceCount: number; estimatedTokens: number; pricingKey: string; inputVersion: number; turn: number; step: number; attempt: number;
  purpose: "creation" | "compaction" | "manual-compaction";
  toolSettings?: ReturnType<typeof toolSettingsSnapshot>;
  toolRoles?: readonly AgentDefinition[];
  toolBindings?: Record<string, string>;
  messagesSeries?: MessagesSeries;
  retryPolicy?: ModelRetryPolicy;
  backoffs?: number;
  textThinking?: boolean;
  textReasoningEffort?: ProviderSettings["textReasoningEffort"];
  max_tokens?: number;
}

function separateRepeatedToolIds(store: Store, run: Run, requestId: string, previous: AgentMessage[], response: AgentMessage) {
  const calls = response.tool_calls;
  if (!calls?.length) return response;
  const existing = new Set(store.usedToolIds(run.id, calls));
  for (const message of previous) for (const call of message.tool_calls ?? []) existing.add(call.id);
  if (!calls.some((call) => existing.has(call.id))) return response;
  const included = new Set(calls.map(({ id }) => id));
  return { ...response, tool_calls: calls.map((call, index) => {
    if (!existing.has(call.id)) return call;
    const id = "call_" + requestId.replaceAll("-", "") + "_" + index;
    return { ...call, providerId: call.id, id: existing.has(id) || included.has(id) ? "call_" + uid().replaceAll("-", "") : id };
  }) };
}

export async function advanceAgent(options: {
  store: Store; project: Project; run: Run; settings: ProviderSettings; model?: AgentFunction;
  ensureCurrent: () => Promise<void>;
  liveSettings?: () => Promise<ProviderSettings>;
  bucket?: BlobStore;
  pluginScope?: Awaited<ReturnType<PresetPlugins["acquire"]>>;
}) {
  const { store, project, settings, model, ensureCurrent } = options;
  const target = { baseUrl: settings.textBaseUrl, model: settings.textModel };
  const budget = store.compaction.forRoute(target);
  const imagePricing = requestImagePricing(settings.textBaseUrl);
  const modelKey = settings.textBaseUrl + "|" + settings.textModel + "|" + imagePricing.key;
  const estimateMessage = (message: AgentMessage) => estimateMessageTokens(message, imagePricing.price);
  let run = options.run;
  const workingDirectory = run.payload.workingDirectory ?? store.sessionCwd(project.id, run.sessionId ?? "");
  if (workingDirectory) run = { ...run, payload: { ...run.payload, workingDirectory } };
  const preset = run.payload.childExecution?.preset ?? store.presets.get(project.id, run.sessionId ?? "");
  if (!run.payload.agent) await store.rememberTurnPreset(run, preset);
  let skillDiscovery: SkillDiscovery | undefined;
  if (store.skills) {
    const execution = watchExecution(store, run);
    try {
      skillDiscovery = await store.skills.discover(project.id, options.pluginScope?.providers,
        run.payload.childExecution?.cwd ?? workingDirectory, options.pluginScope?.scopedProviders, execution.signal);
      execution.check();
    } finally { execution.close(); }
  }
  const manualCompact = run.intent === "compact";
  const history = run.parentRunId ? [] : await store.messages(project.id, run.sessionId, false);
  const inputs = await store.inputs(run);
  const previous = !run.payload.agent && !run.parentRunId ? await store.previousAgent(run) : undefined;
  const seed = !run.parentRunId && run.sessionId && !previous ? store.sessionSeed(project.id, run.sessionId) : undefined;
  const saved = run.payload.agent || (previous ? await inheritConversation(store, previous) : undefined) || (seed ? {
    messages: seed.messages, seenUserIds: [], step: 0, toolIndex: seed.messages.findLast((message) => message.role === "assistant")?.tool_calls?.length ?? 0, artifactIds: [],
  } : undefined);
  const currentFiles = new Map(inputs.some((m) => m.attachments?.length && !saved?.seenUserIds.includes(m.id))
    ? (await store.artifacts(project.id)).map((file) => [file.id, file] as const) : []);
  const asUser = async (message: AgentInput): Promise<AgentMessage[]> => {
    const prompt = message.content;
    if (message.source || message.scheduled || !prompt.includes("dsh-session:")) return [userInput(message, currentFiles)];
    const { text, references } = parseSessionReferences(prompt, run.sessionId ?? "");
    const clean = userInput({ ...message, content: text }, currentFiles);
    if (!references.size) return [clean];
    const snapshots = await Promise.all([...references].map(([id, label]) => store.referenceSession(run, message.id, id, label)));
    const omissions = snapshots.flatMap(({ omission }) => omission ? [omission] : []);
    const snapshotIds = omissions.flatMap(({ fullSnapshot }) => fullSnapshot.status === "saved" ? [fullSnapshot.snapshot_id] : []);
    const previews = snapshots.map(({ preview }) => preview);
    const content = ["## 引用的对话", sessionReferenceWarning, stringifyReference(previews),
      ...(omissions.length ? ["引用省略记录", stringifyReference(omissions)] : [])].join("\n");
    return [clean, { role: "user", source: { kind: "session-reference", ...(snapshotIds.length ? { snapshotIds } : {}) }, content }];
  };
  const skillMessages = async (messages: AgentInput[]) => {
    if (!skillDiscovery) return [];
    const names = new Set(messages.flatMap(({ content, source, scheduled }) =>
      source || scheduled ? [] : skillGestures(content).map(({ name }) => name)));
    if (!names.size) return [];
    const execution = watchExecution(store, run), injections: AgentMessage[] = [];
    try {
      for (const name of names) {
        const skill = skillDiscovery.entries.find(({ entry }) => entry.name === name && canInvokeSkill(entry, preset?.skills, "user"));
        if (!skill) continue;
        try {
          const content = await skill.read(undefined, "user", execution.signal);
          injections.push({ role: "user", source: { kind: "tool-context" },
            content: renderSkillContent(name, content, skill.provider, skill.resourceBase) });
        } catch {
          execution.check();
          injections.push({ role: "user", source: { kind: "tool-context" }, content: "用户选择的技能 /" + name + " 暂不可用。" });
        }
      }
    } finally { execution.close(); }
    return injections;
  };
  const userMessages = async (messages: AgentInput[]) => [...(await Promise.all(messages.map(asUser))).flat(), ...await skillMessages(messages)];
  let state: AgentState;
  if (saved) state = saved;
  else {
    const dependencies = store.batchInputs(run);
    const inputIds = new Set(inputs.map(({ id }) => id));
    const committed = (await Promise.all(history.filter((message) =>
      !inputIds.has(message.id) && (message.content || message.attachments?.length)).slice(-20)
      .map((message): AgentMessage[] | Promise<AgentMessage[]> => message.role === "user" ? asUser(message) :
        [{ role: "assistant", content: message.content }]))).flat();
    const proposed = await userMessages(inputs);
    if (dependencies.length) proposed.push({ role: "user", source: { kind: "task-result" },
      content: "本批次已完成的前置任务结果（供当前任务参考）：\n" + JSON.stringify(dependencies) });
    state = { messages: [...committed, ...proposed], ...(proposed.length ? { unadmittedInputStart: committed.length } : {}),
      seenUserIds: [...inputIds], unadmittedInputIds: [...inputIds], step: 0, toolIndex: 0, artifactIds: [] };
  }
  if (state.contextOverflow && state.contextOverflow.turn !== run.generation)
    state = { ...state, contextOverflow: undefined, contextRecovery: undefined, compactionBypass: undefined };
  if (!state.contextRoute) state = { ...state, contextRoute: store.lastContextRoute(previous ?? run) };
  const toolRecords = new Map<string, ToolOutputRecord>();
  const hooks = options.pluginScope?.hooks ?? [];
  const skipped: SkippedToolCall[] = [];
  const projectResult = (next: AgentState, call: AgentToolCall, observe = true): AgentState => {
    const message = next.messages.at(-1)!;
    const projected = projectToolOutput(message, imagePricing.price, undefined, call.function.name);
    if (projected.record) toolRecords.set(call.id, projected.record);
    const sent = run.parentRunId && call.function.name === "send_message" ? JSON.parse(message.content ?? "{}") : undefined;
    const result = { ...next, messages: [...next.messages.slice(0, -1), projected.message],
      ...((sent?.agent_id === leadAgentId || sent?.task_id === run.parentRunId) && typeof sent.message_id === "string" ? { parentMessageCallId: call.id } : {}) };
    if (!observe) return result;
    const { chain, notice } = observeRepeat(next.repeatToolCall, call);
    return { ...result, repeatToolCall: chain, ...(notice ? { pendingNotices: [...next.pendingNotices ?? [], notice] } : {}) };
  };
  const save = async (next: AgentState, label = "正在创作", kind?: SessionChange, reference?: string, rejectedInputs?: readonly string[]) => {
    await ensureCurrent();
    const projections: ExecutionProjection[] = [];
    for (const hook of hooks) {
      const projection = hook.project?.({ ...executionScope(run), kind: kind ?? "checkpoint", reference,
        get state() { return structuredClone(next); } });
      if (!projection) continue;
      if (!/^[a-z][a-z0-9_/-]{0,95}$/.test(projection.name) || !projection.label.trim() ||
          JSON.stringify(projection).length > 16_384) throw new AppError("扩展投影格式无效", 400, "EXTENSION_PROJECTION_INVALID");
      projections.push(projection);
    }
    state = next;
    run = await store.updateRun(run, { status: "queued", label, payload: { ...run.payload, agent: state }, leaseUntil: run.leaseUntil }, false,
      kind, reference, toolRecords, skipped, projections, rejectedInputs);
  };
  const park = async (waitingFor: string[], reference?: string, limits: { waitingForInputUntil?: number; waitingForTasksUntil?: number; waitingForJob?: true } = {}) => {
    const { waitingForInputUntil, waitingForTasksUntil, waitingForJob } = limits;
    state = { ...state, finalReply: undefined, waitingFor, waitingForJob, waitingForInputUntil, waitingForTasksUntil, waitingInputVersion: run.inputVersion };
    await store.updateRun(run, { status: "waiting", label: waitingForInputUntil ? "等待协作消息" : "等待子任务", leaseUntil: run.leaseUntil,
      payload: { ...run.payload, agent: state } }, false, "tasks/waiting", reference, toolRecords);
  };
  const resumeAfterSummaryFailure = (): AgentState => {
    const overflow = state.contextOverflow;
    if (!overflow?.pruned) throw new AppError(overflow?.error || "模型上下文超过限制", 400, CONTEXT_OVERFLOW);
    return { ...state, pendingRequest: undefined, contextRecovery: "used", compactionBypass: true };
  };
  const applySummary = (summary: string, cut: number): AgentState => {
    const replacement = summaryMessage(summary);
    const recovering = state.contextRecovery === "needed";
    const savings = state.messages.slice(0, cut).reduce((sum, item) => sum + estimateMessage(item), 0) - estimateMessage(replacement);
    if (manualCompact && (!summary.trim() || savings <= 0))
      return { ...state, pendingRequest: undefined, finalReply: "历史未缩短，已保留原上下文。" };
    if (!summary.trim() || savings <= 0) {
      if (recovering) return resumeAfterSummaryFailure();
      return { ...state, pendingRequest: undefined, compactionBypass: true };
    }
    return { ...state, summary, pendingRequest: undefined, ...(manualCompact ? { finalReply: "已整理 " + cut + " 条上下文记录，预计减少 " + savings + " 个 token。" } : {}), messages: [replacement, ...state.messages.slice(cut)],
      unadmittedInputStart: state.unadmittedInputStart === undefined ? undefined : 1 + Math.max(0, state.unadmittedInputStart - cut),
      pressureCompactions: recovering || manualCompact ? state.pressureCompactions : (state.pressureCompactions ?? 0) + 1,
      contextRecovery: recovering ? "used" : state.contextRecovery };
  };
  let recoveredRequest: { kind: SessionChange; id?: string } | undefined;
  let retryRequest: ModelStepRequest | undefined;
  let imageRepair: { rejectedRequestId: string; removed: number } | undefined;
  if (state.pendingRequest) {
    const pendingId = state.pendingRequest.id;
    const call = await store.modelCall(run, pendingId);
    const request = call ? JSON.parse(String(call.request)) as ModelStepRequest : undefined;
    if (call?.status === "completed" && call.response && request) {
      const response = JSON.parse(String(call.response)) as AgentMessage;
      if (request.purpose === "compaction" || request.purpose === "manual-compaction") {
        const overflow = state.contextRecovery === "needed";
        state = applySummary(response.content || "", request.sourceCount ?? request.messages.length);
        recoveredRequest = { kind: state.compactionBypass ? "context/unchanged" : "context/compacted", id: overflow ? undefined : String(call.id) };
      } else {
        const usage = call.usage ? JSON.parse(String(call.usage)) as ModelUsage : undefined;
        const measurement = usage?.inputTokens && Number.isSafeInteger(request.estimatedTokens)
          ? { modelKey: request.pricingKey ?? request.baseUrl + "|" + request.model, inputTokens: usage.inputTokens, estimatedTokens: Number(request.estimatedTokens) } : state.contextMeasurement;
        const finalReply = response.tool_calls?.length ? undefined : response.content?.trim() ?? "";
        state = { ...state, pendingRequest: undefined, toolRequestId: String(call.id), messages: finalReply === "" && !response.messagesReplay && !response.chatReasoning ? state.messages : [...state.messages, response],
          toolIndex: 0, step: state.step + 1, contextMeasurement: measurement, contextRecovery: undefined, contextOverflow: undefined, compactionBypass: undefined, pressureCompactions: undefined, toolConcludesTurn: undefined };
        state.finalReply = finalReply;
        state.finalReplyReason = response.finishReason;
        recoveredRequest = { kind: "model/accepted", id: String(call.id) };
      }
    } else if (call?.error_code === CONTEXT_OVERFLOW && !state.contextRecovery && request?.purpose === "creation" && request.turn === run.generation) {
      const { turn, step, attempt } = request;
      state = { ...state, pendingRequest: undefined, contextRecovery: "needed", contextOverflow: { turn, step, attempt, error: String(call.error || "模型上下文超过限制") } };
    } else {
      if (call?.status === "failed" && request?.turn === run.generation && request.inputVersion === run.inputVersion &&
          !inputs.some((input) => input.source?.kind !== "agent-message" && input.source?.kind !== "schedule-change" && !state.seenUserIds.includes(input.id))) {
        if (call?.error_code === IMAGE_OFFLOAD_REQUIRED && typeof call.offload_images === "number") {
          const imageProjection = offloadRequestImages(state.messages, request.messages, call.offload_images,
            request.purpose === "creation" ? undefined : request.sourceCount);
          if (!imageProjection) throw new ImageBudgetError(call.offload_images);
          imageRepair = { rejectedRequestId: String(call.id), removed: imageProjection.removed };
          const { history, messages } = imageProjection;
          state = { ...state, messages: history };
          retryRequest = { ...request, messages, estimatedTokens: estimateRequestTokens(request.system, request.tools, messages, requestImagePricing(request.baseUrl).price) };
        } else if (request.purpose === "compaction") {
          const overflow = state.contextRecovery === "needed";
          state = overflow ? resumeAfterSummaryFailure() : { ...state, compactionBypass: true };
          recoveredRequest = { kind: "context/unchanged", id: overflow ? undefined : pendingId };
        }
        else if (run.payload.modelDirectRetry === pendingId || canRetryModelError(request.retryPolicy ?? defaultModelRetry, String(call.error_code))) {
          const backoffs = request.backoffs ?? Math.max(0, request.attempt - 1);
          retryRequest = { ...request, backoffs: backoffs + Number(run.payload.modelRetry?.requestId === pendingId) };
        }
      }
      const partial = typeof call?.visible_text === "string" && call.visible_text ? call.visible_text : run.streamText;
      const crashed = !call || call.status === "started";
      if (crashed) await store.settleModelCall(run, pendingId, { status: "interrupted", text: partial, error: "上次模型请求中断", errorCode: "REQUEST_INTERRUPTED" });
      const code = call?.error_code;
      const assistant = interruptedAssistant(call?.response, partial);
      let recovery: string | undefined;
      if (code === "MODEL_TRUNCATED") recovery = "上次响应超过单次输出限制，未完整收到的工具调用没有执行。缩短本次回复；长文件分次写入，先读取已保存版本，再局部追加或修改。保留已完成产物，勿重复提交成功或结果未知的付费生成。";
      else if (code === "MODEL_TIMEOUT" && partial && !retryRequest) recovery = "上次响应已中断，因为读取模型结果超时。接着已收到的正文继续。";
      else if (code === "AGENT_STEER") recovery = assistant ? "当前回复已因用户补充中断。按最新输入继续。" : undefined;
      else if (crashed || call?.status === "interrupted") recovery = "上次响应已中断。保留已保存文件和已交付的文字，继续处理当前要求；未完整收到的工具调用尚未执行。";
      const recovered: AgentMessage[] = recovery ? [
        ...(assistant ? [assistant] : []), { role: "user", content: recovery },
      ] : [];
      const recoverVisibleText = !manualCompact && (!request || request.purpose === "creation");
      state = { ...state, pendingRequest: undefined,
        messages: recoverVisibleText && recovered.length ? [...state.messages, ...recovered] : state.messages };
    }
  }
  if (recoveredRequest) {
    run = await store.updateRun(run, { label: "恢复已收到的结果", status: "running", leaseUntil: run.leaseUntil,
      payload: { ...run.payload, agent: state } }, false, recoveredRequest.kind, recoveredRequest.id);
  }
  if (state.finalReply !== undefined && await store.finishAgent(run, state.finalReply)) return;
  // A recovered draft whose boundary still has work must not close a later checkpoint.
  if (!manualCompact) state = { ...state, finalReply: undefined, finalReplyReason: undefined };
  let settledRequestId: string | undefined;
  const invokeModel = async (system: string, messages: AgentMessage[], tools: AgentTool[], visible = true, sourceCount = messages.length,
    retry?: ModelStepRequest, toolBindings?: Record<string, string>) => {
    await ensureCurrent();
    const requestId = uid(), inputVersion = run.inputVersion;
    const route = retry ?? (!visible ? state.contextRoute : undefined) ?? target;
    const executionSettings = { ...applyToolSettings(settings, { textBaseUrl: route.baseUrl }), textModel: route.model,
      textThinking: retry ? retry.textThinking === true : settings.textThinking,
      textReasoningEffort: retry ? retry.textReasoningEffort : settings.textReasoningEffort };
    const maxTokens = retry?.max_tokens ?? (visible ? MODEL_OUTPUT_TOKENS : store.compaction.forRoute(route).maxTokens);
    if (!visible && !retry && !model && isMessagesRoute(executionSettings.textBaseUrl)) {
      const original = state.toolRequestId && await store.modelCall(run, state.toolRequestId);
      const prefix = original ? JSON.parse(String(original.request)) as ModelStepRequest : undefined;
      messages = [...messages, { role: "user", content: system + " 不调用工具。" }];
      system = prefix?.system ?? renderAgentPrompt(run.payload.resultFollowup);
      tools = prefix?.tools ?? [];
    }
    const repaired = retry ? { messages, repaired: 0 } : await repairToolHistory(messages, (id) => store.toolHistoryResult(run.id, id));
    const historyMessages = boundImages(omitRetiredGuides(repaired.messages));
    const requestMessages = renderSkillToolMessages(historyMessages);
    const estimatedTokens = retry?.estimatedTokens ?? estimateRequestTokens(system, tools, requestMessages, imagePricing.price);
    const native = !model && isMessagesRoute(executionSettings.textBaseUrl);
    const textThinking = !model && visible && executionSettings.textThinking === true && (native || Boolean(executionSettings.textReasoningEffort));
    const messagesSeries = native && visible ? (retry ? retry.messagesSeries : projectMessagesSeries(executionSettings,
      await messagesCapabilities(executionSettings), system, requestMessages, tools, state.messagesSeries)) : undefined;
    const attempt = retry ? retry.attempt + 1 : state.contextOverflow ? state.contextOverflow.attempt + (visible ? 1 : 0) : 1;
    const backoffs = retry?.backoffs ?? 0;
    const request: ModelStepRequest = { system, messages: requestMessages, tools, model: executionSettings.textModel,
      baseUrl: executionSettings.textBaseUrl, sourceCount, estimatedTokens, pricingKey: retry?.pricingKey ?? modelKey, inputVersion,
      turn: run.generation, step: retry?.step ?? state.contextOverflow?.step ?? (await store.nextModelStep(run)),
      attempt,
      max_tokens: maxTokens, retryPolicy: retry?.retryPolicy ?? store.modelRetry.forRoute(route.baseUrl),
      ...(backoffs !== attempt - 1 ? { backoffs } : {}),
      ...(visible ? { toolSettings: retry?.toolSettings ?? toolSettingsSnapshot(settings), toolRoles: retry?.toolRoles ?? store.agents,
        toolBindings: retry?.toolBindings ?? toolBindings } : {}),
      ...(messagesSeries ? { messagesSeries } : {}), ...(textThinking ? { textThinking, ...(executionSettings.textReasoningEffort ? { textReasoningEffort: executionSettings.textReasoningEffort } : {}) } : {}),
      purpose: visible ? "creation" : manualCompact ? "manual-compaction" : "compaction" };
    if (repaired.repaired) await store.event(project.id, "history_repaired", { runId: run.id, count: repaired.repaired }).run();
    state = { ...state, ...(visible && (messages === state.messages || retry) ? { messages: historyMessages } : {}), pendingRequest: { id: requestId },
      ...(visible ? { toolRequestId: requestId, admittedTools: tools.map((item) => item.function.name), messagesSeries,
        contextRoute: { baseUrl: route.baseUrl, model: route.model }, unadmittedInputStart: undefined, unadmittedInputIds: undefined } : {}) };
    run = await store.beginModelCall({ ...run, payload: { ...run.payload, agent: state } }, requestId,
      { ...request, thinking: { type: textThinking ? "enabled" : "disabled" } }, imageRepair);
    const execution = watchExecution(store, { ...run, inputVersion });
    let lastWrite = 0, latestText = "", published = "", lastOutputAt: string | undefined;
    let usage: ModelUsage | undefined, providerRequestId: string | undefined, response: AgentMessage | undefined, firstOutput = false;
    const frames: { at: number; data: string }[] = [];
    let traceBytes = 0, traceTruncated = false;
    const onStreamFrame = (data: string) => {
      if (traceTruncated) return;
      traceBytes += Buffer.byteLength(data, "utf8");
      if (traceBytes > 2 * 1024 * 1024 || frames.length >= 8192) { traceTruncated = true; return; }
      frames.push({ at: Date.now(), data });
    };
    const markFirstOutput = async () => {
      if (firstOutput) return;
      firstOutput = true;
      lastOutputAt ??= new Date().toISOString();
      await store.markModelFirstOutput(run, requestId);
    };
    const publish = async () => {
      if (latestText === published) return;
      if (!await store.publishStream(run, requestId, latestText)) {
        execution.check();
        throw new AppError("模型请求已失效", 409, "RUN_STOPPED");
      }
      published = latestText; lastWrite = Date.now();
    };
    try {
      execution.check();
      response = await (model ?? createAgentModel({ ...executionSettings, textThinking }))(system, requestMessages, tools, { signal: execution.signal,
        providerFiles: store.db, messagesSeries, maxTokens, onStreamFrame,
        onUsage: async (value) => { usage = value; }, onRequestId: (id) => { providerRequestId = id; }, onFirstOutput: markFirstOutput,
        onOutput: () => { lastOutputAt = new Date().toISOString(); },
        resolveImage: options.bucket ? (image) => imageDataUrl(image, options.bucket!, project.id) : undefined,
        onText: visible ? async (text) => {
        if (text) { lastOutputAt = new Date().toISOString(); await markFirstOutput(); }
        latestText = text;
        if (Date.now() - lastWrite >= 180) await publish();
      } : undefined });
      execution.check(); if (visible) await publish();
      if (!visible && response.finishReason === "max-tokens") throw new AppError("上下文摘要达到输出上限", 502, "MODEL_SUMMARY_TRUNCATED");
      if (visible) response = separateRepeatedToolIds(store, run, requestId, requestMessages, response);
      await store.settleModelCall(run, requestId, { status: "completed", response, usage, providerRequestId, text: latestText, lastOutputAt,
        errorCode: response.finishReason === "max-tokens" ? "MODEL_TRUNCATED" : undefined });
      settledRequestId = requestId;
      state = { ...state, pendingRequest: undefined, ...(visible && usage?.inputTokens ? {
        contextMeasurement: { modelKey: request.pricingKey, estimatedTokens, inputTokens: usage.inputTokens },
      } : {}) };
      return response;
    } catch (error) {
      let code = error instanceof AppError ? error.code : "MODEL_UNAVAILABLE";
      let failure = error;
      const policy = request.retryPolicy ?? defaultModelRetry;
      let recovery: "direct" | "terminal" | undefined;
      const advice = error instanceof ModelRequestError ? error.retryAfterMs : undefined;
      const providerDelay = advice && Number.isFinite(advice) && advice > 0 ? advice : undefined;
      const ordinaryRecovery = policy.mode === "normal" && canRetryModelError(policy, code) &&
        (request.backoffs ?? request.attempt - 1) < policy.maxRetries && (providerDelay === undefined || providerDelay <= policy.maxDelayMs);
      const providerFailure = error instanceof ModelRequestError || canRetryModelError(defaultModelRetry, code) ||
        ["MODEL_RESPONSE_INVALID", "MODEL_UNSUPPORTED_CONTENT", "MODEL_ERROR", "MODEL_AUTH", "MODEL_NOT_CONFIGURED", "MODEL_REFUSED"].includes(code);
      if (!execution.signal.aborted && !(error instanceof ImageBudgetError) && code !== CONTEXT_OVERFLOW &&
          providerFailure && !ordinaryRecovery) {
        for (const hook of hooks) {
          if (!hook.requestError) continue;
          try {
            const decision = await hook.requestError({ ...executionScope(run), code, message: safeError(error),
              attempt: request.attempt, signal: execution.signal });
            execution.check();
            if (!decision) continue;
            if (decision === "retry") recovery = "direct";
            else if (policy.mode === "normal") {
              recovery = "terminal";
              code = "MODEL_REQUEST_REJECTED";
              failure = new AppError(safeError(error), 502, code);
            }
            break;
          } catch (hookError) {
            if (policy.mode === "always" && !execution.signal.aborted) break;
            failure = hookError;
            code = hookError instanceof AppError ? hookError.code : "EXTENSION_HOOK_FAILED";
            recovery = "terminal";
            if (!(hookError instanceof AppError)) failure = new AppError(safeError(hookError), 500, code);
            break;
          }
        }
      }
      const replay = native && textThinking && execution.signal.aborted
        ? interruptedMessagesReplay(frames, latestText) : undefined;
      const observed: AgentMessage | undefined = frames.length || traceTruncated ? { role: "assistant", content: latestText || null,
        ...(replay ? { messagesReplay: { endpoint: messagesEndpoint(route.baseUrl), model: route.model, blocks: replay } } : {}),
        attemptTrace: { protocol: native ? "messages" : "chat-completions", frames, truncated: traceTruncated } } : response;
      await store.settleModelCall(run, requestId, { status: ["RUN_STOPPED", "AGENT_STEER"].includes(code) ? "interrupted" : "failed", response: observed, usage, lastOutputAt,
        providerRequestId: providerRequestId || (error as { providerRequestId?: string })?.providerRequestId, text: latestText, error: safeError(failure), errorCode: code,
        offloadImages: error instanceof ImageBudgetError ? error.offloadImages : undefined });
      if (error instanceof ImageBudgetError && requestMessages.some((message) => message.images?.length)) {
        await save(state, "调整图片上下文");
        return;
      }
      if (!visible && !manualCompact && !execution.signal.aborted && !["RUN_STOPPED", "AGENT_STEER"].includes(code)) {
        const overflow = state.contextRecovery === "needed";
        const next = overflow ? resumeAfterSummaryFailure() : { ...state, compactionBypass: true, pendingRequest: undefined };
        await save(next, overflow ? "使用已裁剪的上下文" : "保留原上下文", "context/unchanged", overflow ? undefined : requestId);
        return;
      }
      if (providerFailure && !execution.signal.aborted && code !== CONTEXT_OVERFLOW && !(error instanceof ImageBudgetError))
        throw markModelFailure(failure instanceof AppError ? failure : new AppError(safeError(failure), 502, code), policy,
          { id: requestId, baseUrl: request.baseUrl, turn: request.turn, step: request.step, attempt: request.attempt,
            inputVersion, backoffs: request.backoffs }, recovery);
      throw failure;
    } finally { execution.close(); }
  };
  const acceptCreation = async (response: AgentMessage) => {
    await ensureCurrent();
    const finalReply = response.tool_calls?.length ? undefined : response.content?.trim() ?? "";
    state = { ...state, messages: finalReply === "" && !response.messagesReplay && !response.chatReasoning ? state.messages : [...state.messages, response], step: state.step + 1, toolIndex: 0, contextRecovery: undefined, contextOverflow: undefined, compactionBypass: undefined,
      toolConcludesTurn: undefined, pressureCompactions: undefined, finalReply, finalReplyReason: response.finishReason };
    await save(state, finalReply !== undefined ? "整理结果" : "继续创作", "model/accepted", settledRequestId);
    if (finalReply !== undefined && !await store.finishAgent(run, finalReply))
      await save({ ...state, finalReply: undefined, finalReplyReason: undefined, waitingFor: undefined, waitingForJob: undefined, waitingForInputUntil: undefined, waitingForTasksUntil: undefined, waitingInputVersion: undefined }, "继续处理新消息");
  };
  if (retryRequest) {
    if (!run.parentRunId && await store.claimStepQueue(run)) {
      // A new input can win before the replacement request is committed.
      await save(imageRepair ? run.payload.agent! : state, "处理本轮补充", "inbox/claimed");
      return;
    }
    const retry = retryRequest;
    if (retry.purpose === "creation") {
      try {
        const response = await invokeModel(retry.system, retry.messages, retry.tools, true, retry.sourceCount, retry);
        if (response) await acceptCreation(response);
      }
      catch (error) {
        if (!(error instanceof AppError) || error.code !== CONTEXT_OVERFLOW || state.contextRecovery || !state.pendingRequest) throw error;
        await save(state, "整理上下文");
      }
      return;
    }
    const summary = await invokeModel(retry.system, retry.messages, retry.tools, false, retry.sourceCount, retry);
    if (!summary) return;
    const next = applySummary(summary.content || "", retry.sourceCount);
    await save(next, next.compactionBypass ? "保留原上下文" : "已整理上下文", next.compactionBypass ? "context/unchanged" : "context/compacted", next.contextOverflow ? undefined : settledRequestId);
    if (manualCompact && next.finalReply) await store.finishAgent(run, next.finalReply);
    return;
  }
  if (manualCompact) {
    const unseen = inputs.filter((message) => !state.seenUserIds.includes(message.id));
    state = { ...state, messages: [...state.messages, ...await userMessages(unseen)], seenUserIds: inputs.map((item) => item.id) };
    const latest = state.messages.findLastIndex((message) => message.role === "user" && !message.source);
    const cut = retainedContextBoundary(state.messages, 1, { latestCut: latest < 0 ? undefined : latest, priceImage: imagePricing.price });
    const older = summaryInput(state.messages.slice(0, cut));
    if (!state.finalReply && older.some((message) => message.source?.kind !== "compaction")) {
      const summary = await invokeModel(summaryInstruction, older, [], false, cut);
      if (!summary) return;
      state = applySummary(summary.content ?? "", cut);
    }
    const finalReply = state.finalReply ?? "暂无可整理的历史。";
    await save({ ...state, finalReply }, finalReply, "context/compacted", settledRequestId);
    await store.finishAgent(run, finalReply);
    return;
  }
  const unseen = inputs.filter((m) => !state.seenUserIds.includes(m.id));
  const hasImmediateInput = unseen.some((message) => message.source?.kind !== "agent-message" && message.source?.kind !== "schedule-change");
  const includeInputs = async () => {
    state = { ...state, messages: [...state.messages, ...await userMessages(unseen)], seenUserIds: [...state.seenUserIds, ...unseen.map((m) => m.id)],
      parentMessageCallId: undefined,
      unadmittedInputStart: state.unadmittedInputStart ?? state.messages.length,
      unadmittedInputIds: [...state.unadmittedInputIds ?? [], ...unseen.map(({ id }) => id)],
      ...(hasImmediateInput ? { repeatToolCall: undefined, compactionBypass: undefined, pressureCompactions: undefined, contextRecovery: undefined, contextOverflow: undefined } : {}) };
  };
  const tasks = await store.agentTasks(run);
  const notices = store.taskInbox(run, tasks).filter(taskResultReady);
  const notDelivered = (task: Run) => (task.background ? state.backgroundNotices : state.childNotices)?.[task.id] !== taskNoticeKey(task);
  const assistant = [...state.messages].reverse().find((m) => m.role === "assistant");
  const calls = assistant?.tool_calls || [];
  const admitted = state.toolIndex < calls.length && state.toolRequestId ? await store.toolStepRequest(run, state.toolRequestId) : undefined;
  let needsCheckpoint = false;
  if (admitted?.turn != null && admitted.turn !== run.generation) {
    // A retry of a stopped turn starts a new generation. Its old batch is sealed.
    for (const call of calls.slice(state.toolIndex)) {
      const savedResult = await store.settledToolOutput(run.id, call.id);
      const receipt = await store.toolReceipt(run.id, call.id);
      const closes = call.function.name === structuredOutputTool && receipt?.concludesTurn;
      if (state.structuredResult && !savedResult && !receipt)
        skipped.push({ call, index: state.toolIndex, requestId: state.toolRequestId });
      state = settleTool(state, call.id, savedResult?.result ?? receipt?.result ??
        (state.structuredResult ? toolNotStarted : { status: "unknown", code: "TOOL_RESULT_UNKNOWN", message: "上一轮的工具结果未确认。" }));
      if (closes) state = { ...state, structuredResult: receipt.result.structured as Record<string, unknown> };
      if (savedResult) {
        state.messages[state.messages.length - 1] = { ...state.messages.at(-1)!, images: savedResult.images, outputRef: savedResult.outputRef };
        state = projectResult(state, call, false);
        if (savedResult.additionalContexts?.length)
          state = { ...state, pendingNotices: [...state.pendingNotices ?? [], ...savedResult.additionalContexts] };
      } else if (receipt && call.function.name === "send_message") state = projectResult(state, call, false);
    }
    state = { ...state, waitingFor: undefined, waitingForJob: undefined, waitingForInputUntil: undefined, waitingForTasksUntil: undefined, waitingInputVersion: undefined };
    if (state.structuredResult) {
      await save({ ...state, finalReply: assistant?.content?.trim() ?? "" }, "正在创作", "tools/settled");
      return;
    }
    needsCheckpoint = true;
  }
  if (state.waitingFor?.length || state.waitingForInputUntil) {
    if (!run.parentRunId && await store.claimStepQueue(run)) {
      await save(state, "处理本轮补充", "inbox/claimed");
      return;
    }
    const waitingFor = state.waitingFor ?? [];
    const selected = tasks.filter((task) => waitingFor.includes(task.id));
    const awaitingInput = state.waitingForInputUntil;
    const deadline = state.waitingForTasksUntil;
    const newInput = state.waitingForJob ? unseen.some((input) => !input.source) :
      unseen.some((input) => input.source?.kind !== "schedule-change") || notices.some((task) => !waitingFor.includes(task.id) && notDelivered(task));
    const pending = awaitingInput ? Date.now() < awaitingInput : selected.some((task) => !taskResultReady(task));
    const timedOut = pending && deadline !== undefined && Date.now() >= deadline;
    if (pending && !newInput && !timedOut) {
      await park(waitingFor, undefined, { waitingForInputUntil: awaitingInput, waitingForTasksUntil: deadline, waitingForJob: state.waitingForJob }); return;
    }
    const waitingCall = calls[state.toolIndex];
    if (waitingCall?.function.name === "wait_for_tasks") {
      const status = !pending ? "settled" : timedOut && !newInput ? "timed_out" : "interrupted";
      state = settleTool(state, waitingCall.id, { status, tasks: selected.map(taskResult) });
      state = projectResult(acknowledgeTaskResults(state, selected), waitingCall);
    }
    if (waitingCall?.function.name === "job_output" && waitingFor.length) {
      const result = await consumeJobOutput(store, run, waitingCall.id, waitingFor[0], pending ? timedOut && !newInput ? "timed_out" : "interrupted" : undefined);
      state = settleTool(state, waitingCall.id, result);
      state = projectResult(acknowledgeTaskResults(state, result.result ? selected : []), waitingCall);
    }
    if (waitingCall?.function.name === "wait_for_input") {
      state = projectResult(settleTool(state, waitingCall.id, { timedOut: !newInput }), waitingCall);
    }
    state = { ...state, waitingFor: undefined, waitingForJob: undefined, waitingForInputUntil: undefined, waitingForTasksUntil: undefined, waitingInputVersion: undefined };
    needsCheckpoint = true;
  }
  if (hasImmediateInput) {
    const start = state.toolIndex;
    for (const [offset, call] of calls.slice(start).entries()) {
      const receipt = await store.toolResult(run.id, call.id);
      const result = receipt?.status === "pending" ? { status: "unknown", code: "TOOL_RESULT_UNKNOWN", message: "调用已登记，结果尚未确认。" } : receipt;
      const started = Boolean(receipt) || store.toolStepDispatched(run.id, call.id);
      if (!started) skipped.push({ call, index: start + offset, requestId: state.toolRequestId });
      const settled = settleTool(state, call.id, result ?? (started
        ? { status: "interrupted", message: "用户已更新要求，此调用未取得结果。" }
        : toolNotStarted));
      state = projectResult(call.function.name === "control_task" && result ? acknowledgeTaskControl(settled, result, tasks) : settled, call, started);
    }
    await includeInputs();
    needsCheckpoint = true;
  }
  const toolContext = { store, project, settings, preset, skillDiscovery, scopedTools: options.pluginScope?.tools,
    run: { ...run, payload: { ...run.payload, agent: state } },
    bucket: options.bucket, tasks, ensureCurrent, liveSettings: options.liveSettings, resolveModel: store.resolveModel, executionHooks: hooks };
  const external = async (names?: readonly string[]) => store.mcp?.tools((await store.jobContext(run.id)).userId, preset?.mcpServers, options.pluginScope?.key, names);
  if (state.toolIndex < calls.length) {
    const frozen = admitted?.settings ? JSON.parse(admitted.settings) as ReturnType<typeof toolSettingsSnapshot> : undefined;
    const executionSettings = frozen ? applyToolSettings(settings, frozen) : settings;
    const mcpCalls = calls.slice(state.toolIndex).map((call) => call.function.name).filter(isMcpTool);
    const externalTools = mcpCalls.length ? (await external(mcpCalls))?.registrations : undefined;
    const registry = createToolRegistry({ ...toolContext, externalTools, settings: executionSettings, roles: admitted?.roles ? JSON.parse(admitted.roles) as AgentDefinition[] : undefined }, state.admittedTools,
      admitted?.schemas ? JSON.parse(admitted.schemas) as AgentTool[] : undefined,
      admitted?.bindings ? JSON.parse(admitted.bindings) as Record<string, string> : undefined);
    const call = calls[state.toolIndex], first = registry.prepare(call);
    await ensureCurrent();
    await store.updateRun(run, { label: registry.get(call.function.name)?.label || "使用工具", leaseUntil: run.leaseUntil });
    const parallel = registry.isParallel(first), group = [first];
    if (parallel) {
      for (let index = state.toolIndex + 1; index < calls.length; index++) {
        const prepared = registry.prepare(calls[index]);
        if (!registry.isParallel(prepared)) break;
        group.push(prepared);
      }
    }
    const outcomes = await executeToolGroup(store, run, registry, group, ensureCurrent, parallel, { requestId: state.toolRequestId, index: state.toolIndex });
    let next = state;
    for (const [index, outcome] of outcomes.entries()) {
      const { call: item } = group[index];
      if ("waitFor" in outcome) {
        await park(outcome.waitFor, item.id, { waitingForTasksUntil: outcome.waitForTasksUntil, waitingForJob: item.function.name === "job_output" ? true : undefined });
        return;
      }
      if ("waitForInputUntil" in outcome) {
        await park([], item.id, { waitingForInputUntil: outcome.waitForInputUntil });
        return;
      }
      next = settleTool(next, item.id, outcome.result);
      if (outcome.concludesTurn) next = { ...next, toolConcludesTurn: true };
      if (item.function.name === structuredOutputTool && outcome.concludesTurn)
        next = { ...next, structuredResult: outcome.result.structured as Record<string, unknown> };
      if (item.function.name === "control_task") next = acknowledgeTaskControl(next, outcome.result, tasks);
      if (outcome.observedTasks) next = acknowledgeTaskResults(next, outcome.observedTasks);
      if (item.function.name === "job_output" && outcome.result.result) {
        const task = tasks.find(({ id }) => id === outcome.result.job_id);
        if (task) next = acknowledgeTaskResults(next, [task]);
      }
      if (outcome.images?.length || outcome.outputRef) {
        next.messages[next.messages.length - 1] = { ...next.messages.at(-1)!, images: outcome.images, outputRef: outcome.outputRef };
      }
      if (outcome.artifactIds?.length) next.artifactIds = [...new Set([...next.artifactIds, ...outcome.artifactIds])];
      next = projectResult(next, item);
      if (outcome.additionalContexts?.length)
        next = { ...next, pendingNotices: [...next.pendingNotices ?? [], ...outcome.additionalContexts] };
    }
    if (next.structuredResult && next.toolIndex < calls.length) {
      for (const item of calls.slice(next.toolIndex)) {
        skipped.push({ call: item, index: next.toolIndex, requestId: state.toolRequestId });
        next = projectResult(settleTool(next, item.id, toolNotStarted), item, false);
      }
    }
    if (next.toolIndex >= calls.length && (next.structuredResult || next.toolConcludesTurn && !next.pendingNotices?.length))
      next = { ...next, finalReply: assistant?.content?.trim() ?? "" };
    await save(next, "正在创作", "tools/settled", call.id);
    return;
  }
  if (needsCheckpoint) run = await store.updateRun(run, { status: "running", leaseUntil: run.leaseUntil,
    payload: { ...run.payload, agent: state } }, false, "tools/settled", state.toolRequestId, toolRecords, skipped);
  else await store.settleSteps(run, state.messages);
  if (!run.parentRunId && await store.claimStepQueue(run)) {
    await save(state, "处理本轮补充", "inbox/claimed");
    return;
  }
  if (state.pendingNotices?.length) state = { ...state, unadmittedInputStart: state.unadmittedInputStart ?? state.messages.length,
    messages: [...state.messages, ...state.pendingNotices], pendingNotices: undefined };
  if (!hasImmediateInput && unseen.length) await includeInputs();
  // Inject notices only after the current assistant tool batch has all its receipts.
  for (const child of notices) {
    if (!notDelivered(child)) continue;
    if (child.background) {
      const notice = backgroundTaskNotice(store, run, child);
      state = { ...state, backgroundNotices: { ...state.backgroundNotices, [child.id]: taskNoticeKey(child) } };
      if (!notice) continue;
      state = { ...state, parentMessageCallId: undefined, unadmittedInputStart: state.unadmittedInputStart ?? state.messages.length,
        messages: [...state.messages, notice] };
      if (notice.source?.kind === "task-result" && notice.source.inlineOutput) state = acknowledgeTaskResults(state, [child]);
    } else {
      state = acknowledgeTaskResults({ ...state, parentMessageCallId: undefined,
        unadmittedInputStart: state.unadmittedInputStart ?? state.messages.length, messages: [...state.messages, { role: "user", source: { kind: "task-result" },
          content: "子任务状态通知（数据）：" + JSON.stringify(taskNotice(child, store.childReportedToParent(child, run))) }] }, [child]);
    }
  }
  if (state.structuredResult) {
    await save({ ...state, finalReply: assistant?.content?.trim() ?? "" }, "正在创作", "tools/settled");
    return;
  }
  const [files, collaborators, currentProject, mcp] = await Promise.all([
    store.runtimeFiles(project.id), store.collaborators(run), store.project(project.id, (await store.jobContext(run.id)).userId),
    external(),
  ]);
  const scopedTasks = [...new Map([...collaborators, ...tasks].map((task) => [task.id, task])).values()];
  const registry = createToolRegistry({ ...toolContext, externalTools: mcp?.registrations });
  const availableTools = registry.schemas();
  const skillCatalog = skillDiscovery?.entries.map(({ entry }) => entry).filter((entry) => canInvokeSkill(entry, preset?.skills, "model"));
  const sections = projectContextSections(currentProject, run, files, scopedTasks, settings);
  const depth = store.delegationDepth(run), maximum = store.maxDelegationDepth;
  const delegationTools = availableTools.map(({ function: fn }) => fn.name).filter((name) => name === "delegate" || name === "delegate_batch");
  if (depth >= maximum && delegationTools.length) sections.push({ name: "delegation-depth", text: delegationTools.map((name) =>
    "Delegation depth for `" + name + "`: current " + depth + ", maximum " + maximum + ", remaining levels 0. Do not call `" +
      name + "` at this depth; carry out the work directly.").join("\n") });
  if (registry.get("skill") === skillTools[0] && (skillCatalog?.length || skillDiscovery?.complete === false)) sections.push({ name: "skills", text: JSON.stringify({
    skills: (skillCatalog ?? []).map(({ name, description }) => {
      const normalized = description.replace(/\s+/g, " ").trim();
      return { name, description: normalized.length <= 500 ? normalized : normalized.slice(0, 497) + "..." };
    }),
    ...(skillDiscovery?.complete === false ? { incomplete: true, warning: "部分技能来源暂不可用，只使用本次目录确认的名称。" } : {}),
    read_with: "skill",
  }) });
  if (mcp?.resourceServers.length) sections.push({ name: "mcp", text: JSON.stringify({
    resource_servers: mcp.resourceServers, read_with: ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"],
    ...(mcp.instructions.length ? { external_mcp_instructions: mcp.instructions } : {}),
  }) });
  const reminder = projectRuntimeContext(state.messages, sections);
  state = { ...state, finalReply: undefined };
  const system = renderAgentPrompt(run.payload.resultFollowup) + (preset?.instructions ? "\n\n本会话的用户预设\n" + preset.instructions : "") + (run.payload.childExecution?.outputSchema
    ? "\n\n本次委派有结构化交付约定。完成后用 structured_output 提交符合工具参数定义的数据，提交后结束本轮。" : "");
  const pressureSurface = () => state.messages.slice(0, state.unadmittedInputStart);
  const measure = () => pricedTokens(estimateRequestTokens(system, availableTools, pressureSurface(), imagePricing.price), modelKey, state.contextMeasurement);
  const recovering = state.contextRecovery === "needed";
  const switching = state.contextRoute && compactionRouteKey(state.contextRoute) !== budget.key && !recovering && state.contextRecovery !== "used";
  const switchFailure = () => new AppError("不能切换到该模型线路，已有对话未能压缩到目标线路的阈值。原会话保留已保存的上下文。", 409, "MODEL_SWITCH_COMPACTION_FAILED");
  const aboveThreshold = measure() >= budget.thresholdTokens;
  const mayCompact = Boolean(state.contextRoute || state.step) && !state.compactionBypass && state.contextRecovery !== "used" && (state.pressureCompactions ?? 0) <= budget.compactionRetries;
  if (switching && aboveThreshold && !mayCompact) throw switchFailure();
  if (recovering || (mayCompact && aboveThreshold)) {
    const pruned = projectToolHistory(state.messages);
    if (pruned.replacements.length) {
      const contextOverflow = recovering && state.contextOverflow ? { ...state.contextOverflow, pruned: true as const } : state.contextOverflow;
      state = { ...state, messages: pruned.messages, contextOverflow };
      run = await store.commitToolPruning(run, state, pruned.replacements);
    }
    if (recovering || measure() >= budget.thresholdTokens) {
      // Runtime reminders are regenerated. They must not displace the last real message from the retained tail.
      const surface = recovering ? state.messages.slice(0, state.messages.findLastIndex((message) => message.source?.kind !== "runtime-context") + 1) : pressureSurface();
      const cut = retainedContextBoundary(surface, recovering ? 0 : budget.retainTokens, { priceImage: imagePricing.price });
      const older = summaryInput(state.messages.slice(0, cut));
      if (older.some((message) => message.source?.kind !== "compaction")) {
        if (switching && !model && !applyToolSettings(settings, { textBaseUrl: state.contextRoute!.baseUrl }).textApiKey) throw switchFailure();
        const summary = await invokeModel(summaryInstruction, older, [], false, cut);
        if (!summary) return;
        await ensureCurrent();
        const next = applySummary(summary.content || "", cut);
        // Reactive compaction shares the rejected creation step. Only creation may close it.
        await save(next, next.compactionBypass ? "保留原上下文" : "已整理上下文", next.compactionBypass ? "context/unchanged" : "context/compacted", recovering ? undefined : settledRequestId);
        return;
      }
      if (recovering) state = resumeAfterSummaryFailure();
      else if (switching) throw switchFailure();
    }
  }
  if (state.unadmittedInputIds?.length) await store.claimHumanWakeBudget(run, state.unadmittedInputIds);
  if (hooks.some(({ preStep }) => preStep)) {
    const execution = watchExecution(store, run);
    const boundary = state.unadmittedInputStart ?? state.messages.length;
    let proposed = state.messages.slice(boundary);
    try {
      for (const hook of hooks) {
        if (!hook.preStep) continue;
        const decision = await hook.preStep({ ...executionScope(run), messages: structuredClone(proposed), signal: execution.signal });
        execution.check();
        if (decision?.kind === "reject" || decision?.kind === "accept" && decision.messages?.length === 0 && !state.toolRequestId) {
          const closed = { ...state, messages: state.messages.slice(0, boundary), unadmittedInputStart: undefined, unadmittedInputIds: undefined };
          await save({ ...closed, finalReply: "" }, "整理结果", undefined, undefined, state.unadmittedInputIds);
          if (!await store.finishAgent(run, "")) await save({ ...closed, finalReply: undefined }, "继续处理新消息");
          return;
        }
        if (decision?.kind === "accept" && decision.messages) proposed = decision.messages;
      }
      state = { ...state, messages: [...state.messages.slice(0, boundary), ...proposed] };
    } finally { execution.close(); }
  }
  if (reminder) state = { ...state, messages: [...state.messages, reminder] };
  let response: AgentMessage | undefined;
  try { response = await invokeModel(system, state.messages, availableTools, true, state.messages.length, undefined, registry.bindings()); }
  catch (error) {
    if (!(error instanceof AppError) || error.code !== CONTEXT_OVERFLOW || state.contextRecovery || !state.pendingRequest) throw error;
    await save(state, "整理上下文");
    return;
  }
  if (response) await acceptCreation(response);
}
