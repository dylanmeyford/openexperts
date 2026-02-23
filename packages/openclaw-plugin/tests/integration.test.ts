import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { OpenExpertsRuntime } from "../src/runtime/runtime.js";
import type { OpenClawPluginApi } from "../src/openclaw-types.js";

const FIXTURE_DIR = path.resolve(__dirname, "../../../experts/radiant-sales-expert-fixture");

describe("integration: radiant-sales-expert-fixture", () => {
  let runtime: OpenExpertsRuntime;
  let dataDir: string;
  let logs: string[];

  beforeAll(async () => {
    const stat = await fs.stat(path.join(FIXTURE_DIR, "expert.yaml")).catch(() => null);
    if (!stat) {
      throw new Error(`Fixture not found at ${FIXTURE_DIR}. Run test from repo root.`);
    }
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "openexperts-integration-"));
    logs = [];
    const api: OpenClawPluginApi = {
      config: {
        mcp: { entries: { "nylas-mcp": {}, "google-calendar-mcp": {} } },
        skills: { entries: { attio: {} } },
      },
      logger: {
        info: (msg) => logs.push(String(msg)),
        warn: (msg) => logs.push(`WARN: ${String(msg)}`),
        error: (msg) => logs.push(`ERROR: ${String(msg)}`),
      },
      registerCli: () => undefined,
      registerService: () => undefined,
      registerCommand: () => undefined,
    };
    const openclawConfigPath = path.join(dataDir, "openclaw.json");
    await fs.writeFile(openclawConfigPath, "{}", "utf8");
    runtime = new OpenExpertsRuntime(api, { dataDir, openclawConfigPath });
    await runtime.boot();
  });

  it("installs the fixture package", async () => {
    const result = await runtime.install(FIXTURE_DIR);
    expect(result).toContain("radiant-sales-expert");
    expect(result).toContain("0.1.0");
  });

  it("lists the installed expert with status fields", async () => {
    const list = await runtime.list();
    expect(list).toContain("radiant-sales-expert");
    expect(list).toContain("triggers=");
  });

  it("validates the package structure (phase 1)", async () => {
    const result = await runtime.validate("radiant-sales-expert");
    expect(result).toContain("binding_missing");
  });

  it("binds all three tools", async () => {
    const r1 = await runtime.bind("radiant-sales-expert", "crm", { type: "skill", skill: "attio" });
    expect(r1).toContain("skill:attio");
    const r2 = await runtime.bind("radiant-sales-expert", "email", { type: "mcp", server: "nylas-mcp" });
    expect(r2).toContain("mcp:nylas-mcp");
    const r3 = await runtime.bind("radiant-sales-expert", "calendar", { type: "mcp", server: "google-calendar-mcp" });
    expect(r3).toContain("mcp:google-calendar-mcp");
  });

  it("validates successfully after binding", async () => {
    const result = await runtime.validate("radiant-sales-expert");
    expect(result).not.toContain("ERROR");
    expect(result.toLowerCase()).toContain("passed");
  });

  it("activates the expert", async () => {
    const result = await runtime.activate("radiant-sales-expert");
    expect(result).toContain("Activated");
  });

  it("compiled .lobster files exist for both processes", async () => {
    const compiledDir = path.join(dataDir, "compiled", "radiant-sales-expert");
    const files = await fs.readdir(compiledDir);
    expect(files).toContain("inbound-email-triage.lobster");
    expect(files).toContain("scan-for-opportunities.lobster");
  });

  it("compiled workflow has approval gates on manual/confirm operations", async () => {
    const triageFile = path.join(dataDir, "compiled", "radiant-sales-expert", "inbound-email-triage.lobster");
    const content = await fs.readFile(triageFile, "utf8");
    expect(content).toContain("approval: required");
    expect(content).toContain("email");
  });

  it("state templates were initialized", async () => {
    const stateDir = path.join(dataDir, "state", "radiant-sales-expert", "state");
    const files = await fs.readdir(stateDir);
    expect(files).toContain("pipeline.md");
    expect(files).toContain("session-notes.md");
  });

  it("EXPERTS.md registry was generated", async () => {
    const registryPath = path.join(dataDir, "EXPERTS.md");
    const content = await fs.readFile(registryPath, "utf8");
    expect(content).toContain("radiant-sales-expert");
    expect(content).toContain("0.1.0");
  });

  it("SYSTEM_PROMPT.md was generated with policy tiers", async () => {
    const promptPath = path.join(dataDir, "state", "radiant-sales-expert", "SYSTEM_PROMPT.md");
    const content = await fs.readFile(promptPath, "utf8");
    expect(content).toContain("AUTO");
    expect(content).toContain("MANUAL");
    expect(content).toContain("CONFIRM");
    expect(content).toContain("crm.get_contact");
    expect(content).toContain("email.send");
  });

  it("doctor reports healthy state", async () => {
    const result = await runtime.doctor();
    expect(result).toContain("installed experts: 1");
    expect(result).toContain("compiled workflows fresh:");
  });

  it("binding wizard shows no missing tools after full binding", async () => {
    const result = await runtime.bindingWizard("radiant-sales-expert");
    expect(result).toContain("All required tools are already bound");
  });

  it("learning proposal requires approval when learning.approval is confirm", async () => {
    const result = await runtime.proposeLearning("radiant-sales-expert", {
      scope: "package",
      title: "Test learning",
      source: "test",
      observation: "obs",
      correction: "corr",
      confidence: "high",
    });
    expect(result).toContain("requires approval");
    expect(result).toContain("requestId=");
  });
});
