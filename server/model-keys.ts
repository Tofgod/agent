import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "../lib/studio/security";
import type { Database } from "../lib/studio/storage";
import { SQLiteDatabase } from "./storage";

function* runtimeDatabases(directory: string): Generator<string> {
  try {
    if (!lstatSync(directory).isDirectory()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "browser") yield* runtimeDatabases(filename);
    else if (entry.isFile() && entry.name.endsWith(".sqlite")) yield filename;
  }
}

function isStudioDatabase(db: DatabaseSync) {
  // The old runtime directories also contain SQLite databases belonging to other services.
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('projects','runs','settings')").all();
  if (tables.length !== 3) return false;
  const columns = new Set(db.prepare("PRAGMA table_info(settings)").all().map(({ name }) => name));
  return ["user_id", "config", "secrets", "updated_at"].every((name) => columns.has(name));
}

function purge(db: DatabaseSync, timestamp: string) {
  db.prepare("UPDATE settings SET secrets='', updated_at=? WHERE secrets<>''").run(timestamp);
  // Rewrite old pages left by previous settings saves, then remove the corresponding WAL frames.
  db.exec("VACUUM");
  const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (checkpoint?.busy !== 0) throw new Error("SQLite checkpoint incomplete");
}

export function clearLocalModelKeys(database: Database, userId: string, root = process.cwd()) {
  if (!(database instanceof SQLiteDatabase)) throw new AppError("本地数据库未就绪", 503, "KEY_CLEANUP_UNAVAILABLE");
  const active = database.connection;
  const location = active.location();
  const timestamp = new Date().toISOString();
  try {
    const activeFile = location ? realpathSync(location) : null;
    for (const directory of [".wrangler", ".sites-runtime", ".studio-runtime"]) {
      for (const filename of runtimeDatabases(path.join(root, directory))) {
        if (activeFile && realpathSync(filename) === activeFile) continue;
        const cached = new DatabaseSync(filename);
        try {
          if (isStudioDatabase(cached)) purge(cached, timestamp);
        } finally {
          cached.close();
        }
      }
    }
    // An empty row also invalidates a first save that read the settings before this clear.
    active.prepare("INSERT OR IGNORE INTO settings(user_id,config,secrets,updated_at) VALUES (?,'{}','',?)").run(userId, timestamp);
    purge(active, timestamp);
  } catch {
    throw new AppError("未能彻底清理模型密钥。请确认磁盘空间充足，关闭正在使用这些数据库的其他程序后重试。", 503, "KEY_CLEANUP_INCOMPLETE");
  }
}
