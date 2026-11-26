import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync, createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, link, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import type { Database, SqlStatement, SqlResult, BlobStore } from "../lib/studio/storage";
import { AppError } from "../lib/studio/security";
class Statement implements SqlStatement {
  constructor(private database: DatabaseSync, private query: string, private values: SQLInputValue[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.database, this.query, values as SQLInputValue[]); }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.database.prepare(this.query).get(...this.values);
    return (row ? column ? row[column] : row : null) as T | null;
  }
  async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return { success: true, results: this.rows<T>(), meta: { changes: 0 } };
  }
  rows<T = Record<string, unknown>>() { return this.database.prepare(this.query).all(...this.values) as T[]; }
  execute(): SqlResult {
    const result = this.database.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  async run() { return this.execute(); }
}
export class SQLiteDatabase implements Database {
  readonly connection: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    this.connection = new DatabaseSync(filename);
    this.connection.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  }
  prepare(query: string) { return new Statement(this.connection, query); }
  read<T>(projection: () => T): T {
    this.connection.exec("BEGIN");
    // The cursor and its rows share one SQLite view. Never yield inside it.
    try { const value = projection(); this.connection.exec("COMMIT"); return value; }
    catch (error) { this.connection.exec("ROLLBACK"); throw error; }
  }
  async batch(statements: SqlStatement[]) {
    this.connection.exec("BEGIN IMMEDIATE");
    // No await inside the transaction: other requests cannot interleave changes().
    try { const results = statements.map((statement) => (statement as Statement).execute()); this.connection.exec("COMMIT"); return results; }
    catch (error) { this.connection.exec("ROLLBACK"); throw error; }
  }
  initialize(migrations: string) {
    this.connection.exec("CREATE TABLE IF NOT EXISTS _studio_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const name of readdirSync(migrations).filter((s) => s.endsWith(".sql")).sort()) {
      const applied = this.connection.prepare("SELECT name FROM _studio_migrations WHERE name=?");
      if (applied.get(name)) continue;
      this.connection.exec("BEGIN IMMEDIATE");
      try {
        if (!applied.get(name)) {
          this.connection.exec(readFileSync(path.join(migrations, name), "utf8"));
          this.connection.prepare("INSERT INTO _studio_migrations VALUES(?,?)").run(name, new Date().toISOString());
        }
        this.connection.exec("COMMIT");
      }
      catch (error) { this.connection.exec("ROLLBACK"); throw error; }
    }
  }
  watchSchedules(onChange: () => void) {
    let queued = false, listening = true;
    const operations = ["INSERT", "UPDATE", "DELETE"] as const;
    // TEMP triggers also observe slot releases written by other SQLite triggers on this connection.
    // Refresh after the synchronous write or transaction finishes, never inside it.
    this.connection.function("studio_schedule_changed", () => {
      if (!queued) {
        queued = true;
        queueMicrotask(() => { queued = false; if (listening) onChange(); });
      }
      return null;
    });
    for (const operation of operations)
      this.connection.exec(`CREATE TEMP TRIGGER studio_schedule_watch_${operation} AFTER ${operation} ON main.studio_schedules
        BEGIN SELECT studio_schedule_changed(); END`);
    return () => {
      listening = false;
      for (const operation of operations) this.connection.exec(`DROP TRIGGER temp.studio_schedule_watch_${operation}`);
    };
  }
  releaseAbandonedLeases(options: { interruptAgentTurns?: boolean } = {}) {
    const owners = this.connection.prepare("SELECT DISTINCT lease_owner FROM runs WHERE lease_owner>0 AND lease_until>0").all();
    const interrupted = "status='running' AND agent_role<>'media' AND stage IN ('agent','maintenance')";
    const release = this.connection.prepare(`UPDATE runs SET lease_until=0,lease_token='',lease_owner=0${options.interruptAgentTurns ? `,
      status=CASE WHEN ${interrupted} THEN 'failed' ELSE status END,
      error_code=CASE WHEN ${interrupted} THEN 'SESSION_INTERRUPTED' ELSE error_code END,
      error=CASE WHEN ${interrupted} THEN '本地进程中断，正在恢复执行记录' ELSE error END,
      label=CASE WHEN ${interrupted} THEN '恢复执行记录' ELSE label END` : ""}
      WHERE lease_owner=? AND lease_until>0`);
    for (const { lease_owner } of owners) {
      if (typeof lease_owner !== "number" || !Number.isSafeInteger(lease_owner)) continue;
      try { process.kill(lease_owner, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") release.run(lease_owner);
      }
    }
  }
  close() { this.connection.close(); }
}
export class LocalMediaStore implements BlobStore {
  private readonly writes = new Map<string, Set<Promise<void>>>();
  constructor(private root: string, private database: SQLiteDatabase) {
    mkdirSync(root, { recursive: true });
    database.connection.exec("CREATE TABLE IF NOT EXISTS _studio_media(key TEXT PRIMARY KEY, content_type TEXT NOT NULL,size INTEGER NOT NULL,etag TEXT NOT NULL)");
  }
  private filename(key: string) {
    if (!key || key.length > 1000 || key.split("/").some((s) => !s || s === "." || s === "..") || /[\\\u0000-\u001f:]/.test(key)) throw new AppError("素材路径无效");
    const file = path.resolve(this.root, key);
    if (!file.startsWith(path.resolve(this.root) + path.sep)) throw new AppError("素材路径无效");
    return file;
  }
  async remove(key: string) {
    await rm(this.filename(key), { force: true });
    this.database.connection.prepare("DELETE FROM _studio_media WHERE key=?").run(key);
  }
  async removeProject(projectId: string) {
    await Promise.allSettled(this.writes.get(projectId) ?? []);
    if (!(await lstat(this.root)).isDirectory()) throw new AppError("素材目录无效");
    await rm(this.filename(projectId), { recursive: true, force: true });
    this.database.connection.prepare("DELETE FROM _studio_media WHERE key GLOB ?").run(projectId + "/*");
  }
  async put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string, options?: { httpMetadata?: { contentType?: string } }) {
    const projectId = key.split("/", 1)[0];
    const writes = this.writes.get(projectId) ?? new Set<Promise<void>>();
    this.writes.set(projectId, writes);
    const write = this.write(key, value, options?.httpMetadata?.contentType);
    writes.add(write);
    try { await write; }
    finally { writes.delete(write); if (!writes.size) this.writes.delete(projectId); }
  }
  private async write(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string, contentType?: string) {
    const filename = this.filename(key), temp = filename + "." + randomUUID() + ".tmp";
    await mkdir(path.dirname(filename), { recursive: true });
    const file = await open(temp, "wx", 0o600), hash = createHash("sha256"); let size = 0;
    const write = async (data: Uint8Array) => { size += data.byteLength; if (size > 300 * 1024 * 1024) throw new AppError("素材超过 300 MiB", 413); hash.update(data); await file.writeFile(data); };
    try {
      if (value instanceof ReadableStream) {
        const reader = value.getReader();
        try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; await write(chunk.value); } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } else await write(typeof value === "string" ? new TextEncoder().encode(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value));
      await file.sync(); await file.close();
      const etag = '"' + hash.digest("hex") + '"', old = this.database.connection.prepare("SELECT etag FROM _studio_media WHERE key=?").get(key);
      if (old) {
        if (old.etag !== etag) throw new AppError("此素材版本已存在，请保存为新版本", 409, "OBJECT_CONFLICT");
        await rm(temp, { force: true }); return;
      }
      try { await link(temp, filename); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(filename)) digest.update(chunk);
        if ('"' + digest.digest("hex") + '"' !== etag) throw new AppError("此素材版本已存在，请保存为新版本", 409, "OBJECT_CONFLICT");
      }
      this.database.connection.prepare("INSERT INTO _studio_media VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET content_type=excluded.content_type,size=excluded.size,etag=excluded.etag")
        .run(key, contentType || "application/octet-stream", size, etag);
      await rm(temp, { force: true });
    } catch (error) { await file.close().catch(() => {}); await rm(temp, { force: true }); throw error; }
  }
  async get(key: string, options?: { range: Headers }) {
    const filename = this.filename(key), metadata = this.database.connection.prepare("SELECT * FROM _studio_media WHERE key=?").get(key);
    if (!metadata) return null;
    const size = Number(metadata.size), contentType = String(metadata.content_type), etag = String(metadata.etag); let range: { offset: number; length: number } | undefined;
    const header = options?.range.get("range");
    if (header) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(header);
      if (!match || !size || !match[1] && !match[2]) throw new AppError("请求的素材范围无效", 416, "RANGE_NOT_SATISFIABLE");
      const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) throw new AppError("请求的素材范围无效", 416, "RANGE_NOT_SATISFIABLE");
      range = { offset: start, length: end - start + 1 };
    }
    return { size, contentType, etag, range,
      get body() { return size ? Readable.toWeb(createReadStream(filename, range ? { start: range.offset, end: range.offset + range.length - 1 } : undefined)) as ReadableStream<Uint8Array> : new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }); },
      writeHeaders(headers: Headers) { headers.set("Content-Type", contentType); },
      async arrayBuffer() { const bytes = await readFile(filename); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; } };
  }
}
