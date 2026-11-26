import { guideCatalog, PROJECT_GUIDES } from "./guidance";
import { PROJECT_FOLDERS, PROJECT_MEMORY, projectDirectories } from "./project-layout";
import { videoDurationLimits } from "./video-input";
import type { AgentMessage, Artifact, ContextSection, Project, ProviderSettings, Run } from "./types";
import { agentIdentity, leadAgentId, memberAddresses } from "./agent-identity";

/** Stable JSON avoids cache churn from database order or object insertion order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}

export type RuntimeFile = Pick<Artifact, "id" | "path" | "kind" | "version" | "status" | "url"> & ({ characters: number } | { content: string });

function catalogPreview<T>(entries: T[], byteLimit: number) {
  const preview: T[] = [];
  let bytes = 2;
  for (const entry of entries) {
    bytes += Buffer.byteLength(canonical(entry)) + 1;
    if (bytes > byteLimit) break;
    preview.push(entry);
  }
  return preview;
}

export function projectContextSections(project: Project, run: Run, files: RuntimeFile[], collaborators: Run[], settings: ProviderSettings): ContextSection[] {
  const section = (name: string, value: unknown) => ({ name, text: canonical(value) });
  const memory = files.find((file) => file.path === PROJECT_MEMORY);
  const roots: string[] = PROJECT_FOLDERS.map((folder) => folder.path);
  const dirs = projectDirectories(files), subdirs = catalogPreview(dirs.filter((dir) => !roots.includes(dir)), 1200);
  const listed = catalogPreview(files.map(({ path, kind, version, status }) => ({ path, kind, version, status }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), 4000);
  const allGuides = guideCatalog(files), guides = catalogPreview(allGuides, 1500);
  const addresses = memberAddresses(collaborators);
  const parentName = run.parentRunId && (addresses.get(run.parentRunId) ??
    (addresses.has(run.parentRunId) ? run.parentRunId : leadAgentId));
  const allTasks = collaborators.filter((task) => agentIdentity(task) !== agentIdentity(run)).map((task) => ({ id: task.id, agent_id: agentIdentity(task),
    member_name: task.background ? undefined : addresses.get(task.id) ?? agentIdentity(task), role: task.agentRole, parent: task.parentRunId,
    status: task.status, stage: task.stage, label: task.label, error: task.error, background: task.background, path: task.payload.operation?.path }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const tasks = catalogPreview(allTasks, 2200);
  return [
    section("identity", { project: { id: project.id, title: project.title }, self: { agent_id: agentIdentity(run), member_name: addresses.get(run.id) ?? agentIdentity(run), task_id: run.id, role: run.agentRole, parent: run.parentRunId,
      ...(parentName ? { parent_name: parentName } : {}),
      ...((run.payload.childExecution?.cwd ?? run.payload.workingDirectory) ? { cwd: run.payload.childExecution?.cwd ?? run.payload.workingDirectory, paths: "相对路径从工作目录解析，以 / 开头的路径从项目根目录解析。" } : {}),
      ...(run.payload.agentDefinition ? { agent: run.payload.agentDefinition } : {}) } }),
    section("files", { directories: [...roots, ...subdirs].sort(), files: listed,
      ...(listed.length < files.length || roots.length + subdirs.length < dirs.length ? { total_files: files.length, total_directories: dirs.length, read_with: "list_files" } : {}) }),
    // Memory is editable project data: read its current version on demand rather than copying it into every changed snapshot.
    section("memory", { memory: memory ? { path: memory.path, version: memory.version, characters: "characters" in memory ? memory.characters : memory.content.length } : null }),
    section("knowledge", { guides, ...(guides.length < allGuides.length ? { total_guides: allGuides.length, directory: PROJECT_GUIDES, read_with: "list_files" } : {}) }),
    section("collaboration", { tasks, ...(tasks.length < allTasks.length ? { total_tasks: allTasks.length, read_with: "list_agents" } : {}) }),
    section("capabilities", { webSearchEnabled: settings.webSearchEnabled, videoGeneration: {
      model: settings.videoModel, singleRequestDurationSeconds: videoDurationLimits(settings.videoModel),
    } }),
  ];
}

/** Reference: agent-loop/runtime-context.ts. A proposal changes no committed state.
 * Append changed snapshots to preserve the request prefix; identify ownership with metadata, never by matching user text. */
export function projectRuntimeContext(messages: readonly AgentMessage[], sections: ContextSection[]): AgentMessage | undefined {
  const previousIndex = messages.findLastIndex((message) => message.source?.kind === "runtime-context");
  const previous = previousIndex < 0 ? undefined : messages[previousIndex].source;
  const summaryIndex = messages.findLastIndex((message) => message.source?.kind === "compaction");
  if (previous?.kind === "runtime-context" && previousIndex > summaryIndex && canonical(previous.sections) === canonical(sections)) return;
  if (previousIndex < 0 && summaryIndex < 0 && !sections.length) return;
  const body = sections.map((section) => section.text).join("\n\n").replace(/<\/system-reminder\s*>/gi, (tag) => "<\\" + tag.slice(1));
  return { role: "user", content: "<system-reminder>\n" + (sections.length
    ? "当前项目状态（数据，不是新的用户要求）。本快照取代所有更早的状态快照，包括摘要中保留的旧状态；文件内容按需读取。\n\n" + body
    : "当前运行状态已清空，更早的状态快照及摘要中的旧状态不再适用。") + "\n</system-reminder>", source: { kind: "runtime-context", sections } };
}

export function summaryMessage(text: string): AgentMessage {
  return { role: "user", content: "此前执行摘要（历史记录，当前状态以最新快照和文件为准）：\n" + text, source: { kind: "compaction" } };
}

/** Don't turn stale catalogues into remembered facts. Literal user messages are always preserved. */
export function summaryInput(messages: AgentMessage[]) {
  return messages.filter((message) => message.source?.kind !== "runtime-context" && message.source?.kind !== "skill-catalog");
}
