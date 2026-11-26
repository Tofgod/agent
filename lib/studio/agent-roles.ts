import { readFileSync } from "node:fs";
import { z } from "zod";
import type { AgentDefinition } from "./types";
import { childModel } from "./child-execution";

const role = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/).refine((id) => id !== "main" && id !== "media"),
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(500).optional(),
  textRoute: childModel.optional(),
}).strict();

export const builtinAgents: readonly AgentDefinition[] = [
  { id: "writer", name: "编剧" },
  { id: "director", name: "导演" },
];

export function loadAgentRoles(filename: string): readonly AgentDefinition[] {
  let value: string;
  try { value = readFileSync(filename, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return builtinAgents;
    throw error;
  }
  const entries = z.array(role).max(48).parse(JSON.parse(value));
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) throw new Error("agents.json 中有重复的角色 ID");
  const registry = new Map(builtinAgents.map((agent) => [agent.id, agent]));
  for (const agent of entries) registry.set(agent.id, agent);
  return [...registry.values()];
}
