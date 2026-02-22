import type { ConcurrencyMode } from "../types.js";

type Task = () => Promise<void>;

export class ConcurrencyQueue {
  private readonly serialQueues = new Map<string, Promise<void>>();
  private readonly serialPerKeyQueues = new Map<string, Promise<void>>();

  async enqueue(mode: ConcurrencyMode, triggerName: string, key: string | undefined, task: Task): Promise<void> {
    if (mode === "parallel") {
      await task();
      return;
    }
    if (mode === "serial") {
      const queueKey = `serial:${triggerName}`;
      await this.chain(this.serialQueues, queueKey, task);
      return;
    }
    const resolved = key ?? `fallback:${triggerName}`;
    await this.chain(this.serialPerKeyQueues, `key:${triggerName}:${resolved}`, task);
  }

  private async chain(map: Map<string, Promise<void>>, key: string, task: Task): Promise<void> {
    const prev = map.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    map.set(
      key,
      next.catch(() => {
        return;
      }),
    );
    await next;
  }
}
