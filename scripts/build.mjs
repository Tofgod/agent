import { rm } from "node:fs/promises";
import { build } from "esbuild";
import { build as buildClient } from "vite";
await rm("dist", { recursive: true, force: true });
await buildClient();
await build({ entryPoints: ["server/index.ts"], outfile: "dist/server/index.mjs", bundle: true, platform: "node", target: "node24", format: "esm", packages: "external", tsconfig: "tsconfig.json" });
console.log("本地前端和 Node.js 后端构建完成。");
