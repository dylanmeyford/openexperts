import { describe, expect, it } from "vitest";
import { ConcurrencyQueue } from "../src/runtime/concurrency.js";

describe("concurrency queue", () => {
  it("serializes same key work while allowing other keys", async () => {
    const queue = new ConcurrencyQueue();
    const events: string[] = [];

    const task = (label: string, delay: number) => async () => {
      events.push(`start:${label}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      events.push(`end:${label}`);
    };

    await Promise.all([
      queue.enqueue("serial_per_key", "t", "a", task("a1", 30)),
      queue.enqueue("serial_per_key", "t", "a", task("a2", 1)),
      queue.enqueue("serial_per_key", "t", "b", task("b1", 1)),
    ]);

    const a1Start = events.indexOf("start:a1");
    const a1End = events.indexOf("end:a1");
    const a2Start = events.indexOf("start:a2");
    expect(a1Start).toBeGreaterThanOrEqual(0);
    expect(a1End).toBeGreaterThan(a1Start);
    expect(a2Start).toBeGreaterThan(a1End);
  });
});
