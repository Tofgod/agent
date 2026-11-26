"use client";
import { useRef } from "react";

export function ResizeHandle({ label, edge, min, max, onResize }: {
  label: string; edge: "left" | "right"; min: number; max: () => number; onResize: (width: number) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const direction = edge === "left" ? -1 : 1;
  const resize = (width: number) => onResize(Math.round(Math.max(min, Math.min(max(), width))));
  return <div className={"resize-handle resize-" + edge} role="separator" aria-label={label} aria-orientation="vertical" tabIndex={0}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag.current = { x: event.clientX, width: event.currentTarget.parentElement!.getBoundingClientRect().width };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => { if (drag.current) resize(drag.current.width + direction * (event.clientX - drag.current.x)); }}
    onPointerUp={(event) => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { drag.current = null; }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const width = event.currentTarget.parentElement!.getBoundingClientRect().width;
      resize(event.key === "Home" ? min : event.key === "End" ? max() : width + (event.key === "ArrowLeft" ? -1 : 1) * direction * (event.shiftKey ? 50 : 20));
    }}><span/></div>;
}
