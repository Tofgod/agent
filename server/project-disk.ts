import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, watch, type FSWatcher } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { promisify } from "node:util";
import { PROJECT_FOLDERS, projectOutputPath } from "../lib/studio/project-layout";
import { AppError, safeError } from "../lib/studio/security";
import { uid, type Store } from "../lib/studio/store";
import type { BlobStore } from "../lib/studio/storage";
import type { Artifact } from "../lib/studio/types";

const fileTypes: Record<string, string> = {
  ".md": "text/markdown", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
};
type Entry = { name: string; stamp: string; inode: string; size: number };
type Known = { path: string; artifact_id: string; version: number; stamp: string };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const noLinks = constants.O_NOFOLLOW ?? 0;
const exec = promisify(execFile);

async function entry(name: string): Promise<Entry | undefined> {
  const info = await lstat(name, { bigint: true }).catch((error) => { if (!missing(error)) throw error; });
  if (!info?.isFile()) return undefined;
  const inode = info.dev + ":" + info.ino;
  return { name, inode, size: Number(info.size), stamp: inode + ":" + info.mtimeNs + ":" + info.size };
}

async function directory(name: string) {
  await mkdir(name, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  if (!(await lstat(name)).isDirectory()) throw new AppError("工作目录包含链接或非目录项目", 409, "WORKSPACE_PATH");
}

/** Each workspace is owned by one local project. Files on disk are editable copies of versioned artifacts. */
export class ProjectDisk {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private interval?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private root: string, private store: Store, private media: BlobStore, private userId: string,
    private report: (error: unknown) => void = (error) => console.error("[项目目录]", safeError(error))) {}

  start() {
    const poll = () => {
      for (const { project_id } of this.store.db.prepare("SELECT project_id FROM disk_workspaces JOIN projects ON projects.id=project_id WHERE status<>'archived'").rows<{project_id: string}>())
        this.schedule(project_id);
    };
    poll();
    this.interval = setInterval(poll, 3000);
  }

  async close() {
    this.closed = true;
    clearInterval(this.interval);
    for (const watcher of this.watchers.values()) watcher.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    await Promise.allSettled(this.pending.values());
  }

  async activate(projectId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new AppError("项目目录无效", 400);
    await this.store.project(projectId, this.userId);
    await this.store.db.prepare("INSERT OR IGNORE INTO disk_workspaces(project_id) VALUES(?)").bind(projectId).run();
    await this.sync(projectId);
    return path.join(this.root, projectId);
  }

  async reveal(projectId: string) {
    const location = await this.activate(projectId);
    if (process.platform === "win32") await exec("explorer.exe", [location]).catch((error) => { if (error.code !== 1) throw error; });
    else await exec(process.platform === "darwin" ? "/usr/bin/open" : "xdg-open", [location]);
  }

  async removeProject(projectId: string) {
    clearTimeout(this.timers.get(projectId));
    this.timers.delete(projectId);
    await this.pending.get(projectId)?.catch(this.report);
    this.watchers.get(projectId)?.close();
    this.watchers.delete(projectId);
    const parent = await lstat(this.root).catch((error) => { if (!missing(error)) throw error; });
    if (!parent) return;
    if (!parent.isDirectory()) throw new AppError("工作目录包含链接或非目录项目", 409, "WORKSPACE_PATH");
    await rm(path.join(this.root, projectId), { recursive: true, force: true });
  }

  private schedule(projectId: string) {
    if (this.closed || this.timers.has(projectId)) return;
    this.timers.set(projectId, setTimeout(() => {
      this.timers.delete(projectId);
      void this.sync(projectId).catch(this.report);
    }, 180));
  }

  sync(projectId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const running = this.pending.get(projectId);
    if (running) return running;
    const promise = this.reconcile(projectId).finally(() => this.pending.delete(projectId));
    this.pending.set(projectId, promise);
    return promise;
  }

  private async reconcile(projectId: string) {
    const project = await this.store.project(projectId, this.userId);
    if (project.status === "archived") throw new AppError("请先恢复项目", 409);
    const root = path.join(this.root, projectId);
    await directory(this.root);
    const existing = await lstat(root).catch((error) => { if (!missing(error)) throw error; });
    await directory(root);
    for (const folder of PROJECT_FOLDERS) {
      const name = path.join(root, folder.path.slice(1));
      try { await directory(name); } catch (error) { if (!(error instanceof AppError)) throw error; }
    }
    if (!this.closed && !this.watchers.has(projectId)) {
      try {
        const watcher = watch(root, { recursive: true, persistent: false }, () => this.schedule(projectId));
        watcher.on("error", () => { watcher.close(); this.watchers.delete(projectId); });
        this.watchers.set(projectId, watcher);
      } catch { /* The reconciliation timer also covers filesystems without recursive watch. */ }
    }
    const db = this.store.db;
    if (!existing) await db.prepare("DELETE FROM disk_workspace_files WHERE project_id=?").bind(projectId).run();
    const known = new Map(db.prepare("SELECT path,artifact_id,version,stamp FROM disk_workspace_files WHERE project_id=?")
      .bind(projectId).rows<Known>().map((row) => [row.path, row]));
    const disk = new Map<string, Entry>();
    const occupied = new Set<string>(), blocked = new Set<string>();
    const scan = async (folder: string, prefix: string): Promise<void> => {
      for (const child of await readdir(folder, { withFileTypes: true }).catch((error) => { if (!missing(error)) throw error; return []; })) {
        if (child.name === ".DS_Store" || child.name === ".do漫回收站" || child.name.startsWith(".do漫-")) continue;
        const key = prefix + "/" + child.name.normalize("NFC"), name = path.join(folder, child.name);
        occupied.add(key);
        if (child.isDirectory()) await scan(name, key);
        else if (child.isSymbolicLink()) blocked.add(key);
        else if (child.isFile() && fileTypes[path.extname(key).toLowerCase()]) {
          const candidate = await entry(name);
          if (candidate) disk.set(key, candidate);
        }
      }
    };
    for (const folder of PROJECT_FOLDERS) {
      const name = path.join(root, folder.path.slice(1));
      if ((await lstat(name).catch(() => undefined))?.isDirectory()) await scan(name, folder.path);
      else blocked.add(folder.path);
    }
    const current = new Map((await this.store.artifacts(projectId)).map((file) => [file.path, file]));
    const remember = async (key: string, file: Artifact, stamp: string) => {
      await db.prepare(`INSERT INTO disk_workspace_files(project_id,path,artifact_id,version,stamp) VALUES(?,?,?,?,?)
        ON CONFLICT(project_id,path) DO UPDATE SET artifact_id=excluded.artifact_id,version=excluded.version,stamp=excluded.stamp`)
        .bind(projectId, key, file.id, file.version, stamp).run();
    };
    const forget = (key: string) => db.prepare("DELETE FROM disk_workspace_files WHERE project_id=? AND path=?").bind(projectId, key).run();
    const owned = (previous: Known, file?: Artifact) => file?.id === previous.artifact_id && file.version === previous.version;

    // A rename in Finder keeps the inode. Keep the artifact ID so old message links still resolve.
    const newNames = new Map([...disk].filter(([key]) => !known.has(key) && !current.has(key)).map(([key, value]) => [value.inode, key]));
    for (const [key, previous] of known) {
      const destination = newNames.get(previous.stamp.split(":").slice(0, 2).join(":")), file = current.get(key);
      if (!destination || [...blocked].some((prefix) => key === prefix || key.startsWith(prefix + "/")) || occupied.has(key) || !file || !owned(previous, file)) continue;
      if (file.locked || file.status === "generating" || path.extname(destination).toLowerCase() !== path.extname(key).toLowerCase()) continue;
      const moved = await this.store.changeProjectFile(projectId, file, destination);
      await remember(destination, moved, previous.stamp);
      await forget(key);
      known.delete(key); known.set(destination, { ...previous, path: destination, version: moved.version });
      current.delete(key); current.set(destination, moved);
      newNames.delete(disk.get(destination)!.inode);
    }

    for (const key of new Set([...known.keys(), ...current.keys(), ...disk.keys()])) {
      try {
        if (projectOutputPath(key) !== key || (!disk.has(key) && occupied.has(key)) ||
            [...blocked].some((prefix) => key === prefix || key.startsWith(prefix + "/"))) continue;
        const previous = known.get(key), file = current.get(key), local = disk.get(key);
        if (!file && !local) { if (previous) await forget(key); continue; }
        if (file?.status !== undefined && file.status !== "ready") continue;
        const diskChanged = local?.stamp !== previous?.stamp;
        const appChanged = previous ? !owned(previous, file) : Boolean(file);
        if (local && diskChanged && (!file?.locked && !appChanged)) {
          const saved = await this.importFile(projectId, key, local, file);
          await remember(key, saved, local.stamp);
        } else if (!local && previous && file && !appChanged && !file.locked) {
          await this.store.changeProjectFile(projectId, file);
          await forget(key);
        } else if (appChanged || diskChanged) {
          if (file && local && diskChanged && await this.matches(file, local)) {
            await remember(key, file, local.stamp);
            continue;
          }
          if (local && diskChanged) {
            const ext = path.extname(key);
            let conflict: string;
            do { conflict = key.slice(0, -ext.length) + " (本地副本 " + uid().slice(0, 8) + ")" + ext; }
            while (current.has(conflict) || occupied.has(conflict));
            await this.importFile(projectId, conflict, local);
          }
          if (file) {
            const stamp = await this.publish(root, file, local);
            if (stamp) await remember(key, file, stamp);
          } else if (local && (await entry(local.name))?.stamp === local.stamp) {
            await rm(local.name);
            await forget(key);
          }
        }
      } catch (error) {
        if (error instanceof AppError && ["INVALID_PATH", "PROJECT_DIRECTORY_REQUIRED", "VERSION_CONFLICT"].includes(error.code)) continue;
        if (!missing(error)) this.report(error);
      }
    }
  }

  private async importFile(projectId: string, key: string, local: Entry, file?: Artifact) {
    const type = fileTypes[path.extname(key).toLowerCase()];
    const input = await open(local.name, constants.O_RDONLY | noLinks);
    const objectKey = projectId + "/native/" + uid();
    let uploaded = false, saved = false;
    try {
      const state = await input.stat({ bigint: true });
      if (!state.isFile() || state.dev + ":" + state.ino + ":" + state.mtimeNs + ":" + state.size !== local.stamp)
        throw new AppError("文件正在更新", 409, "VERSION_CONFLICT");
      const markdown = type === "text/markdown";
      if (local.size > (markdown ? 2 * 1024 * 1024 : 300 * 1024 * 1024)) throw new AppError("本机文件超过大小限制", 413);
      const content = markdown ? new TextDecoder("utf-8", { fatal: true }).decode(await input.readFile()) : "";
      if (content.length > 700000) throw new AppError("Markdown 文档超过 70 万字符", 413);
      if (!markdown) {
        const stream = input.createReadStream({ autoClose: false });
        try { await this.media.put(objectKey, Readable.toWeb(stream) as ReadableStream<Uint8Array>, { httpMetadata: { contentType: type } }); uploaded = true; }
        finally { stream.destroy(); }
      }
      if ((await entry(local.name))?.stamp !== local.stamp) throw new AppError("文件正在更新", 409, "VERSION_CONFLICT");
      const result = await this.store.putArtifact(projectId, { path: projectOutputPath(key), content,
        kind: file?.kind ?? (markdown ? "document" : type.startsWith("image/") ? "image" : type.startsWith("audio/") ? "audio" :
          key.startsWith("/07_成片/") ? "final" : "video"),
        expectedVersion: file?.version ?? 0, expectedArtifactId: file?.id, serveMedia: !markdown,
        metadata: markdown ? { ...file?.metadata, editedByUser: true, structuredVersion: null } : { objectKey, contentType: type, uploaded: true },
      });
      saved = true;
      return result;
    } finally {
      await input.close().catch(() => {});
      if (uploaded && !saved) await this.media.remove?.(objectKey);
    }
  }

  private async matches(file: Artifact, local: Entry) {
    const key = file.metadata.objectKey;
    if (typeof key !== "string" && local.size !== Buffer.byteLength(file.content)) return false;
    const object = typeof key === "string" && key.startsWith(file.projectId + "/") ? await this.media.get(key) : null;
    if (typeof key === "string" && (!object || object.size !== local.size)) {
      await object?.body.cancel();
      return false;
    }
    const input = await open(local.name, constants.O_RDONLY | noLinks);
    const actual = createHash("sha256");
    try {
      for await (const chunk of input.createReadStream({ autoClose: false })) actual.update(chunk);
    } finally { await input.close().catch(() => {}); await object?.body.cancel(); }
    const expected = object?.etag ?? '"' + createHash("sha256").update(file.content).digest("hex") + '"';
    return (await entry(local.name))?.stamp === local.stamp && '"' + actual.digest("hex") + '"' === expected;
  }
  private async publish(root: string, file: Artifact, local?: Entry) {
    const parts = projectOutputPath(file.path).slice(1).split("/"), filename = parts.pop()!;
    let folder = root;
    for (const name of parts) { folder = path.join(folder, name); await directory(folder); }
    const name = local?.name ?? path.join(folder, filename);
    const object = typeof file.metadata.objectKey === "string" && file.metadata.objectKey.startsWith(file.projectId + "/")
      ? await this.media.get(file.metadata.objectKey) : null;
    if (["image", "audio", "video", "final"].includes(file.kind) && !object) return;
    const temp = path.join(folder, ".do漫-" + uid());
    const output = await open(temp, "wx", 0o600);
    try {
      if (object) {
        for await (const chunk of Readable.fromWeb(object.body as import("node:stream/web").ReadableStream)) await output.writeFile(chunk);
      }
      else await output.writeFile(file.content);
      await output.sync();
      await output.close();
      if (local) {
        if ((await entry(name))?.stamp !== local.stamp) throw new AppError("文件正在更新", 409, "VERSION_CONFLICT");
        await rename(temp, name);
      } else {
        await link(temp, name).catch((error) => { if (error.code !== "EEXIST") throw error; throw new AppError("文件正在更新", 409, "VERSION_CONFLICT"); });
      }
      return (await entry(name))?.stamp;
    } finally { await output.close().catch(() => {}); await rm(temp, { force: true }); }
  }
}
