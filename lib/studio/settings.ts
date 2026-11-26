import { z } from "zod";
import { DEFAULT_SETTINGS, IMAGE_MODELS, VIDEO_MODELS, type ProviderSettings } from "./types";
import { validateProviderUrl } from "./security";

export const settingsInput = z.object({
  textBaseUrl: z.string().max(300).transform(validateProviderUrl), textModel: z.literal("deepseek-flash"), textApiKey: z.string().max(1000).optional(),
  textThinking: z.boolean().optional(),
  arkBaseUrl: z.string().max(300).transform(validateProviderUrl), arkApiKey: z.string().max(1000).optional(),
  minimaxBaseUrl: z.string().max(300).transform(validateProviderUrl), minimaxApiKey: z.string().max(1000).optional(),
  aiclubApiKey: z.string().max(1000).optional(),
  imageModel: z.enum(IMAGE_MODELS), videoModel: z.enum(VIDEO_MODELS),
  busyEnter: z.enum(["steer", "queue"]).optional(),
  webSearchEnabled: z.boolean().default(true),
});
export function mergeSettings(old: ProviderSettings, input: Partial<ProviderSettings>): ProviderSettings {
  const merged = { ...old, ...input };
  for (const key of ["textApiKey", "arkApiKey", "minimaxApiKey", "aiclubApiKey"] as const)
    merged[key] = input[key]?.trim() || old[key];
  return merged;
}
export function savedSettings(config: Record<string, unknown>, secrets: Record<string, string>): ProviderSettings {
  // Read only declared fields. Secret fields are never read from plain configuration.
  const result = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof ProviderSettings)[]) {
    if (key.endsWith("ApiKey")) continue;
    if (config[key] !== undefined) Object.assign(result, { [key]: config[key] });
  }
  if (result.busyEnter !== "queue" && result.busyEnter !== "steer") result.busyEnter = DEFAULT_SETTINGS.busyEnter;
  result.textModel = "deepseek-flash";
  result.textThinking = result.textThinking === true;
  if (!IMAGE_MODELS.includes(result.imageModel)) result.imageModel = DEFAULT_SETTINGS.imageModel;
  if (!VIDEO_MODELS.includes(result.videoModel)) result.videoModel = DEFAULT_SETTINGS.videoModel;
  for (const key of ["textApiKey", "arkApiKey", "minimaxApiKey", "aiclubApiKey"] as const) result[key] = secrets[key] || "";
  return result;
}
