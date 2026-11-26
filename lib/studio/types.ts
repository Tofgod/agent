import type { MessagesReplay, MessagesSeries } from "./deepseek-history";
import type { ChildExecution } from "./child-execution";
import type { ModelRetryRecord } from "./model-retry-policy";
import type { CompositionFps, CompositionResolution, MediaRatio, VideoRatio, ImageOptions } from "./media-specs";
import type { VideoOptions } from "./video-input";

export const STUDIO_NAME = "do漫";
export type ArtifactKind = "script" | "storyboard" | "characters" | "review" | "image" | "video" | "audio" | "final" | "document";
export type ArtifactStatus = "ready" | "generating" | "failed" | "stale";
export type RunIntent = "agent" | "compact" | "write" | "direct" | "revise" | "produce" | "frames" | "videos";
export type RunStatus = "queued" | "running" | "waiting" | "paused" | "failed" | "cancelled" | "done";
export type Stage = "agent" | "maintenance" | "media" | "writing" | "reviewing" | "revising" | "directing" | "frames" | "videos" | "composing" | "inspecting" | "done";
export interface AgentToolCall { id: string; providerId?: string; type: "function"; function: { name: string; arguments: string } }
export interface AgentImage { id: string; version: number; path: string; objectKey: string; mediaType: string; bytes: number; width: number; height: number; sha256?: string }
export interface ModelUsage { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens?: number; cacheWriteInputTokens?: number }
export interface ContextMeasurement { inputTokens: number; estimatedTokens: number; modelKey: string }
export interface ContextSection { name: string; text: string }
export type AgentInputSource = { kind: "agent-message" | "delegation"; senderRunId: string; senderRole: AgentRole; senderName?: string } |
  { kind: "schedule-change"; id: string };
export interface AgentInput { id: string; content: string; attachments?: MessageAttachment[]; source?: AgentInputSource; scheduled?: boolean; scheduledFrame?: string }
export interface BackgroundOutputClaim { jobId: string; cursor: number; terminal: string }
export interface ModelAttemptTrace {
  protocol: "chat-completions" | "messages";
  frames: { at: number; data: string }[];
  truncated: boolean;
}
export const reasoningEfforts = ["low", "high", "max"] as const;
export type ReasoningEffort = typeof reasoningEfforts[number];
export interface SkillCatalogSource {
  kind: "skill-catalog";
  entries: { name: string; description: string }[];
  update?: true;
  incomplete?: true;
}
export interface AgentMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: AgentToolCall[]; tool_call_id?: string; images?: AgentImage[]; outputRef?: string;
  finishReason?: "max-tokens";
  attemptTrace?: ModelAttemptTrace;
  orderedToolContent?: ({ type: "text"; text: string } | { type: "image"; index: number })[];
  messagesReplay?: MessagesReplay;
  chatReasoning?: { endpoint: string; model: string; text: string };
  source?: { kind: "runtime-context"; sections: ContextSection[] } | { kind: "compaction" } | { kind: "task-result"; inlineOutput?: BackgroundOutputClaim } |
    { kind: "repeat-tool-reminder"; tool: string; count: number } | { kind: "tool-context" } | { kind: "session-reference"; snapshotIds?: string[] } |
    SkillCatalogSource | { kind: "skill-invocation"; name: string } | { kind: "model-recovery" } | AgentInputSource; }
export type AgentRole = string;
export interface AgentDefinition { id: AgentRole; name: string; description?: string; textRoute?: { provider: "chat-completions" | "messages"; model: "deepseek-flash"; reasoning_effort?: ReasoningEffort | "off" } }
export interface AgentState { messages: AgentMessage[]; seenUserIds: string[]; step: number; toolIndex: number; artifactIds: string[]; summary?: string;
  parentMessageCallId?: string;
  childNotices?: Record<string, string>; waitingFor?: string[]; waitingForJob?: true; waitingForTasksUntil?: number; waitingForInputUntil?: number; waitingInputVersion?: number; pendingRequest?: { id: string }; observedVersions?: Record<string, number>; contextMeasurement?: ContextMeasurement;
  admittedTools?: string[]; toolRequestId?: string; finalReply?: string; finalReplyReason?: AgentMessage["finishReason"]; backgroundNotices?: Record<string, string>;
  messagesSeries?: MessagesSeries;
  contextRoute?: { baseUrl: string; model: ProviderSettings["textModel"] };
  unadmittedInputStart?: number;
  unadmittedInputIds?: string[];
  skillCatalogPublished?: true;
  contextRecovery?: "needed" | "used";
  contextOverflow?: { turn: number; step: number; attempt: number; error: string; pruned?: true };
  compactionBypass?: boolean;
  pressureCompactions?: number;
  toolConcludesTurn?: boolean;
  structuredResult?: Record<string, unknown>;
  repeatToolCall?: { key: string; count: number };
  pendingNotices?: AgentMessage[]; }
export interface Project {
  id: string; title: string; brief: string; style: string; ratio: "16:9" | "9:16";
  duration: number; status: string; isExample: boolean; createdAt: string; updatedAt: string;
}
export interface Artifact {
  id: string; projectId: string; path: string; kind: ArtifactKind; content: string; version: number;
  status: ArtifactStatus; locked: boolean; url: string | null; metadata: Record<string, unknown>;
  createdAt: string; updatedAt: string;
}
export type MessageAttachment = Pick<Artifact, "id" | "path" | "kind" | "version">;
export type BusyEnter = "steer" | "queue";
export const CHAT_ATTACHMENT_LIMIT = 20;
export interface ChatSubmission { requestId: string; text: string; attachmentIds: string[]; mode?: "next-turn"; scheduledFrame?: string }
export interface QueuedChat {
  requestId: string; text: string; attachments: MessageAttachment[]; version: number; targetRunId?: string; createdAt?: string;
}
export type QueuedChatVersion = Pick<QueuedChat, "requestId" | "version">;
export type QueuedChatEdit = { version: number } & (
  { action: "cancel" } | { action: "replace"; text: string; attachmentIds: string[] } | { action: "steer"; runId: string });
export interface Message {
  id: string; projectId: string; role: "user" | "assistant"; agent: "main" | "writer" | "director" | null;
  content: string; runId: string | null; artifactIds: string[]; createdAt: string; eventSeq?: number;
  requestId?: string; attachments?: MessageAttachment[];
}
export type VideoReferenceSource = { type: "project_file"; path: string } | { type: "url"; url: string };
export interface VideoReferences<Video = string> {
  first?: string; last?: string; images?: string[]; videos?: Video[]; audio?: string[];
}
export interface RunPayload {
  backgroundOutputLimitBytes?: number;
  workingDirectory?: string;
  instruction: string;
  resultFollowup?: true;
  imported?: true;
  archivedFork?: true;
  archivedOutputPath?: string;
  inherited?: true;
  forkSource?: { runId: string; revision: number };
  forkChanges?: (TurnFileChange & { kind: ArtifactKind })[];
  agentDefinition?: AgentDefinition;
  childExecution?: ChildExecution;
  memberName?: string;
  sourceVersions: Record<string, number>; providerTaskId?: string;
  pendingArtifactId?: string; pendingArtifactVersion?: number; pendingType?: "image" | "video"; providerRequestId?: string; submittedAt?: string; submissionUnknown?: boolean;
  mediaProvider?: MediaProvider; providerModel?: string; providerBaseUrl?: string; outputUrl?: string; outputDuration?: number;
  outputLastFrameUrl?: string; outputRatio?: string; outputResolution?: string; outputFps?: number;
  submissionId?: string;
  cancellation?: { state: "checking" | "running" | "cancelled" | "completed" | "failed" | "unknown"; detail: string; attempts: number; checkedAt?: string };
  agent?: AgentState;
  agentRevision?: number;
  modelRetry?: ModelRetryRecord;
  modelDirectRetry?: string;
  stoppedBySessionArchive?: boolean;
  agentInterrupted?: true;
  batch?: { id: string; title: string; key: string; dependencies: string[] };
  production?: { toolCallId: string; mode: "frames" | "videos" | "compose"; scriptId?: string; storyboardId: string };
  operation?: { toolCallId: string; name: "generate_image" | "generate_video" | "compose_video"; path: string;
    prompt?: string; references?: string[]; imagePath?: string; duration?: number; dialogue?: string; ratio?: VideoRatio;
    referenceVersions?: MessageAttachment[];
    imageModel?: ProviderSettings["imageModel"]; videoModel?: ProviderSettings["videoModel"]; mediaBaseUrl?: string;
    videoReferences?: VideoReferences<VideoReferenceSource | string>; generateAudio?: boolean; imageOptions?: ImageOptions; videoOptions?: VideoOptions; draftTaskId?: string };
  inspection?: { sourceId: string; sourceVersion: number; timestamps?: number[] };
  composition?: { shots: { id: string; videoId: string; audioId?: string; duration: number; dialogue: string }[];
    ratio: MediaRatio; resolution?: CompositionResolution; fps?: CompositionFps };
}
export interface Run {
  id: string; projectId: string; intent: RunIntent; status: RunStatus; stage: Stage; progress: number;
  sessionId?: string;
  canFork?: boolean;
  label: string; error: string | null; payload: RunPayload; leaseUntil: number; leaseToken: string;
  attempts: number; nextAttemptAt: number; errorCode: string | null; createdAt: string; updatedAt: string;
  background?: true; agentRevision?: number;
  parentRunId: string | null; agentRole: AgentRole; generation: number; inputVersion: number; streamText: string; resultText: string;
}
export interface ActiveBackgroundTask {
  id: string; projectId: string; status: Extract<RunStatus, "queued" | "running" | "waiting">; label: string; path: string | null;
}
export const IMAGE_MODELS = ["doubao-seedream-5-0-pro-260628", "doubao-seedream-5-5-261028"] as const;
export const AICLUB_VIDEO_MODELS = ["zimao-2.5", "zimao-2.0", "zimao-2.0-fast"] as const;
export const VIDEO_MODELS = ["doubao-seedance-2-5-260628", "doubao-seedance-2-0-260128", "MiniMax-H3", "MiniMax-H3-Max", ...AICLUB_VIDEO_MODELS] as const;
export type MediaProvider = "volcengine" | "minimax" | "aiclub";
export interface ProviderSettings {
  textBaseUrl: string; textModel: "deepseek-flash"; textApiKey: string;
  textThinking?: boolean;
  textReasoningEffort?: ReasoningEffort;
  arkBaseUrl: string; arkApiKey: string; minimaxBaseUrl: string; minimaxApiKey: string; aiclubApiKey: string;
  busyEnter: BusyEnter; webSearchEnabled: boolean; imageModel: typeof IMAGE_MODELS[number]; videoModel: typeof VIDEO_MODELS[number];
}
export type PublicSettings = Omit<ProviderSettings, "textApiKey" | "arkApiKey" | "minimaxApiKey" | "aiclubApiKey"> & {
  textConnected: boolean; arkConnected: boolean; minimaxConnected: boolean; aiclubConnected: boolean;
};
export interface ExecutionStep {
  seq: number; runId: string; callId: string; name: string; status: "running" | "done" | "failed" | "interrupted" | "unknown";
  summary: string; startedAt: string; finishedAt: string | null; eventSeq?: number;
  notDispatched?: true;
}
export interface ExecutionDetail {
  input: string; output: string | null; inputTruncated: boolean; outputTruncated: boolean;
  web?: { sources: { url: string; title: string; description?: string }[] };
  images?: { url: string; name: string }[];
}
export interface ExecutionPart { text: string | null; nextOffset?: number }
export interface AssistantReply {
  id: string; runId: string; kind: "reply" | "compaction"; content: string; createdAt: string; eventSeq?: number;
  status: "running" | "settled" | "interrupted" | "truncated";
}
export interface TurnFileChange {
  id: string; path: string; previousPath: string | null; beforeVersion: number | null; afterVersion: number;
}
export interface FileDiffHunk { oldStart: number; newStart: number; lines: string[] }
export type FileComparison = TurnFileChange & (
  | { kind: "text"; hunks: FileDiffHunk[]; truncated: boolean; coarse: boolean }
  | { kind: "media"; before: { url: string; kind: ArtifactKind } | null; after: { url: string; kind: ArtifactKind } | null }
);
export interface WorkspaceSnapshot {
  project: Project; artifacts: Artifact[]; messages: Message[]; runs: Run[]; cursor: number; steps: ExecutionStep[]; stepCounts: Record<string, number>; replies: AssistantReply[];
  changesByRun?: Record<string, TurnFileChange[]>; chatQueue?: QueuedChat[];
  sessionId?: string; sessions?: ProjectSession[]; historyBefore?: number; deliveries?: Delivery[];
  teamTasks?: TeamTask[]; activeBackgroundTasks?: ActiveBackgroundTask[];
}
export interface ProjectSession { id: string; title: string; createdAt: string; forkRunId?: string; teamEnabled?: boolean; archived?: boolean; pinned?: boolean; position?: number }
export interface Delivery { id: string; runId: string; files: (MessageAttachment & { label?: string })[] }
export interface TeamTask {
  id: string; title: string; detail: string; status: "pending" | "in_progress" | "done" | "deleted";
  revision: number; ownerId: string | null; ownerName?: string; dependencies: string[]; ready: boolean;
  writeScopes?: string[]; writeScopeWarnings?: string[];
}
export interface BatchMember { key: string; role: string; instruction: string; dependencies: string[]; execution?: ChildExecution }
export interface WorkspaceDelta {
  type: "delta"; projectId: string; after: number; cursor: number;
  project?: Project; artifacts?: Artifact[]; removedArtifacts?: string[]; messages?: Message[]; runs?: Run[];
  steps?: ExecutionStep[]; replies?: AssistantReply[]; removedReplies?: string[];
  stepCounts?: Record<string, number>; changesByRun?: Record<string, TurnFileChange[]>; chatQueue?: QueuedChat[];
  sessionId?: string; sessions?: ProjectSession[]; deliveries?: Delivery[];
  teamTasks?: TeamTask[]; activeBackgroundTasks?: ActiveBackgroundTask[];
}
export type HistoryPage = Pick<WorkspaceSnapshot, "messages" | "runs" | "replies" | "steps" | "stepCounts" | "changesByRun" | "historyBefore" | "deliveries">;
export interface HistoryMatch { id: string; role: Message["role"]; snippet: string; before?: number }
export interface SessionSearchMatch {
  projectId: string; projectTitle: string; sessionId: string; title: string; archived: boolean;
  projectArchived: boolean; message?: HistoryMatch;
}
export interface SessionTurnSummary { runId: string; id: string; before: number; prompt: string; reply: string }
export interface SessionActivity { runs: { id: string; label: string; kind: "turn" | "agent" | "job" }[]; schedules: { id: string; title: string }[]; pending: number }
export type WorkspaceFrame = WorkspaceDelta | { type: "snapshot"; snapshot: WorkspaceSnapshot };
export const DEFAULT_SETTINGS: ProviderSettings = {
  textBaseUrl: "https://api.deepseek.com/v1", textModel: "deepseek-flash", textApiKey: "", textThinking: false,
  arkBaseUrl: "https://ark.cn-beijing.volces.com/api/v3", arkApiKey: "",
  minimaxBaseUrl: "https://api.minimax.cn", minimaxApiKey: "", aiclubApiKey: "",
  busyEnter: "steer", webSearchEnabled: true, imageModel: IMAGE_MODELS[1], videoModel: AICLUB_VIDEO_MODELS[0],
};
export const STAGE_LABELS: Record<Stage, string> = {
  agent: "创作", maintenance: "整理上下文", media: "生成素材", writing: "编剧", reviewing: "审稿", revising: "改稿", directing: "分镜", frames: "关键帧", videos: "视频", composing: "合成", inspecting: "读取视频", done: "完成",
};
