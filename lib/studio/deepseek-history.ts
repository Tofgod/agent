import { createHash } from "node:crypto";
import type { AgentTool } from "./file-tools";
import { fetchWithoutRedirect } from "./http";
import { messagesEndpoint } from "./deepseek-route";
import { reasoningEfforts, type AgentMessage, type ProviderSettings, type ReasoningEffort } from "./types";

export type MessagesReplayBlock = { type: "text"; length: number } | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; callIndex: number };
export interface MessagesReplay { endpoint: string; model: string; blocks: MessagesReplayBlock[] }
export interface MessagesCapabilities { promptUpdate?: boolean; toolUpdate?: "addition-only" | "in-history" }
interface DeepSeekCatalogCapabilities extends MessagesCapabilities { efforts?: ReasoningEffort[]; listed?: boolean; imageInput?: boolean; unauthorized?: boolean }
export interface MessagesUpdate { after: number; system?: string; additions?: string[]; removals?: string[] }
export interface MessagesSeries {
  key: string; length: number; digest: string; system: string; leadingSystem: string; active: string[];
  tools: (AgentTool & { deferred?: true })[]; updates: MessagesUpdate[];
}
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
const historyDigest = (items: AgentMessage[]) => digest(JSON.stringify(items));
const officialModels = "https://api.deepseek.com/models";
const catalog = new Map<string, { expires: number; value: Promise<DeepSeekCatalogCapabilities> }>();

export async function messagesCapabilities(settings: ProviderSettings): Promise<MessagesCapabilities> {
  const { promptUpdate, toolUpdate } = await deepSeekCatalogCapabilities(settings);
  return { ...(promptUpdate === undefined ? {} : { promptUpdate }), ...(toolUpdate ? { toolUpdate } : {}) };
}

export async function deepSeekCatalogCapabilities(settings: ProviderSettings): Promise<DeepSeekCatalogCapabilities> {
  if (!settings.textApiKey || new URL(settings.textBaseUrl).origin !== new URL(officialModels).origin) return {};
  const key = digest(settings.textApiKey) + ":" + settings.textModel;
  const current = catalog.get(key), time = Date.now();
  if (current && current.expires > time) return current.value;
  const entry = { expires: time + 300_000, value: readCatalog(settings).catch(() => {
    entry.expires = Date.now() + 15_000;
    return {};
  }) };
  for (const [key, cached] of catalog) if (cached.expires <= time) catalog.delete(key);
  catalog.set(key, entry);
  return entry.value;
}

async function readCatalog(settings: ProviderSettings): Promise<DeepSeekCatalogCapabilities> {
  const response = await fetchWithoutRedirect(officialModels, { method: "GET", headers: { Authorization: "Bearer " + settings.textApiKey }, signal: AbortSignal.timeout(4000) });
  if (response.status === 401 || response.status === 403) return { unauthorized: true };
  if (!response.ok) throw new Error("DeepSeek 能力目录不可用");
  const json = await response.json() as { data?: { id?: string; input_modalities?: unknown; effort?: { supported_levels?: unknown }; api_capabilities?: { anthropic_messages?: {
    system_prompt_update?: unknown; tool_update?: unknown;
  } } }[] };
  const model = Array.isArray(json?.data) ? json.data.find((row) => row?.id === settings.textModel) : undefined;
  const native = model?.api_capabilities?.anthropic_messages;
  const levels = model?.effort?.supported_levels;
  return { ...(Array.isArray(levels) ? { efforts: levels.filter((level): level is ReasoningEffort => reasoningEfforts.includes(level)) } : {}),
    promptUpdate: native?.system_prompt_update === "in-history",
    ...(Array.isArray(json?.data) ? { listed: Boolean(model) } : {}),
    ...(Array.isArray(model?.input_modalities) ? { imageInput: model.input_modalities.includes("image") } : {}),
    ...(native?.tool_update === "addition-only" || native?.tool_update === "in-history" ? { toolUpdate: native.tool_update } : {}) };
}

/** Reuse the earlier prefix only while the exact admitted history still survives. */
export function projectMessagesSeries(settings: ProviderSettings, capabilities: MessagesCapabilities, system: string,
  messages: AgentMessage[], tools: AgentTool[], previous?: MessagesSeries): MessagesSeries {
  const key = `${messagesEndpoint(settings.textBaseUrl)}|${settings.textModel}|${Boolean(settings.textThinking)}|${settings.textReasoningEffort ?? ""}|${Boolean(capabilities.promptUpdate)}|${capabilities.toolUpdate ?? "leading"}`;
  const identity = { key, length: messages.length, digest: historyDigest(messages), system, active: tools.map(({ function: tool }) => tool.name) };
  const baseline = () => ({ ...identity, leadingSystem: system, tools, updates: [] });
  if (!previous || previous.key !== key || previous.length > messages.length ||
      historyDigest(messages.slice(0, previous.length)) !== previous.digest) return baseline();
  const declared = new Map(previous.tools.map((tool) => [tool.function.name, tool]));
  const wasActive = new Set(previous.active), active = new Set(identity.active);
  const additions = tools.filter(({ function: tool }) => !wasActive.has(tool.name));
  const removals = previous.active.filter((name) => !active.has(name));
  const systemChange = previous.system !== system;
  const resetSystem = systemChange && (!capabilities.promptUpdate || !system);
  const resetTools = tools.some(({ function: tool }) => declared.has(tool.name) && JSON.stringify(declared.get(tool.name)?.function) !== JSON.stringify(tool)) ||
    (removals.length > 0 && capabilities.toolUpdate !== "in-history") ||
    (additions.length > 0 && (!capabilities.toolUpdate || !previous.tools.length));
  const leadingSystem = resetSystem ? system : previous.leadingSystem;
  const updates = previous.updates.flatMap(({ after, system, additions, removals }): MessagesUpdate[] => {
    const entry = { after, ...(!resetSystem && system ? { system } : {}), ...(!resetTools && additions ? { additions } : {}),
      ...(!resetTools && removals ? { removals } : {}) };
    return entry.system || entry.additions || entry.removals ? [entry] : [];
  });
  const newSystem = systemChange && !resetSystem ? system : undefined;
  const newTools = resetTools ? [] : additions.map(({ function: tool }) => tool.name);
  const removed = resetTools ? [] : removals;
  const current = () => ({ ...identity, leadingSystem, tools: resetTools ? tools : [...declared.values()], updates });
  if (!newSystem && !newTools.length && !removed.length) return current();
  const after = messages.findLastIndex(({ role }) => role === "user" || role === "tool") + 1;
  if (after <= previous.length) return baseline();
  if (!resetTools) for (const tool of additions) if (!declared.has(tool.function.name)) declared.set(tool.function.name, { ...tool, deferred: true });
  updates.push({ after, ...(newSystem ? { system: newSystem } : {}), ...(newTools.length ? { additions: newTools } : {}), ...(removed.length ? { removals: removed } : {}) });
  return current();
}
