import { z } from "zod";
import { AppError } from "./security";
import type { ProviderSettings } from "./types";

export const MEDIA_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
export type MediaRatio = typeof MEDIA_RATIOS[number];
export const VIDEO_RATIOS = [...MEDIA_RATIOS, "adaptive"] as const;
export type VideoRatio = typeof VIDEO_RATIOS[number];

export const imageOptions = z.object({
  size: z.string().trim().max(20).optional(),
  output_format: z.enum(["png", "jpeg"]).optional(),
  watermark: z.boolean().optional(),
  background: z.enum(["auto", "opaque", "transparent"]).optional(),
  optimize_prompt_options: z.object({ mode: z.enum(["standard", "fast"]) }).strict().optional(),
});
export type ImageOptions = z.infer<typeof imageOptions>;
type ImageModel = ProviderSettings["imageModel"];
const imageTiers = ["1K", "1.5K", "2K"];
export const isSeedream55 = (model: ImageModel) => model.startsWith("doubao-seedream-5-5");

export function imageRequestOptions(model: ImageModel, ratio: MediaRatio, options: ImageOptions, refs: number) {
  const newer = isSeedream55(model);
  if (refs > 10) throw new AppError("图片最多可用 10 张参考图");
  let size = options.size?.toUpperCase();
  if (size && !imageTiers.includes(size)) {
    const dimensions = /^(\d{1,4})X(\d{1,4})$/.exec(size);
    const width = Number(dimensions?.[1]), height = Number(dimensions?.[2]);
    if (!dimensions || width * height < 921_600 || width * height > 4_624_220 || width / height < 1 / 16 || width / height > 16)
      throw new AppError("图片 size 可用 1K、1.5K、2K，或满足总像素 921600–4624220 和宽高比 1:16–16:1 的 宽x高", 400, "IMAGE_SIZE_UNSUPPORTED");
    size = width + "x" + height;
  }
  if (!size) {
    const landscape = {
      "16:9": newer ? "2560x1440" : "2048x1152",
      "9:16": newer ? "1440x2560" : "1152x2048",
      "1:1": "2048x2048", "4:3": "2048x1536", "3:4": "1536x2048", "21:9": "2520x1080",
    };
    size = landscape[ratio];
  }
  if (newer && options.optimize_prompt_options?.mode === "fast")
    throw new AppError("Seedream 5.5 的提示词优化仅支持 standard");
  if (!newer && options.background === "auto")
    throw new AppError("Seedream 5.0 Pro 的背景可选 opaque 或 transparent");
  if (options.background === "transparent" && options.output_format === "jpeg")
    throw new AppError("透明背景需要 PNG");
  if (!newer && options.background === "transparent" && refs !== 1)
    throw new AppError("Seedream 5.0 Pro 生成透明图需提供一张带透明通道的参考图");
  return { ...options, size, watermark: options.watermark ?? false };
}

export const COMPOSITION_RESOLUTIONS = ["480p", "720p", "1080p", "2k", "4k"] as const;
export const COMPOSITION_FPS = [24, 25, 30, 50, 60] as const;
export type CompositionResolution = typeof COMPOSITION_RESOLUTIONS[number];
export type CompositionFps = typeof COMPOSITION_FPS[number];

export function compositionOutput({ ratio, resolution = "720p", fps = 24 }: { ratio: MediaRatio; resolution?: CompositionResolution; fps?: CompositionFps }) {
  const shortest = { "480p": 480, "720p": 720, "1080p": 1080, "2k": 1440, "4k": 2160 }[resolution];
  const [w, h] = ratio.split(":").map(Number);
  const long = Math.round(shortest * (Math.max(w, h) / Math.min(w, h)) / 2) * 2;
  return { ratio, resolution, fps, width: w >= h ? long : shortest, height: w >= h ? shortest : long };
}
