import { Store } from "../lib/studio/store";
import type { BlobStore, Database } from "../lib/studio/storage";
import type { AgentDefinition } from "../lib/studio/types";
import type { ModelRetryConfig } from "../lib/studio/model-retry-policy";
import type { CompactionConfig } from "../lib/studio/compaction-policy";
import type { ProjectDisk } from "./project-disk";
import type { SkillLibrary } from "../lib/studio/skills";
import type { McpManager } from "../lib/studio/mcp";
import type { SchedulePolicy } from "../lib/studio/schedules";
import type { PresetPlugins } from "../lib/studio/preset-plugins";
import type { TextModelResolver } from "../lib/studio/providers";
export interface Runtime { database: Database; media: BlobStore; encryptionSecret: string; workerSecret: string; userId: string; agents?: readonly AgentDefinition[]; disk?: ProjectDisk;
  skills?: SkillLibrary; mcp?: McpManager; presetPlugins?: PresetPlugins; scheduleToolsEnabled?: boolean; schedulePolicy?: SchedulePolicy; resolveModel?: TextModelResolver;
  goalMaxRounds?: number; goalBlockedAfterRounds?: number; questionTimeout?: number; parallelTodos?: boolean; defaultApprovalPolicy?: "ask" | "never";
  contextWindow?: number; compaction?: CompactionConfig; modelRetry?: ModelRetryConfig; maxParallelTools?: number; maxDelegationDepth?: number; maxConsecutiveWakes?: number; maxConcurrentJobsPerOwner?: number; jobWaitTimeout?: number; maxJobWaitTimeout?: number; completionDelivery?: "quiet" | "wakeup" }
let runtime: Runtime | undefined;
export function configureRuntime(value: Runtime) { runtime = value; }
export function getRuntime() {
  if (!runtime) throw new Error("本地服务尚未启动");
  return { ...runtime, store: new Store(runtime.database, runtime) };
}
