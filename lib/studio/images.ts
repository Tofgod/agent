import { createHash } from "node:crypto";
import type { BlobStore } from "./storage";
import { imageSize } from "image-size";
import sharp, { type Sharp } from "sharp";
import type { AgentImage, AgentMessage, Artifact } from "./types";
import { AppError } from "./security";

const MEDIA_TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const;
const MAX_SOURCE_EDGE = 8192;
const MAX_VISION_EDGE = 2048;
const MAX_VISION_IMAGE_BYTES = 4 * 1024 * 1024;
// Leave room for text and JSON beneath the provider's 48 MiB HTTP body limit.
const MAX_INLINE_BYTES = 30 * 1024 * 1024;

const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
type PreparedImage = Omit<AgentImage, "id" | "version" | "path"> & { sourceWidth: number; sourceHeight: number };
const preparing = new WeakMap<BlobStore, Map<string, Promise<PreparedImage>>>();

export async function inspectImage(file: Artifact, bucket?: BlobStore): Promise<AgentImage & { sourceWidth: number; sourceHeight: number }> {
  const key = file.metadata.objectKey;
  if (!bucket || file.kind !== "image" || file.status !== "ready" || typeof key !== "string" || !key.startsWith(file.projectId + "/"))
    throw new AppError("图片尚不可读，请先生成或上传图片", 409, "IMAGE_UNAVAILABLE");
  let pending = preparing.get(bucket);
  if (!pending) { pending = new Map(); preparing.set(bucket, pending); }
  let image = pending.get(key);
  if (!image) {
    const jobs = pending;
    image = prepareImage(file.projectId, key, bucket).finally(() => jobs.delete(key));
    pending.set(key, image);
  }
  return { id: file.id, version: file.version, path: file.path, ...await image };
}

async function prepareImage(projectId: string, key: string, bucket: BlobStore): Promise<PreparedImage> {
  const object = await bucket.get(key);
  if (!object) throw new AppError("图片文件不存在，请重新上传", 404, "IMAGE_UNAVAILABLE");
  if (object.size > MAX_INLINE_BYTES) throw new AppError("图片超过当前视觉请求的 30 MiB 限制，请先缩小图片", 400, "IMAGE_TOO_LARGE");
  const bytes = new Uint8Array(await object.arrayBuffer());
  return prepareImageBytes(projectId, key, bytes, bucket);
}

export async function prepareImageBytes(projectId: string, key: string, bytes: Uint8Array, bucket: BlobStore,
  variantRoot = projectId + "/vision/sharp-0.35.5-v1"): Promise<PreparedImage> {
  let size;
  try { size = imageSize(bytes); } catch { throw new AppError("图片内容无法识别，请使用完整的 PNG、JPEG、GIF 或 WebP 图片", 400, "IMAGE_INVALID"); }
  const mediaType = MEDIA_TYPES[size.type as keyof typeof MEDIA_TYPES];
  if (!mediaType || !size.width || !size.height) throw new AppError("图片格式不受支持", 400, "IMAGE_INVALID");
  if (Math.max(size.width, size.height) > MAX_SOURCE_EDGE) throw new AppError("图片边长超过模型 8192px 限制，请先缩小图片", 400, "IMAGE_TOO_LARGE");
  const source = sharp(bytes, { failOn: "warning", limitInputPixels: MAX_SOURCE_EDGE ** 2 });
  const decoded = await checkedDecode(() => source.metadata());
  const { width: sourceWidth, height: sourceHeight } = decoded.autoOrient;
  const dimensions = { sourceWidth, sourceHeight };
  const sourceDigest = digest(bytes);
  const convert = size.type === "gif" || (decoded.pages ?? 1) > 1 || decoded.depth !== "uchar" || decoded.space !== "srgb" ||
    decoded.exif || decoded.hasProfile || decoded.iptc || decoded.xmp || decoded.comments ||
    bytes.byteLength > MAX_VISION_IMAGE_BYTES || Math.max(sourceWidth, sourceHeight) > MAX_VISION_EDGE;
  if (!convert) {
    await checkedDecode(() => source.raw().toBuffer());
    return { ...dimensions, objectKey: key, mediaType, bytes: bytes.byteLength, width: sourceWidth, height: sourceHeight, sha256: sourceDigest };
  }
  const outputType = decoded.hasAlpha ? "image/webp" : "image/jpeg";
  const variant = variantRoot + "/" + sourceDigest;
  const cached = await bucket.get(variant);
  if (cached && cached.size > MAX_VISION_IMAGE_BYTES) throw new AppError("用于识别的图片校验失败", 409, "IMAGE_UNAVAILABLE");
  const encoded = cached ? new Uint8Array(await cached.arrayBuffer()) : await encodeVisionImage(source, decoded.hasAlpha);
  const shape = visionShape(encoded, outputType);
  const sha256 = digest(encoded);
  if (!shape || cached?.etag && cached.etag !== '"' + sha256 + '"') throw new AppError("用于识别的图片校验失败", 409, "IMAGE_UNAVAILABLE");
  if (!cached) await bucket.put(variant, encoded, { httpMetadata: { contentType: outputType } });
  return { ...dimensions, objectKey: variant, mediaType: outputType, bytes: encoded.byteLength, sha256, ...shape };
}

async function checkedDecode<T>(decode: () => Promise<T>) {
  try { return await decode(); }
  catch { throw new AppError("图片像素无法完整解码，请重新上传原图", 400, "IMAGE_INVALID"); }
}

async function encodeVisionImage(source: Sharp, alpha: boolean) {
  for (const edge of [MAX_VISION_EDGE, 960]) {
    const prepared = source.clone().autoOrient().toColourspace("srgb").resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
    for (const quality of [85, 75, 60]) {
      const pipeline = prepared.clone();
      const bytes = await checkedDecode(() => (alpha ? pipeline.webp({ quality, effort: 0 }) : pipeline.jpeg({ quality })).toBuffer());
      if (bytes.byteLength <= MAX_VISION_IMAGE_BYTES) return bytes;
    }
  }
  throw new AppError("用于识别的图片超过大小预算", 400, "IMAGE_TOO_LARGE");
}

function visionShape(data: Uint8Array, expectedType: string) {
  if (data.byteLength > MAX_VISION_IMAGE_BYTES) return;
  try {
    const { type, width, height } = imageSize(data);
    if (MEDIA_TYPES[type as keyof typeof MEDIA_TYPES] === expectedType && width > 0 && height > 0 && Math.max(width, height) <= MAX_VISION_EDGE) return { width, height };
  } catch {}
}

function withoutImages(message: AgentMessage, kept: AgentImage[], omitted: AgentImage[]): AgentMessage {
  const names = omitted.map((image) => image.path + " v" + image.version).join("、");
  const recovery = message.outputRef ? "read_tool_result（使用 result_ref 和 image_index）" : "read_image（指定原版本）";
  const note = "较早图片已移出本次视觉上下文，需再次查看请调用 " + recovery + "：" + names;
  let content = (message.content || "") + "\n[" + note + "]";
  if (message.role === "tool" && message.content) {
    try {
      const result = JSON.parse(message.content);
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const previous = typeof result.image_context_excerpt === "string" ? result.image_context_excerpt + "\n" : "";
        content = JSON.stringify({ ...result, image_context_excerpt: previous + note });
      }
    } catch {}
  }
  const orderedToolContent = message.orderedToolContent?.flatMap((part): NonNullable<AgentMessage["orderedToolContent"]> => {
    if (part.type === "text") return [part];
    const image = message.images?.[part.index], index = image ? kept.indexOf(image) : -1;
    return index < 0 ? [] : [{ type: "image", index }];
  });
  orderedToolContent?.push({ type: "text", text: "[" + note + "]" });
  return { ...message, images: kept.length ? kept : undefined, content, orderedToolContent };
}

/** Keep recent image occurrences within the wire budget; the explicit placeholders are persisted with history. */
export function boundImages(messages: AgentMessage[]): AgentMessage[] {
  let bytes = 0, count = 0;
  return messages.slice().reverse().map((message) => {
    if (!message.images?.length) return message;
    const kept: AgentImage[] = [], omitted: AgentImage[] = [];
    for (const image of message.images.slice().reverse()) {
      if (bytes + image.bytes > MAX_INLINE_BYTES || count >= 12) { omitted.unshift(image); continue; }
      bytes += image.bytes; count++; kept.unshift(image);
    }
    if (!omitted.length) return message;
    return withoutImages(message, kept, omitted);
  }).reverse();
}

/** Remove only occurrences sent in the rejected request, inside its original source span. */
export function offloadRequestImages(history: AgentMessage[], request: AgentMessage[], count: number, sourceCount?: number) {
  const indexes = history.slice(0, sourceCount ?? history.length).flatMap((message, index) =>
    sourceCount === undefined || message.source?.kind !== "runtime-context" ? [index] : []);
  const projected = [...history];
  let removed = 0;
  const messages = request.map((message, position) => {
    if (removed >= count || !message.images?.length) return message;
    const index = message.tool_call_id ? indexes.find((i) => history[i].tool_call_id === message.tool_call_id) : indexes[position];
    const original = index === undefined ? undefined : projected[index];
    if (!original?.images?.length || original.role !== message.role) return message;
    const omitted: AgentImage[] = [], kept: AgentImage[] = [], originals = [...original.images];
    for (const image of message.images) {
      const match = originals.findLastIndex((candidate) => candidate.id === image.id && candidate.version === image.version && candidate.objectKey === image.objectKey);
      if (removed >= count || match < 0) { kept.push(image); continue; }
      omitted.push(image); originals.splice(match, 1); removed++;
    }
    if (!omitted.length) return message;
    projected[index!] = withoutImages(original, originals, omitted);
    return withoutImages(message, kept, omitted);
  });
  return removed ? { history: projected, messages, removed } : undefined;
}

/** Resolve immutable project objects only; never fetch an arbitrary URL from model arguments. */
export async function imageDataUrl(image: AgentImage, bucket: BlobStore, projectId: string): Promise<string> {
  if (!image.objectKey.startsWith(projectId + "/")) throw new AppError("图片不属于当前项目", 403, "IMAGE_UNAVAILABLE");
  const object = await bucket.get(image.objectKey);
  if (!object || object.size !== image.bytes || object.size > MAX_INLINE_BYTES) throw new AppError("已读取的图片已不可用，请重新读取", 409, "IMAGE_UNAVAILABLE");
  const bytes = Buffer.from(await object.arrayBuffer());
  if (bytes.byteLength !== image.bytes || (image.sha256 && digest(bytes) !== image.sha256))
    throw new AppError("已读取的图片已不可用，请重新读取", 409, "IMAGE_UNAVAILABLE");
  return "data:" + image.mediaType + ";base64," + bytes.toString("base64");
}

const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;

/** Decode and save gateway images in the requested project format. */
export async function generatedImage(body: ReadableStream<Uint8Array>, format: "png" | "jpeg") {
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_GENERATED_IMAGE_BYTES) throw new Error("生成图片超过 32 MiB");
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, size);
    const shape = imageSize(bytes);
    if (shape.type !== "jpg" && shape.type !== "png") throw new Error("生成接口返回了非 JPEG / PNG 内容");
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: 4096 ** 2 }).autoOrient();
    return await (format === "png" ? image.png() : image.jpeg({ quality: 95 })).toBuffer({ resolveWithObject: true });
  } catch {
    throw new AppError("下载的图片无法保存为 " + format.toUpperCase() + "，可尝试重新下载原结果", 502, "MEDIA_DOWNLOAD_FAILED");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
