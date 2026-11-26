import { createHash } from "node:crypto";
import { estimateMessageTokens } from "./context-tokens";
import type { AgentImage, AgentMessage, AgentToolCall } from "./types";
import { parseToolArguments } from "./tool-history";
import type { ImageTokenPrice } from "./vision-tokens";
import { retainContent, type RetainableBlock } from "./harness/retention";

export const TOOL_INLINE_TOKENS = 12_500;
export interface ToolOutputRecord { content: string; images?: AgentImage[]; reference?: string }

/** Project sanitized MCP data with image references in their original block positions. */
export function mcpModelBlocks(content: string | null, images: readonly AgentImage[]): RetainableBlock[] | undefined {
  if (!content) return;
  const receipt = parseToolArguments(content);
  if (receipt?.external !== true || !receipt.data || typeof receipt.data !== "object") return;
  const { content: blocks, ...metadata } = receipt.data as Record<string, unknown>;
  if (!Array.isArray(blocks)) return;
  const imageCount = blocks.filter((block) => block?.type === "image").length;
  const issue = typeof receipt.image_error === "string" ? receipt.image_error : undefined;
  if (!imageCount || images.length !== imageCount && !issue) return;
  let image = 0;
  const projected = blocks.map((block): RetainableBlock => {
    if (block?.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if (block?.type === "image") return issue ? { type: "text", text: "[MCP 图片不可用] " + issue } : { type: "image", image: images[image++] };
    return { type: "text", text: JSON.stringify(block) ?? "" };
  });
  delete metadata.isError;
  if (Object.keys(metadata).length) projected.push({ type: "text", text: JSON.stringify(metadata) });
  return projected;
}

/** Keep the model copy bounded and retain the accepted result independently. */
export function projectToolOutput(message: AgentMessage, priceImage: ImageTokenPrice, limit = TOOL_INLINE_TOKENS, toolName?: string) {
  const content = message.content ?? "", images = message.images ?? [];
  if (estimateMessageTokens(message, priceImage) <= limit)
    return { message, record: images.length ? { content, images } satisfies ToolOutputRecord : undefined };
  const reference = message.outputRef ?? crypto.randomUUID();
  const preview = (excerpt: string, keptImages: AgentImage[], omittedBytes: number, omittedImages: number): AgentMessage => ({
    ...message, outputRef: reference, images: keptImages.length ? keptImages : undefined, content: JSON.stringify({
      result_ref: reference, excerpt, omitted_bytes: omittedBytes, omitted_images: omittedImages,
      read_with: "read_tool_result",
    }),
  });
  const gap = "\n…\n", notice = estimateMessageTokens(preview(gap + "\n\n", [], Buffer.byteLength(content), images.length), priceImage);
  if (notice > limit)
    return { message, record: images.length ? { content, images } satisfies ToolOutputRecord : undefined };
  const ordered = (toolName === undefined || toolName.startsWith("mcp_")) ? mcpModelBlocks(content, images) : undefined;
  const blocks: RetainableBlock[] = ordered ?? [{ type: "text", text: content }, ...images.map((image) => ({ type: "image" as const, image }))];
  const kept = retainContent(blocks, limit - notice, (block) => block.type === "image" ? priceImage(block.image) :
    Math.ceil((Buffer.byteLength(JSON.stringify(block.text)) - 2) / 4));
  const readText = (end: RetainableBlock[]) => end.map((block) => block.type === "text" ? block.text : "").join("");
  const retainedImages = [...kept.head, ...kept.tail].flatMap((block) => block.type === "image" ? [block.image] : []);
  const excerpt = readText(kept.head) + (kept.omittedBytes || kept.omittedImages ? gap : "") + readText(kept.tail);
  const bounded = preview(excerpt, retainedImages, kept.omittedBytes, kept.omittedImages);
  if (ordered) {
    let image = 0;
    const footer = { type: "text" as const, text: JSON.stringify({ result_ref: reference, omitted_bytes: kept.omittedBytes,
      omitted_images: kept.omittedImages, read_with: "read_tool_result" }) };
    const blocks = kept.head.length || kept.tail.length
      ? [...kept.head, { type: "text" as const, text: gap }, ...kept.tail, { ...footer, text: "\n\n" + footer.text }]
      : [footer];
    const merged: NonNullable<AgentMessage["orderedToolContent"]> = [];
    for (const part of blocks) {
      const previous = merged.at(-1);
      if (part.type === "image") merged.push({ type: "image", index: image++ });
      else if (previous?.type === "text") previous.text += part.text;
      else merged.push({ ...part });
    }
    bounded.orderedToolContent = merged;
  }
  return { message: bounded, record: { content, images, reference } satisfies ToolOutputRecord };
}

export function observeRepeat(previous: { key: string; count: number } | undefined, call: AgentToolCall) {
  let args: unknown = call.function.arguments;
  try { args = args ? JSON.parse(String(args)) : {}; } catch {}
  const canonical = JSON.stringify(args, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
  const tool = call.function.name;
  const key = createHash("sha256").update(JSON.stringify([tool, canonical])).digest("hex");
  const count = previous?.key === key ? previous.count + 1 : 1;
  let notice: AgentMessage | undefined;
  if ([3, 5, 8].includes(count)) notice = {
    role: "user", source: { kind: "repeat-tool-reminder", tool, count },
    content: count === 3 ? "你正在用相同参数重复调用同一工具。请检查已有结果，需要继续时换一种方法或参数。" :
      `工具 ${tool} 已连续用同一组参数调用 ${count} 次。参数 ${canonical.slice(0, 500)}${canonical.length > 500 ? "…" : ""}。请检查最新结果，改用其他操作、参数，或在已有足够信息时结束本轮。`,
  };
  return { chain: { key, count }, notice };
}
