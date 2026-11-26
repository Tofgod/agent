import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const studio = fileURLToPath(new URL("../", import.meta.url));
const reference = resolve(process.env.DSH_REFERENCE_DIR || resolve(studio, "../../deepseekh/deepseek-harness"));
const revision = (cwd) => {
  const result = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout.trim();
};
const run = (args, cwd, env) => {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 40_000, maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

const relativeEntry = "tests/harness-parity";
const referenceRevision = revision(reference);
assert.equal(referenceRevision, "e8f7b93a3449", "The execution fixtures target the reviewed Harness revision.");
const output = resolve(studio, ".studio-runtime/tests/harness-parity.mjs");
mkdirSync(resolve(studio, ".studio-runtime/tests"), { recursive: true });
await build({ entryPoints: [resolve(studio, relativeEntry, "studio.mts")], outfile: output,
  platform: "node", target: "node24", format: "esm", bundle: true, packages: "external" });
const base = run(["--import", "tsx", resolve(studio, relativeEntry, "reference.mts")], reference,
  { ...process.env, TSX_TSCONFIG_PATH: resolve(reference, "tsconfig.base.json") });
const current = run([output], studio, process.env);
let errors = 0;
assert.deepEqual(Object.keys(current.scenarios).sort(), Object.keys(base.scenarios).sort());
assert.deepEqual(current.retention, base.retention);
assert.deepEqual(current.compaction, base.compaction);
console.log(`✔ ${base.retention.length} ordered retention fixtures`);
console.log(`✔ ${base.compaction.length} compactable surface boundaries`);
for (const [name, expected] of Object.entries(base.scenarios)) {
  try { assert.deepEqual(current.scenarios[name], expected); console.log("✔", name); }
  catch (error) { console.error("✖", name, error.message); errors++; }
}
console.log(`Harness ${referenceRevision} · ${Object.keys(base.scenarios).length - errors}/${Object.keys(base.scenarios).length} native traces matched`);
if (errors) process.exitCode = 1;
