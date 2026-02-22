import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpenExpertsRuntime } from "../src/runtime/runtime.js";
import type { OpenClawPluginApi } from "../src/openclaw-types.js";

describe("runtime flow", () => {
  it("supports install, list, validate, bind, and activate", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "openexperts-runtime-data-"));
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openexperts-runtime-source-"));
    await createExpertPackage(sourceDir);

    const logs: string[] = [];
    const api: OpenClawPluginApi = {
      logger: {
        info: (msg) => logs.push(msg),
        warn: (msg) => logs.push(msg),
        error: (msg) => logs.push(msg),
      },
      registerCli: () => undefined,
      registerService: () => undefined,
      registerCommand: () => undefined,
      runtime: {
        addCronJob: async () => undefined,
        removeCronJob: async () => undefined,
        addWebhookMapping: async () => undefined,
        removeWebhookMapping: async () => undefined,
      },
    };

    const runtime = new OpenExpertsRuntime(api, { dataDir });
    await runtime.boot();
    expect(await runtime.install(sourceDir)).toContain("Installed");
    expect(await runtime.list()).toContain("demo-expert");

    await runtime.bind("demo-expert", "crm", { type: "skill", skill: "attio" });
    const validate = await runtime.validate("demo-expert");
    expect(validate).toContain("Validation passed");

    const activate = await runtime.activate("demo-expert");
    expect(activate).toContain("Activated");
  });
});

async function createExpertPackage(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "persona"), { recursive: true });
  await fs.mkdir(path.join(root, "functions"), { recursive: true });
  await fs.mkdir(path.join(root, "processes"), { recursive: true });
  await fs.mkdir(path.join(root, "tools"), { recursive: true });
  await fs.mkdir(path.join(root, "state"), { recursive: true });
  await fs.writeFile(
    path.join(root, "expert.yaml"),
    `spec: "1.0"
name: demo-expert
version: "0.1.0"
description: Demo expert
requires:
  tools: [crm]
learning:
  enabled: true
  approval: confirm
components:
  orchestrator: orchestrator.md
  persona: [persona/identity.md]
  functions: [functions/classify.md]
  processes: [processes/triage.md]
  tools: [tools/crm.yaml]
  state: [state/pipeline.md]
`,
    "utf8",
  );
  await fs.writeFile(path.join(root, "orchestrator.md"), "Do work", "utf8");
  await fs.writeFile(path.join(root, "persona", "identity.md"), "You are demo", "utf8");
  await fs.writeFile(
    path.join(root, "functions", "classify.md"),
    `---
name: classify
description: classify things
tools: [crm]
---
Classify`,
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "processes", "triage.md"),
    `---
name: triage
description: triage process
functions: [classify]
tools: [crm]
---
- [ ] crm.get_contact`,
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "tools", "crm.yaml"),
    `name: crm
description: crm
operations:
  - name: get_contact
    description: read
    approval: auto`,
    "utf8",
  );
  await fs.writeFile(path.join(root, "state", "pipeline.md"), "# Pipeline", "utf8");
}
