import { z } from "zod";
import { AppError } from "./security";
import type { Store } from "./store";
import { type Artifact, type ArtifactKind, type Run } from "./types";
import { projectDirectories, projectOutputPath, projectRelativePath } from "./project-layout";
import { readWindow, serializedBytes, TOOL_RESULT_BYTES } from "./read-window";
import type { ToolRegistration } from "./tool-registry";
import { literalEdit } from "./literal-edit";
export { projectDirectories, projectPath } from "./project-layout";

export interface AgentTool { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }
const str = { type: "string" }, integer = { type: "integer" };
export function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): AgentTool {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}
function fileTool(schema: AgentTool, label: string, mode?: "parallel"): ToolRegistration {
  return {
    schema, label, mode,
    async execute({ store, run }, callId, args) {
      const result = await executeFileTool(store, run, callId, schema.function.name, args);
      const files = Array.isArray(result.files) ? result.files : [result];
      return { result, artifactIds: mode ? [] : files.flatMap((file) => typeof file.id === "string" ? [file.id] : []) };
    },
  };
}
export const fileTools = [
  fileTool(tool("list_files", "查看项目文件和目录，可指定目录前缀；结果分页，使用 next_offset 继续。", { directory: str, offset: integer, limit: integer }), "查看目录", "parallel"),
  fileTool(tool("read_file", "按路径或文件 ID 读取项目文件，可指定引用中的 version 查看历史版本。用 next_offset、next_column 继续未读内容。图片、视频返回素材信息。", { file_path: str, file_id: str, version: integer, offset: integer, column: integer, limit: integer }), "读取文件", "parallel"),
  fileTool(tool("search_files", "在项目文本中搜索字面量，返回匹配行。", { query: str, directory: str }, ["query"]), "搜索文件", "parallel"),
  fileTool(tool("write_file", "创建或完整更新文本文件，自动创建父目录。创作文档使用 Markdown；格式自由。", {
    file_path: str, content: str, kind: { type: "string", enum: ["document", "script", "storyboard", "characters", "review"] }, version: integer,
  }, ["file_path", "content"]), "写入文件"),
  fileTool(tool("edit_file", "局部替换文字，默认要求唯一匹配，保留其余内容。", { file_path: str, old_string: str, new_string: str, replace_all: { type: "boolean" }, version: integer }, ["file_path", "old_string", "new_string"]), "修改文件"),
  fileTool(tool("edit_files", "联动修改多个文本文件：先检查全部匹配、已读取版本和锁定状态，再一次提交。任一文件有冲突时全部不改。对同一路径的多处替换按给定顺序执行。", { edits: { type: "array", items: { type: "object", properties: { file_path: str, old_string: str, new_string: str, replace_all: { type: "boolean" }, version: integer }, required: ["file_path", "old_string", "new_string"], additionalProperties: false } } }, ["edits"]), "联动修改文件"),
  fileTool(tool("move_file", "在本项目内移动或重命名文件，不覆盖目标文件。", { file_path: str, new_path: str }, ["file_path", "new_path"]), "整理文件"),
];
function textFile(file: Artifact) {
  if (file.url || ["image", "video", "audio", "final"].includes(file.kind)) throw new AppError("请使用文本文件工具编辑文档，媒体文件请重新生成或上传", 400, "NOT_TEXT_FILE");
}
const baseArgs = z.object({ file_path: z.string().min(1), version: z.number().int().positive().optional() });
export const readSelection = z.object({ file_path: z.string().min(1).optional(), file_id: z.string().uuid().optional(),
  version: z.number().int().positive().optional() });
export async function resolveReadFile(store: Store, projectId: string, input: z.infer<typeof readSelection>, files?: Artifact[], cwd?: string) {
  if (input.file_id) return input.version === undefined
    ? store.artifact(input.file_id, projectId) : store.artifactVersion(projectId, input.file_id, input.version);
  if (!input.file_path) throw new AppError("请提供文件路径或文件 ID");
  const path = projectRelativePath(input.file_path, cwd);
  const file = (files ?? await store.artifacts(projectId)).find((item) => item.path === path);
  if (!file) throw new AppError("文件不存在：" + path, 404, "FILE_NOT_FOUND");
  return input.version === undefined ? file : store.artifactVersion(projectId, file.id, input.version);
}
export async function executeFileTool(store: Store, run: Run, callId: string, name: string, raw: unknown): Promise<Record<string, unknown>> {
  const cached = await store.toolResult(run.id, callId);
  if (cached) return cached;
  const files = await store.artifacts(run.projectId);
  const cwd = run.payload.childExecution?.cwd ?? run.payload.workingDirectory;
  const resolvePath = (path: string) => projectRelativePath(path, cwd);
  const find = (path: string) => {
    const file = files.find((f) => f.path === resolvePath(path));
    if (!file) throw new AppError("文件不存在：" + path, 404, "FILE_NOT_FOUND");
    return file;
  };
  if (name === "list_files") {
    const args = z.object({ directory: z.string().optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(100) }).parse(raw), dir = resolvePath(args.directory || ".");
    const includes = (path: string) => dir === "/" || path === dir || path.startsWith(dir + "/");
    const directories = projectDirectories(files).filter(includes);
    const entries = [...directories.map((path) => ({ directory: path })), ...files.filter((f) => includes(f.path)).map((f) => ({ file: { path: f.path, kind: f.kind, version: f.version, status: f.status, locked: f.locked } }))];
    const result: { directories: string[]; files: Record<string, unknown>[]; total_entries: number; offset: number; next_offset: number | null } = { directories: [], files: [], total_entries: entries.length, offset: args.offset, next_offset: args.offset < entries.length ? args.offset : null };
    for (let index = args.offset; index < Math.min(entries.length, args.offset + args.limit); index++) {
      const entry = entries[index], next = index + 1 < entries.length ? index + 1 : null;
      const candidate = { ...result, directories: "directory" in entry ? [...result.directories, entry.directory] : result.directories,
        files: "file" in entry ? [...result.files, entry.file] : result.files, next_offset: next };
      if (serializedBytes(candidate) > TOOL_RESULT_BYTES) break;
      Object.assign(result, candidate);
    }
    return result;
  }
  if (name === "read_file") {
    const args = readSelection.extend({ offset: z.number().int().min(1).default(1), column: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(400).default(200) }).parse(raw);
    const file = await resolveReadFile(store, run.projectId, args, files, cwd);
    if (file.url) return { path: file.path, version: file.version, kind: file.kind, status: file.status, url: file.url, metadata: file.metadata };
    return readWindow(file, args);
  }
  if (name === "search_files") {
    const args = z.object({ query: z.string().min(1).max(1000), directory: z.string().optional() }).parse(raw), dir = resolvePath(args.directory || ".");
    const matches: { path: string; line: number; text: string }[] = [];
    let truncated = false;
    scan: for (const f of files.filter((f) => !f.url && (dir === "/" || f.path.startsWith(dir + "/") || f.path === dir))) {
      const lines = f.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const start = lines[i].indexOf(args.query); if (start < 0) continue;
        const match = { path: f.path, line: i + 1, text: lines[i].slice(Math.max(0, start - 160), start + args.query.length + 340) };
        if (matches.length >= 80 || serializedBytes({ matches: [...matches, match], limit: 80, truncated: true }) > TOOL_RESULT_BYTES) { truncated = true; break scan; }
        matches.push(match);
      }
    }
    return { matches, limit: 80, truncated };
  }
  if (name === "move_file") {
    const args = baseArgs.extend({ new_path: z.string().min(1) }).parse(raw), file = find(args.file_path), path = projectOutputPath(resolvePath(args.new_path));
    if (files.some((f) => f.path === path)) throw new AppError("目标文件已存在，请选择其他名称", 409, "FILE_EXISTS");
    return store.moveArtifact(run, callId, file, path);
  }
  if (name === "edit_files") {
    const input = z.object({ edits: z.array(baseArgs.extend({ old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().default(false) })).min(1).max(24) }).parse(raw);
    const changes = new Map<string, { file: Artifact; content: string; version: number }>();
    for (const edit of input.edits) {
      const file = find(edit.file_path); textFile(file); projectOutputPath(file.path);
      if (file.locked) throw new AppError("文件已锁定：" + file.path, 409, "ARTIFACT_LOCKED");
      const version = edit.version ?? run.payload.agent?.observedVersions?.[file.id];
      if (version === undefined) throw new AppError("批量修改前请先读取文件：" + file.path, 409, "FILE_NOT_OBSERVED");
      if (version !== file.version) throw new AppError("文件已有新版本，请重新读取：" + file.path, 409, "VERSION_CONFLICT");
      const prior = changes.get(file.id);
      changes.set(file.id, { file, version, content: literalEdit(prior?.content ?? file.content, edit.old_string, edit.new_string, edit.replace_all) });
    }
    return store.editArtifacts(run, callId, [...changes.values()]);
  }
  let content: string, file: Artifact | undefined, kind: ArtifactKind, path: string, expectedVersion: number | undefined;
  if (name === "write_file") {
    const args = baseArgs.extend({ content: z.string().max(300000), kind: z.enum(["document", "script", "storyboard", "characters", "review"]).optional() }).parse(raw);
    path = projectOutputPath(resolvePath(args.file_path)); file = files.find((f) => f.path === path); if (file) textFile(file);
    content = args.content; kind = args.kind || file?.kind || "document";
    expectedVersion = args.version ?? (file ? run.payload.agent?.observedVersions?.[file.id] : 0);
    if (file && expectedVersion === undefined) throw new AppError("完整更新前请先读取文件并使用其版本，保留用户最新修改", 409, "FILE_NOT_OBSERVED");
  } else if (name === "edit_file") {
    const args = baseArgs.extend({ old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().default(false) }).parse(raw);
    file = find(args.file_path); textFile(file); path = projectOutputPath(file.path); kind = file.kind; expectedVersion = args.version ?? run.payload.agent?.observedVersions?.[file.id] ?? file.version;
    content = literalEdit(file.content, args.old_string, args.new_string, args.replace_all);
  } else throw new AppError("工具不存在：" + name, 400, "UNKNOWN_TOOL");
  if (path === "/") throw new AppError("请指定文件名", 400, "INVALID_PATH");
  if (!/\.md$/i.test(path) && !(path.startsWith("/06_字幕/") && /\.(srt|vtt|ass)$/i.test(path)))
    throw new AppError("创作文档请使用 .md，字幕可使用 .srt、.vtt 或 .ass", 400, "DOCUMENT_FORMAT_REQUIRED");
  await store.putArtifact(run.projectId, { path, kind, content, expectedVersion, expectedArtifactId: file?.id,
    metadata: { ...(file?.metadata || {}), agent: run.agentRole }, toolReceipt: { run, callId } });
  const receipt = await store.toolResult(run.id, callId);
  if (!receipt) throw new AppError("文件写入回执不可用", 500, "FILE_WRITE_RESULT_MISSING");
  return receipt;
}
