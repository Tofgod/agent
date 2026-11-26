"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
export function Modal({ title, children, onClose, wide = false, compact = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; compact?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    const first = dialog.querySelector<HTMLElement>("[data-dialog-autofocus]");
    (first ?? (compact ? null : heading.current))?.focus({ preventScroll: true });
    return () => dialog.close();
  }, [compact]);
  return <dialog ref={ref} className={"modal" + (wide ? " modal-wide" : "") + (compact ? " modal-compact" : "")} aria-labelledby={headingId} onCancel={onClose}
    onClick={(e) => { if (e.target === ref.current) onClose(); }}>
    <div className="modal-title"><h2 ref={heading} id={headingId} tabIndex={-1}>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17}/></button></div>
    {children}
  </dialog>;
}
