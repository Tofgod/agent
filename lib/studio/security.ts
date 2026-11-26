export class AppError extends Error {
  constructor(message: string, public status = 400, public code = "INVALID_REQUEST") { super(message); }
}
export function validateProviderUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError("API 地址无效"); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    host === "localhost" || host === "::1" || host.endsWith(".local") || host.endsWith(".internal") ||
    /^(0|10|127|169\.254|192\.168)\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^[\d.]+$/.test(host) || host.includes(":")) throw new AppError("请填写公网 HTTPS API 地址");
  return url.toString().replace(/\/+$/, "");
}
function b64(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += String.fromCharCode(byte);
  return btoa(result);
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
}
async function encryptionKey(secret: string) {
  if (!secret || secret.length < 32) throw new AppError("服务器密钥尚未配置，暂不能保存 API Key", 503, "ENCRYPTION_UNAVAILABLE");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptSecrets(value: unknown, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(secret),
    new TextEncoder().encode(JSON.stringify(value)));
  return b64(iv) + "." + b64(new Uint8Array(encrypted));
}
export async function decryptSecrets(value: string, secret: string): Promise<Record<string, string>> {
  if (!value) return {};
  try {
    const [iv, data] = value.split(".");
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv) }, await encryptionKey(secret), bytes(data));
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch { throw new AppError("无法读取已保存的 API Key，请在设置中重新保存", 503, "DECRYPTION_FAILED"); }
}
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "执行失败，请重试";
  return message.replace(/(?:sk-|key-)[A-Za-z0-9_-]{8,}/g, "[密钥]").slice(0, 600);
}
