import type { Run } from "./types";

/** The lead's address is stable within the project's conversation. */
export const leadAgentId = "lead";
export const agentIdentity = (run: Pick<Run, "id" | "parentRunId">) => run.parentRunId ? run.id : leadAgentId;

export function joinMemberPath(parent: string | undefined, name: string | undefined) {
  return parent === undefined || !name ? undefined : parent ? parent + "/" + name : name;
}

// Names in storage are local to the creator. Derive addresses even for children from older lead turns.
export function memberAddresses(members: readonly Run[]) {
  const paths = new Map<string, string | undefined>();
  for (const member of members) {
    if (!member.parentRunId || member.background) continue;
    const parent = paths.has(member.parentRunId) ? paths.get(member.parentRunId) : "";
    paths.set(member.id, joinMemberPath(parent, member.payload.memberName));
  }
  return paths;
}
