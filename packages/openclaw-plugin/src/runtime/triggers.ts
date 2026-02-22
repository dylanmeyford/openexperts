import { ConcurrencyQueue } from "./concurrency.js";
import type { ExpertManifest, ExpertTrigger } from "../types.js";
import { readJson, writeJson } from "../fs-utils.js";

interface TriggerInvocationContext {
  trigger: ExpertTrigger;
  payload: Record<string, unknown>;
}

export class TriggerRuntime {
  private readonly dedupe = new Map<string, number>();
  private readonly queue = new ConcurrencyQueue();

  constructor(
    private readonly dedupeWindowMs: number,
    private readonly invokeProcess: (trigger: ExpertTrigger, payload: Record<string, unknown>) => Promise<void>,
    private readonly dedupeStateFile: string,
  ) {}

  async activateManifest(manifest: ExpertManifest): Promise<void> {
    // This function intentionally only validates activation prerequisites.
    // OpenClaw-specific trigger registrations happen in integration adapters.
    for (const trigger of manifest.triggers ?? []) {
      if (trigger.type === "cron" && !trigger.expr) {
        throw new Error(`Trigger '${trigger.name}' is cron but expr is missing`);
      }
      if (trigger.type === "webhook" && !trigger.preset && !trigger.requires_tool) {
        throw new Error(`Trigger '${trigger.name}' must define preset or requires_tool`);
      }
    }
  }

  async onTriggerEvent(manifest: ExpertManifest, context: TriggerInvocationContext): Promise<void> {
    const trigger = context.trigger;
    if (trigger.dedupe_key) {
      const dedupeValue = getByPath(context.payload, trigger.dedupe_key);
      if (typeof dedupeValue === "string" || typeof dedupeValue === "number") {
        const key = `${manifest.name}:${trigger.name}:${String(dedupeValue)}`;
        const ts = this.dedupe.get(key);
        if (ts && Date.now() - ts < this.dedupeWindowMs) {
          return;
        }
        this.dedupe.set(key, Date.now());
        await this.persistDedupe();
      }
    }

    const mode = trigger.concurrency ?? manifest.concurrency?.default ?? "parallel";
    const keyPath = trigger.concurrency_key ?? manifest.concurrency?.key;
    const keyValue = keyPath ? getByPath(context.payload, keyPath) : undefined;
    const queueKey = typeof keyValue === "string" || typeof keyValue === "number" ? String(keyValue) : undefined;

    await this.queue.enqueue(mode, trigger.name, queueKey, async () => {
      await this.invokeProcess(trigger, context.payload);
    });
  }

  cleanupDedupe(): void {
    const now = Date.now();
    for (const [key, ts] of this.dedupe.entries()) {
      if (now - ts > this.dedupeWindowMs) {
        this.dedupe.delete(key);
      }
    }
    void this.persistDedupe();
  }

  async loadPersistedDedupe(): Promise<void> {
    const saved = await readJson<Record<string, number>>(this.dedupeStateFile, {});
    const now = Date.now();
    for (const [key, ts] of Object.entries(saved)) {
      if (now - ts <= this.dedupeWindowMs) {
        this.dedupe.set(key, ts);
      }
    }
  }

  private async persistDedupe(): Promise<void> {
    const data: Record<string, number> = {};
    for (const [key, value] of this.dedupe.entries()) {
      data[key] = value;
    }
    await writeJson(this.dedupeStateFile, data);
  }
}

function getByPath(payload: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let current: unknown = payload;
  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
