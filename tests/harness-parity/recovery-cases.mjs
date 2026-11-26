export const overflowCases = [
  { name: "overflow recovers with both pruning and summary", oldReceipt: true, summarySucceeds: true },
  { name: "summary failure preserves the original overflow", oldReceipt: false, summarySucceeds: false },
  { name: "durable pruning survives summary failure", oldReceipt: true, summarySucceeds: false },
  { name: "overflow can compact a single tool-heavy turn", oldReceipt: true, summarySucceeds: true, firstTurn: true },
];

export const earlierPrompt = "prior request";
export const earlierReply = "prior answer " + "ordinary history ".repeat(310);
export const currentPrompt = "inspect and continue";
export const shortenedHistory = "CHECKPOINT PROBE";
export const prunableReceipt = "OLD_DETAILS " + "history ".repeat(3300);
export const recentReceipt = "RECENT_DETAILS";
export const requestReplay = {
  first: "Keep the original creative direction across model request records.",
  answer: "Stored reply",
  second: "Read the earlier reply and continue with the same creative direction.",
};

export const referenceBudget = 65_600;
export const referencePageSize = 32;
export const referenceUpdate = "SOURCE-UPDATED-AFTER-CAPTURE";
const longFiller = "界😀".repeat(12_000);
export const longReferenceCases = [
  { name: "a long reference recovers whole omitted messages after the source changes", missing: "早期设定：主角不能说谎",
    turns: [["早期设定：主角不能说谎", longFiller], ["最近讨论", "当轮回复"]], dropped: 2 },
  { name: "a long reference recovers a shortened Unicode message exactly", missing: "被截断的中段设定",
    turns: [["请保存原样", "开头\r\n" + longFiller + "被截断的中段设定\t\"\\<\u0000" + longFiller + "\n结尾"]], dropped: 1 },
];

export function decodeReferenceTranscript(lines) {
  const messages = [];
  for (const line of lines) {
    const header = /^### Message \d+: (user|assistant)$/.exec(line);
    if (header) messages.push({ role: header[1], text: "" });
    else if (messages.length && line.startsWith('"')) messages.at(-1).text += JSON.parse(line);
  }
  return messages;
}

export const expectedReferenceMessages = ({ turns }) => turns.flatMap(([user, assistant]) => [
  { role: "user", text: user }, { role: "assistant", text: assistant },
]);

export const compactOutputTokens = 12_000;
export const compactHistory = [
  ["[OLD-REQUEST] Original premise", "[OLD-ANSWER] " + "a".repeat(75_000)],
  ["[MIDDLE-REQUEST] Develop motives", "[MIDDLE-ANSWER] " + "m".repeat(16_000)],
  ["[RECENT-REQUEST] Revise the ending", "[RECENT-ANSWER] " + "r".repeat(8_000)],
];
export const compactLatest = "[NEW-REQUEST] Continue from the last change";
export const compactMemo = "[SUMMARY-RESULT] Preserve the premise and current revision.";
export const compactRouteCases = [
  { name: "the wide route leaves the long history intact", start: "wide", final: "wide", retainTokens: 1500, state: "wide" },
  { name: "the tight route proactively preserves its absolute tail", start: "tight", final: "tight", retainTokens: 1500, state: "short" },
  { name: "switching uses the destination ratio and summarizes on the previous route", start: "wide", final: "tight", retainRatio: .10, state: "ratio" },
  { name: "a failed switch summary keeps the previous route and original history", start: "wide", final: "tight", retainTokens: 1500, state: "rejected" },
];

export function compactRoutes(scenario) {
  return {
    wide: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", contextWindow: 96_000,
      thresholdRatio: .5, headroomTokens: 6000, retainRatio: .16, maxTokens: 4096 },
    tight: { baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-flash", contextWindow: 64_000,
      thresholdRatio: .8, headroomTokens: 28_000, maxTokens: 2048,
      ...(scenario.retainTokens !== undefined ? { retainTokens: scenario.retainTokens } : { retainRatio: scenario.retainRatio }) },
  };
}

const compactMarkers = ["OLD-REQUEST", "OLD-ANSWER", "MIDDLE-REQUEST", "MIDDLE-ANSWER", "RECENT-REQUEST", "RECENT-ANSWER", "NEW-REQUEST", "SUMMARY-RESULT"];
export function compactMarkerTrace(text) { return compactMarkers.filter((marker) => text.includes("[" + marker + "]")); }

export const childPrompt = "first instruction";
export const firstDelta = "first half";
export const secondDelta = " second half";
export const childTool = "child tool";
export const peerMessage = "peer request";
export const peerReply = "peer received";

export const authorizationCases = [
  { name: "revoked tools are rejected before dispatch", enabled: true },
  { name: "newly enabled tools cannot enter an admitted step", enabled: false },
];

export const mixedArguments = [
  { id: "valid", arguments: '{"value":1}' },
  { id: "broken", arguments: "{" },
];

export const messagesHistory = { user: "start", callId: "past-call", tool: "probe", update: "additional direction", result: "tool reply" };

export const messagesFrames = [
  { type: "message_start", message: { id: "response", model: "deepseek-flash", usage: { input_tokens: 12, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "probe", name: "probe", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"value":' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '1}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];
export const messagesResponse = (frames = messagesFrames) => new Response(frames.map((frame) => "event: " + frame.type + "\ndata: " + JSON.stringify(frame) + "\n\n").join(""),
  { headers: { "content-type": "text/event-stream" } });

const nativeStart = messagesFrames[0];
const nativeEnd = (stop_reason) => [{ type: "message_delta", delta: { stop_reason }, usage: { output_tokens: 5 } }, { type: "message_stop" }];
const nativeBlock = (index, content_block, deltas = []) => [
  { type: "content_block_start", index, content_block },
  ...deltas.map((delta) => ({ type: "content_block_delta", index, delta })),
  { type: "content_block_stop", index },
];
export const nativeReply = (text = "Done", withUsage = true) => messagesResponse([
  withUsage ? nativeStart : { ...nativeStart, message: { ...nativeStart.message, usage: undefined } },
  ...nativeBlock(0, { type: "text", text }), ...nativeEnd("end_turn"),
]);
export const nativeAddedTool = () => messagesResponse([nativeStart,
  ...nativeBlock(0, { type: "tool_use", id: "new-tool-call", name: "native_b", input: {} }), ...nativeEnd("tool_use"),
]);
export const nativeToolCalls = (calls) => messagesResponse([nativeStart,
  ...calls.flatMap(({ id, name, args }, index) => nativeBlock(index, { type: "tool_use", id, name, input: args })),
  ...nativeEnd("tool_use")]);

export const childExecutionProbe = {
  folder: "01_创作/第01集",
  file: "notes.md",
  content: "第01集的独立工作目录",
  role: "writer",
  model: "deepseek-flash",
  provider: "messages",
  plain: "普通文本结果",
  output: { answer: 42 },
  invalid: { answer: "42" },
  schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false },
};
export const childExecutionCases = [
  { name: "a delegated route and working directory are independent and return validated data", output: "structured" },
  { name: "a child with an output schema fails when it only replies in text", output: "missing" },
  { name: "an ordinary child returns text without a structured output tool", output: "text" },
];
export const crossTurnProbe = {
  first: "Start a named collaborator and claim a shared task",
  second: "Continue the same conversation while the collaborator works",
  child: "Check the alternative scene",
  name: "reviewer",
  finding: "The alternative scene preserves the opening motive",
  task: { subject: "Review the opening", description: "Compare the two opening scenes" },
  cases: {
    message: "a previous turn's child can message the lead in the current turn",
    names: "the current turn can address the original child and rejects its duplicate name",
    owner: "the lead retains ownership of a shared task across turns",
  },
};
export const childNoticeProbe = {
  prompt: "Evaluate the continuity of the opening",
  finding: "The opening keeps the same motive",
  revision: "Recheck it against the new ending",
  finalRevision: "The new ending requires a different motive",
  structured: { accepted: true },
  schema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false },
  cases: [
    { name: "a final direct message leaves one copy of the child closing text", next: "none" },
    { name: "a tool dispatched after the direct message keeps the closing text", next: "tool" },
    { name: "an input claimed after the direct message keeps the new closing text", next: "input" },
    { name: "a child that reported directly still delivers its structured result", next: "structured" },
  ],
};
export const largeToolBatches = [
  { name: "25 legal Chat Completions streaming calls settle in order", transport: "chat-stream", size: 25 },
  { name: "32 legal Messages streaming calls settle in order", transport: "messages", size: 32 },
  { name: "25 legal Chat Completions JSON calls settle in order", transport: "chat-json", size: 25 },
];
export const largeBatchCalls = (size) => Array.from({ length: size }, (_, value) => ({
  id: "bulk-" + value, name: value === 12 ? "probe_write" : "probe_read", args: { value },
}));
export const nativeThinking = () => messagesResponse([nativeStart,
  ...nativeBlock(0, { type: "thinking", thinking: "思考", signature: "" }, [
    { type: "thinking_delta", thinking: "片段" }, { type: "signature_delta", signature: "sig-" }, { type: "signature_delta", signature: "probe" },
  ]),
  ...nativeBlock(1, { type: "text", text: "先读" }),
  ...nativeBlock(2, { type: "tool_use", id: "native-call", name: "native_a", input: { scene: 3 } }),
  ...nativeBlock(3, { type: "text", text: "再改" }),
  ...nativeEnd("tool_use"),
]);
export const nativeScenarios = ["First native turn", "Add tool and update prompt", "Keep the update", "Remove the original tool"];
export const nativeCapabilitiesFixture = (tool_update = "addition-only") => ({ data: [
  { id: "deepseek-flash", api_capabilities: { anthropic_messages: { system_prompt_update: "in-history", tool_update } } },
] });

export function nativeUpdateTrace(bodies) {
  return bodies.map((body) => {
    const inHistory = body.messages.flatMap((message, index) => message.role === "system" ? message.content.map((block) => ({
      kind: block.type, ...(block.tool ? { name: block.tool.name } : {}),
      after: body.messages.slice(0, index).findLast(({ role }) => role !== "system")?.role,
    })) : []);
    return { stable: body.system === bodies[0].system, inHistory, tools: body.tools.map(({ name, defer_loading }) => [name, defer_loading === true]) };
  });
}

export function nativeReplayTrace(bodies) {
  const [first, continued] = bodies;
  const assistant = continued.messages.find(({ role }) => role === "assistant");
  const receipt = continued.messages[continued.messages.indexOf(assistant) + 1];
  return { mode: first.thinking.type, blocks: assistant.content, toolReceipt: receipt.content[0].tool_use_id };
}

export function imageTransportFixture() {
  const trace = { uploads: 0, files: [] };
  return { trace, fetch: async (url, init) => {
    if (new URL(String(url)).pathname.endsWith("/files")) {
      trace.uploads++;
      return Response.json({ id: "file-probe", type: "file", mime_type: "image/png", filename: "image.png", size_bytes: 3, created_at: new Date().toISOString() });
    }
    const body = JSON.parse(init.body);
    trace.files.push(body.messages.flatMap(({ content }) => content).filter((part) => part.type === "image").map(({ source }) => source.file_id));
    return messagesResponse();
  } };
}

export const backgroundHistoryProbe = {
  label: "后台检查",
  output: ["画面通过", "字幕完成"],
  result: "完成标记-归档",
  largeOutput: Array.from({ length: 544 }, (_, index) => ("probe-" + String(index).padStart(4, "0")).padEnd(511, "x")),
  cases: [
    "background completion notice and job_output consume the same small result",
    "large completion notices leave the full result for job_output",
    "first job output reports a missing prefix and retains its tail",
    "archived background jobs keep a stable history of status and output",
  ],
};
export const delegationParityProbe = {
  names: ["a", "b"],
  leaf: "edit",
  route: { provider: "messages", model: "deepseek-flash" },
  parentEffort: "high",
  explicitEffort: "max",
  configuredEffort: "max",
  log: "delegated job output",
  limit: 10,
  cases: {
    reasoning: "delegation selects the same effective reasoning for omitted and explicit routes",
    names: "nested names belong to their creator and resolve from the conversation root",
    output: "only the job owner can read or wait for background output",
    capacity: "job capacity defaults to ten per owner and releases on settlement",
  },
};

export const innerFlowProbe = {
  wait: { case: "distinct input waits can report the same pending message without consuming it",
    message: "fresh input", calls: ["wait-first", "wait-second"], invalid: 9_999, timeout: 10_000 },
  tool: { case: "a missing media credential fails its own call and lets the next write settle",
    unavailable: "media-unavailable", write: "write-after-media", code: "MEDIA_NOT_CONFIGURED", text: "independent written draft" },
  control: { case: "ancestor interruption leaves deeper work running and the same child can continue",
    a: "interruptible", b: "peer", leaf: "deeper", resume: "continue this same collaborator", done: "continuation accepted" },
};

export async function probeJobCapacity(start, stop, finish, limit) {
  const active = await Promise.all(Array.from({ length: limit + 1 }, (_, i) => start("a", i).then(
    (id) => ({ id }), (error) => ({ error: error.code }),
  )));
  const other = await start("b", limit);
  const first = active.find(({ id }) => id).id;
  await stop(first);
  const stopping = await start("a", limit + 1).then(() => false, (error) => error.code);
  await finish(first);
  return { admitted: active.filter(({ id }) => id).length, refused: active.flatMap(({ error }) => error ? [error] : []),
    separateOwner: Boolean(other), stopping, freed: Boolean(await start("a", limit + 1)) };
}
