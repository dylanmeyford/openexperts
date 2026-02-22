import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/spec/validator.js";
import { loadManifest } from "../src/spec/manifest.js";

describe("manifest validation", () => {
  it("flags unresolved trigger process as error", async () => {
    const root = await makeExpertFixture({
      manifest: `
spec: "1.0"
name: demo-expert
version: "0.1.0"
description: demo
requires:
  tools: [crm]
triggers:
  - name: run
    type: cron
    expr: "* * * * *"
    process: does-not-exist
components:
  orchestrator: orchestrator.md
  persona: [persona/identity.md]
  functions: [functions/fn.md]
  processes: [processes/main.md]
  tools: [tools/crm.yaml]
`,
    });
    const manifest = await loadManifest(root);
    const result = await validateManifest(root, manifest);
    expect(result.ok).toBe(false);
    expect(result.messages.some((msg) => msg.code === "trigger_process_unresolved")).toBe(true);
  });
});

async function makeExpertFixture(input: { manifest: string }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openexperts-validator-"));
  await fs.mkdir(path.join(dir, "persona"), { recursive: true });
  await fs.mkdir(path.join(dir, "functions"), { recursive: true });
  await fs.mkdir(path.join(dir, "processes"), { recursive: true });
  await fs.mkdir(path.join(dir, "tools"), { recursive: true });
  await fs.writeFile(path.join(dir, "expert.yaml"), input.manifest, "utf8");
  await fs.writeFile(path.join(dir, "orchestrator.md"), "# Orchestrator", "utf8");
  await fs.writeFile(path.join(dir, "persona", "identity.md"), "You are expert.", "utf8");
  await fs.writeFile(
    path.join(dir, "functions", "fn.md"),
    `---
name: fn
description: demo
tools: [crm]
---
Do a thing.`,
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "processes", "main.md"),
    `---
name: main
description: demo process
functions: [fn]
tools: [crm]
---
- [ ] Do thing`,
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "tools", "crm.yaml"),
    `name: crm
description: CRM
operations:
  - name: get_contact
    description: read
    approval: auto`,
    "utf8",
  );
  return dir;
}
