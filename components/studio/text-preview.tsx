"use client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Artifact } from "@/lib/studio/types";
import { linkedArtifact } from "@/lib/studio/file-links";
export function TextPreview({ text, sourcePath, artifacts, onOpen }: { text: string; sourcePath: string; artifacts: Artifact[]; onOpen: (id: string) => void }) {
  return <article className="markdown-preview"><Markdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => {
      const artifact = linkedArtifact(artifacts, sourcePath, href);
      if (artifact?.url && ["video", "final"].includes(artifact.kind)) return <video src={artifact.url} controls playsInline preload="metadata"/>;
      if (artifact) return <button className="document-link" onClick={() => onOpen(artifact.id)}>{children}</button>;
      return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
    },
    img: ({ src, alt }) => {
      const artifact = linkedArtifact(artifacts, sourcePath, typeof src === "string" ? src : undefined);
      return <img src={artifact?.url || src} alt={alt || ""} onClick={artifact ? () => onOpen(artifact.id) : undefined}/>;
    },
  }}>{text}</Markdown></article>;
}
