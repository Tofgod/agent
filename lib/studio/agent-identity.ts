import type { Run } from "./types";

/** The lead's address is stable within the project's conversation. */
export const leadAgentId = "lead";
export const agentIdentity = (run: Pick<Run, "id" | "parentRunId">) => run.parentRunId ? run.id : leadAgentId;
