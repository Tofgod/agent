import { structuredPatch } from "diff";
import type { FileDiffHunk } from "./types";

export function compareText(before: string, after: string) {
  const patch = structuredPatch("", "", before, after, undefined, undefined, { context: 3, timeout: 80, maxEditLength: 4000 });
  if (!patch) {
    const excerpt = (text: string, prefix: string) => text ? text.split("\n", 200).map((line) => prefix + line.slice(0, 400)) : [];
    return {
      hunks: [{ oldStart: 1, newStart: 1, lines: [...excerpt(before, "-"), ...excerpt(after, "+")] }],
      coarse: true, truncated: true,
    };
  }

  const hunks: FileDiffHunk[] = [];
  let rows = 0, characters = 0;
  for (const { oldStart, newStart, lines } of patch.hunks) {
    const hunk: FileDiffHunk = { oldStart, newStart, lines: [] };
    hunks.push(hunk);
    for (const line of lines) {
      const remaining = 120000 - characters;
      if (rows >= 3000 || remaining < line.length) {
        if (remaining >= 2 && rows < 3000) hunk.lines.push(line.slice(0, remaining - 1) + "…");
        return { hunks, coarse: false, truncated: true };
      }
      hunk.lines.push(line);
      rows++;
      characters += line.length;
    }
  }
  return { hunks, coarse: false, truncated: false };
}
