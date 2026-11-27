// Both adapters receive these exact model calls, user inputs, and decisions.
export const workflowCases = {
  goal: { name: "Goal round admission, cap, lower cap and editing a completed goal", objective: "verify the delivery", rounds: 2 },
  goalTruncated: { name: "Goal stops after a truncated model reply", objective: "check the delivery", rounds: 4 },
  todos: {
    name: "Personal todos replace the whole list and clear at the next started turn",
    input: "check the plan", next: "check the output",
    lists: [
      [{ content: "  plan  ", status: "in_progress" }],
      [{ content: "plan", status: "completed" }, { content: "assemble", status: "in_progress" }],
    ],
  },
  question: {
    name: "Questions return multi-select labels, custom text, and an explicit skip",
    input: "ask for direction", answers: [{ id: "look", selected: ["Ink", "Luminous"], custom: "keep the background simple" }, { id: "note", selected: [] }],
    questions: [{ id: "look", header: "Look", question: "Which treatments?", options: [{ label: "Ink" }, { label: "Luminous" }], multi_select: true },
      { id: "note", question: "Additional notes?" }],
  },
  timed: { name: "Timed questions keep their later answer in the next user step", input: "ask and keep working", timeout: 1 },
  longWait: { name: "Timed questions accept waits above one day", timeout: 86401 },
  planQueued: { name: "Selecting plan mode before a queued turn starts commits immediately", input: "waiting to start" },
  dismiss: { name: "Dismissing plan review sends the immediate follow-up into the next turn", next: "use this revised direction" },
  plan: { name: "Plan approval with feedback stays in plan mode; plain approval exits", input: "plan the delivery",
    markdown: "# Delivery\n\n- Confirm the inputs\n- Verify the result", feedback: "add a time estimate" },
  approval: { name: "Approval policy changes apply to future calls and leave the in-flight decision intact", input: "run two protected operations", reason: "Authorize exactly this operation?" },
};
export const textReply = (text = "done", maxTokens = false) => ({ text, maxTokens });
export const toolReply = (id, name, args) => ({ text: null, calls: [{ id, name, args }] });
export const questionCall = (extra = {}) => toolReply("question", "ask_user_question", { questions: workflowCases.question.questions, ...extra });
export const todoCall = (index) => toolReply("todo-" + index, "todo_write", { todos: workflowCases.todos.lists[index] });
export const planCall = (index) => toolReply("plan-" + index, "exit_plan_mode", { plan: workflowCases.plan.markdown });
export const approvalCall = (index) => toolReply("approval-" + index, "approval_probe", {});
