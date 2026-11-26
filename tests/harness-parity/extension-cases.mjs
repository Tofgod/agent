export const skillFiles = {
  ".dsh/skills/notes/SKILL.md": "---\nname: notes\ndescription: Project notes\nwhenToUse: Before a revision\nmetadata:\n  category: editing\nuser-invocable: false\n---\nProject body",
  ".agents/skills/notes.md": "---\nname: notes\ndescription: Lower priority\n---\nOther body",
  ".agents/skills/quiet.md": "---\nname: quiet\ndescription: Direct invitation only\ndisable-model-invocation: true\n---\nQuiet body",
};
export const skillRoot = "ba4ac009-7b43-4d9d-a708-039f78fede37";

export const mcpServer = "catalog";
export const mcpRawName = "lookup.entries";
const mixedImages = [
  { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWP4DwYMEAoAU7oL9W/sIDEAAAAASUVORK5CYII=" },
  { type: "image", mimeType: "image/png", data: "AQ" },
];
export const mcpScript = (modified = false, failList = false) => `
const read = require('node:readline').createInterface({input:process.stdin});
read.on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (${failList} && method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id, error: { code: -32601, message: 'fixture list failure' } }) + '\\n');
    return;
  }
  const first = { uri: 'fixture://notes', name: 'notes' };
  const second = { uri: 'fixture://later', name: 'later' };
  const result = ({
    initialize: () => ({ protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'fixture', version: '1' } }),
    'tools/list': () => ({ tools: [{ name: '${mcpRawName}', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ${JSON.stringify(modified ? [] : ["query"])} } }] }),
    'tools/call': () => ({ content: ${JSON.stringify(mixedImages)} }),
    'resources/list': () => params?.cursor === 'page-2' ? { resources: [second] } : { resources: [first], nextCursor: 'page-2' },
    'resources/templates/list': () => ({ resourceTemplates: [{ uriTemplate: 'fixture://{id}', name: 'template' }] }),
    'resources/read': () => ({ contents: [{ uri: params.uri, text: 'resource body' }] }),
  })[method]?.();
  process.stdout.write(JSON.stringify(result ? { jsonrpc:'2.0', id, result } :
    { jsonrpc:'2.0', id, error: { code: -32601, message: 'unknown' } }) + '\\n');
});`;

export const scheduleCases = [
  { name: "after", timing: { kind: "after", after_seconds: 180 }, start: "2030-01-03T09:00:00Z", delivered: "2030-01-03T09:20:00Z" },
  { name: "absolute in autumn overlap", timing: { kind: "at", at: { date: "2026-11-01", time: "01:30:00", time_zone: "America/New_York" } },
    start: "2026-10-30T00:00:00Z", delivered: "2026-11-02T15:00:00Z" },
  { name: "every with missed occurrences", timing: { kind: "every", every_seconds: 90 },
    start: "2030-01-03T09:00:00Z", delivered: "2030-01-03T09:20:00Z" },
  { name: "daily across DST gap", timing: { kind: "daily", daily: { time: "02:30:00", time_zone: "America/New_York" } },
    start: "2026-03-08T05:00:00Z", delivered: "2026-03-09T12:00:00Z" },
  { name: "weekly with multiple weekdays", timing: { kind: "weekly", weekly: { time: "09:30:00", time_zone: "Asia/Shanghai", weekdays: [5, 1, 3] } },
    start: "2030-01-01T00:00:00Z", delivered: "2030-01-07T02:00:00Z" },
  { name: "cron with missed occurrences", timing: { kind: "cron", cron: { expression: "0 9 * * 1-5", time_zone: "Asia/Shanghai" } },
    start: "2030-01-01T00:00:00Z", delivered: "2030-01-07T02:00:00Z" },
  { name: "rrule with a finite end", timing: { kind: "rrule", rrule: "DTSTART:20300103T090000Z\nRRULE:FREQ=DAILY;COUNT=2" },
    start: "2030-01-03T08:00:00Z", delivered: "2030-01-05T09:00:00Z" },
];
export const cutToolId = "fixture-cut";
export const cutPrompt = "An exact fork must keep this prompt.";
export const futureReply = "Do not inherit this later reply.";
export const resumePrompt = "Continue from the persisted tool receipt.";
export const traceNoise = 101;
export const settledReply = "A late response still settles its original row.";
export const scheduleTitle = "Before the edit";
export const scheduleTitleAfter = "After the edit";
export const schedulePrompt = "Check the related conversation.";
export const scheduleTimingFixture = { kind: "rrule", rrule: "DTSTART:20990101T000000Z\nRRULE:FREQ=DAILY;COUNT=1" };
export const hooksQuery = "Run the audit tools";
export const hookResult = "converted result";
export const streamOutput = Array.from({ length: 48 }, (_, i) => "part-" + (i + 1));
export const stderrOutput = "worker diagnostic";
export const outputTail = "tail-🧩";
export const oversizedOutput = "界".repeat(100_000) + outputTail;
export const skillGesture = "/shared-skill";
export const sharedSkillBody = "Use the matching resource only when needed.";
export const largeSkillBody = "x".repeat(132 * 1024);
export const normalizeSkillBlock = (content) => content.replace(/Base directory for this skill: [^\n]+/g, "Base directory for this skill: <fixture>");
export const mcpConcurrentRefresh = `
const input = require('node:readline').createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const changed = () => send({ method: 'notifications/tools/list_changed' });
const spec = name => ({ name, inputSchema: { type: 'object', properties: {} } });
let listCalls = 0, pending = 0, overlapped = false;
input.on('line', line => {
  const { method, id } = JSON.parse(line);
  if (id == null) return;
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fixture', version: '1' } } });
  } else if (method === 'tools/call') {
    send({ id, result: { content: [{ type: 'text', text: 'refresh' }] } });
    changed();
  } else if (method === 'tools/list') {
    const ordinal = ++listCalls;
    overlapped ||= ++pending > 1;
    if (ordinal === 2) setTimeout(changed, 30);
    const finish = () => {
      pending--;
      const name = ordinal === 1 ? 'initial' : ordinal === 2 ? 'middle' : 'latest';
      send({ id, result: { tools: [spec('poke'), spec(name), ...(overlapped ? [spec('overlapped')] : [])] } });
    };
    if (ordinal === 2) setTimeout(finish, 260); else finish();
  } else send({ id, error: { code: -32601, message: 'unsupported' } });
});`;

export const mcpAdmissionCases = ["same", "schema", "disconnect"];
export const mcpAdmissionServer = String.raw`
const input = require('node:readline').createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const spec = (name, properties = {}) => ({ name, inputSchema: { type: 'object', properties } });
let action = '';
input.on('line', line => {
  const { method, id, params } = JSON.parse(line);
  if (id == null) return;
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fixture', version: '1' } } });
  } else if (method === 'tools/list') {
    send({ id, result: { tools: [spec('poke'), spec('invoke', action === 'schema' ? { value: { type: 'number' } } : { value: { type: 'string' } }),
      ...(action ? [spec('witness')] : [])] } });
  } else if (method === 'tools/call' && params.name === 'poke') {
    action = params.arguments.action;
    send({ id, result: { content: [{ type: 'text', text: 'catalog update' }] } });
    if (action === 'disconnect') setTimeout(() => process.exit(0), 20);
    else send({ method: 'notifications/tools/list_changed' });
  } else if (method === 'tools/call') {
    send({ id, result: { content: [{ type: 'text', text: 'runner accepted admitted call' }] } });
  } else send({ id, error: { code: -32601, message: 'unsupported' } });
});`;
