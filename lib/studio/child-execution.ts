import { z } from "zod";
import { isMessagesRoute } from "./deepseek-route";
import { assertObjectJsonSchema, JsonSchemaError, type ObjectJsonSchema } from "./harness/json-schema";
import { PROJECT_FOLDERS, projectRelativePath } from "./project-layout";
import { AppError } from "./security";
import { reasoningEfforts, type ReasoningEffort, type AgentDefinition, type ProviderSettings, type Run } from "./types";
import type { SessionPreset } from "./session-presets";
import { resolveDeepSeekModel, type TextModelResolver } from "./providers";

const providers = { "chat-completions": "https://api.deepseek.com/v1", messages: "https://api.deepseek.com/anthropic" } as const;
const official = (baseUrl: string) => new URL(baseUrl).origin === "https://api.deepseek.com";
export const structuredOutputTool = "structured_output";
export interface ChildExecution {
  cwd?: string;
  route: { baseUrl: string; model: ProviderSettings["textModel"]; thinking: boolean; effort?: ReasoningEffort };
  outputSchema?: ObjectJsonSchema;
  preset?: SessionPreset;
}

const childReasoningEfforts = ["off", ...reasoningEfforts] as const;
export const childModel = z.object({ provider: z.enum(["chat-completions", "messages"]), model: z.literal("deepseek-flash"), reasoning_effort: z.enum(childReasoningEfforts).optional() }).strict();
const childSchema = z.unknown().transform((value): ObjectJsonSchema => {
  try { assertObjectJsonSchema(value); return value; }
  catch (error) {
    if (error instanceof JsonSchemaError) throw new AppError(error.violations.slice(0, 4).join("，"), 400, error.code);
    throw error;
  }
});
export const childFields = {
  cwd: z.string().min(1).max(600).optional(),
  provider: childModel.shape.provider.optional(), model: childModel.shape.model.optional(), reasoning_effort: childModel.shape.reasoning_effort, output_schema: childSchema.optional(),
  agent_preset: z.string().uuid().optional(),
};
type ChildOptions = { cwd?: string; provider?: keyof typeof providers; model?: "deepseek-flash"; reasoning_effort?: ReasoningEffort | "off"; output_schema?: ObjectJsonSchema };

export function childParameters(settings: ProviderSettings) {
  return {
    cwd: { type: "string", description: "项目内的工作目录。相对文件路径从此目录解析。" },
    ...(official(settings.textBaseUrl) ? {
      provider: { type: "string", enum: Object.keys(providers), description: "明确要求独立协议时与 model 一起填写。默认继承当前线路。" },
      model: { type: "string", enum: ["deepseek-flash"] },
      reasoning_effort: { type: "string", enum: childReasoningEfforts, description: "仅与 provider、model 一起填写。off 关闭推理。显式指定线路但省略强度时使用线路默认值；三个字段均省略时沿用角色配置或继承兼容的父任务设置。" },
    } : {}),
    output_schema: { type: "object", description: "仅为需要返回机器可读数据的任务指定对象型 JSON Schema。创作文档仍按项目约定保存。" },
  };
}

export function childExecution(options: ChildOptions, settings: ProviderSettings, definition?: AgentDefinition, parentCwd?: string): ChildExecution {
  if (Boolean(options.provider) !== Boolean(options.model) || (options.reasoning_effort && !options.provider))
    throw new AppError("provider 和 model 需要一起提供，reasoning_effort 需要同时指定两者", 400, "INVALID_ARGS");
  const selection = options.provider ? { provider: options.provider, model: options.model! } : definition?.textRoute;
  const inheritedProvider = isMessagesRoute(settings.textBaseUrl) ? "messages" : "chat-completions";
  const routeChanged = selection && (selection.provider !== inheritedProvider || selection.model !== settings.textModel);
  const effort = options.provider ? options.reasoning_effort :
    definition?.textRoute?.reasoning_effort ?? (routeChanged ? undefined : settings.textReasoningEffort);
  if (selection && !official(settings.textBaseUrl)) throw new AppError("当前 DeepSeek 凭据只能用于现有服务的线路", 403, "AGENT_ROUTE_UNAVAILABLE");
  const baseUrl = selection ? providers[selection.provider] : settings.textBaseUrl;
  const cwd = options.cwd ? projectRelativePath(options.cwd, parentCwd) : parentCwd;
  if (cwd && cwd !== "/" && !PROJECT_FOLDERS.some(({ path }) => cwd === path || cwd.startsWith(path + "/")))
    throw new AppError("工作目录应位于当前项目的一级目录下", 400, "INVALID_PATH");
  const thinking = effort !== "off" && (Boolean(effort) || (isMessagesRoute(baseUrl) && settings.textThinking === true));
  return { ...(cwd ? { cwd } : {}), route: { baseUrl, model: selection?.model ?? settings.textModel, thinking, ...(effort && effort !== "off" ? { effort } : {}) },
    ...(options.output_schema ? { outputSchema: options.output_schema } : {}) };
}

export function childModelSettings(run: Run, settings: ProviderSettings) {
  const route = run.parentRunId && run.payload.childExecution?.route;
  if (!route) return settings;
  if (new URL(route.baseUrl).origin !== new URL(settings.textBaseUrl).origin)
    throw new AppError("子任务原线路的凭据不可用", 409, "AGENT_ROUTE_UNAVAILABLE");
  return { ...settings, textBaseUrl: route.baseUrl, textModel: route.model, textThinking: route.thinking, textReasoningEffort: route.effort };
}

export async function preflightChildModel(execution: ChildExecution, settings: ProviderSettings, signal: AbortSignal,
  resolve: TextModelResolver = resolveDeepSeekModel) {
  const { route } = execution;
  const model = await resolve({ ...settings, textBaseUrl: route.baseUrl, textModel: route.model, textThinking: route.thinking, textReasoningEffort: route.effort }, signal);
  signal.throwIfAborted();
  if (model.id !== route.model || !model.thinking.includes(route.thinking) || (route.effort && model.efforts && !model.efforts.includes(route.effort)))
    throw new AppError("所选子智能体线路不支持该模型或推理设置", 409, "AGENT_ROUTE_UNAVAILABLE");
}
