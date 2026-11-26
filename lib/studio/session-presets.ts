import { z } from "zod";
import { AppError } from "./security";
import type { Database } from "./storage";
import { pluginId, type PresetPlugins } from "./preset-plugins";

export const skillName = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const presetInput = z.strictObject({
  name: z.string().trim().min(1).max(80),
  instructions: z.string().trim().max(16000),
  skills: z.array(skillName).max(64).nullable().default(null),
  mcpServers: z.array(z.string().uuid()).max(32).nullable().default(null),
  tools: z.array(z.string().min(1).max(64)).max(128).nullable().default(null),
  childPresets: z.array(z.string().uuid()).max(32).default([]),
  plugins: z.array(pluginId).max(32).default([]),
});
export interface SessionPreset extends z.output<typeof presetInput> { id: string }

export class SessionPresets {
  constructor(private db: Database, private pluginRuntime?: PresetPlugins) {}
  list(userId: string) {
    return this.db.prepare("SELECT data FROM session_presets WHERE user_id=? ORDER BY rowid")
      .bind(userId).rows<{ data: string }>().map(({ data }) => JSON.parse(data) as SessionPreset);
  }
  get(projectId: string, sessionId: string): SessionPreset | null {
    const [row] = this.db.prepare("SELECT data FROM session_preset_bindings WHERE project_id=? AND session_id=?")
      .bind(projectId, sessionId).rows<{ data: string }>();
    return row ? JSON.parse(row.data) : null;
  }
  defaultId(userId: string) {
    return this.db.prepare("SELECT preset_id FROM session_preset_defaults WHERE user_id=?")
      .bind(userId).rows<{ preset_id: string }>()[0]?.preset_id ?? null;
  }
  async setDefault(userId: string, id: string | null) {
    if (id) {
      const changed = await this.db.prepare(`INSERT INTO session_preset_defaults(user_id,preset_id)
        SELECT user_id,id FROM session_presets WHERE user_id=? AND id=? ON CONFLICT(user_id) DO UPDATE SET preset_id=excluded.preset_id`)
        .bind(userId, id).run();
      if (!changed.meta.changes) throw new AppError("预设不存在", 404);
    } else await this.db.prepare("DELETE FROM session_preset_defaults WHERE user_id=?").bind(userId).run();
    return this.defaultId(userId);
  }
  projectPreset(projectId: string, id: string) {
    const [row] = this.db.prepare(`SELECT s.data FROM session_presets s JOIN projects p ON p.user_id=s.user_id WHERE p.id=? AND s.id=?`)
      .bind(projectId, id).rows<{ data: string }>();
    if (!row) throw new AppError("预设不存在", 404, "PRESET_NOT_FOUND");
    return JSON.parse(row.data) as SessionPreset;
  }
  bindNew(projectId: string, sessionId: string, id?: string, guard = "1", ...bindings: unknown[]) {
    return this.db.prepare(`INSERT INTO session_preset_bindings(project_id,session_id,data)
      SELECT p.id,?,s.data FROM projects p LEFT JOIN session_preset_defaults d ON d.user_id=p.user_id
      JOIN session_presets s ON s.user_id=p.user_id AND s.id=COALESCE(?,d.preset_id)
      WHERE p.id=? AND (${guard})`).bind(sessionId, id ?? null, projectId, ...bindings);
  }
  async save(userId: string, input: unknown, id?: string) {
    const preset = { ...presetInput.parse(input), id: id ?? crypto.randomUUID() };
    if (preset.plugins.length && !this.pluginRuntime) throw new AppError("本地扩展尚未安装", 400, "PRESET_PLUGIN_MISSING");
    this.pluginRuntime?.validate(preset.plugins);
    if (id) {
      const changed = await this.db.prepare("UPDATE session_presets SET data=? WHERE id=? AND user_id=?")
        .bind(JSON.stringify(preset), id, userId).run();
      if (!changed.meta.changes) throw new AppError("预设不存在", 404);
    } else await this.db.prepare("INSERT INTO session_presets(id,user_id,data) VALUES(?,?,?)").bind(preset.id, userId, JSON.stringify(preset)).run();
    await this.pluginRuntime?.retire(userId, preset.id, preset);
    return preset;
  }
  async remove(userId: string, id: string) {
    await this.db.prepare("DELETE FROM session_presets WHERE id=? AND user_id=?").bind(id, userId).run();
    await this.pluginRuntime?.retire(userId, id);
  }
  async select(userId: string, projectId: string, sessionId: string, id: string | null) {
    const preset = id ? this.list(userId).find((entry) => entry.id === id) : null;
    if (id && !preset) throw new AppError("预设不存在", 404);
    const idle = `NOT EXISTS(SELECT 1 FROM runs WHERE project_id=? AND session_id=? AND agent_role<>'media'
      AND json_extract(payload,'$.inherited') IS NOT 1 AND status IN ('queued','running','waiting','paused'))`;
    const change = await (preset
      ? this.db.prepare(`INSERT INTO session_preset_bindings(project_id,session_id,data) SELECT ?,?,? WHERE ${idle}
          ON CONFLICT(project_id,session_id) DO UPDATE SET data=excluded.data`)
        .bind(projectId, sessionId, JSON.stringify(preset), projectId, sessionId)
      : this.db.prepare(`DELETE FROM session_preset_bindings WHERE project_id=? AND session_id=? AND ${idle}`)
        .bind(projectId, sessionId, projectId, sessionId)).run();
    if (!change.meta.changes && (preset || this.get(projectId, sessionId)))
      throw new AppError("请等当前对话停止执行后再切换预设", 409, "PRESET_BUSY");
    if (change.meta.changes) await this.pluginRuntime?.detach({ projectId, sessionId });
    return preset ?? null;
  }
  inheritStatement(projectId: string, source: string, target: string) {
    return this.db.prepare(`INSERT INTO session_preset_bindings(project_id,session_id,data)
      SELECT project_id,?,data FROM session_preset_bindings WHERE project_id=? AND session_id=?`).bind(target, projectId, source);
  }
}
