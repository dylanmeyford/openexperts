import os from "node:os";
import path from "node:path";
import type { ExpertManifest } from "../types.js";
import type { OpenClawCronJob, OpenClawPluginApi } from "../openclaw-types.js";
import { exists, readJson, readUtf8, writeJson, writeUtf8 } from "../fs-utils.js";

interface TriggerRegistrationState {
  experts: Record<string, { cron: string[]; webhook: string[] }>;
}

interface ConfigPatchEntry {
  section: string;
  key: string;
  value: unknown;
  description: string;
}

export interface TriggerConfigResult {
  applied: ConfigPatchEntry[];
  needsRestart: boolean;
  warnings: string[];
}

export class TriggerAdapter {
  private readonly stateFile: string;
  private readonly configPathOverride?: string;
  private readonly cronApi: {
    add?: (job: OpenClawCronJob) => Promise<unknown> | unknown;
    remove?: (id: string) => Promise<unknown> | unknown;
  };
  private readonly logger?: OpenClawPluginApi["logger"];

  constructor(dataDir: string, configPathOverride?: string, api?: OpenClawPluginApi) {
    this.stateFile = path.join(dataDir, "trigger-registrations.json");
    this.configPathOverride = configPathOverride;
    this.cronApi = {
      add: api?.cron?.add ?? api?.gateway?.cron?.add,
      remove: api?.cron?.remove ?? api?.gateway?.cron?.remove,
    };
    this.logger = api?.logger;
  }

  async registerForManifest(manifest: ExpertManifest): Promise<TriggerConfigResult> {
    const configPath = this.configPathOverride ?? resolveOpenClawConfigPath();
    const config = await readJson<Record<string, unknown>>(configPath, {});
    const entries: ConfigPatchEntry[] = [];
    const warnings: string[] = [];
    let configMutated = false;
    const nextForExpert = { cron: [] as string[], webhook: [] as string[] };

    const state = await this.loadState();
    const prev = state.experts[manifest.name];
    if (prev) {
      await this.removePreviousEntries(config, prev);
    }

    for (const trigger of manifest.triggers ?? []) {
      const id = `${manifest.name}:${trigger.name}`;

      if (trigger.type === "cron" && trigger.expr) {
        const job: OpenClawCronJob = {
          id,
          schedule: { kind: "cron", expr: trigger.expr, tz: trigger.tz ?? "UTC" },
          task: `Run expert process: ${trigger.process}`,
          sessionTarget: trigger.session === "main" ? "main" : "isolated",
          payload: {
            kind: "systemEvent",
            expert: manifest.name,
            trigger: trigger.name,
            process: trigger.process,
          },
          delivery: { mode: "announce" },
        };
        if (this.cronApi.add) {
          try {
            await this.cronApi.add(job);
            entries.push({
              section: "cron",
              key: id,
              value: job,
              description: `registered via cron API: ${trigger.expr} ${trigger.tz ?? "UTC"} → ${trigger.process}`,
            });
            nextForExpert.cron.push(id);
          } catch (error) {
            this.logger?.warn(
              `Failed to register cron trigger ${id} via API: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } else {
          this.logger?.warn(`Cron API unavailable; skipped cron trigger registration for ${id}`);
        }
        continue;
      }

      if (trigger.type === "webhook") {
        ensureObj(config, "hooks");
        const hooks = config.hooks as Record<string, unknown>;
        if (trigger.preset) {
          const presets = ensureStringArray(hooks, "presets");
          if (!presets.includes(trigger.preset)) {
            presets.push(trigger.preset);
            entries.push({
              section: "hooks",
              key: "presets",
              value: [...presets],
              description: `enabled preset '${trigger.preset}' for webhook source`,
            });
            configMutated = true;
          }
        }
        const hasHooksToken = typeof hooks.token === "string" && hooks.token.trim().length > 0;
        if (hasHooksToken && hooks.enabled !== true) {
          hooks.enabled = true;
          entries.push({
            section: "hooks",
            key: "enabled",
            value: true,
            description: "enabled for webhook trigger support",
          });
          configMutated = true;
        }
        if (!hasHooksToken) {
          warnings.push(
            `Webhook trigger '${id}' not auto-enabled: set hooks.token before enabling hooks for webhook delivery.`,
          );
        }
        warnings.push(
          `Webhook trigger '${id}' not auto-registered: OpenClaw hooks.mappings schema is not compatible with OpenExperts process routing in this version.`,
        );
      }
    }

    if (configMutated) {
      await writeOpenClawConfig(configPath, config);
    }

    state.experts[manifest.name] = nextForExpert;
    await writeJson(this.stateFile, state);

    return { applied: entries, needsRestart: configMutated, warnings };
  }

  async getState(): Promise<TriggerRegistrationState> {
    return this.loadState();
  }

  private async loadState(): Promise<TriggerRegistrationState> {
    return readJson<TriggerRegistrationState>(this.stateFile, { experts: {} });
  }

  private async removePreviousEntries(config: Record<string, unknown>, prev: { cron: string[]; webhook: string[] }): Promise<void> {
    for (const id of prev.cron) {
      if (this.cronApi.remove) {
        await Promise.resolve(this.cronApi.remove(id)).catch((error) => {
          this.logger?.warn(
            `Failed to remove prior cron trigger ${id} via API: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      const jobs = deepGet(config, ["cron", "jobs"]) as Record<string, unknown> | undefined;
      if (jobs) {
        delete jobs[id];
      }
    }
    for (const id of prev.webhook) {
      const mappings = deepGet(config, ["hooks", "mappings"]);
      if (Array.isArray(mappings)) {
        const filtered = mappings.filter((entry) => {
          if (!entry || typeof entry !== "object") {
            return true;
          }
          return (entry as { id?: unknown }).id !== id;
        });
        ensureObj(config, "hooks");
        (config.hooks as Record<string, unknown>).mappings = filtered;
        continue;
      }
      if (mappings && typeof mappings === "object") {
        delete (mappings as Record<string, unknown>)[id];
      }
    }
  }
}

function resolveOpenClawConfigPath(): string {
  const envPath = process.env.OPENCLAW_CONFIG;
  if (envPath) {
    return envPath;
  }
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

async function writeOpenClawConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
  const raw = await readUtf8(configPath).catch(() => "");
  if (raw.includes("//")) {
    await writeUtf8(configPath, JSON.stringify(config, null, 2));
  } else {
    await writeUtf8(configPath, JSON.stringify(config, null, 2));
  }
}

function ensureObj(parent: Record<string, unknown>, key: string): void {
  if (!parent[key] || typeof parent[key] !== "object" || Array.isArray(parent[key])) {
    parent[key] = {};
  }
}

function ensureStringArray(parent: Record<string, unknown>, key: string): string[] {
  const existing = parent[key];
  if (!Array.isArray(existing)) {
    parent[key] = [];
    return parent[key] as string[];
  }
  const next = existing.filter((item): item is string => typeof item === "string");
  if (next.length !== existing.length) {
    parent[key] = next;
    return next;
  }
  return existing as string[];
}

function deepGet(obj: Record<string, unknown>, keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
