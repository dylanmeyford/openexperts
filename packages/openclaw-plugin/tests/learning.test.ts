import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LearningService } from "../src/runtime/learning.js";

describe("learning service", () => {
  it("enforces max entries per file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openexperts-learning-"));
    const service = new LearningService(root);
    for (let i = 1; i <= 4; i += 1) {
      await service.appendApprovedLearning(
        "demo-expert",
        {
          scope: "package",
          title: `Entry ${i}`,
          date: "2026-02-22",
          source: "test",
          observation: "obs",
          correction: "corr",
          confidence: "high",
        },
        3,
      );
    }
    const result = await service.loadScopeLearnings("demo-expert", "package");
    expect(result).toContain("Entry 4");
    expect(result).not.toContain("Entry 1");
  });
});
