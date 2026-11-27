"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Pencil, Square, X } from "lucide-react";
import type { Interaction, InteractionDecision } from "@/lib/studio/workflow-types";

type Draft = { selected: string[]; custom: string; skipped: boolean };
type Progress = { index: number; drafts: Draft[]; takeTime?: boolean };
type StopRun = { busy: boolean; stop: () => void };
const blank = (): Draft => ({ selected: [], custom: "", skipped: false });
const answered = (draft: Draft) => draft.selected.length > 0 || Boolean(draft.custom.trim());
const recommendation = /\s*(?:\((?:推荐|recommended)\)|（(?:推荐|recommended)）)\s*$/i;
const storageKey = (scope: string) => "mujian.question-drafts." + scope;

function readDrafts(scope: string): Record<string, Progress> {
  try { return JSON.parse(localStorage.getItem(storageKey(scope)) || "{}") || {}; }
  catch { return {}; }
}

function saveDrafts(scope: string, drafts: Record<string, Progress>) {
  try {
    if (Object.keys(drafts).length) localStorage.setItem(storageKey(scope), JSON.stringify(drafts));
    else localStorage.removeItem(storageKey(scope));
  } catch {}
}

export function pruneQuestionDrafts(scope: string, items: readonly Interaction[]) {
  const stored = readDrafts(scope);
  const pending = new Set(items.filter(({ kind }) => kind === "question").map(({ id }) => id));
  const active = Object.entries(stored).filter(([key]) => pending.has(key));
  if (active.length !== Object.keys(stored).length) saveDrafts(scope, Object.fromEntries(active));
}

function initialProgress(scope: string, item: Interaction): Progress {
  const saved = readDrafts(scope)[item.id];
  if (Number.isInteger(saved?.index) && saved.index >= 0 && saved.index < item.questions.length &&
      Array.isArray(saved.drafts) && saved.drafts.length === item.questions.length &&
      saved.drafts.every((draft) => draft && Array.isArray(draft.selected) && draft.selected.every((label) => typeof label === "string") &&
        typeof draft.custom === "string" && typeof draft.skipped === "boolean")) return saved;
  return { index: 0, drafts: item.questions.map(({ options, multi_select }) => {
    const recommended = options?.filter(({ label }) => recommendation.test(label)).map(({ label }) => label) ?? [];
    return { ...blank(), selected: multi_select ? recommended : (options?.[0] && recommendation.test(options[0].label) ? [options[0].label] : []) };
  }) };
}

export function QuestionComposer({ scope, item, hidden, onHold, onClose, onDecision, stopRun }: {
  scope: string; item: Interaction; hidden: boolean; onHold: (id: string) => Promise<unknown>;
  onClose: () => void; onDecision: (decision: InteractionDecision) => Promise<void>; stopRun?: StopRun;
}) {
  const [progress, setProgress] = useState(() => initialProgress(scope, item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [minimized, setMinimized] = useState(false);
  const [focused, setFocused] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const content = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { index, drafts, takeTime } = progress;
  const question = item.questions[index];
  const draft = drafts[index];
  const last = index === item.questions.length - 1;
  const timed = item.state === "waiting" && Boolean(item.deadline);
  const holding = timed && !hidden && (takeTime || (!minimized && focused));
  useEffect(() => {
    if (!holding) return;
    const renew = () => { void onHold(item.id).catch(() => {}); };
    renew();
    const interval = setInterval(renew, 4000);
    return () => clearInterval(interval);
  }, [holding, item.id, onHold]);
  useEffect(() => {
    if (!timed || hidden) return;
    const interval = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(interval);
  }, [hidden, timed]);
  useEffect(() => { if (content.current) content.current.scrollTop = 0; }, [index]);

  function save(next: Progress) {
    setProgress(next);
    saveDrafts(scope, { ...readDrafts(scope), [item.id]: next });
  }
  function move(next: number) {
    save({ ...progress, index: next });
    setError("");
  }
  function update(next: Draft, page = index) {
    const values = drafts.map((value, position) => position === index ? next : value);
    save({ index: page, drafts: values, takeTime: true });
    setError("");
    return values;
  }
  function choose(label: string) {
    if (question.multi_select) {
      const selected = draft.selected.includes(label) ? draft.selected.filter((item) => item !== label) : [...draft.selected, label];
      update({ ...draft, selected, skipped: false });
    } else {
      update({ ...blank(), selected: [label] }, last ? index : index + 1);
    }
  }
  async function submit(values: Draft[]) {
    if (busy) return;
    const missing = values.findIndex((answer) => !answer.skipped && !answered(answer));
    if (missing >= 0) {
      save({ ...progress, index: missing, drafts: values });
      setError("请先回答或跳过这道题。");
      return;
    }
    setBusy(true); setError("");
    try {
      await onDecision({ action: "answer", answers: item.questions.map(({ id }, position) => {
        const answer = values[position];
        const custom = answer.custom.trim();
        return answer.skipped ? { id, selected: [] } : { id, selected: answer.selected, ...(custom ? { custom } : {}) };
      }) });
      const stored = readDrafts(scope);
      delete stored[item.id];
      saveDrafts(scope, stored);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "提交失败");
      setBusy(false);
    }
  }
  function proceed() {
    if (!answered(draft)) { setError("请先填写回答或跳过。"); return; }
    if (last) void submit(drafts);
    else move(index + 1);
  }
  function skip() {
    const values = update({ ...blank(), skipped: true }, last ? index : index + 1);
    if (last) void submit(values);
  }

  return <section className="workflow-question" hidden={hidden} aria-labelledby={titleId}>
    <header className="workflow-question-header">
      {minimized ? <span id={titleId} className="workflow-label">{question.question}</span> :
        question.header && <span>{question.header}</span>}
      <div className="toolbar-spacer"/>
      {item.state === "pending" ? <span>可补答</span> : timed && (takeTime ? <span>等待回答</span> :
        <><span>{Math.max(0, Math.ceil(((item.deadline ?? clock) - clock) / 1000))} 秒</span>
          <button type="button" className="workflow-question-link" onClick={() => save({ ...progress, takeTime: true })}>慢慢回答</button></>)}
      {stopRun && <button className="icon-button" type="button" aria-label="停止回复" title="停止回复" disabled={busy || stopRun.busy}
        onClick={stopRun.stop}><Square size={12} fill="currentColor" aria-hidden="true"/></button>}
      <button className="icon-button" type="button" aria-label={minimized ? "展开问题" : "折叠问题"}
        title={minimized ? "展开问题" : "折叠问题"} aria-expanded={!minimized} disabled={busy}
        onClick={() => { setMinimized(!minimized); setFocused(false); }}>
        {minimized ? <ChevronUp size={15}/> : <ChevronDown size={15}/>}
      </button>
      <button className="icon-button" type="button" aria-label="关闭问题" title="关闭问题" disabled={busy}
        onClick={() => { setFocused(false); onClose(); }}><X size={15}/></button>
    </header>
    {!minimized && <>
      <div className="workflow-question-scroll" ref={content}
        onFocus={() => setFocused(true)}
        onBlur={({ currentTarget, relatedTarget }) => { if (!currentTarget.contains(relatedTarget)) setFocused(false); }}>
        <h2 id={titleId}>{question.question}</h2>
        <div className="workflow-question-options" role={question.multi_select ? "group" : "radiogroup"} aria-labelledby={titleId}>
          {question.options?.map(({ label, description }, position) => {
            const checked = draft.selected.includes(label);
            const recommended = recommendation.test(label);
            const descriptionId = titleId + "-option-" + position;
            return <button key={label} type="button" className="workflow-question-option" role={question.multi_select ? "checkbox" : "radio"}
              aria-checked={checked} aria-label={label.replace(recommendation, "")} aria-describedby={description ? descriptionId : undefined}
              disabled={busy} onClick={() => choose(label)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(drafts); } }}>
              <span className="workflow-question-mark" data-checkbox={question.multi_select || undefined} aria-hidden="true">
                {checked ? <Check size={12}/> : question.multi_select ? null : position + 1}</span>
              <span>{label.replace(recommendation, "")}{recommended && <small className="workflow-question-recommended">推荐</small>}
                {description && <small id={descriptionId}>{description}</small>}</span>
            </button>;
          })}
        </div>
        <label className="workflow-question-custom">
          {Boolean(question.options?.length) && <Pencil size={13} aria-hidden="true"/>}
          <textarea className="workflow-question-text" key={question.id} aria-label="自定义回答" placeholder="输入自定义回答"
            rows={1} maxLength={16000} disabled={busy} value={draft.custom}
            onChange={({ target }) => update({ selected: question.multi_select ? draft.selected : [], custom: target.value, skipped: false })}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault(); proceed();
            }}/>
        </label>
      </div>
      <footer className="workflow-question-footer">
        {item.questions.length > 1 && <div className="workflow-question-pager" aria-label="问题分页">
          <button type="button" className="icon-button" aria-label="上一题" disabled={busy || index === 0}
            onClick={() => move(index - 1)}><ChevronLeft size={16}/></button>
          <span>{index + 1} / {item.questions.length}</span>
          <button type="button" className="icon-button" aria-label="下一题" disabled={busy || last}
            onClick={() => move(index + 1)}><ChevronRight size={16}/></button>
        </div>}
        <div className="toolbar-spacer"/>
        <button type="button" className="button" disabled={busy} onClick={skip}>跳过</button>
        <button type="button" className="button primary" disabled={busy || !answered(draft)}
          onClick={proceed}>{busy ? "提交中" : last ? "提交回答" : "继续"}</button>
      </footer>
      {error && <p className="workflow-question-error" role="alert">{error}</p>}
    </>}
  </section>;
}
