import type { AgentMessage, AgentState, AgentToolCall, Run } from "./types";
import type { ToolOutcome } from "./tool-registry";
import type { SessionChange } from "./session-journal";

export interface ExecutionScope {
  projectId: string;
  sessionId: string;
  runId: string;
}
export const executionScope = (run: Run): ExecutionScope =>
  ({ projectId: run.projectId, sessionId: run.sessionId ?? "", runId: run.id });

type MaybePromise<T> = T | Promise<T>;
export interface ExecutionProjection {
  name: string;
  label: string;
  data?: Record<string, unknown>;
}
export interface ExecutionHooks {
  preStep?(input: ExecutionScope & { messages: readonly AgentMessage[]; signal: AbortSignal }):
    MaybePromise<{ kind: "accept"; messages?: AgentMessage[] } | { kind: "reject" } | void>;
  preTool?(input: ExecutionScope & { call: AgentToolCall; args: unknown; signal: AbortSignal }):
    MaybePromise<{ kind: "deny" | "cancel"; reason: string } | void>;
  postTool?(input: ExecutionScope & { call: AgentToolCall; outcome: Readonly<ToolOutcome>; signal: AbortSignal }):
    MaybePromise<ToolOutcome | void>;
  requestError?(input: ExecutionScope & { code: string; message: string; attempt: number; signal: AbortSignal }):
    MaybePromise<"retry" | "fail" | void>;
  project?(input: ExecutionScope & { kind: SessionChange; reference?: string; state: Readonly<AgentState> }):
    ExecutionProjection | void;
}
