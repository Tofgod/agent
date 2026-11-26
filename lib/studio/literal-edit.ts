import { AppError } from "./security";

/** Match exact text, accepting LF input for a consistently CRLF file while preserving its line endings. */
export function literalEdit(content: string, oldText: string, newText: string, all: boolean): string {
  const crlf = content.includes("\r\n") && !/(?<!\r)\n/.test(content);
  const before = crlf ? oldText.replace(/\r?\n/g, "\r\n") : oldText;
  const after = crlf ? newText.replace(/\r?\n/g, "\r\n") : newText;
  if (!before || before === after) throw new AppError("替换前后的文字必须不同", 400, "EDIT_NO_CHANGE");
  const count = content.split(before).length - 1;
  if (!count || !all && count !== 1) throw new AppError("替换文字" + (!count ? "不存在" : "出现多次") + "，请重新读取并提供唯一片段", 409, "EDIT_MATCH_FAILED");
  return all ? content.replaceAll(before, after) : content.replace(before, after);
}
