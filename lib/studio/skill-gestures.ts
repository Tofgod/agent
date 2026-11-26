// Harness tool-skill recognizes whitespace-bounded gestures throughout direct input.
export function skillGestures(text: string) {
  return [...text.matchAll(/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g)].map((match) => ({
    name: match[2], start: match.index + match[1].length, end: match.index + match[0].length,
  }));
}

export function skillCompletion(text: string, caret: number) {
  const match = /(^|\s)\/([a-z0-9-]*)$/i.exec(text.slice(0, caret));
  if (!match) return undefined;
  const tail = /^[a-z0-9-]*(?=\s|$)/i.exec(text.slice(caret));
  if (!tail) return undefined;
  return { query: match[2].toLowerCase(), start: match.index + match[1].length, end: caret + tail[0].length };
}
