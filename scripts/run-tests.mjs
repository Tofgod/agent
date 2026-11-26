import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
mkdirSync(".studio-runtime/tests", { recursive: true });
const entries = ["core", "runtime", "reference-features", "capabilities", "native-storage", "execution-history", "conversation", "prompt-context", "architecture", "agent-execution-parity", "extensions"];
await build({ entryPoints: entries.map((name) => "tests/" + name + ".test.ts"), outdir: ".studio-runtime/tests", outExtension: { ".js": ".mjs" }, platform: "node", target: "node24", format: "esm", bundle: true, packages: "external" });
const result = spawnSync(process.execPath, ["--test", ...entries.map((name) => ".studio-runtime/tests/" + name + ".test.mjs"), "tests/local-worker.test.mjs"], { stdio: "inherit" });
process.exit(result.status ?? 1);
