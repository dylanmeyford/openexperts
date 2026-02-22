import path from "node:path";
import type { OpenClawPluginApi } from "../openclaw-types.js";
import type { ExpertManifest } from "../types.js";
import { readJson, writeJson } from "../fs-utils.js";

interface TriggerRegistrationState {
  experts: Record<string, { cron: string[]; webhook: string[] }>;
}

export class TriggerAdapter {
  private readonly stateFile: string;

  constructor(
    private readonly api: OpenClawPluginApi,
    dataDir: string,
  ) {
    this.stateFile = path.join(dataDir, "trigger-registrations.json");
  }

  async registerForManifest(manifest: ExpertManifest): Promise<void> {
    const state = await this.loadState();
    const previousForExpert = state.experts[manifest.name] ?? { cron: [], webhook: [] };
    await this.clear(previousForExpert);
    const nextForExpert = { cron: [] as string[], webhook: [] as string[] };

    for (const trigger of manifest.triggers ?? []) {
      const id = `${manifest.name}:${trigger.name}`;
      if (trigger.type === "cron" && trigger.expr) {
        if (!this.api.runtime?.addCronJob) {
          throw new Error("OpenClaw runtime API addCronJob is unavailable.");
        }
        await this.api.runtime.addCronJob({
          id,
          expr: trigger.expr,
          tz: trigger.tz,
          payload: {
            expert: manifest.name,
            trigger: trigger.name,
            process: trigger.process,
          },
        });
        nextForExpert.cron.push(id);
        continue;
      }

      if (trigger.type === "webhook") {
        if (!this.api.runtime?.addWebhookMapping) {
          throw new Error("OpenClaw runtime API addWebhookMapping is unavailable.");
        }
        await this.api.runtime.addWebhookMapping({
          id,
          preset: trigger.preset,
          requiresTool: trigger.requires_tool,
          payload: {
            expert: manifest.name,
            trigger: trigger.name,
            process: trigger.process,
          },
        });
        nextForExpert.webhook.push(id);
      }
    }

    state.experts[manifest.name] = nextForExpert;
    await writeJson(this.stateFile, state);
  }

  async getState(): Promise<TriggerRegistrationState> {
    return this.loadState();
  }

  private async loadState(): Promise<TriggerRegistrationState> {
    return readJson<TriggerRegistrationState>(this.stateFile, { experts: {} });
  }

  private async clear(state: { cron: string[]; webhook: string[] }): Promise<void> {
    if (!this.api.runtime?.removeCronJob) {
      throw new Error("OpenClaw runtime API removeCronJob is unavailable.");
    }
    for (const id of state.cron) {
      await this.api.runtime.removeCronJob(id);
    }
    if (!this.api.runtime?.removeWebhookMapping) {
      throw new Error("OpenClaw runtime API removeWebhookMapping is unavailable.");
    }
    for (const id of state.webhook) {
      await this.api.runtime.removeWebhookMapping(id);
    }
  }
}
