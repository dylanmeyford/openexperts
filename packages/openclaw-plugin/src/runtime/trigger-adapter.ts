import os from "node:os";
import path from "node:path";
import type { ExpertManifest } from "../types.js";
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
}

export class TriggerAdapter {
  private readonly stateFile: string;
  private readonly configPathOverride?: string;

  constructor(dataDir: string, configPathOverride?: string) {
    this.stateFile = path.join(dataDir, "trigger-registrations.json");
    this.configPathOverride = configPathOverride;
  }

  async registerForManifest(manifest: ExpertManifest): Promise<TriggerConfigResult> {
    const configPath = this.configPathOverride ?? resolveOpenClawConfigPath();
    const config = await readJson<Record<string, unknown>>(configPath, {});
    const entries: ConfigPatchEntry[] = [];
    const nextForExpert = { cron: [] as string[], webhook: [] as string[] };

    const state = await this.loadState();
    const prev = state.experts[manifest.name];
    if (prev) {
      this.removePreviousEntries(config, prev);
    }

    for (const trigger of manifest.triggers ?? []) {
      const id = `${manifest.name}:${trigger.name}`;

      if (trigger.type === "cron" && trigger.expr) {
        ensureObj(config, "cron");
        ensureObj(config.cron as Record<string, unknown>, "jobs");
        const jobs = (config.cron as Record<string, unknown>).jobs as Record<string, unknown>;
        jobs[id] = {
          schedule: { kind: "cron", expr: trigger.expr, tz: trigger.tz ?? "UTC" },
          task: `Run expert process: ${trigger.process}`,
          delivery: { mode: "announce" },
          sessionTarget: trigger.session === "main" ? "main" : "isolated",
          payload: {
            kind: "systemEvent",
            expert: manifest.name,
            trigger: trigger.name,
            process: trigger.process,
          },
        };
        (config.cron as Record<string, unknown>).enabled = true;
        entries.push({
          section: "cron.jobs",
          key: id,
          value: jobs[id],
          description: `${trigger.expr} ${trigger.tz ?? "UTC"} → ${trigger.process}`,
        });
        nextForExpert.cron.push(id);
        continue;
      }

      if (trigger.type === "webhook") {
        ensureObj(config, "hooks");
        const hooks = config.hooks as Record<string, unknown>;
        hooks.enabled = true;
        ensureObj(hooks, "mappings");
        const mappings = hooks.mappings as Record<string, unknown>;
        const mapping: Record<string, unknown> = {
          expert: manifest.name,
          trigger: trigger.name,
          process: trigger.process,
        };
        if (trigger.preset) {
          mapping.preset = trigger.preset;
        }
        if (trigger.requires_tool) {
          mapping.requiresTool = trigger.requires_tool;
        }
        mappings[id] = mapping;
        entries.push({
          section: "hooks.mappings",
          key: id,
          value: mapping,
          description: `${trigger.preset ?? trigger.requires_tool ?? "custom"} → ${trigger.process}`,
        });
        nextForExpert.webhook.push(id);
      }
    }

    if (entries.length > 0) {
      await writeOpenClawConfig(configPath, config);
    }

    state.experts[manifest.name] = nextForExpert;
    await writeJson(this.stateFile, state);

    return { applied: entries, needsRestart: entries.length > 0 };
  }

  async getState(): Promise<TriggerRegistrationState> {
    return this.loadState();
  }

  private async loadState(): Promise<TriggerRegistrationState> {
    return readJson<TriggerRegistrationState>(this.stateFile, { experts: {} });
  }

  private removePreviousEntries(config: Record<string, unknown>, prev: { cron: string[]; webhook: string[] }): void {
    for (const id of prev.cron) {
      const jobs = deepGet(config, ["cron", "jobs"]) as Record<string, unknown> | undefined;
      if (jobs) {
        delete jobs[id];
      }
    }
    for (const id of prev.webhook) {
      const mappings = deepGet(config, ["hooks", "mappings"]) as Record<string, unknown> | undefined;
      if (mappings) {
        delete mappings[id];
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
