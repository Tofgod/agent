import { context } from "esbuild";
import { spawn } from "node:child_process";
import { watchFile, unwatchFile } from "node:fs";
import { mkdir } from "node:fs/promises";
const [mode = "dev", ...args] = process.argv.slice(2);
if (!["dev", "start"].includes(mode)) throw new Error("Expected dev or start");
let filename = "dist/server/index.mjs", builder, child, closing = false, restarting = Promise.resolve();
if (mode === "dev") {
  filename = ".studio-runtime/server.mjs"; await mkdir(".studio-runtime", { recursive: true });
  builder = await context({ entryPoints: ["server/index.ts"], outfile: filename, bundle: true, platform: "node", target: "node24", format: "esm", packages: "external", tsconfig: "tsconfig.json" });
  await builder.rebuild(); await builder.watch();
}
function start() {
  const current = spawn(process.execPath, [filename, mode, ...args], { stdio: "inherit" }); child = current;
  current.once("exit", (code) => { if (child === current && !closing) { closing = true; unwatchFile(filename); void builder?.dispose(); process.exitCode = code || 0; } });
}
async function stopChild() {
  const current = child; child = undefined;
  if (!current || current.exitCode !== null || current.signalCode) return;
  await new Promise((resolve) => { const timeout = setTimeout(() => current.kill("SIGKILL"), 3000); current.once("exit", () => { clearTimeout(timeout); resolve(); }); current.kill("SIGTERM"); });
}
start();
if (mode === "dev") watchFile(filename, { interval: 200 }, (next, previous) => {
  if (closing || !next.mtimeMs || !next.size || next.mtimeMs === previous.mtimeMs) return;
  restarting = restarting.then(async () => { if (closing) return; await stopChild(); if (!closing) start(); });
});
async function stop() { if (closing) return; closing = true; unwatchFile(filename); await builder?.dispose(); await restarting; await stopChild(); }
process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
