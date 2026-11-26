import { z } from "zod";
import { AppError, validateProviderUrl } from "./security";
import { VIDEO_RATIOS, type VideoRatio } from "./media-specs";
import type { MediaProvider, ProviderSettings, VideoReferenceSource, VideoReferences } from "./types";

type VideoModel = ProviderSettings["videoModel"];
const ARK_RESOLUTIONS = ["480p", "720p", "1080p", "4k"] as const;
const MINIMAX_RESOLUTIONS = ["480P", "768P", "2K"] as const;
const RESOLUTIONS = [...ARK_RESOLUTIONS, ...MINIMAX_RESOLUTIONS] as const;
export const OMNI_TASK_TYPES = ["auto", "reference", "edit", "extend"] as const;
export const H3_MAX_PROMPT_EXPANSION = ["disabled", "balanced", "quality"] as const;

export const videoOptions = z.object({
  resolution: z.enum(RESOLUTIONS).optional(),
  generate_audio: z.boolean().optional(),
  watermark: z.boolean().optional(),
  return_last_frame: z.boolean().optional(),
  output_format: z.enum(["mp4", "mov"]).optional(),
  omni_reference_task_type: z.enum(OMNI_TASK_TYPES).optional(),
  draft: z.boolean().optional(),
  priority: z.number().int().min(0).max(9).optional(),
  execution_expires_after: z.number().int().min(3600).max(259200).optional(),
  tools: z.array(z.object({ type: z.literal("web_search") }).strict()).max(1).optional(),
  extra: z.strictObject({ prompt_expansion_mode: z.enum(H3_MAX_PROMPT_EXPANSION).optional() }).optional(),
});
export type VideoOptions = z.infer<typeof videoOptions>;
type ResolvedVideoOptions = VideoOptions & { resolution: typeof RESOLUTIONS[number]; duration?: number; ratio?: VideoRatio };

export function videoProvider(model: VideoModel): MediaProvider {
  if (model.startsWith("zimao-")) return "aiclub";
  return model.startsWith("MiniMax-") ? "minimax" : "volcengine";
}

export function videoCapabilities(model: VideoModel) {
  const seedance = videoProvider(model) !== "minimax";
  const v25 = model === "zimao-2.5" || model === "doubao-seedance-2-5-260628";
  const resolutions: readonly typeof RESOLUTIONS[number][] = seedance
    ? model === "zimao-2.0-fast" ? ["480p", "720p"] : ARK_RESOLUTIONS
    : model === "MiniMax-H3-Max" ? ["480P", "768P"] : ["768P", "2K"];
  return { seedance, v25, resolutions, imageLimit: v25 ? 30 : 9, otherLimit: v25 ? 10 : 3 };
}

export function videoDurationLimits(model: VideoModel) {
  return { min: model === "MiniMax-H3-Max" ? 5 : 4, max: videoCapabilities(model).v25 ? 30 : 15 };
}

export function isVideoReferenceUrl(value: string | null): value is string {
  if (!value || !/^https:\/\/[^/]/i.test(value) || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    validateProviderUrl(url.origin + url.pathname);
    return true;
  } catch {
    return false;
  }
}

export function videoRequestOptions(model: VideoModel, prompt: string, refs: VideoReferences<string | VideoReferenceSource>,
  duration: number | undefined, ratio: VideoRatio | undefined, fallbackRatio: VideoRatio,
  options: VideoOptions = {}, draftTaskId?: string): ResolvedVideoOptions {
  const { seedance, v25, resolutions, imageLimit, otherLimit } = videoCapabilities(model);
  const { min, max } = videoDurationLimits(model);
  const images = refs.images?.length ?? 0, videos = refs.videos?.length ?? 0, audio = refs.audio?.length ?? 0;
  const multimodal = images + videos + audio > 0;
  const frames = Boolean(refs.first || refs.last);
  const mode = options.omni_reference_task_type;
  const editOrExtend = mode === "edit" || mode === "extend";
  const resolution = options.resolution ?? (options.draft ? "480p" : seedance ? "720p" : "768P");

  if (!resolutions.includes(resolution))
    throw new AppError("当前模型可用分辨率：" + resolutions.join("、"), 400, "RESOLUTION_UNSUPPORTED");
  if (options.extra !== undefined && model !== "MiniMax-H3-Max") throw new AppError("extra 仅适用于 MiniMax-H3-Max");
  if (!seedance && (options.watermark !== undefined || options.return_last_frame !== undefined || options.priority !== undefined ||
    options.execution_expires_after !== undefined || options.tools !== undefined))
    throw new AppError("当前 MiniMax 模型不支持这些 Seedance 参数");
  if (!v25 && (options.draft !== undefined || draftTaskId || mode !== undefined || options.output_format !== undefined))
    throw new AppError("样片、MOV 与全模态任务类型仅适用于 Seedance 2.5");
  if (draftTaskId) {
    if (options.draft || prompt.trim() || frames || multimodal || duration !== undefined || ratio !== undefined ||
      mode !== undefined || options.generate_audio !== undefined || options.tools !== undefined)
      throw new AppError("基于样片生成正式视频时，提示词、参考素材、时长、比例和音频由样片继承");
    if (resolution !== "1080p" && resolution !== "4k") throw new AppError("样片转正式视频需指定 1080p 或 4k");
    return { ...options, resolution };
  }
  if (options.draft && (resolution !== "480p" || options.return_last_frame))
    throw new AppError("样片模式使用 480p，且无法返回尾帧");
  if (seedance && refs.last && !refs.first) throw new AppError("指定尾帧时需要同时指定首帧");
  if (frames && multimodal) throw new AppError("首尾帧和多素材参考分别提交");
  if (!seedance && !prompt.trim()) throw new AppError("MiniMax 视频需要提示词");
  if (!frames && !multimodal && !prompt.trim()) throw new AppError("请输入视频提示词或提供参考素材");
  if (images > imageLimit || videos > otherLimit || audio > otherLimit)
    throw new AppError("当前模型单次最多接收 " + imageLimit + " 张参考图、" + otherLimit + " 个参考视频和 " + otherLimit + " 段参考音频");
  if (seedance && !v25 && audio && !images && !videos) throw new AppError("Seedance 2.0 的参考音频需要搭配参考图片或视频");
  if (mode && mode !== "auto" && !multimodal) throw new AppError("全模态任务类型需要参考素材");
  if (editOrExtend && !videos) throw new AppError("编辑或延长需要提供参考视频");

  const effectiveDuration = duration ?? (seedance ? -1 : undefined);
  if (effectiveDuration === undefined || !Number.isInteger(effectiveDuration) ||
    (!(seedance && effectiveDuration === -1) && (effectiveDuration < min || effectiveDuration > max)))
    throw new AppError(model + " 单次生成支持 " + min + "–" + max + " 秒" + (seedance ? "，也可用 -1 自动选择" : ""), 409, "DURATION_UNSUPPORTED");
  if (mode === "edit" && effectiveDuration !== -1) throw new AppError("视频编辑的 duration 必须为 -1");

  let effectiveRatio = ratio ?? (!seedance && multimodal ? "adaptive" : fallbackRatio);
  if (editOrExtend || (v25 || !seedance) && frames) effectiveRatio = "adaptive";
  if (editOrExtend && ratio && ratio !== "adaptive") throw new AppError("视频编辑和延长的 ratio 必须为 adaptive");
  if (!seedance && !frames && !multimodal && effectiveRatio === "adaptive") throw new AppError("MiniMax 文生视频需要具体宽高比");
  if (!VIDEO_RATIOS.includes(effectiveRatio)) throw new AppError("视频宽高比不受支持");

  return {
    ...options, duration: effectiveDuration, ratio: effectiveRatio, resolution,
    ...(seedance ? { generate_audio: options.generate_audio ?? true } : {}),
    ...(v25 ? { output_format: options.output_format ?? "mp4" } : {}),
  };
}
