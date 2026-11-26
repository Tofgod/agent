import { AppError } from "./security";

export function authorizeLocalWorker(request: Request, secret?: string) {
  const host = new URL(request.url).hostname.replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(host) || request.headers.has("origin")) throw new AppError("接口不存在", 404);
  if (!secret || secret.length < 48 || request.headers.get("authorization") !== "Bearer " + secret)
    throw new AppError("后台身份无效", 401);
}
