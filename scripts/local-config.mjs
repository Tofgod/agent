import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";

export function localConfig({ create = false } = {}) {
  let text = "";
  try { text = readFileSync(".env.local", "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const values = { ...parseEnv(text), ...process.env };
  let changed = false;
  for (const name of ["SETTINGS_ENCRYPTION_KEY", "LOCAL_WORKER_SECRET"]) {
    if (!values[name] && create) { values[name] = randomBytes(32).toString("hex"); text += "\n" + name + "=" + values[name] + "\n"; changed = true; }
  }
  if (changed) { writeFileSync(".env.local", text, { mode: 0o600 }); chmodSync(".env.local", 0o600); }
  if (!values.LOCAL_WORKER_SECRET || values.LOCAL_WORKER_SECRET.length < 48) throw new Error("缺少本地后台密钥，请使用 npm run dev 启动工作室");
  return { workerSecret: values.LOCAL_WORKER_SECRET, env: values };
}
