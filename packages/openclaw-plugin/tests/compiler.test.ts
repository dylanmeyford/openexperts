import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileExpertProcessesToLobster } from "../src/runtime/lobster-compiler.js";
import type { ExpertManifest } from "../src/types.js";

describe("lobster compiler", () => {
  it("creates a lobster file per process", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openexperts-compiler-"));
    const compiled = await fs.mkdtemp(path.join(os.tmpdir(), "openexperts-compiled-"));
    await fs.mkdir(path.join(root, "processes"), { recursive: true });
    await fs.writeFile(
      path.join(root, "processes", "triage.md"),
      `---
name: inbound-triage
description: test
---
- [ ] Fetch record
- [ ] Write response`,
      "utf8",
    );
    const manifest: ExpertManifest = {
      spec: "1.0",
      name: "demo",
      version: "0.1.0",
      description: "x",
      components: {
        orchestrator: "orchestrator.md",
        persona: ["persona/identity.md"],
        functions: [],
        processes: ["processes/triage.md"],
      },
    };
    const out = await compileExpertProcessesToLobster(root, compiled, manifest, {
      tools: {
        crm: { type: "mcp", server: "crm-mcp" },
      },
    });
    expect(out).toHaveLength(1);
    const file = await fs.readFile(out[0].outputPath, "utf8");
    expect(file).toContain("name: inbound-triage");
    expect(file).toContain("step_1");
  });
});
