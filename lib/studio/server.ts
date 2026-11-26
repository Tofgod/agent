import { getRuntime } from "../../server/runtime";
import { AppError, safeError } from "./security";
export async function serverContext(request: Request) {
  const { userId, store, media, encryptionSecret, disk } = getRuntime();
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new AppError("请求来源无效", 403);
  }
  return { userId, store, bucket: media, encryptionSecret, disk };
}
export async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.length > 1024 * 1024) throw new AppError("内容过大", 413);
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { throw new AppError("请求内容无效"); }
}
export function errorResponse(error: unknown) {
  return Response.json({ error: safeError(error), code: error instanceof AppError ? error.code : "SERVER_ERROR" },
    { status: error instanceof AppError ? error.status : 500 });
}
