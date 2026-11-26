export type DocumentDraft = { value: string; baseContent: string; baseVersion: number };
export const documentDraft = (content: string, version: number): DocumentDraft => ({ value: content, baseContent: content, baseVersion: version });
export function refreshDraft(draft: DocumentDraft, content: string, version: number): DocumentDraft {
  return draft.value === draft.baseContent && version > draft.baseVersion ? documentDraft(content, version) : draft;
}
