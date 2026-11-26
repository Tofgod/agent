/** The same scripted model and synthetic tools run through both native loops. */
export const call = (id, name, args = {}) => ({ id, name, args });
const model = (text, calls) => ({ text, calls });
const repeat = Array.from({ length: 8 }, (_, index) =>
  model(null, [call("repeat-" + (index + 1), "zulu", { value: 1 })]));
export const cases = [
  { name: "single answer", responses: [model("done")] },
  { name: "canonical tool order", responses: [model("done")], order: true },
  { name: "multiple calls and an exclusive barrier", responses: [
    model("checking", [call("z", "zulu", { value: 1 }), call("a", "alpha", { value: 2 }),
      call("write", "exclusive"), call("again", "alpha", { value: 3 })]), model("done"),
  ], barrier: true },
  { name: "unknown tool is a recoverable receipt", responses: [
    model(null, [call("absent", "absent")]), model("recovered"),
  ] },
  { name: "tool timeout settles before the next model request", responses: [
    model(null, [call("late", "deadline")]), model("recovered"),
  ] },
  { name: "tool concludes after the rest of its batch", responses: [
    model("delivered", [call("finish", "conclude"), call("after", "alpha")]),
  ] },
  { name: "deferred tool context reaches the model after the whole batch", responses: [
    model(null, [call("notify", "note"), call("following", "alpha")]), model("noted"),
  ], deferred: true },
  { name: "next-step steering keeps the current stream", responses: [
    model("first answer"), model("answer to correction"),
  ], steer: true },
  { name: "waiting input is delivered after the wait receipt", responses: [
    model(null, [call("hold", "wait_agent")]), model("received"),
  ], wait: true },
  { name: "next-turn input owns a new turn", responses: [model("first turn"), model("second turn")], followup: true },
  { name: "transient provider failure retries the same step", responses: [{ failure: "SERVER" }, model("recovered")] },
  { name: "provider retry hint beyond the policy cap ends the turn", responses: [{ failure: "RATE_LIMIT", retryAfter: 120000 }] },
  { name: "provider output ceiling retains accepted text", responses: [{ text: "visible prefix", maxTokens: true }] },
  { name: "explicit cancellation drains and skips the remaining tools", responses: [
    model(null, [call("started", "blocking"), call("unused", "exclusive")]),
  ], cancel: true },
  { name: "cold recovery keeps a committed result and distinguishes unknown from unstarted", responses: [
    model("before crash", [call("committed", "exclusive"), call("lost", "blocking"), call("never", "exclusive")]),
  ], crash: true },
  { name: "fork includes a failed turn's committed work", responses: [
    model("before failure", [call("write", "exclusive", { value: 7 })]), { failure: "AUTH" },
  ], fork: true },
  { name: "fork includes existing receipts of a cancelled turn", responses: [
    model(null, [call("saved", "exclusive"), call("stopped", "blocking"), call("skipped", "exclusive")]),
  ], fork: true, cancel: true },
  { name: "repeat notices are admitted after the triggering receipt", responses: [
    ...repeat, model("done"),
  ], reminders: true },
];

export const tools = [
  { name: "zulu", parallel: true }, { name: "exclusive" }, { name: "alpha", parallel: true },
  { name: "deadline", timeoutMs: 20 }, { name: "conclude", concludes: true }, { name: "blocking" }, { name: "note", deferred: true },
];
export const boundaryTypes = ["turn/start", "step/start", "step/end", "turn/end"];
export const signalWait = (signal) => {
  signal.throwIfAborted();
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
};
export async function toolResult(definition, args, signal, onBlock) {
  if (definition.name === "blocking") {
    await onBlock();
    return signalWait(signal);
  }
  if (definition.name === "deadline") return signalWait(signal);
  return { value: args.value ?? 0 };
}

export function receiptCode(code) {
  switch (code) {
    case "TOOL_ABORTED_BEFORE_DISPATCH": return "TOOL_NOT_STARTED";
    case "ABORTED_BEFORE_DISPATCH": return "TOOL_NOT_STARTED";
    case "ABORTED": return "TOOL_ABORTED";
    case "OUTCOME_UNKNOWN": return "TOOL_OUTCOME_UNKNOWN";
    case "TOOL_NOT_FOUND": return "UNKNOWN_TOOL";
    default: return code;
  }
}

export const retentionCases = [
  { text: "0123456789".repeat(30), imagePrices: [], budget: 21 },
  { text: "前🙂中🌕末".repeat(20), imagePrices: [8, 2, 9], budget: 24 },
  { text: "short", imagePrices: [100, 2], budget: 10 },
  { text: "unicode🙂😀", imagePrices: [4, 3], budget: 1 },
];
export function retentionMatrix(retain) {
  return retentionCases.map(({ text, imagePrices, budget }) => {
    const images = imagePrices.map((bytes, index) => ({ type: "image", image: { id: String(index), bytes }, price: bytes }));
    return retain([{ type: "text", text }, ...images], budget,
      (block) => block.type === "image" ? block.price : Buffer.byteLength(block.text, "utf8"));
  });
}

// Pre-priced surface nodes. A cut can move toward the head to keep a batch intact.
export const compactionCases = [
  { nodes: [["user", 200], ["assistant", 40], ["user", 30]], retain: 30 },
  { nodes: [["user", 200], ["assistant", 50, ["x", "y"]], ["tool", 30, "x"], ["tool", 30, "y"], ["user", 20]], retain: 65 },
  { nodes: [["user", 30], ["assistant", 50, ["x"]], ["tool", 25, "x"]], retain: 100 },
  { nodes: [["user", 400], ["assistant", 50, ["x"]], ["tool", 100, "x"]], retain: 0 },
];
