import type { Artifact } from "./types";

export function linkedArtifact(files: Artifact[], sourcePath: string, destination?: string) {
  if (!destination) return undefined;
  const served = files.find((f) => f.url === destination);
  if (served) return served;
  if (/^[a-z][a-z\d+.-]*:/i.test(destination) || destination.startsWith("//") || destination.startsWith("#")) return undefined;
  let path: string;
  try { path = decodeURIComponent(destination.split(/[?#]/, 1)[0]); } catch { return undefined; }
  const parts = path.startsWith("/") ? [] : sourcePath.split("/").filter(Boolean).slice(0, -1);
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return undefined; parts.pop(); }
    else parts.push(part);
  }
  return files.find((f) => f.path === "/" + parts.join("/"));
}
