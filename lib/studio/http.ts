import { AppError } from "./security";

/** Reject redirects without forwarding provider credentials to another endpoint. */
export async function fetchWithoutRedirect(input: string | URL, init: RequestInit = {}) {
  const response = await fetch(input, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new AppError("服务返回了跳转，请检查 API 或素材地址", 502, "PROVIDER_REDIRECT");
  }
  return response;
}
