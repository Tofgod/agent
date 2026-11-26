import { z } from "zod";
import { readSelection, resolveReadFile, tool } from "./file-tools";
import { inspectImage } from "./images";
import { projectOutputPath, projectRelativePath } from "./project-layout";
import { imageProvider, mediaBaseUrl, requireMedia } from "./providers";
import { OMNI_TASK_TYPES, isVideoReferenceUrl, videoCapabilities, videoDurationLimits, videoOptions, videoProvider, videoRequestOptions } from "./video-input";
import { COMPOSITION_FPS, COMPOSITION_RESOLUTIONS, MEDIA_RATIOS, VIDEO_RATIOS, imageOptions, imageRequestOptions, isSeedream55 } from "./media-specs";
import type { ProviderSettings, VideoReferenceSource, VideoReferences } from "./types";
import { AppError } from "./security";
import type { ToolRegistration } from "./tool-registry";

const string = { type: "string" };
const file = { file_path: string };
const ratio = { type: "string", enum: MEDIA_RATIOS };
const paths = { type: "array", items: string };
const versions = { type: "array", description: "需要指定历史参考时提供引用中的路径、文件 ID 和版本。未指定的参考使用任务入队时的当前版本。", items: {
  type: "object", properties: { path: string, file_id: string, version: { type: "integer" } }, required: ["path", "file_id", "version"],
} };
const commonInput = z.object({
  file_path: z.string().min(1), prompt: z.string().trim().max(16000).default(""),
  reference_paths: z.array(z.string().min(1)).max(30).optional(),
  reference_versions: z.array(z.object({ path: z.string().min(1), file_id: z.string().uuid(), version: z.number().int().positive() })).max(50).optional(),
});
const imageInput = commonInput.extend({ ratio: z.enum(MEDIA_RATIOS).optional(), ...imageOptions.shape }).strict();
const videoReferenceSource = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("project_file"), path: z.string().min(1) }),
  z.strictObject({ type: z.literal("url"), url: z.string().min(1) }),
]);
const videoInput = commonInput.extend({
  ratio: z.enum(VIDEO_RATIOS).optional(), image_path: z.string().min(1).optional(),
  last_image_path: z.string().min(1).optional(), reference_video_paths: z.array(z.string().min(1)).max(10).optional(),
  reference_videos: z.array(videoReferenceSource).max(10).optional(),
  reference_audio_paths: z.array(z.string().min(1)).max(10).optional(),
  duration: z.number().int().optional(), dialogue: z.string().max(4000).optional(), draft_video_path: z.string().min(1).optional(),
  ...videoOptions.shape,
}).strict();
const bool = { type: "boolean" };

function videoSchema(settings: ProviderSettings) {
  const { seedance, v25, resolutions, imageLimit, otherLimit } = videoCapabilities(settings.videoModel);
  const { min, max } = videoDurationLimits(settings.videoModel);
  const duration = `整数秒 ${min}–${max}` + (seedance ? "，-1 或省略为自动。" : "。") + (v25 ? "编辑必须为 -1，使用样片续做时省略。" : "");
  const ratioHint = (v25 ? "首帧/首尾帧、视频编辑和延长自动沿用输入画幅。" : !seedance
    ? "图生视频沿用参考帧画幅，文生视频使用具体宽高比。" : "adaptive 根据输入自动确定画幅。") + "其他模式未指定时沿用项目比例。";
  return tool("generate_video", "提交后台视频生成。可用提示词直出、参考帧或多素材参考。参考视频需要供应商能访问的公网链接。返回任务编号；本轮需要成品时用 job_output（wait=true）。", {
    ...file, image_path: { ...string, description: "项目首帧图片路径" }, last_image_path: { ...string, description: seedance ? "项目尾帧图片路径，须搭配首帧" : "项目尾帧图片路径" },
    prompt: string, duration: { type: "integer", description: duration }, dialogue: string,
    ratio: { ...ratio, enum: VIDEO_RATIOS, description: ratioHint },
    resolution: { ...string, enum: resolutions, description: "视频输出分辨率" }, generate_audio: bool, reference_versions: versions,
    reference_paths: { ...paths, maxItems: imageLimit, description: "多素材参考中的项目图片路径。" },
    reference_videos: { type: "array", maxItems: otherLimit,
      description: "按提示词中视频1、视频2的顺序列出参考视频。用户提供的公网 HTTPS 视频链接填 url，项目内的视频填 project_file。混用时写在同一个数组中。",
      items: { oneOf: [
        { type: "object", properties: { type: { ...string, enum: ["project_file"] }, path: { ...string, description: "当前项目内的视频文件路径" } },
          required: ["type", "path"], additionalProperties: false },
        { type: "object", properties: { type: { ...string, enum: ["url"] }, url: { ...string, description: "供应商可直接下载的视频 HTTPS 原链接，保留签名参数" } },
          required: ["type", "url"], additionalProperties: false },
      ] } },
    reference_video_paths: { ...paths, maxItems: otherLimit, description: "兼容旧调用的项目视频路径。两种字段同时填写时，本字段的素材接在 reference_videos 后。" },
    reference_audio_paths: { ...paths, maxItems: otherLimit },
    ...(seedance ? { watermark: bool, return_last_frame: { ...bool, description: "把供应商返回的尾帧存到项目图片目录" },
      priority: { type: "integer", minimum: 0, maximum: 9 }, execution_expires_after: { type: "integer", minimum: 3600, maximum: 259200, description: "供应商任务超时秒数" },
      tools: { type: "array", maxItems: 1, items: { type: "object", properties: { type: { ...string, enum: ["web_search"] } }, required: ["type"], additionalProperties: false } },
    } : {}),
    ...(v25 ? { output_format: { ...string, enum: ["mp4", "mov"], description: "与输出文件后缀一致" },
      omni_reference_task_type: { ...string, enum: OMNI_TASK_TYPES, description: "auto 自动，reference 参考生成，edit 编辑，extend 延长" },
      draft: { ...bool, description: "生成 480p 样片" }, draft_video_path: { ...string, description: "用本项目同线路的 480p 样片生成 1080p 或 4k 正式视频，继承样片的提示词、素材、时长、画幅和音频" },
    } : {}),
  }, seedance ? ["file_path"] : ["file_path", "duration", "prompt"]);
}
function generationTool(image: boolean): ToolRegistration {
  const name = image ? "generate_image" : "generate_video";
  return {
    name,
    schema: image
      ? ({ settings }) => tool(name, "提交后台图片生成，保存到项目目录。返回任务编号；本轮需要成品图时用 job_output（wait=true）。", {
        ...file, prompt: string, reference_paths: { ...paths, maxItems: 10 }, ratio: { ...ratio, description: "按画幅使用默认像素尺寸，和 size 二选一" }, reference_versions: versions,
        size: { ...string, description: "1K、1.5K、2K 或 宽x高，例如 2048x2048。用档位时可在提示词描述画幅" },
        output_format: { ...string, enum: ["png", "jpeg"], description: "与输出文件后缀一致" }, watermark: bool,
        background: { ...string, enum: isSeedream55(settings.imageModel) ? ["auto", "opaque", "transparent"] : ["opaque", "transparent"] },
        optimize_prompt_options: { type: "object", properties: { mode: { ...string, enum: isSeedream55(settings.imageModel) ? ["standard"] : ["standard", "fast"] } }, required: ["mode"], additionalProperties: false },
      }, ["file_path", "prompt"])
      : ({ settings }) => videoSchema(settings),
    label: image ? "生成图片" : "生成视频",
    async execute({ store, run, project, settings, ensureCurrent }, id, args) {
      const committed = await store.toolResult(run.id, id);
      if (committed) return { result: committed };
      const resolvePath = (path: string) => projectRelativePath(path, run.payload.childExecution?.cwd ?? run.payload.workingDirectory);
      const parsedImage = image ? imageInput.parse(args) : undefined;
      const parsedVideo = image ? undefined : videoInput.parse(args);
      const input = (parsedImage ?? parsedVideo)!;
      const path = projectOutputPath(resolvePath(input.file_path), image ? "/03_图片" : "/04_视频");
      const provider = image ? imageProvider(settings.imageModel) : videoProvider(settings.videoModel);
      requireMedia(settings, provider);
      const referencePaths = input.reference_paths?.map(resolvePath);
      let videoReferences: VideoReferences<VideoReferenceSource> | undefined;
      let imageSpec: ReturnType<typeof imageRequestOptions> | undefined;
      let videoSpec: ReturnType<typeof videoRequestOptions> | undefined;
      let draftTaskId: string | undefined;
      const draftPath = parsedVideo?.draft_video_path ? resolvePath(parsedVideo.draft_video_path) : undefined;
      const dialogue = parsedVideo?.dialogue;
      if (parsedImage) {
        const parsed = parsedImage;
        if (!input.prompt) throw new AppError("请输入图片提示词");
        if (parsed.size && parsed.ratio) throw new AppError("图片 size 和 ratio 请选一个");
        const jpeg = /\.jpe?g$/i.test(path);
        if ((!jpeg && !/\.png$/i.test(path)) || (parsed.output_format && (parsed.output_format === "jpeg") !== jpeg))
          throw new AppError("图片文件后缀需对应 PNG 或 JPEG 输出格式");
        imageSpec = imageRequestOptions(settings.imageModel, parsed.ratio ?? project.ratio,
          { ...imageOptions.parse(args), output_format: parsed.output_format ?? (jpeg ? "jpeg" : undefined) }, referencePaths?.length ?? 0);
      } else {
        const parsed = parsedVideo!;
        const mov = /\.mov$/i.test(path);
        if ((!mov && !/\.mp4$/i.test(path)) || (parsed.output_format && (parsed.output_format === "mov") !== mov))
          throw new AppError("视频文件后缀需对应 MP4 或 MOV 输出格式");
        const videos: VideoReferenceSource[] = [
          ...(parsed.reference_videos ?? []).map((reference, index) => {
            if (reference.type === "project_file") return { ...reference, path: resolvePath(reference.path) };
            if (!isVideoReferenceUrl(reference.url)) throw new AppError("第 " + (index + 1) + " 个参考视频需要公网 HTTPS 地址", 400, "INVALID_REFERENCE_VIDEO_URL");
            return reference;
          }),
          ...(parsed.reference_video_paths ?? []).map((path) => ({ type: "project_file" as const, path: resolvePath(path) })),
        ];
        videoReferences = { first: parsed.image_path ? resolvePath(parsed.image_path) : undefined,
          last: parsed.last_image_path ? resolvePath(parsed.last_image_path) : undefined,
          images: referencePaths, videos, audio: parsed.reference_audio_paths?.map(resolvePath) };
        videoSpec = videoRequestOptions(settings.videoModel, input.prompt || dialogue || "", videoReferences,
          parsed.duration, parsed.ratio, project.ratio, { ...videoOptions.parse(args), output_format: parsed.output_format ?? (mov ? "mov" : undefined) }, draftPath);
      }
      const references = [
        ...(image ? referencePaths ?? [] : [videoReferences?.first, videoReferences?.last, ...videoReferences?.images ?? []]).filter((path): path is string => Boolean(path)).map((path) => ({ path, kind: "image" })),
        ...(videoReferences?.videos ?? []).flatMap((ref) => ref.type === "project_file" ? [{ path: ref.path, kind: "video" }] : []),
        ...(videoReferences?.audio ?? []).map((path) => ({ path, kind: "audio" })),
        ...(draftPath ? [{ path: draftPath, kind: "video" }] : []),
      ];
      const files = references.length ? await store.artifacts(project.id) : [];
      const selected = new Map((input.reference_versions ?? []).map((ref) => [resolvePath(ref.path), ref]));
      if (selected.size !== (input.reference_versions?.length ?? 0) || [...selected.keys()].some((path) => !references.some((ref) => ref.path === path)))
        throw new AppError("历史版本必须对应本次任务选用的参考路径");
      const referenceVersions = await Promise.all(references.map(async ({ path, kind }) => {
        const exact = selected.get(path);
        const file = exact ? await store.artifactVersion(project.id, exact.file_id, exact.version) : files.find((file) => file.path === path);
        if (!file || file.path !== path || file.status !== "ready" || !(file.kind === kind || kind === "video" && file.kind === "final"))
          throw new AppError("缺少可用参考素材：" + path, 409, "REFERENCE_UNAVAILABLE");
        if (path === draftPath) {
          if (file.metadata.draft !== true || file.metadata.model !== settings.videoModel || file.metadata.provider !== provider ||
            file.metadata.providerBaseUrl !== mediaBaseUrl(settings, provider) || typeof file.metadata.providerTaskId !== "string")
            throw new AppError("请指定本项目同模型、同线路已生成的样片");
          draftTaskId = file.metadata.providerTaskId;
        }
        return { id: file.id, path, kind: file.kind, version: file.version };
      }));
      await ensureCurrent();
      const { ratio, duration, ...persistedVideoOptions } = videoSpec ?? { ratio: undefined, duration: undefined };
      return { result: await store.startChild(run, id, "media", input.prompt || dialogue || (image ? "生成图片" : "生成视频"), { stage: "media", background: true,
        payload: { instruction: input.prompt, sourceVersions: Object.fromEntries(referenceVersions.map(({ id, version }) => [id, version])), operation: { toolCallId: id, name, path, prompt: input.prompt, referenceVersions,
          mediaBaseUrl: mediaBaseUrl(settings, provider),
          ...(image ? { references: referencePaths, imageModel: settings.imageModel, imageOptions: imageSpec } :
            { videoReferences, videoModel: settings.videoModel, videoOptions: persistedVideoOptions, ratio, duration, dialogue, draftTaskId }) } } }) };
    },
  };
}

export const mediaTools: ToolRegistration[] = [
  {
    schema: tool("read_video", "读取项目已有视频或 MP4 成片的画面。后台解析时长、尺寸、帧率和音轨是否存在，默认抽取 6 张实际画面。用 job_output（wait=true）等待并读取 JPEG 帧，可用于检查构图、人物和画面衔接。", {
      file_path: { ...string, description: "当前项目中可用的视频或成片路径" },
      timestamps: { type: "array", minItems: 1, maxItems: 12, items: { type: "number", minimum: 0 },
        description: "指定取帧位置，单位为从片头起算的秒数，可用小数，每个位置须小于视频时长。省略时在全片均匀取 6 帧。" },
    }, ["file_path"]),
    label: "读取视频",
    async execute({ store, run, project }, id, args) {
      const committed = await store.toolResult(run.id, id);
      if (committed) return { result: committed };
      const input = z.object({ file_path: z.string().min(1), timestamps: z.array(z.number().nonnegative()).min(1).max(12).optional() }).parse(args);
      const path = projectRelativePath(input.file_path, run.payload.childExecution?.cwd ?? run.payload.workingDirectory);
      const source = (await store.artifacts(project.id)).find((item) => item.path === path);
      if (!source || !["video", "final"].includes(source.kind) || source.status !== "ready" || typeof source.metadata.objectKey !== "string")
        throw new AppError("视频尚不可读", 409, "VIDEO_UNAVAILABLE");
      return { result: await store.startChild(run, id, "media", "读取视频画面：" + source.path, { stage: "inspecting", background: true,
        payload: { instruction: "读取视频画面", sourceVersions: { [source.id]: source.version }, inspection: { sourceId: source.id, sourceVersion: source.version, timestamps: input.timestamps } } }) };
    },
  },
  {
    schema: tool("read_image", "按路径或文件 ID 读取项目图片的实际像素。可指定引用中的 version 查看历史版本。", { ...file, file_id: string, version: { type: "integer" } }),
    label: "查看图片",
    async execute({ store, run, project, bucket }, _id, args) {
      const source = await resolveReadFile(store, project.id, readSelection.parse(args), undefined, run.payload.childExecution?.cwd ?? run.payload.workingDirectory);
      const image = await inspectImage(source, bucket);
      return { images: [image], result: { id: image.id, path: image.path, version: image.version, width: image.width, height: image.height,
        sourceWidth: image.sourceWidth, sourceHeight: image.sourceHeight, bytes: image.bytes, mediaType: image.mediaType } };
    },
  },
  generationTool(true),
  generationTool(false),
  {
    schema: tool("compose_video", "用项目已有视频或成片在本地裁短、拼接和合成。单个 clips 项可从原片开头截取前 duration 秒，例如 duration=15 输出前 15 秒。多个片段各自从片头按指定时长截取，再按 clips 顺序拼接。可替换音轨、烧录字幕，调整输出画幅、分辨率和帧率。返回后台任务编号，用 job_output（wait=true）获取 MP4。", {
      file_path: { ...string, description: "保存到 /07_成片 的 .mp4 路径。使用新路径可保留原文件。" },
      ratio: { ...ratio, description: "输出画幅，默认沿用项目设置。视频等比缩放并补边以适配画幅。" },
      resolution: { ...string, enum: COMPOSITION_RESOLUTIONS, description: "输出画布分辨率，默认 720p" },
      fps: { type: "integer", enum: COMPOSITION_FPS, description: "输出帧率，默认 24" },
      clips: { type: "array", minItems: 1, maxItems: 96, description: "按输出顺序排列。只裁短一条视频时传一个片段即可。",
        items: { type: "object", properties: {
          video_path: { ...string, description: "当前项目中可用的视频或成片路径" },
          duration: { type: "number", exclusiveMinimum: 0, maximum: 600,
            description: "从该素材的 0 秒开始保留的时长，单位秒，可用小数。源片必须足够长。" },
          audio_path: { ...string, description: "可选的项目音频路径，用于替换该片段原声。省略时沿用原声，原片无音轨且无台词时补静音。" },
          dialogue: { ...string, description: "可选，烧录为该片段全段显示的字幕。有字幕台词时需要原声或替换音轨。" },
        }, required: ["video_path", "duration"] } },
    }, ["file_path", "clips"]),
    label: "合成成片",
    async execute({ store, run, project, ensureCurrent }, id, args) {
      const committed = await store.toolResult(run.id, id);
      if (committed) return { result: committed };
      const input = z.object({ file_path: z.string().min(1), ratio: z.enum(MEDIA_RATIOS).optional(), resolution: z.enum(COMPOSITION_RESOLUTIONS).optional(),
        fps: z.number().refine((value): value is typeof COMPOSITION_FPS[number] => COMPOSITION_FPS.some((fps) => fps === value), "帧率需为 24、25、30、50 或 60").optional(),
        clips: z.array(z.object({ video_path: z.string(), audio_path: z.string().optional(), duration: z.number().positive().max(600), dialogue: z.string().max(4000).default("") })).min(1).max(96) }).strict().parse(args);
      const resolvePath = (path: string) => projectRelativePath(path, run.payload.childExecution?.cwd ?? run.payload.workingDirectory);
      const path = projectOutputPath(resolvePath(input.file_path), "/07_成片");
      if (!/\.mp4$/i.test(path)) throw new AppError("成片文件使用 .mp4");
      const files = await store.artifacts(project.id), sources: Record<string, number> = {};
      const shots = input.clips.map((clip, index) => {
        const videoPath = resolvePath(clip.video_path), audioPath = clip.audio_path ? resolvePath(clip.audio_path) : undefined;
        const video = files.find((item) => item.path === videoPath && ["video", "final"].includes(item.kind) && item.url && item.status === "ready");
        const audio = audioPath ? files.find((item) => item.path === audioPath && item.kind === "audio" && item.url && item.status === "ready") : undefined;
        if (!video || clip.audio_path && !audio) throw new AppError("请先确认可用镜头与音频：" + clip.video_path);
        sources[video.id] = video.version;
        if (audio) sources[audio.id] = audio.version;
        return { id: "clip-" + (index + 1), videoId: video.id, audioId: audio?.id, duration: clip.duration, dialogue: clip.dialogue };
      });
      await ensureCurrent();
      return { result: await store.startChild(run, id, "media", "合成成片", { stage: "composing", background: true,
        payload: { instruction: "合成成片", sourceVersions: sources, operation: { toolCallId: id, name: "compose_video", path },
          composition: { shots, ratio: input.ratio || project.ratio, resolution: input.resolution, fps: input.fps } } }) };
    },
  },
];
