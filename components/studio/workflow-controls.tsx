"use client";
import { useEffect, useState } from "react";
import { Check, Circle, ListTodo, MessageCircleQuestionMark, Target } from "lucide-react";
import type { Interaction, InteractionDecision, WorkflowView } from "@/lib/studio/workflow-types";
import { Modal } from "./modal";
import { pruneQuestionDrafts, QuestionComposer } from "./question-composer";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function WorkflowControls({ scope, value, readOnly, onCommand, onDecision, onHold, visibleQuestion, onShowQuestion, stopRun }: {
  scope: string; value: WorkflowView; readOnly: boolean;
  onCommand: (text: string) => void;
  onDecision: (id: string, decision: InteractionDecision) => Promise<void>;
  onHold: (id: string) => Promise<unknown>;
  visibleQuestion?: string;
  onShowQuestion: (id: string, show?: boolean) => void;
  stopRun?: { busy: boolean; stop: () => void };
}) {
  const [review, setReview] = useState<string | undefined>();
  const item = value.interactions.find(({ id }) => id === review);
  const { goal, todos } = value;
  useEffect(() => { pruneQuestionDrafts(scope, value.interactions); }, [scope, value.interactions]);
  return <>
    {goal && <div className="workflow-line">
      <Target size={14} aria-hidden="true"/>
      <span className="workflow-label" title={goal.objective}>{goal.objective}</span>
      <span>{goal.roundsStarted}/{goal.maxGoalRounds} 轮</span>
      {(goal.phase !== "active" || !goal.armed) && <span title={goal.blockedReason?.message}>
        {{ active: "待恢复", paused: "已暂停", blocked: "已阻塞", complete: "已完成" }[goal.phase]}
      </span>}
      {!readOnly && goal.phase !== "complete" && <button type="button" onClick={() => onCommand(goal.armed ? "/goal pause" : "/goal resume")}
        disabled={!goal.armed && goal.roundsStarted >= goal.maxGoalRounds}>{goal.armed ? "暂停" : "恢复"}</button>}
    </div>}
    {!!todos?.length && <details className="workflow-todos">
      <summary><ListTodo size={14} aria-hidden="true"/>个人待办 {todos.filter(({ status }) => status === "completed").length}/{todos.length}</summary>
      <ul>{todos.map(({ content, status }) => <li key={content} data-status={status}>
        {status === "completed" ? <Check size={13} aria-label="已完成"/> : <Circle size={12} aria-label={status === "in_progress" ? "进行中" : "待处理"}/>}
        <span>{content}</span>
      </li>)}</ul>
    </details>}
    {!readOnly && value.interactions.map((request) => request.kind === "question" ? <div key={request.id}>
      {visibleQuestion !== request.id && <div className="workflow-line workflow-question-summary">
        <MessageCircleQuestionMark size={14} aria-hidden="true"/>
        <span className="workflow-label" title={request.questions[0]?.question}>{request.questions[0]?.header || request.questions[0]?.question || "待回答问题"}</span>
        <button type="button" onClick={() => onShowQuestion(request.id)}>回答问题</button>
      </div>}
      <QuestionComposer scope={scope} item={request} hidden={visibleQuestion !== request.id} onHold={onHold}
        stopRun={stopRun}
        onClose={() => onShowQuestion(request.id, false)} onDecision={(decision) => onDecision(request.id, decision)}/>
    </div> : <div className="workflow-line" key={request.id}>
      <span className="workflow-label">{request.kind === "plan" ? "计划待评审" : "工具待审批"}</span>
      <button type="button" onClick={() => setReview(request.id)}>{request.kind === "plan" ? "查看计划" : "查看审批"}</button>
    </div>)}
    {item && !readOnly && <InteractionForm key={item.id} item={item} onClose={() => setReview(undefined)}
      onDecision={async (decision) => { await onDecision(item.id, decision); setReview(undefined); }}/>}
  </>;
}

function InteractionForm({ item, onClose, onDecision }: {
  item: Interaction; onClose: () => void; onDecision: (decision: InteractionDecision) => Promise<void>;
}) {
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const plan = item.kind === "plan", review = item.questions[0];
  async function submit(decision: InteractionDecision) {
    if (busy) return;
    setBusy(true); setError("");
    try { await onDecision(decision); }
    catch (error) { setError(error instanceof Error ? error.message : "提交失败"); setBusy(false); }
  }
  const answer = (choice: number) => submit({ action: "answer", answers: [{
    id: review.id, selected: [review.options![choice].label], ...(custom.trim() ? { custom: custom.trim() } : {}),
  }] });
  return <Modal title={plan ? "计划评审" : "工具审批"} wide busy={busy} onClose={onClose}>
    <div className="modal-scroll">
      <div className="form-fields workflow-form">
        {item.toolName && <p className="form-notice">{item.toolName}</p>}
        {item.plan && <article className="markdown-preview"><Markdown remarkPlugins={[remarkGfm]}>{item.plan}</Markdown></article>}
        <fieldset disabled={busy}>
          <legend>{review.question}</legend>
          {plan && <label>修改意见（可选）
            <textarea rows={2} value={custom} maxLength={16000} onChange={({ target }) => setCustom(target.value)}/>
          </label>}
        </fieldset>
        {error && <p className="extension-error" role="alert">{error}</p>}
      </div>
    </div>
    <div className="modal-footer">
      <button className="button" type="button" disabled={busy} onClick={() => void submit({ action: "dismiss" })}>改用聊天</button>
      <div className="toolbar-spacer"/>
      <button className="button" type="button" disabled={busy} onClick={() => void answer(1)}>{plan ? "继续规划" : "拒绝"}</button>
      <button className="button primary" type="button" disabled={busy} onClick={() => void answer(0)}>{plan ? "批准" : "允许一次"}</button>
    </div>
  </Modal>;
}
