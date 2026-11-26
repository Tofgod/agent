import { isDeepStrictEqual } from "node:util";
import type { AgentTool } from "./file-tools";
import { AppError } from "./security";
import { parseToolArguments } from "./tool-history";
import type { BlobStore } from "./storage";
import type { Store } from "./store";
import type { SessionPreset } from "./session-presets";
import type { TextModelResolver } from "./providers";
import { executionScope, type ExecutionHooks } from "./execution-hooks";
import type { SkillDiscovery } from "./skills";
import type { AgentDefinition, AgentImage, AgentMessage, AgentToolCall, Project, ProviderSettings, Run } from "./types";

export interface ToolContext {
  store: Store;
  run: Run;
  project: Project;
  settings: ProviderSettings;
  bucket?: BlobStore;
  tasks: Run[];
  roles?: readonly AgentDefinition[];
  preset?: SessionPreset | null;
  externalTools?: readonly ToolRegistration[];
  scopedTools?: readonly ToolRegistration[];
  skillDiscovery?: SkillDiscovery;
  ensureCurrent: () => Promise<void>;
  liveSettings?: () => Promise<ProviderSettings>;
  resolveModel?: TextModelResolver;
  executionHooks?: readonly ExecutionHooks[];
}

export interface ToolContinuation { concludesTurn?: boolean; additionalContexts?: AgentMessage[] }
export type ToolOutcome = ({ result: Record<string, unknown>; images?: AgentImage[]; outputRef?: string; artifactIds?: string[]; observedTasks?: Run[] } & ToolContinuation)
  | { waitFor: string[]; waitForTasksUntil?: number } | { waitForInputUntil: number };
export interface ToolRegistration {
  name?: string;
  schema: AgentTool | ((context: ToolContext) => AgentTool | undefined);
  available?: (context: ToolContext) => boolean;
  label: string;
  mode?: "parallel" | ((args: unknown, context: ToolContext) => boolean);
  timeoutMs?: number;
  matchAdmitted?: boolean;
  binding?: string;
  execute: (context: ToolContext & { signal: AbortSignal }, callId: string, args: unknown) => Promise<ToolOutcome>;
}
export interface PreparedToolCall { call: AgentToolCall; args: unknown; valid: boolean }

export function toolSettingsSnapshot(settings: ProviderSettings) {
  const { textBaseUrl, textThinking, textReasoningEffort, webSearchEnabled, imageModel, videoModel, arkBaseUrl, minimaxBaseUrl } = settings;
  return { textBaseUrl, textThinking, textReasoningEffort, webSearchEnabled, imageModel, videoModel, arkBaseUrl, minimaxBaseUrl };
}

export function applyToolSettings(current: ProviderSettings, saved: Partial<ReturnType<typeof toolSettingsSnapshot>>) {
  const settings = { ...current, ...toolSettingsSnapshot({ ...current, ...saved }) };
  settings.webSearchEnabled &&= current.webSearchEnabled;
  for (const [base, key] of [["textBaseUrl", "textApiKey"], ["arkBaseUrl", "arkApiKey"], ["minimaxBaseUrl", "minimaxApiKey"]] as const) {
    if (settings[base] !== current[base] && new URL(settings[base]).origin !== new URL(current[base]).origin) settings[key] = "";
  }
  return settings;
}

const runtimeBindings = new WeakMap<object, string>();

export function runtimeToolBinding(owner: object) {
  let binding = runtimeBindings.get(owner);
  if (!binding) { binding = crypto.randomUUID(); runtimeBindings.set(owner, binding); }
  return binding;
}

export class ToolRegistry {
  private readonly entries = new Map<string, { registration: ToolRegistration; schema: AgentTool; binding: string }>();
  constructor(private readonly context: ToolContext, registrations: readonly ToolRegistration[], admitted?: readonly string[], schemas?: readonly AgentTool[],
    bindings?: Readonly<Record<string, string>>, builtIn: ReadonlySet<ToolRegistration> = new Set(),
    private readonly currentRegistration?: (registration: ToolRegistration) => boolean) {
    const admittedNames = admitted ? new Set(admitted) : undefined;
    const saved = schemas ? new Map(schemas.map((schema) => [schema.function.name, schema])) : undefined;
    for (const registration of registrations) {
      if (registration.available?.(context) === false) continue;
      const stableName = registration.name ?? (typeof registration.schema !== "function" ? registration.schema.function.name : undefined);
      const schema = saved && stableName ? saved.get(stableName) :
        typeof registration.schema === "function" ? registration.schema(context) : registration.schema;
      if (!schema) continue;
      if (saved && registration.matchAdmitted && typeof registration.schema !== "function" &&
          !isDeepStrictEqual(schema.function.parameters, registration.schema.function.parameters)) continue;
      const name = schema.function.name;
      if (saved ? !saved.has(name) : admittedNames && !admittedNames.has(name)) continue;
      if (this.entries.has(name)) throw new Error("重复注册工具 " + name);
      const binding = registration.binding ?? (builtIn.has(registration) ? "builtin:" + name : runtimeToolBinding(registration));
      if (bindings && (!Object.hasOwn(bindings, name) || bindings[name] !== binding)) continue;
      this.entries.set(name, { registration, schema: saved?.get(name) ?? schema, binding });
    }
  }
  schemas() {
    return [...this.entries.keys()].sort().map((name) => this.entries.get(name)!.schema);
  }
  bindings() {
    return Object.fromEntries([...this.entries].map(([name, { binding }]) => [name, binding]));
  }
  get(name: string) { return this.entries.get(name)?.registration; }
  prepare(call: AgentToolCall): PreparedToolCall {
    const args = parseToolArguments(call.function.arguments);
    return { call, args: args ?? call.function.arguments, valid: args !== undefined };
  }
  isParallel(prepared: PreparedToolCall) {
    if (!prepared.valid) return false;
    const entry = this.get(prepared.call.function.name);
    if (!entry || entry.available?.(this.context) === false) return false;
    const mode = entry.mode;
    try { return mode === "parallel" || (typeof mode === "function" && mode(prepared.args, this.context) === true); }
    catch { return false; }
  }
  async projectToolResult(prepared: PreparedToolCall, result: ToolOutcome, signal: AbortSignal) {
    for (const hook of this.context.executionHooks ?? []) {
      if (!hook.postTool) continue;
      signal.throwIfAborted();
      result = await hook.postTool({ ...executionScope(this.context.run), call: structuredClone(prepared.call),
        outcome: structuredClone(result), signal }) ?? result;
    }
    return result;
  }
  async execute({ call, args, valid }: PreparedToolCall, signal: AbortSignal, dispatch?: () => Promise<void>) {
    const { name } = call.function;
    const entry = this.get(name);
    const live = entry?.available && this.context.liveSettings ? await this.context.liveSettings() : undefined;
    const context = live ? { ...this.context, settings: { ...this.context.settings,
      webSearchEnabled: this.context.settings.webSearchEnabled && live.webSearchEnabled,
      textApiKey: new URL(this.context.settings.textBaseUrl).origin === new URL(live.textBaseUrl).origin ? live.textApiKey : "" } } : this.context;
    const unavailable = () => new AppError("当前会话没有此工具：" + name, 400, "UNKNOWN_TOOL");
    if (!entry || entry.available?.(context) === false || this.currentRegistration?.(entry) === false) throw unavailable();
    if (!valid) throw new AppError("工具参数必须是完整的 JSON 对象", 400, "INVALID_ARGS");
    signal.throwIfAborted();
    for (const hook of this.context.executionHooks ?? []) {
      if (!hook.preTool) continue;
      const decision = await hook.preTool({ ...executionScope(context.run), call: structuredClone(call), args: structuredClone(args), signal });
      signal.throwIfAborted();
      if (decision) throw new AppError(decision.reason, 403, decision.kind === "deny" ? "TOOL_DENIED" : "TOOL_CANCELLED");
    }
    const verifyRegistration = () => {
      if (entry.available?.(context) === false || this.currentRegistration?.(entry) === false) throw unavailable();
    };
    verifyRegistration();
    await dispatch?.();
    signal.throwIfAborted();
    verifyRegistration();
    if (entry.timeoutMs === undefined) return entry.execute({ ...context, signal }, call.id, args);
    const deadline = new AbortController();
    const timeout = new AppError("工具执行超过 " + entry.timeoutMs + " 毫秒", 504, "TOOL_TIMEOUT");
    const toolSignal = AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(timeout), entry.timeoutMs);
    try {
      const result = await entry.execute({ ...context, signal: toolSignal }, call.id, args);
      if (toolSignal.reason === timeout) throw timeout;
      return result;
    } catch (error) {
      throw toolSignal.reason === timeout ? timeout : error;
    } finally { clearTimeout(timer); }
  }
}
