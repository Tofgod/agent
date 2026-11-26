import type { Artifact } from "./types";
import { AppError } from "./security";

export const TOOL_RESULT_BYTES = 32 * 1024;
export const serializedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** A cursor can continue inside a long line; byte accounting includes the complete JSON result. */
export function readWindow(file: Artifact, input: { offset: number; column: number; limit: number }, budget = TOOL_RESULT_BYTES) {
  const lines = file.content ? file.content.replace(/\r\n/g, "\n").split("\n") : [];
  if (input.offset > Math.max(1, lines.length)) throw new AppError("读取位置超出文件范围，共 " + lines.length + " 行", 400, "READ_OFFSET_RANGE");
  const base = { id: file.id, path: file.path, version: file.version, total_lines: lines.length, offset: input.offset, column: input.column };
  const result = { ...base, next_offset: lines.length ? input.offset as number | null : null, next_column: lines.length ? input.column as number | null : null, truncated: false, content: "" };
  for (let index = input.offset - 1; index < Math.min(lines.length, input.offset - 1 + input.limit); index++) {
    const characters = Array.from(lines[index]), start = index === input.offset - 1 ? input.column - 1 : 0;
    if (start > characters.length) throw new AppError("读取字符位置超出该行范围", 400, "READ_OFFSET_RANGE");
    const prefix = (result.content ? "\n" : "") + (index + 1) + ": " + (start ? "[从第" + (start + 1) + "个字符继续] " : "");
    const content = result.content + prefix + characters.slice(start).join("");
    const next = index + 1 < lines.length ? index + 2 : null;
    const full = { ...result, content, next_offset: next, next_column: next ? 1 : null, truncated: next !== null };
    if (serializedBytes(full) <= budget) { Object.assign(result, full); continue; }
    let low = 0, high = characters.length - start;
    const partial = (count: number) => ({ ...result, content: result.content + prefix + characters.slice(start, start + count).join(""), next_offset: index + 1, next_column: start + count + 1, truncated: true });
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (serializedBytes(partial(middle)) <= budget) low = middle; else high = middle - 1;
    }
    if (low) Object.assign(result, partial(low));
    else { result.next_offset = index + 1; result.next_column = start + 1; result.truncated = true; }
    return result;
  }
  result.truncated = result.next_offset !== null;
  return result;
}
