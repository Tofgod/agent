import { AppError } from "./security";
import type { AgentMessage, Artifact } from "./types";
import { readWindow, serializedBytes, TOOL_RESULT_BYTES } from "./read-window";

export const PROJECT_GUIDES = "/01_创作/指南/";
type GuideFile = Pick<Artifact, "id" | "path" | "url" | "status" | "version">;

function projectGuides<File extends GuideFile>(files: readonly File[]) {
  return files.filter((file) => file.path.startsWith(PROJECT_GUIDES) && file.path.endsWith(".md") && !file.url && file.status === "ready")
    .sort((a, b) => a.path.localeCompare(b.path));
}
function guideName(file: GuideFile) { return file.path.slice(PROJECT_GUIDES.length, -3); }
function describeGuide(file: GuideFile) {
  return { name: guideName(file), revision: "project:" + file.id + ":" + file.version,
    source: "project", path: file.path, version: file.version };
}
export function guideCatalog(files: readonly GuideFile[] = []) {
  return projectGuides(files).map(describeGuide);
}
export function readGuide(name: string, files: Artifact[] = [], input: { offset?: number; column?: number; limit?: number; version?: number; revision?: string } = {}) {
  const file = projectGuides(files).find((file) => guideName(file) === name);
  const guide = file ? describeGuide(file) : undefined;
  if (input.revision !== undefined && input.revision !== guide?.revision)
    throw new AppError("指南来源已变化，请重新读取当前目录并从开头读取", 409, "VERSION_CONFLICT");
  if (((input.offset ?? 1) !== 1 || (input.column ?? 1) !== 1) && !input.revision)
    throw new AppError("指南来源已变化或续读缺少 revision，请携带上一页来源标识", 409, "VERSION_CONFLICT");
  if (!file || !guide) throw new AppError("项目指南不存在，请使用当前目录中的名称", 404, "GUIDE_NOT_FOUND");
  if (input.version !== undefined && file.version !== input.version) throw new AppError("指南已有新版本，请从开头重新读取", 409, "VERSION_CONFLICT");
  const extra = { name, source: guide.source, revision: guide.revision };
  return { ...readWindow(file, { offset: input.offset ?? 1, column: input.column ?? 1, limit: input.limit ?? 200 }, TOOL_RESULT_BYTES - serializedBytes(extra) + 1), ...extra };
}

/** Retire the old bundled guide text while preserving tool-call pairing and user-provided project guides. */
export function omitRetiredGuides(messages: AgentMessage[]) {
  const guideCalls = new Set<string>();
  return messages.map((message) => {
    for (const call of message.tool_calls || []) {
      if (call.function.name === "read_guide") guideCalls.add(call.id);
    }
    if (message.role !== "tool" || !message.tool_call_id || !guideCalls.has(message.tool_call_id) || !message.content) return message;
    let result: { source?: string; revision?: string; name?: string } | null;
    try { result = JSON.parse(message.content); } catch { return message; }
    if (result?.source !== "builtin" || typeof result.revision !== "string" || !result.revision.startsWith("builtin:")) return message;
    return { ...message, content: JSON.stringify({ name: result.name, status: "unavailable", message: "此内置指南已移除。" }) };
  });
}
