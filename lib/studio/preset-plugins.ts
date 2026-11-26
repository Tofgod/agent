import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { McpManager } from "./mcp";
import { AppError } from "./security";
import type { SessionPreset } from "./session-presets";
import type { SkillProvider } from "./skills";
import type { Database } from "./storage";
import type { ToolRegistration } from "./tool-registry";
import type { ExecutionHooks } from "./execution-hooks";

type Dispose = () => void | Promise<void>;
export const pluginId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export interface StudioPluginContext {
  registerSkillProvider(provider: SkillProvider): Dispose;
  registerMcp(name: string, configuration: unknown): void;
  registerTool(tool: ToolRegistration): void;
  registerExecutionHooks(hooks: ExecutionHooks): void;
  onDispose(dispose: Dispose): void;
}
export interface StudioPlugin {
  id: string;
  name: string;
  setup(context: StudioPluginContext): void | Dispose | Promise<void | Dispose>;
}
interface PluginScope {
  key?: string;
  providers: SkillProvider[];
  tools: ToolRegistration[];
  hooks: ExecutionHooks[];
  dispose: Dispose;
}
export interface PluginOwner { projectId: string; sessionId: string; runId?: string }
interface Generation {
  userId: string;
  presetId: string;
  users: number;
  retired: boolean;
  ready: Promise<PluginScope>;
}
const ownerKey = ({ projectId, sessionId, runId }: PluginOwner) => JSON.stringify([projectId, sessionId, runId]);
const generationKey = (userId: string, preset: SessionPreset) =>
  createHash("sha256").update(JSON.stringify([userId, preset])).digest("hex");

async function disposeAll(disposers: Dispose[]) {
  for (const dispose of disposers.reverse()) {
    try { await dispose(); } catch (error) {
      console.warn("[扩展] 释放失败", error instanceof Error ? error.name : "Error");
    }
  }
}

export class PresetPlugins {
  private readonly definitions = new Map<string, StudioPlugin>();
  private readonly generations = new Map<string, Generation>();
  private readonly disposing = new Map<string, Promise<void>>();
  private readonly owners = new Map<string, { owner: PluginOwner; key: string }>();
  private host?: PluginScope;
  private stopping = false;

  constructor(private db: Database, private mcp: McpManager, definitions: readonly StudioPlugin[]) {
    for (const definition of definitions) {
      const id = pluginId.parse(definition.id);
      if (this.definitions.has(id) || typeof definition.setup !== "function" || !definition.name?.trim())
        throw new AppError("扩展定义无效 " + id);
      this.definitions.set(id, definition);
    }
  }
  list() { return [...this.definitions.values()].map(({ id, name }) => ({ id, name })); }
  validate(ids: readonly string[]) {
    if (new Set(ids).size !== ids.length || ids.some((id) => !this.definitions.has(id)))
      throw new AppError("预设包含重复或尚未安装的扩展", 400, "PRESET_PLUGIN_MISSING");
  }
  async start(userId: string, ids: readonly string[]) {
    this.host = await this.mount(userId, ids);
  }
  private async mount(userId: string, ids: readonly string[], key?: string): Promise<PluginScope> {
    this.validate(ids);
    const providers: SkillProvider[] = [], tools: ToolRegistration[] = [], disposers: Dispose[] = [];
    const hooks: ExecutionHooks[] = [];
    const readiness: Promise<void>[] = [];
    let registering = true;
    const check = () => {
      if (!registering) throw new AppError("扩展只能在装载时注册能力");
    };
    const context: StudioPluginContext = {
      registerSkillProvider(provider) {
        check();
        const lifetime = new AbortController();
        let invalidate: (() => void) | undefined;
        const registered: SkillProvider = (options) => {
          lifetime.signal.throwIfAborted();
          invalidate = options.invalidate;
          return provider({ ...options, signal: AbortSignal.any([options.signal, lifetime.signal]), invalidate: () => {
            if (!lifetime.signal.aborted) options.invalidate();
          } });
        };
        providers.push(registered);
        const dispose = () => {
          if (lifetime.signal.aborted) return;
          providers.splice(providers.indexOf(registered), 1);
          lifetime.abort(new Error("技能提供方已撤下"));
          invalidate?.();
          invalidate = undefined;
        };
        disposers.push(dispose);
        return dispose;
      },
      registerExecutionHooks(registration) { check(); hooks.push(registration); },
      registerTool(tool) {
        check();
        if (typeof tool.schema === "function" && !tool.name) throw new AppError("扩展的动态工具须有固定名称");
        tools.push(tool);
      },
      registerMcp: (name, configuration) => {
        check();
        const registration = this.mcp.register(userId, name, configuration, key);
        disposers.push(registration.dispose);
        if (registration.readiness) {
          void registration.readiness.catch(() => {});
          readiness.push(registration.readiness);
        }
      },
      onDispose(dispose) { check(); disposers.push(dispose); },
    };
    try {
      for (const id of ids) {
        const dispose = await this.definitions.get(id)!.setup(context);
        if (dispose) disposers.push(dispose);
      }
      await Promise.all(readiness);
    } catch (error) {
      await disposeAll(disposers);
      throw new AppError("会话扩展装载失败", 503, "PRESET_PLUGIN_FAILED");
    } finally { registering = false; }
    return { key, providers, tools, hooks, dispose: () => disposeAll(disposers.splice(0)) };
  }
  async acquire(userId: string, preset: SessionPreset | null, owner?: PluginOwner) {
    if (this.stopping) throw new AppError("扩展宿主已关闭", 503);
    if (!preset?.plugins?.length) {
      if (owner) await this.detach(owner);
      return { key: undefined, providers: this.host?.providers ?? [], scopedProviders: [], tools: this.host?.tools ?? [],
        hooks: this.host?.hooks ?? [], release: async () => {} };
    }
    const key = generationKey(userId, preset);
    await this.disposing.get(key);
    if (this.stopping) throw new AppError("扩展宿主已关闭", 503);
    let generation = this.generations.get(key);
    if (!generation) {
      const [latest] = this.db.prepare("SELECT data FROM session_presets WHERE user_id=? AND id=?")
        .bind(userId, preset.id).rows<{ data: string }>();
      const ready = this.mount(userId, preset.plugins, key);
      generation = { userId, presetId: preset.id, users: 0, retired: !latest || generationKey(userId, JSON.parse(latest.data)) !== key, ready };
      this.generations.set(key, generation);
    }
    const retained = generation;
    retained.users++;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      retained.users--;
      await this.collect(key, retained);
    };
    try {
      const scope = await retained.ready;
      if (owner) {
        const id = ownerKey(owner);
        const previous = this.owners.get(id);
        if (previous?.key !== key) {
          this.owners.set(id, { owner, key });
          retained.users++;
          if (previous) await this.releaseOwner(previous.key);
        }
      }
      return { key: scope.key, tools: [...this.host?.tools ?? [], ...scope.tools],
        providers: this.host?.providers ?? [], scopedProviders: scope.providers, hooks: [...scope.hooks, ...this.host?.hooks ?? []], release };
    } catch (error) {
      if (this.generations.get(key) === retained) this.generations.delete(key);
      await release();
      throw error;
    }
  }
  private async collect(key: string, generation: Generation) {
    if (!generation.retired || generation.users > 0 || this.generations.get(key) !== generation) return;
    this.generations.delete(key);
    const disposed = generation.ready.then((scope) => scope.dispose(), () => {}).finally(() => this.disposing.delete(key));
    this.disposing.set(key, disposed);
    await disposed;
  }
  private async releaseOwner(key: string) {
    const generation = this.generations.get(key);
    if (!generation) return;
    generation.users--;
    await this.collect(key, generation);
  }
  async detach(owner: PluginOwner) {
    const id = ownerKey(owner);
    const pin = this.owners.get(id);
    if (!pin) return;
    this.owners.delete(id);
    await this.releaseOwner(pin.key);
  }
  async retire(userId: string, id: string, latest?: SessionPreset) {
    const current = latest && generationKey(userId, latest);
    for (const [key, generation] of this.generations) {
      if (generation.userId !== userId || generation.presetId !== id || key === current) continue;
      generation.retired = true;
      await this.collect(key, generation);
    }
  }
  async sweep() {
    for (const { owner } of [...this.owners.values()]) {
      const active = this.db.prepare(`SELECT 1 FROM projects p WHERE p.id=? AND p.status<>'archived'
        AND (? IS NULL OR EXISTS(SELECT 1 FROM runs r WHERE r.id=? AND r.project_id=p.id AND r.status IN ('queued','running','waiting','paused')))`)
        .bind(owner.projectId, owner.runId ?? null, owner.runId ?? null).rows().length;
      if (!active) await this.detach(owner);
    }
  }
  async close() {
    this.stopping = true;
    for (const { owner } of [...this.owners.values()]) await this.detach(owner);
    for (const [key, generation] of this.generations) {
      generation.retired = true;
      await this.collect(key, generation);
    }
    await this.host?.dispose();
  }
}

export async function readLocalPlugins(filename: string): Promise<{ plugins: StudioPlugin[]; host: string[] }> {
  try { await stat(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { plugins: [], host: [] };
    throw error;
  }
  const { plugins, host } = await import(pathToFileURL(filename).href);
  if (!Array.isArray(plugins) || host !== undefined && !Array.isArray(host)) throw new AppError("本地扩展声明无效");
  return { plugins, host: host ?? [] };
}
