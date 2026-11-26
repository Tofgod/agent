"use client";
import { useMemo } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";

export function MarkdownEditor({ value, readOnly, onChange, onSave }: {
  value: string; readOnly: boolean; onChange: (value: string) => void; onSave: () => void;
}) {
  const extensions = useMemo(() => [markdown(), EditorView.lineWrapping, EditorView.contentAttributes.of({ "aria-label": "Markdown 文件内容", spellcheck: "false" })], []);
  return <div className="markdown-editor" onKeyDown={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); onSave(); }
  }}><CodeMirror className="markdown-editor-host" value={value} onChange={onChange} extensions={extensions} readOnly={readOnly} theme="light" height="100%"
    basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false, autocompletion: false, bracketMatching: false, highlightSelectionMatches: false }}/></div>;
}
