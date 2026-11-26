import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
export function mediaError(message, code = "MEDIA_PROCESS_ERROR") { const error = new Error(message); error.code = code; return error; }
// Settle after close: cancellation must not release a job while FFmpeg still owns its files.
export function mediaCommand(binary, args, cwd, signal, timeoutMs = 180000) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errorText = "", failure, killTimer;
    const stop = (reason) => { if (failure) return; failure = reason; child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 2000); };
    const abort = () => stop(signal.reason || mediaError("任务已停止", "RUN_STOPPED"));
    const timeout = setTimeout(() => stop(mediaError("媒体处理超时", "MEDIA_PROCESS_TIMEOUT")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (data) => { output = (output + data).slice(-32000); });
    child.stderr.on("data", (data) => { errorText = (errorText + data).slice(-2400); });
    child.once("error", (error) => { failure = error.code === "ENOENT" ? mediaError("未找到 FFmpeg / FFprobe，请先安装", "COMPOSER_NOT_FOUND") : error; });
    child.once("close", (code) => {
      clearTimeout(timeout); clearTimeout(killTimer); signal?.removeEventListener("abort", abort);
      if (failure) reject(failure); else if (code === 0) resolve(output); else reject(mediaError("媒体处理失败：" + errorText.slice(-1000)));
    });
  });
}
export async function downloadMedia(uri, destination, { baseUrl, token, signal, fetchImpl = fetch }) {
  const url = new URL(uri, baseUrl);
  if (url.origin !== new URL(baseUrl).origin || !/^\/api\/worker\/media\/[^/]+$/.test(url.pathname)) throw mediaError("素材地址无效");
  const response = await fetchImpl(url, { headers: { Authorization: "Bearer " + token }, redirect: "error", signal });
  if (!response.ok || !response.body) throw mediaError("读取素材失败", "MEDIA_DOWNLOAD_FAILED");
  const limit = 240 * 1024 * 1024, reader = response.body.getReader(); let size = 0;
  const file = await open(destination, "w");
  try {
    for (;;) {
      signal?.throwIfAborted(); const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw mediaError("素材超过 240 MiB", "MEDIA_TOO_LARGE");
      await file.writeFile(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await file.close(); }
}
