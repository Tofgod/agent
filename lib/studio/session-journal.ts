import type { AgentMessage, AgentState } from "./types";

export type SessionChange = "checkpoint" | "model/request" | "model/accepted" | "context/pruned" | "context/compacted" | "context/unchanged" | "tools/settled" | "inbox/claimed" | "tasks/waiting";
type Fields = Omit<AgentState, "messages">;
export interface SessionPatch {
  fields?: Partial<Fields>;
  unset?: (keyof Fields)[];
  messages?: { start: number; remove: number; insert: AgentMessage[] };
}
export interface SessionEntry {
  revision: number;
  kind: SessionChange;
  reference: string | null;
  patch: SessionPatch;
}

const same = (left: unknown, right: unknown) => left === right || JSON.stringify(left) === JSON.stringify(right);

export function sessionPatch(previous: AgentState | undefined, next: AgentState): SessionPatch | undefined {
  const { messages, ...fields } = next;
  if (!previous) return { fields, messages: { start: 0, remove: 0, insert: messages } };
  const before = previous.messages;
  let start = 0, tail = 0;
  while (start < Math.min(before.length, messages.length) && same(before[start], messages[start])) start++;
  while (tail < Math.min(before.length, messages.length) - start &&
    same(before[before.length - tail - 1], messages[messages.length - tail - 1])) tail++;
  const insertEnd = messages.length - tail;
  const changed = Object.entries(fields).filter(([key, value]) => value !== undefined && !same(previous[key as keyof Fields], value));
  const unset = (Object.keys(previous) as (keyof AgentState)[]).filter((key): key is keyof Fields =>
    key !== "messages" && previous[key] !== undefined && fields[key] === undefined);
  const patch: SessionPatch = {};
  if (changed.length) patch.fields = Object.fromEntries(changed);
  if (unset.length) patch.unset = unset;
  if (start < before.length - tail || start < insertEnd)
    patch.messages = { start, remove: before.length - tail - start, insert: messages.slice(start, insertEnd) };
  return Object.keys(patch).length ? patch : undefined;
}

export function replaySession(entries: readonly SessionEntry[], previous?: { state: AgentState; revision: number }): AgentState | undefined {
  if (!entries.length) return previous ? structuredClone(previous.state) : undefined;
  const state: AgentState = previous ? structuredClone(previous.state) :
    { messages: [], seenUserIds: [], step: 0, toolIndex: 0, artifactIds: [] };
  for (const [index, { revision, patch }] of entries.entries()) {
    const expected = (previous?.revision ?? 0) + index + 1;
    if (revision !== expected) throw new Error("会话日志缺少检查点 " + expected);
    Object.assign(state, patch.fields);
    for (const key of patch.unset ?? []) delete (state as Partial<AgentState>)[key];
    if (patch.messages) {
      const { start, remove, insert } = patch.messages;
      if (start > state.messages.length || start + remove > state.messages.length) throw new Error("会话消息变更超出范围");
      if (start === state.messages.length) {
        for (const message of insert) state.messages.push(message);
      } else {
        state.messages = state.messages.slice(0, start).concat(insert, state.messages.slice(start + remove));
      }
    }
  }
  return state;
}
