import type { Artifact } from "./types";
import { AppError } from "./security";

export const PROJECT_FOLDERS = [
  { path: "/01_创作", purpose: "剧本、分镜、角色设定、项目记忆" },
  { path: "/02_参考", purpose: "用户上传的参考图片、视频和资料" },
  { path: "/03_图片", purpose: "生成的角色图、场景图、关键帧" },
  { path: "/04_视频", purpose: "生成的视频镜头、剪辑片段" },
  { path: "/05_音频", purpose: "配音、音乐、音效" },
  { path: "/06_字幕", purpose: "字幕文件" },
  { path: "/07_成片", purpose: "最终视频" },
  { path: "/08_记录", purpose: "制作进度、审查结果、失败记录" },
] as const;
export type ProjectFolder = typeof PROJECT_FOLDERS[number]["path"];
export const PROJECT_TRASH = "/08_记录/.do漫回收站/";
export const projectTrashPath = (id: string) => PROJECT_TRASH + id;
export const PROJECT_MEMORY = "/01_创作/项目记忆.md";

export function projectPath(value: string): string {
  const parts = value.replaceAll("\\", "/").split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === ".." || /[\u0000-\u001f]/.test(p)) || value.length > 600)
    throw new AppError("请使用当前项目内的文件路径", 400, "INVALID_PATH");
  return "/" + parts.join("/");
}

export function projectRelativePath(value: string, cwd?: string): string {
  const path = value.replaceAll("\\", "/");
  return projectPath(cwd && !path.startsWith("/") ? cwd + "/" + path : path);
}

export function projectWorkingDirectory(value: string, parent?: string) {
  const directory = projectRelativePath(value, parent);
  if (directory !== "/" && !PROJECT_FOLDERS.some(({ path }) => directory === path || directory.startsWith(path + "/")))
    throw new AppError("工作目录应位于当前项目的一级目录下", 400, "INVALID_PATH");
  if (directory === PROJECT_TRASH.slice(0, -1) || directory.startsWith(PROJECT_TRASH))
    throw new AppError("工作目录无效", 400, "INVALID_PATH");
  return directory;
}

/** Validate the namespace at each write entry; reading existing files does not relocate them. */
export function projectOutputPath(value: string, folder?: ProjectFolder): string {
  const path = projectPath(value), parts = path.split("/").filter(Boolean);
  if (path === PROJECT_TRASH.slice(0, -1) || path.startsWith(PROJECT_TRASH) ||
      parts.some((part) => /[:*?"<>|]/.test(part) || part.startsWith(".do漫-"))) throw new AppError("项目文件名无效", 400, "INVALID_PATH");
  if (parts.length < 2 || !PROJECT_FOLDERS.some((f) => f.path === "/" + parts[0]))
    throw new AppError("文件必须保存在固定一级目录内：" + PROJECT_FOLDERS.map((f) => f.path).join("、") + "。子目录可按内容建立。", 400, "PROJECT_DIRECTORY_REQUIRED");
  if (folder && !path.startsWith(folder + "/")) throw new AppError("此类文件应保存在 " + folder + " 中，可自行建立子目录。", 400, "FILE_DIRECTORY_MISMATCH");
  return path;
}

export function projectDirectories(files: readonly Pick<Artifact, "path">[]): string[] {
  const directories = new Set<string>(PROJECT_FOLDERS.map((f) => f.path));
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) directories.add("/" + parts.slice(0, i).join("/"));
  }
  return [...directories].sort();
}

/** Uploaded references retain the user's filename; type-specific subfolders appear only on upload. */
export function referencePath(name: string, type: string): string {
  const file = name.replace(/[\/\\<>:"|?*\u0000-\u001f]/g, "_").slice(0, 160).trim();
  if (!file || [".", ".."].includes(file)) throw new AppError("文件名无效", 400, "INVALID_PATH");
  const category = type.startsWith("image/") ? "图片" : type.startsWith("video/") ? "视频" : type.startsWith("audio/") ? "音频" : "资料";
  return projectOutputPath("/02_参考/" + category + "/" + file, "/02_参考");
}
