export function parseJsonResponse(raw: string): unknown {
  const trimmed = raw.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "");
  try { return JSON.parse(trimmed); } catch {
    const first = trimmed.indexOf("{"), last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
    throw new Error("模型未返回有效的结构化内容，请重试。");
  }
}
export function publicSettings(settings: import("./types").ProviderSettings): import("./types").PublicSettings {
  const { textApiKey, arkApiKey, minimaxApiKey, aiclubApiKey, ...visible } = settings;
  return { ...visible, textConnected: Boolean(textApiKey), arkConnected: Boolean(arkApiKey), minimaxConnected: Boolean(minimaxApiKey), aiclubConnected: Boolean(aiclubApiKey) };
}
