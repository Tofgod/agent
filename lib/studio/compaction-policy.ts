import { readFileSync } from "node:fs";
import { z } from "zod";
import { MODEL_OUTPUT_TOKENS } from "./context-tokens";
import { isMessagesRoute, messagesEndpoint } from "./deepseek-route";
import { AppError, validateProviderUrl } from "./security";

export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const OFFICIAL_FLASH_WINDOW = 1_048_576;
const DEFAULT_THRESHOLD = 0.8, DEFAULT_RETENTION = 0.16, DEFAULT_HEADROOM = 65_536;
const ratio = z.number().positive().max(1), count = z.number().int().nonnegative().safe();
const fields = {
  contextWindow: count.min(16_000).optional(), thresholdRatio: ratio.optional(), headroomTokens: count.optional(),
  retainRatio: ratio.optional(), retainTokens: count.optional(), maxTokens: count.positive().optional(),
  compactionRetries: count.optional(),
};
const modelPolicy = z.strictObject({ baseUrl: z.string().transform(validateProviderUrl), model: z.string().trim().min(1), ...fields });
const configSchema = z.strictObject({ ...fields, modelPolicies: z.array(modelPolicy).default([]) });
export type CompactionConfig = z.input<typeof configSchema>;
export type CompactionRoute = { baseUrl: string; model: string };

export function compactionRouteKey(route: CompactionRoute) {
  const baseUrl = validateProviderUrl(route.baseUrl);
  const endpoint = isMessagesRoute(baseUrl) ? messagesEndpoint(baseUrl) : baseUrl.endsWith("/chat/completions") ? baseUrl : baseUrl + "/chat/completions";
  return endpoint + "|" + route.model;
}

export function loadCompactionConfig(filename: string): CompactionConfig | undefined {
  try { return JSON.parse(readFileSync(filename, "utf8")) as CompactionConfig; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("无法读取 compaction.json", { cause: error });
  }
}

type PolicyFields = Omit<z.output<typeof configSchema>, "modelPolicies">;
const retention = (policy: PolicyFields, fallback: PolicyFields) => policy.retainTokens !== undefined ? { retainTokens: policy.retainTokens }
  : policy.retainRatio !== undefined ? { retainRatio: policy.retainRatio } : fallback;

export class CompactionPolicies {
  private readonly defaults: PolicyFields;
  private readonly routes = new Map<string, PolicyFields>();

  constructor(configuration: CompactionConfig = {}, private readonly legacyWindow?: number) {
    const { modelPolicies, ...defaults } = configSchema.parse(configuration);
    this.defaults = defaults;
    this.validateRetention(defaults, defaults);
    for (const { baseUrl, model, ...override } of modelPolicies) {
      const route = { baseUrl, model }, key = compactionRouteKey(route);
      if (this.routes.has(key)) throw new Error("重复的模型压缩规则 " + key);
      this.validateRetention(override, defaults);
      this.routes.set(key, override);
      this.forRoute(route);
    }
    this.forRoute({ baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash" });
  }

  private validateRetention(policy: PolicyFields, fallback: PolicyFields) {
    if (policy.retainRatio !== undefined && policy.retainTokens !== undefined)
      throw new Error("压缩保留量只能设置 retainRatio 或 retainTokens 其中一项");
    const resolved = retention(policy, fallback);
    if (resolved.retainTokens === undefined && (resolved.retainRatio ?? DEFAULT_RETENTION) >= (policy.thresholdRatio ?? fallback.thresholdRatio ?? DEFAULT_THRESHOLD))
      throw new Error("压缩保留比例必须小于触发比例");
  }

  forRoute(route: CompactionRoute, outputTokens = MODEL_OUTPUT_TOKENS) {
    const key = compactionRouteKey(route), override = this.routes.get(key) ?? {};
    if (!Number.isSafeInteger(outputTokens) || outputTokens < 0)
      throw new AppError("模型输出预留必须是非负整数", 400, "COMPACTION_POLICY_INVALID");
    const official = new URL(route.baseUrl).origin === "https://api.deepseek.com" && route.model === "deepseek-flash";
    const configuredWindow = override.contextWindow ?? this.defaults.contextWindow;
    const contextWindow = configuredWindow ?? this.legacyWindow ?? (official ? OFFICIAL_FLASH_WINDOW : DEFAULT_CONTEXT_WINDOW);
    const messageBudget = contextWindow - outputTokens;
    const retain = retention(override, this.defaults);
    const retainTokens = retain.retainTokens ?? Math.floor(messageBudget * (retain.retainRatio ?? DEFAULT_RETENTION));
    const thresholdRatio = override.thresholdRatio ?? this.defaults.thresholdRatio ?? DEFAULT_THRESHOLD;
    // Small legacy STUDIO_CONTEXT_WINDOW values used the entire input budget before headroom was configurable.
    const defaultHeadroom = configuredWindow === undefined && this.legacyWindow !== undefined && messageBudget - DEFAULT_HEADROOM <= retainTokens
      ? 0 : DEFAULT_HEADROOM;
    const headroomTokens = override.headroomTokens ?? this.defaults.headroomTokens ?? defaultHeadroom;
    const thresholdTokens = Math.floor(Math.min(contextWindow * thresholdRatio, messageBudget - headroomTokens));
    if (retainTokens < 0 || retainTokens >= thresholdTokens)
      throw new AppError("线路的上下文窗口、输出预留、压缩余量和保留量无法同时满足：" + key, 400, "COMPACTION_POLICY_INVALID");
    return { key, contextWindow, outputTokens, thresholdTokens, headroomTokens, retainTokens,
      maxTokens: override.maxTokens ?? this.defaults.maxTokens ?? MODEL_OUTPUT_TOKENS,
      compactionRetries: override.compactionRetries ?? this.defaults.compactionRetries ?? 1 };
  }
}
