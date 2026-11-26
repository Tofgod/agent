import type { AgentMessage, ContextMeasurement } from "./types";
import type { AgentTool } from "./file-tools";
import { conservativeImagePrice, type ImageTokenPrice } from "./vision-tokens";

export const MODEL_OUTPUT_TOKENS = 12000;
const textTokens = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 4);

export function estimateMessageTokens(message: AgentMessage, priceImage: ImageTokenPrice = conservativeImagePrice): number {
  return 8 + textTokens(message.content || "") + (message.images ?? []).reduce((total, image) => total + priceImage(image), 0) +
    (message.messagesReplay?.blocks ?? []).reduce((total, block) => total + (block.type === "thinking" ? textTokens(block.thinking) : 0), 0) +
    (message.tool_calls || []).reduce((sum, call) => sum + 4 + textTokens(call.function.name) + textTokens(call.function.arguments), 0);
}

export function estimateRequestTokens(system: string, tools: AgentTool[], messages: AgentMessage[], priceImage?: ImageTokenPrice): number {
  return textTokens(system) + textTokens(JSON.stringify(tools)) + messages.reduce((sum, message) => sum + estimateMessageTokens(message, priceImage), 8);
}

/** Provider usage prices the last completed request. Estimate only the change since that request. */
export function pricedTokens(estimate: number, modelKey: string, previous?: ContextMeasurement): number {
  if (previous?.modelKey !== modelKey) return estimate;
  return Math.max(0, previous.inputTokens + estimate - previous.estimatedTokens);
}

export function retainedContextBoundary(messages: AgentMessage[], retain: number, options: { latestCut?: number; priceImage?: ImageTokenPrice } = {}) {
  let cut = messages.length, tokens = 0;
  while (cut > 0 && (cut === messages.length || tokens < retain)) {
    tokens += estimateMessageTokens(messages[cut - 1], options.priceImage);
    cut--;
  }
  cut = Math.min(cut, options.latestCut ?? messages.length);
  const receiptIndexes = new Map<string, number>();
  for (const [index, message] of messages.entries()) if (message.tool_call_id) receiptIndexes.set(message.tool_call_id, index);
  for (let index = cut - 1; index >= 0; index--) {
    if (messages[index].tool_calls?.some((call) => (receiptIndexes.get(call.id) ?? -1) >= cut)) cut = index;
  }
  return cut;
}
