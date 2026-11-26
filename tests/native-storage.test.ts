import { ProjectDisk } from "../server/project-disk";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SQLiteDatabase, LocalMediaStore } from "../server/storage";
import { Store } from "../lib/studio/store";
import { fetchWithoutRedirect } from "../lib/studio/http";
import { createModel } from "../lib/studio/providers";
import { DEFAULT_SETTINGS } from "../lib/studio/types";
import { executeFileTool } from "../lib/studio/file-tools";
import { configureRuntime } from "../server/runtime";
import { DELETE, GET } from "../app/api/studio/[...path]/route";
import { SkillLibrary } from "../lib/studio/skills";
import { Schedules } from "../lib/studio/schedules";
import { recordModelRequest } from "../lib/studio/model-request-record";
import { cleanDeletedProject } from "../server/project-deletion";

test("native SQLite preserves project data and encrypted settings across restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mujian-db-"));
  try {
    const filename = path.join(directory, "studio.sqlite"), database = new SQLiteDatabase(filename); database.initialize("drizzle");
    const store = new Store(database), project = await store.createProject("local", {});
    await store.putArtifact(project.id, { path: "/01_创作/剧本.md", kind: "document", content: "用户保留的原稿" });
    await store.saveSettings("local", { textApiKey: "native-private-key" }, "private-local-encryption-key-32chars"); database.close();
    const reopened = new SQLiteDatabase(filename); reopened.initialize("drizzle"); const restored = new Store(reopened);
    assert.equal((await restored.artifacts(project.id))[0].content, "用户保留的原稿");
    assert.equal((await restored.getSettings("local", "private-local-encryption-key-32chars")).textApiKey, "native-private-key"); reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("only an owned archive can be permanently deleted, including its local files and execution history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "doman-delete-project-"));
  const db = new SQLiteDatabase(path.join(root, "studio.sqlite"));
  db.initialize("drizzle");
  const skills = new SkillLibrary(path.join(root, "skills"));
  const store = new Store(db, { skills }), mediaRoot = path.join(root, "media"), media = new LocalMediaStore(mediaRoot, db);
  const disk = new ProjectDisk(path.join(root, "workspaces"), store, media, "local");
  const remove = (id: string, userId = "local") => {
    configureRuntime({ database: db, media, disk, skills, userId, workerSecret: "test", encryptionSecret: "test" });
    return DELETE(new Request("http://localhost/api/studio/projects/" + id, { method: "DELETE" }), { params: Promise.resolve({ path: ["projects", id] }) });
  };
  try {
    const project = await store.createProject("local", { title: "Archived production" });
    const other = await store.createProject("local", { title: "Keep this project" });
    const file = await store.createProjectDocument(project.id, "/01_创作/剧本.md", "第一版");
    const workspace = await disk.activate(project.id);
    const content = "---\nname: storyboard\ndescription: Storyboard guide\n---\nStory notes";
    skills.save(project.id, "project", content);
    skills.save(other.id, "project", content);
    skills.save(project.id, "global", content);
    const session = await store.createSession(project.id, "分镜对话");
    await store.addMessage(project.id, "user", "需要删除的对话");
    const schedules = new Schedules(store);
    await schedules.save(project.id, { title: "Review", prompt: "Review notes", timing: { kind: "after", after_seconds: 60 },
      target: { kind: "session", id: session.id } });
    await media.put(project.id + "/uploads/old-version", "bytes");
    await media.put(other.id + "/uploads/keep", "bytes");

    const modelRequest = (name: string) => ({ system: "Shared system instructions", messages: [
      { role: "user", content: "A common message shared by both projects, long enough to be stored separately." },
      { role: "user", content: "A project-specific private message stored separately for " + name },
    ] });
    const record = async (projectId: string, name: string) => {
      const run = await store.createRun(projectId, { instruction: "Read scene", sourceVersions: {} });
      assert.ok(await store.claimRun(run.id, projectId));
      const request = modelRequest(name), requestId = crypto.randomUUID();
      await store.beginModelCall(await store.run(run.id, projectId), requestId, request);
      await store.db.prepare("UPDATE runs SET status='done',lease_until=0 WHERE id=?").bind(run.id).run();
      return { run, requestId, parts: recordModelRequest(request).parts };
    };
    const discarded = await record(project.id, "deletion"), preserved = await record(other.id, "retention");
    await db.prepare("INSERT INTO background_job_output(job_id,line,created_at) VALUES(?,?,?)")
      .bind(discarded.run.id, "生成日志", new Date().toISOString()).run();
    assert.equal((await remove(project.id)).status, 409);
    assert.equal(await readFile(path.join(workspace, "01_创作", "剧本.md"), "utf8"), "第一版");
    await store.archiveProject(project.id, "local", true, true);
    assert.equal((await remove(project.id, "another-user")).status, 404);
    await db.prepare("UPDATE runs SET lease_until=? WHERE id=?").bind(Date.now() + 60000, discarded.run.id).run();
    assert.equal((await remove(project.id)).status, 409);
    await db.prepare("UPDATE runs SET lease_until=0 WHERE id=?").bind(discarded.run.id).run();
    const deleted = await remove(project.id);
    assert.equal(deleted.status, 200, await deleted.text());
    assert.deepEqual((await store.listProjects("local")).map(({ id }) => id), [other.id]);
    const records = (table: string, column: string, id: string) => db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`).bind(id).rows<{ count: number }>().at(0)?.count;
    for (const table of ["messages", "runs", "events", "agent_inbox", "project_sessions", "studio_schedules", "artifacts", "disk_workspaces", "project_deletions"])
      assert.equal(records(table, "project_id", project.id), 0, table);
    assert.equal(records("artifact_versions", "artifact_id", file.id), 0);
    assert.equal(records("model_calls", "id", discarded.requestId), 0);
    assert.equal(records("background_job_output", "job_id", discarded.run.id), 0);
    assert.equal(records("model_calls", "id", preserved.requestId), 1);
    for (const id of discarded.parts.keys()) assert.equal(records("model_request_parts", "id", id), Number(preserved.parts.has(id)));
    assert.deepEqual(db.connection.prepare("PRAGMA foreign_key_check").all(), []);
    await assert.rejects(stat(workspace), { code: "ENOENT" });
    await assert.rejects(stat(path.join(mediaRoot, project.id)), { code: "ENOENT" });
    await assert.rejects(stat(path.join(root, "skills", "projects", project.id)), { code: "ENOENT" });
    assert.equal(await media.get(project.id + "/uploads/old-version"), null);
    assert.ok(await media.get(other.id + "/uploads/keep"));
    assert.equal(skills.source(other.id, "project", "storyboard"), content);
    assert.equal(skills.source(other.id, "global", "storyboard"), content);

    const interrupted = await store.createProject("local", {});
    await media.put(interrupted.id + "/uploads/old", "bytes");
    await store.archiveProject(interrupted.id, "local", true);
    const hidden = mediaRoot + "-temporarily-unavailable";
    await rename(mediaRoot, hidden);
    const failed = await remove(interrupted.id);
    assert.equal(failed.status, 500);
    assert.equal((await failed.json()).code, "PROJECT_CLEANUP_FAILED");
    assert.equal(records("project_deletions", "project_id", interrupted.id), 1);
    assert.equal((await remove(interrupted.id, "another-user")).status, 404);
    await rename(hidden, mediaRoot);
    const reopened = new SQLiteDatabase(path.join(root, "studio.sqlite"));
    try { await cleanDeletedProject(new Store(reopened), interrupted.id, new LocalMediaStore(mediaRoot, reopened)); }
    finally { reopened.close(); }
    assert.equal(records("project_deletions", "project_id", interrupted.id), 0);
    await assert.rejects(stat(path.join(mediaRoot, interrupted.id)), { code: "ENOENT" });
  } finally {
    skills.close(); await disk.close(); db.close(); await rm(root, { recursive: true, force: true });
  }
});

test("clearing model keys scrubs SQLite pages and WAL in both the current and legacy workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "doman-clear-model-keys-"));
  const filename = path.join(root, "data", "studio.sqlite");
  const historical = path.join(root, ".wrangler", "state", "v3", "d1", "legacy.sqlite");
  const database = new SQLiteDatabase(filename), legacy = new SQLiteDatabase(historical);
  const secret = "local-settings-encryption-fixture".repeat(2);
  try {
    database.initialize("drizzle");
    legacy.initialize("drizzle");
    const store = new Store(database), oldStore = new Store(legacy);
    const project = await store.createProject("local", { title: "保留的项目" });
    const document = await store.putArtifact(project.id, { path: "/01_创作/剧本.md", kind: "document", content: "保留的原稿" });
    await store.addMessage(project.id, "user", "保留的对话");
    const media = new LocalMediaStore(path.join(root, "data", "media"), database);
    const mediaKey = project.id + "/uploads/fixture";
    await media.put(mediaKey, "保留的素材");
    const snapshot = await store.snapshot(project.id, "local");
    const readCiphertext = (target: SQLiteDatabase) =>
      target.connection.prepare("SELECT secrets FROM settings").get()!.secrets as string;
    const keys = { textApiKey: "fixture-deepseek", arkApiKey: "fixture-ark", minimaxApiKey: "fixture-minimax", aiclubApiKey: "fixture-aiclub" };
    await store.saveSettings("local", { ...keys, webSearchEnabled: false }, secret);
    await oldStore.saveSettings("older-user", keys, secret);
    const oldCiphertext = readCiphertext(database), legacyCiphertext = readCiphertext(legacy);
    database.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    assert.ok((await readFile(filename)).includes(oldCiphertext));
    await store.saveSettings("local", { textApiKey: "rotated-fixture-deepseek" }, secret);
    const currentCiphertext = readCiphertext(database);
    assert.ok((await readFile(filename + "-wal")).includes(currentCiphertext));

    configureRuntime({ database, media, userId: "local", workerSecret: "fixture", encryptionSecret: secret });
    const removeKeys = (origin: string) => DELETE(new Request("http://localhost/api/studio/settings/keys", {
      method: "DELETE", headers: { origin },
    }), { params: Promise.resolve({ path: ["settings", "keys"] }) });
    const cwd = process.cwd();
    process.chdir(root);
    let staleSave: ReturnType<Store["saveSettings"]>;
    try {
      assert.equal((await removeKeys("https://other.example.com")).status, 403);
      assert.equal(readCiphertext(database), currentCiphertext);
      staleSave = store.saveSettings("local", { textApiKey: "", webSearchEnabled: true }, secret);
      const response = await removeKeys("http://localhost");
      assert.equal(response.status, 200);
      const view = await response.json();
      assert.equal(view.textConnected, false);
      assert.equal(view.arkConnected, false);
      assert.equal(view.minimaxConnected, false);
      assert.equal(view.aiclubConnected, false);
    } finally { process.chdir(cwd); }
    await assert.rejects(staleSave, { code: "SETTINGS_CHANGED" });
    assert.equal(readCiphertext(database), "");
    assert.equal(readCiphertext(legacy), "");
    for (const dbFile of [filename, historical]) {
      const file = await readFile(dbFile);
      for (const ciphertext of [oldCiphertext, legacyCiphertext, currentCiphertext]) assert.ok(!file.includes(ciphertext));
      const wal = await readFile(dbFile + "-wal").catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
        return Buffer.alloc(0);
      });
      assert.equal(wal.length, 0);
    }

    const reopened = new SQLiteDatabase(filename);
    try {
      const restored = new Store(reopened), settings = await restored.getSettings("local", secret);
      for (const key of Object.keys(keys) as (keyof typeof keys)[]) assert.equal(settings[key], "");
      assert.equal(settings.webSearchEnabled, false);
      assert.equal((await restored.artifact(document.id, project.id)).content, "保留的原稿");
      assert.deepEqual((await restored.messages(project.id)).map(({ content }) => content), ["保留的对话"]);
      assert.deepEqual(await restored.snapshot(project.id, "local"), snapshot);
      assert.equal(await new Response((await media.get(mediaKey))!.body).text(), "保留的素材");
      await restored.saveSettings("local", { textApiKey: "recipient-fixture" }, secret);
      assert.equal((await restored.getSettings("local", secret)).textApiKey, "recipient-fixture");
    } finally { reopened.close(); }
  } finally {
    database.close(); legacy.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("turn comparisons keep the first and last committed versions across child edits and restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mujian-turn-review-"));
  const filename = path.join(directory, "studio.sqlite");
  let database = new SQLiteDatabase(filename);
  try {
    database.initialize("drizzle");
    const store = new Store(database), project = await store.createProject("local", {});
    const original = await store.putArtifact(project.id, { path: "/01_创作/旧名.md", kind: "script", content: "原始台词\n保留的场景\n" });
    const unrelated = await store.putArtifact(project.id, { path: "/01_创作/个人笔记.md", kind: "document", content: "手动保存" });
    // A version created before the comparison feature is still a valid baseline.
    await store.db.prepare("UPDATE artifact_versions SET kind=NULL,path=NULL WHERE artifact_id=?").bind(original.id).run();
    const root = await store.createRun(project.id, { instruction: "修改对白", sourceVersions: {} });
    assert.ok(await store.claimRun(root.id, project.id));
    const parent = await store.run(root.id, project.id);
    const childId = String((await store.startChild(parent, "delegate", "writer", "改对白")).task_id);
    assert.ok(await store.claimRun(childId, project.id));
    const child = await store.run(childId, project.id);
    await executeFileTool(store, child, "edit", "edit_file", { file_path: original.path, old_string: "原始台词", new_string: "新台词" });
    await executeFileTool(store, parent, "rename", "move_file", { file_path: original.path, new_path: "/01_创作/新名.md" });
    await executeFileTool(store, parent, "create", "write_file", { file_path: "/01_创作/分镜.md", content: "新分镜\n" });
    await store.putArtifact(project.id, { path: "/01_创作/新名.md", kind: "script", content: "之后手动改写" });
    database.close();
    database = new SQLiteDatabase(filename); database.initialize("drizzle");
    const reopened = new Store(database), snapshot = await reopened.snapshot(project.id, "local");
    const changes = snapshot.changesByRun?.[root.id];
    assert.equal(changes?.length, 2);
    assert.deepEqual(changes?.find((row) => row.id === original.id), {
      id: original.id, path: "/01_创作/新名.md", previousPath: original.path, beforeVersion: 1, afterVersion: 3,
    });
    const comparison = await reopened.compareTurnFile(project.id, root.id, original.id);
    assert.equal(comparison.kind, "text");
    const lines = comparison.hunks.flatMap((hunk) => hunk.lines);
    assert.deepEqual(lines, ["-原始台词", "+新台词", " 保留的场景"]);
    assert.ok(!changes?.some((row) => row.id === unrelated.id));
    await assert.rejects(reopened.compareTurnFile(project.id, root.id, unrelated.id), /没有修改/);
    await executeFileTool(reopened, await reopened.run(root.id, project.id), "continue", "edit_file", {
      file_path: "/01_创作/新名.md", old_string: "之后手动改写", new_string: "本轮继续改写",
    });
    assert.equal((await reopened.compareTurnFile(project.id, root.id, original.id)).afterVersion, 5);
    assert.deepEqual(await reopened.compareTurnFile(project.id, root.id, original.id, 3), comparison);
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

test("media change preview reads exact before and after versions from the project API", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mujian-media-review-")), database = new SQLiteDatabase(":memory:");
  try {
    database.initialize("drizzle");
    const store = new Store(database), project = await store.createProject("local", {});
    const media = new LocalMediaStore(directory, database);
    configureRuntime({ database, media, userId: "local", workerSecret: "test", encryptionSecret: "test" });
    const save = async (value: string, lease?: Awaited<ReturnType<Store["run"]>>) => {
      const objectKey = project.id + "/test/" + value;
      await media.put(objectKey, value, { httpMetadata: { contentType: "video/mp4" } });
      return store.putArtifact(project.id, { path: "/04_视频/镜头.mp4", kind: "video", content: "", serveMedia: true, lease,
        metadata: { objectKey, contentType: "video/mp4" } });
    };
    const first = await save("before");
    const run = await store.createRun(project.id, { instruction: "替换镜头", sourceVersions: {} });
    assert.ok(await store.claimRun(run.id, project.id));
    await save("during", await store.run(run.id, project.id));
    await save("later");
    const comparison = await store.compareTurnFile(project.id, run.id, first.id);
    assert.equal(comparison.kind, "media");
    for (const [side, expected] of [["before", "before"], ["after", "during"]] as const) {
      const address = new URL(comparison[side]!.url, "http://localhost");
      const response = await GET(new Request(address), { params: Promise.resolve({ path: ["projects", project.id, "media", first.id] }) });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), expected);
    }
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

test("local media supports full, partial and suffix reads with durable immutable versions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mujian-media-")), database = new SQLiteDatabase(path.join(directory, "studio.sqlite"));
  try {
    let media = new LocalMediaStore(path.join(directory, "media"), database);
    await media.put("project/source/v1", new TextEncoder().encode("0123456789"), { httpMetadata: { contentType: "video/mp4" } });
    media = new LocalMediaStore(path.join(directory, "media"), database);
    const full = await media.get("project/source/v1"); assert.equal(await new Response(full!.body).text(), "0123456789"); assert.equal(full!.contentType, "video/mp4");
    const partial = await media.get("project/source/v1", { range: new Headers({ range: "bytes=2-5" }) }); assert.equal(await new Response(partial!.body).text(), "2345"); assert.deepEqual(partial!.range, { offset: 2, length: 4 });
    const suffix = await media.get("project/source/v1", { range: new Headers({ range: "bytes=-3" }) }); assert.equal(await new Response(suffix!.body).text(), "789");
    await media.put("project/source/v1", "0123456789");
    await assert.rejects(media.put("project/source/v1", "overwrite"), /保存为新版本/);
    assert.equal(new TextDecoder().decode(await (await media.get("project/source/v1"))!.arrayBuffer()), "0123456789");
    for (const range of ["bytes=30-", "bytes=5-2", "bytes=-0", "bytes=1-2,4-5"]) await assert.rejects(media.get("project/source/v1", { range: new Headers({ range }) }), /范围无效/);
    for (const key of ["../secret", "/etc/file", "project/../file", "project\\file"]) await assert.rejects(media.put(key, "unsafe"), /路径无效/);
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});
test("an interrupted media write leaves no visible object and preserves the existing version", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mujian-write-")), database = new SQLiteDatabase(":memory:");
  try {
    const media = new LocalMediaStore(directory, database); await media.put("project/old", "preserve");
    const broken = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error("source interrupted")); } });
    await assert.rejects(media.put("project/new", broken()), /source interrupted/); assert.equal(await media.get("project/new"), null);
    await assert.rejects(media.put("project/old", broken()), /source interrupted/); assert.equal(new TextDecoder().decode(await (await media.get("project/old"))!.arrayBuffer()), "preserve");
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});
test("provider fetch rejects redirects without forwarding credentials", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => { calls++; assert.equal(init.redirect, "manual"); return new Response(null, { status: 307, headers: { location: "https://other.example.com/credentials" } }); });
  await assert.rejects(fetchWithoutRedirect("https://api.deepseek.com/v1/chat/completions", { headers: { authorization: "Bearer private-key" } }), (error: any) => error.code === "PROVIDER_REDIRECT" && !error.message.includes("private-key")); assert.equal(calls, 1);
});
test("model connections use the supported redirect mode and preserve useful safe diagnostics", async (t) => {
  const settings = { ...DEFAULT_SETTINGS, textApiKey: "secret-test-value" };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => { if (init.redirect === "error") throw new TypeError("Invalid redirect value"); return Response.json({ choices: [{ message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }] }); });
  assert.deepEqual(await createModel(settings)({ system: "connection test", input: {}, maxTokens: 20 }), { ok: true });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("connect " + settings.textApiKey + " failed"); });
  await assert.rejects(createModel(settings)({ system: "test", input: {} }), (error: any) => !error.message.includes(settings.textApiKey) && error.code === "MODEL_UNAVAILABLE");
});

test("concurrent writes cannot replace an immutable media version", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mujian-race-")), database = new SQLiteDatabase(":memory:");
  try {
    const media = new LocalMediaStore(directory, database);
    const results = await Promise.allSettled([media.put("project/version", "first"), media.put("project/version", "second")]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const saved = await media.get("project/version"), bytes = await saved!.arrayBuffer();
    assert.ok(["first", "second"].includes(new TextDecoder().decode(bytes)));
    assert.equal(saved!.size, bytes.byteLength);
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a native project directory round-trips edits, moves, deletes, and immutable versions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "doman-native-files-"));
  const db = new SQLiteDatabase(path.join(root, "studio.sqlite"));
  db.initialize("drizzle");
  const store = new Store(db), media = new LocalMediaStore(path.join(root, "media"), db);
  const disk = new ProjectDisk(path.join(root, "workspaces"), store, media, "local", (error) => { throw error; });
  try {
    const project = await store.createProject("local", {});
    const original = await store.createProjectDocument(project.id, "/01_创作/旧名.md", "第一版");
    const location = await disk.activate(project.id);
    const old = path.join(location, "01_创作", "旧名.md"), moved = path.join(location, "01_创作", "新名.md");
    assert.equal(await readFile(old, "utf8"), "第一版");
    await writeFile(old, "第二版");
    await disk.sync(project.id);
    assert.equal((await store.artifact(original.id, project.id)).content, "第二版");
    await rename(old, moved);
    await disk.sync(project.id);
    const renamed = await store.artifact(original.id, project.id);
    assert.equal(renamed.path, "/01_创作/新名.md");
    assert.equal(renamed.version, 3);
    const before = (await store.snapshot(project.id, "local")).cursor;
    await unlink(moved);
    await disk.sync(project.id);
    assert.deepEqual(await store.artifacts(project.id), []);
    const { frame } = store.workspaceFrame(project.id, "local", before);
    assert.ok(frame?.type === "delta" && frame.removedArtifacts?.includes(original.id));
    assert.equal((await store.artifactVersion(project.id, original.id, 1)).content, "第一版");
    const replacement = await store.createProjectDocument(project.id, "/01_创作/新名.md", "新稿");
    assert.notEqual(replacement.id, original.id);
    await writeFile(path.join(location, "03_图片", "参考.png"), "original-media-bytes");
    await disk.sync(project.id);
    const image = (await store.artifacts(project.id)).find(({ kind }) => kind === "image");
    assert.ok(image && typeof image.metadata.objectKey === "string");
    assert.equal(Buffer.from(await (await media.get(image.metadata.objectKey))!.arrayBuffer()).toString(), "original-media-bytes");
    const other = await store.createProject("local", {});
    assert.deepEqual(await store.artifacts(other.id), []);
    await writeFile(moved, "本机先改");
    await store.putArtifact(project.id, { path: replacement.path, kind: replacement.kind, content: "界面先保存",
      expectedArtifactId: replacement.id, expectedVersion: replacement.version });
    await disk.sync(project.id);
    assert.equal(await readFile(moved, "utf8"), "界面先保存");
    assert.ok((await store.artifacts(project.id)).some((file) => file.path.includes("本地副本") && file.content === "本机先改"));
  } finally { await disk.close(); db.close(); await rm(root, { recursive: true, force: true }); }
});
