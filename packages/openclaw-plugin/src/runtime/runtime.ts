import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfig, getRuntimePaths, type RuntimeConfig, type RuntimePaths } from "../config.js";
import type { OpenClawPluginApi } from "../openclaw-types.js";
import { installExpertPackage, listInstalledExperts, resolveInstallSource } from "../install/installer.js";
import { loadManifest } from "../spec/manifest.js";
import { validateManifest } from "../spec/validator.js";
import { readBindings, upsertBinding, validateBindings, validateBindingReachability } from "../bindings/store.js";
import { buildBindingPrompts } from "../bindings/wizard.js";
import { initializeStateTemplates, resetSessionScopedState } from "../state/lifecycle.js";
import { compileExpertProcessesToLobster } from "./lobster-compiler.js";
import { assembleSystemPrompt } from "./prompt.js";
import { ApprovalService } from "./approvals.js";
import { ProcessExecutor } from "./executor.js";
import { TriggerRuntime } from "./triggers.js";
import { TriggerAdapter } from "./trigger-adapter.js";
import { LearningService } from "./learning.js";
import { writeExpertsRegistry } from "../registry/experts-md.js";
import type { BindingFile, ExpertManifest, ToolBinding } from "../types.js";
import { ensureDir, exists, writeUtf8 } from "../fs-utils.js";

export class OpenExpertsRuntime {
  readonly cfg: RuntimeConfig;
  readonly paths: RuntimePaths;
  readonly approvals: ApprovalService;
  readonly learningService: LearningService;
  readonly triggerRuntime: TriggerRuntime;
  readonly executor: ProcessExecutor;
  readonly triggerAdapter: TriggerAdapter;
  private readonly activeManifests = new Map<string, ExpertManifest>();

  constructor(private readonly api: OpenClawPluginApi, rawConfig: unknown) {
    this.cfg = resolveConfig(rawConfig);
    this.paths = getRuntimePaths(this.cfg);
    this.approvals = new ApprovalService(this.paths.approvalsDir);
    this.learningService = new LearningService(this.paths.learningsDir);
    this.executor = new ProcessExecutor(
      this.approvals,
      async (requestId, prompt) => {
        this.api.logger.info(`approval_required id=${requestId} prompt=${prompt}`);
      },
      this.cfg.lobsterTimeoutMs,
    );
    this.triggerRuntime = new TriggerRuntime(this.cfg.dedupeWindowMs, async (trigger, payload) => {
      const expert = String(payload.__expert ?? "");
      if (!expert) {
        this.api.logger.warn(`trigger_invoked_without_expert trigger=${trigger.name}`);
        return;
      }
      await this.run(expert, trigger.process, JSON.stringify(payload));
    }, path.join(this.cfg.dataDir, "dedupe-state.json"));
    this.triggerAdapter = new TriggerAdapter(this.api, this.cfg.dataDir);
  }

  async boot(): Promise<void> {
    await Promise.all([
      ensureDir(this.paths.expertsDir),
      ensureDir(this.paths.configDir),
      ensureDir(this.paths.stateDir),
      ensureDir(this.paths.compiledDir),
      ensureDir(this.paths.learningsDir),
      ensureDir(this.paths.approvalsDir),
    ]);
    await this.triggerRuntime.loadPersistedDedupe();
  }

  async install(sourceInput: string, options?: { linkLocal?: boolean }): Promise<string> {
    const source = resolveInstallSource(sourceInput);
    const rootDir = await installExpertPackage(source, this.paths.expertsDir, options);
    const manifest = await loadManifest(rootDir);
    return `Installed ${manifest.name}@${manifest.version} from ${source.type}`;
  }

  async list(): Promise<string> {
    const experts = await listInstalledExperts(this.paths.expertsDir);
    if (experts.length === 0) {
      return "No experts installed.";
    }
    const triggerState = await this.triggerAdapter.getState();
    const rows: string[] = [];
    for (const exp of experts) {
      const manifest = await loadManifest(exp.rootDir);
      const bindings = await readBindings(this.paths.configDir, manifest.name);
      const required = manifest.requires?.tools ?? [];
      const bound = required.filter((tool) => Boolean(bindings.tools[tool]));
      const active = Boolean(triggerState.experts[manifest.name]);
      rows.push(
        `- ${exp.name}@${exp.version} status=${active ? "active" : "installed"} bound=${bound.length}/${required.length} triggers=${(manifest.triggers ?? []).length}`,
      );
    }
    return rows.join("\n");
  }

  async validate(expertName: string): Promise<string> {
    const expertDir = await this.findExpertDir(expertName);
    const manifest = await loadManifest(expertDir);
    const base = await validateManifest(expertDir, manifest);
    const bindings = await readBindings(this.paths.configDir, manifest.name);
    const bindingMessages = validateBindings(manifest, bindings);
    const reachabilityMessages = validateBindingReachability(bindings, this.api.config);
    const all = [...base.messages, ...bindingMessages, ...reachabilityMessages];
    if (all.length === 0) {
      return "Validation passed with no issues.";
    }
    const summary = all.map((msg) => `${msg.severity.toUpperCase()} [${msg.code}] ${msg.message}`).join("\n");
    const failed = all.some((msg) => msg.severity === "error");
    return `${failed ? "Validation failed" : "Validation passed with warnings"}\n${summary}`;
  }

  async bind(expertName: string, toolName: string, binding: ToolBinding): Promise<string> {
    await upsertBinding(this.paths.configDir, expertName, toolName, binding);
    return `Bound ${toolName} for ${expertName} to ${binding.type === "mcp" ? `mcp:${binding.server}` : `skill:${binding.skill}`}`;
  }

  async activate(expertName: string): Promise<string> {
    const expertDir = await this.findExpertDir(expertName);
    const manifest = await loadManifest(expertDir);
    const validation = await validateManifest(expertDir, manifest);
    const bindings = await readBindings(this.paths.configDir, manifest.name);
    const bindingMessages = validateBindings(manifest, bindings);
    const reachabilityMessages = validateBindingReachability(bindings, this.api.config);
    if (!validation.ok || [...bindingMessages, ...reachabilityMessages].some((m) => m.severity === "error")) {
      throw new Error(`Activation blocked: run 'openclaw expert validate ${expertName}' first.`);
    }

    await initializeStateTemplates(expertDir, this.paths.stateDir, manifest.name);
    await compileExpertProcessesToLobster(expertDir, this.paths.compiledDir, manifest, bindings);
    await this.triggerRuntime.activateManifest(manifest);
    await this.triggerAdapter.registerForManifest(manifest);
    this.activeManifests.set(manifest.name, manifest);

    const learningSnippet = await this.learningService.loadScopeLearnings(manifest.name, "package");
    const prompt = await assembleSystemPrompt({
      expertDir,
      manifest,
      bindings,
      learningsPackageSnippet: learningSnippet,
    });
    await writeUtf8(path.join(this.paths.stateDir, manifest.name, "SYSTEM_PROMPT.md"), prompt);
    await this.refreshRegistry();
    return `Activated ${manifest.name}.`;
  }

  async bindingWizard(expertName: string): Promise<string> {
    const expertDir = await this.findExpertDir(expertName);
    const manifest = await loadManifest(expertDir);
    const bindings = await readBindings(this.paths.configDir, manifest.name);
    const prompts = buildBindingPrompts(manifest, bindings);
    if (prompts.length === 0) {
      return "All required tools are already bound.";
    }
    return prompts.map((p) => p.prompt).join("\n\n");
  }

  async run(expertName: string, processName: string, payloadRaw?: string): Promise<string> {
    const expertDir = await this.findExpertDir(expertName);
    const manifest = await loadManifest(expertDir);
    await resetSessionScopedState(expertDir, this.paths.stateDir, manifest.name);
    const payload = safeJson(payloadRaw);
    const result = await this.executor.run({
      expertName: manifest.name,
      processName,
      compiledDir: this.paths.compiledDir,
      payload,
      manifest,
    });
    if (!result.ok) {
      return `Run failed: ${result.error}`;
    }
    return result.output ?? "Run complete.";
  }

  async doctor(): Promise<string> {
    const lines: string[] = [];
    lines.push(`dataDir: ${this.cfg.dataDir}`);
    for (const [label, p] of Object.entries(this.paths)) {
      lines.push(`${label}: ${(await exists(p)) ? "ok" : "missing"} (${p})`);
    }
    lines.push(`pending approvals: ${(await this.approvals.listPending()).length}`);
    const experts = await listInstalledExperts(this.paths.expertsDir);
    lines.push(`installed experts: ${experts.length}`);
    lines.push(`lobster: ${await checkCommandVersion("lobster", ["--version"])}`);
    lines.push(`llm-task enabled: ${configPathBoolean(this.api.config, ["plugins", "entries", "llm-task", "enabled"])}`);
    const alsoAllow = configPathArray(this.api.config, ["tools", "alsoAllow"]);
    lines.push(`tools.alsoAllow has lobster: ${alsoAllow.includes("lobster")}`);
    lines.push(`tools.alsoAllow has llm-task: ${alsoAllow.includes("llm-task")}`);
    lines.push(`sandbox.network: ${resolveSandboxNetwork(this.api.config)}`);
    if (resolveSandboxNetwork(this.api.config) === "none") {
      lines.push("WARN sandbox network is none; MCP/external tools may fail.");
    }
    const triggerState = await this.triggerAdapter.getState();
    const cronCount = Object.values(triggerState.experts).reduce((sum, row) => sum + row.cron.length, 0);
    const webhookCount = Object.values(triggerState.experts).reduce((sum, row) => sum + row.webhook.length, 0);
    lines.push(`registered cron triggers: ${cronCount}`);
    lines.push(`registered webhook triggers: ${webhookCount}`);
    const freshness = await this.compiledFreshnessSummary();
    lines.push(`compiled workflows fresh: ${freshness.fresh}/${freshness.total}`);
    if (freshness.stale.length > 0) {
      lines.push(`stale workflows: ${freshness.stale.join(", ")}`);
    }
    const promptWarnings = await this.promptBudgetWarnings();
    lines.push(...promptWarnings);
    return lines.join("\n");
  }

  async approve(requestId: string): Promise<string> {
    const result = await this.executor.resume(requestId, true);
    return result.ok ? `Approved request ${requestId}. ${result.output ?? ""}` : `Approval failed: ${result.error}`;
  }

  async reject(requestId: string): Promise<string> {
    const result = await this.executor.resume(requestId, false);
    return result.ok ? `Rejected request ${requestId}.` : `Reject failed: ${result.error}`;
  }

  async processApprovalTimeouts(): Promise<void> {
    const expired = await this.approvals.expireTimedOut();
    for (const req of expired) {
      this.api.logger.warn(`approval_timed_out id=${req.id} operation=${req.operation}`);
    }
  }

  async onGatewayStartup(): Promise<void> {
    this.triggerRuntime.cleanupDedupe();
    const records = await listInstalledExperts(this.paths.expertsDir);
    for (const record of records) {
      const manifest = await loadManifest(record.rootDir);
      this.activeManifests.set(manifest.name, manifest);
    }
  }

  async onMessageReceived(event: unknown): Promise<void> {
    const payload = normalizeMessagePayload(event);
    for (const manifest of this.activeManifests.values()) {
      for (const trigger of manifest.triggers ?? []) {
        if (trigger.type !== "channel") {
          continue;
        }
        const enriched = {
          ...payload,
          __expert: manifest.name,
          __trigger: trigger.name,
        };
        await this.triggerRuntime.onTriggerEvent(manifest, {
          trigger,
          payload: enriched,
        });
      }
    }
  }

  async beforePromptBuild(event: unknown): Promise<void> {
    const targetExpert = resolveExpertFromPromptEvent(event);
    if (!targetExpert) {
      return;
    }
    const expertDir = await this.findExpertDir(targetExpert);
    const manifest = await loadManifest(expertDir);
    const bindings = await readBindings(this.paths.configDir, manifest.name);
    const learnings = await this.learningService.loadScopeLearnings(manifest.name, "package");
    const prompt = await assembleSystemPrompt({
      expertDir,
      manifest,
      bindings,
      learningsPackageSnippet: learnings,
    });
    appendPromptContext(event, prompt);
  }

  async proposeLearning(expertName: string, proposal: {
    scope: string;
    title: string;
    source: string;
    observation: string;
    correction: string;
    confidence: "high" | "medium" | "low";
  }): Promise<string> {
    const expertDir = await this.findExpertDir(expertName);
    const manifest = await loadManifest(expertDir);
    const enabled = manifest.learning?.enabled ?? false;
    if (!enabled) {
      return "Learning is disabled for this expert.";
    }
    const approval = manifest.learning?.approval ?? "confirm";
    const maxEntries = manifest.learning?.max_entries_per_file ?? 50;
    const draft = {
      ...proposal,
      scope: proposal.scope === "package" ? "package" : proposal.scope,
      date: new Date().toISOString().slice(0, 10),
    };

    if (approval === "auto") {
      await this.learningService.appendApprovedLearning(manifest.name, draft, maxEntries);
      return "Learning saved automatically.";
    }

    if (approval === "manual") {
      return `Learning draft ready (manual): ${draft.title}`;
    }

    const request = await this.approvals.createRequest({
      expertName: manifest.name,
      operation: `learning.persist`,
      tier: "confirm",
      reason: `Learning proposal: ${draft.title}`,
      payload: draft,
    });
    return `Learning requires approval. requestId=${request.id}`;
  }

  async applyApprovedLearning(requestId: string): Promise<string> {
    const pending = await this.approvals.listPending();
    const request = pending.find((entry) => entry.id === requestId);
    if (!request) {
      return `No pending request ${requestId}.`;
    }
    if (request.operation !== "learning.persist") {
      return `Request ${requestId} is not a learning proposal.`;
    }
    const expertName = request.expertName;
    const expertDir = await this.findExpertDir(expertName);
    const manifest = await loadManifest(expertDir);
    const maxEntries = manifest.learning?.max_entries_per_file ?? 50;
    const payload = request.payload as {
      scope: string;
      title: string;
      date: string;
      source: string;
      observation: string;
      correction: string;
      confidence: "high" | "medium" | "low";
    };
    await this.learningService.appendApprovedLearning(expertName, payload, maxEntries);
    await this.approvals.resolve(requestId);
    return `Learning applied for ${expertName}.`;
  }

  async setup(): Promise<string> {
    const checks: string[] = [];
    let lobster = await checkCommandVersion("lobster", ["--version"]);
    if (lobster === "missing") {
      const installed = await installLobsterFromGitHub();
      checks.push(installed ? "Installed lobster from github:openclaw/lobster." : "Failed to auto-install lobster; install manually.");
      lobster = await checkCommandVersion("lobster", ["--version"]);
    }
    checks.push(`lobster: ${lobster}`);
    const llmEnabled = configPathBoolean(this.api.config, ["plugins", "entries", "llm-task", "enabled"]);
    const allow = configPathArray(this.api.config, ["tools", "alsoAllow"]);
    const hasLobster = allow.includes("lobster");
    const hasLlmTask = allow.includes("llm-task");
    checks.push(`llm-task enabled: ${llmEnabled}`);
    checks.push(`tools.alsoAllow contains lobster: ${hasLobster}`);
    checks.push(`tools.alsoAllow contains llm-task: ${hasLlmTask}`);
    const webhookNeeded = await this.anyWebhookTriggers();
    if (this.api.runtime?.updateConfig) {
      const nextAllow = Array.from(new Set([...allow, "lobster", "llm-task"]));
      await this.api.runtime.updateConfig({
        tools: { alsoAllow: nextAllow },
        plugins: {
          entries: {
            "llm-task": { enabled: true },
          },
        },
        ...(webhookNeeded
          ? {
              hooks: {
                enabled: true,
              },
            }
          : {}),
      });
      checks.push("Applied config patch: enabled llm-task and allowlisted lobster/llm-task.");
      if (webhookNeeded) {
        checks.push("Webhook triggers detected: enabled hooks. Ensure hooks token is configured.");
      }
    } else {
      checks.push("Runtime config patch API unavailable; apply config manually.");
    }
    return checks.join("\n");
  }

  private async refreshRegistry(): Promise<void> {
    const records = await listInstalledExperts(this.paths.expertsDir);
    const entries: Array<{ record: { name: string; version: string; description: string; rootDir: string }; manifest: ExpertManifest; bindings: BindingFile }> =
      [];
    for (const record of records) {
      const manifest = await loadManifest(record.rootDir);
      const bindings = await readBindings(this.paths.configDir, record.name);
      entries.push({ record, manifest, bindings });
    }
    await writeExpertsRegistry(this.paths.registryFile, entries);
  }

  private async findExpertDir(expertName: string): Promise<string> {
    const direct = path.join(this.paths.expertsDir, expertName);
    if (await exists(path.join(direct, "expert.yaml"))) {
      return direct;
    }
    const entries = await fs.readdir(this.paths.expertsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = path.join(this.paths.expertsDir, entry.name);
      const manifestPath = path.join(dir, "expert.yaml");
      if (!(await exists(manifestPath))) {
        continue;
      }
      const manifest = await loadManifest(dir);
      if (manifest.name === expertName) {
        return dir;
      }
    }
    throw new Error(`Expert '${expertName}' not found under ${this.paths.expertsDir}`);
  }

  private async anyWebhookTriggers(): Promise<boolean> {
    const records = await listInstalledExperts(this.paths.expertsDir);
    for (const record of records) {
      const manifest = await loadManifest(record.rootDir);
      if ((manifest.triggers ?? []).some((trigger) => trigger.type === "webhook")) {
        return true;
      }
    }
    return false;
  }

  private async compiledFreshnessSummary(): Promise<{ fresh: number; total: number; stale: string[] }> {
    const records = await listInstalledExperts(this.paths.expertsDir);
    let fresh = 0;
    let total = 0;
    const stale: string[] = [];
    for (const record of records) {
      const manifest = await loadManifest(record.rootDir);
      for (const processPath of manifest.components.processes ?? []) {
        total += 1;
        const absProcess = path.join(record.rootDir, processPath);
        const processName = path.basename(processPath, path.extname(processPath));
        const compiled = path.join(this.paths.compiledDir, manifest.name, `${processName}.lobster`);
        if (!(await exists(compiled))) {
          stale.push(`${manifest.name}/${processName}`);
          continue;
        }
        const [srcStat, outStat] = await Promise.all([fs.stat(absProcess), fs.stat(compiled)]);
        if (outStat.mtimeMs >= srcStat.mtimeMs) {
          fresh += 1;
        } else {
          stale.push(`${manifest.name}/${processName}`);
        }
      }
    }
    return { fresh, total, stale };
  }

  private async promptBudgetWarnings(): Promise<string[]> {
    const warnings: string[] = [];
    const records = await listInstalledExperts(this.paths.expertsDir);
    for (const record of records) {
      const manifest = await loadManifest(record.rootDir);
      const bindings = await readBindings(this.paths.configDir, record.name);
      const prompt = await assembleSystemPrompt({
        expertDir: record.rootDir,
        manifest,
        bindings,
      });
      if (prompt.length > 20000) {
        warnings.push(`WARN prompt budget exceeded for ${record.name}: ${prompt.length} chars`);
      }
    }
    return warnings;
  }
}

function safeJson(raw?: string): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function checkCommandVersion(command: string, args: string[]): Promise<string> {
  try {
    const { spawn } = await import("node:child_process");
    const output = await new Promise<string>((resolve) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += String(d);
      });
      child.stderr.on("data", (d) => {
        stderr += String(d);
      });
      child.on("error", () => resolve("missing"));
      child.on("exit", (code) => resolve(code === 0 ? (stdout || stderr).trim() || "ok" : "missing"));
    });
    return output;
  } catch {
    return "missing";
  }
}

function configPathBoolean(source: unknown, pathParts: string[]): boolean {
  let current: unknown = source;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current === true;
}

function configPathArray(source: unknown, pathParts: string[]): string[] {
  let current: unknown = source;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") {
      return [];
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (!Array.isArray(current)) {
    return [];
  }
  return current.filter((value): value is string => typeof value === "string");
}

function resolveSandboxNetwork(source: unknown): string {
  let current: unknown = source;
  for (const key of ["sandbox", "docker", "network"]) {
    if (!current || typeof current !== "object") {
      return "unknown";
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : "unknown";
}

async function installLobsterFromGitHub(): Promise<boolean> {
  try {
    const { spawn } = await import("node:child_process");
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn("npm", ["install", "-g", "github:openclaw/lobster"], {
        stdio: "ignore",
      });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
    return ok;
  } catch {
    return false;
  }
}

function normalizeMessagePayload(event: unknown): Record<string, unknown> {
  const e = (event ?? {}) as {
    context?: {
      from?: string;
      content?: string;
      channelId?: string;
    };
  };
  return {
    sender_id: e.context?.from ?? "unknown",
    message_text: e.context?.content ?? "",
    channel_name: e.context?.channelId ?? "unknown",
  };
}

function resolveExpertFromPromptEvent(event: unknown): string | undefined {
  const e = (event ?? {}) as {
    context?: {
      sessionKey?: string;
    };
  };
  const key = e.context?.sessionKey;
  if (!key) {
    return undefined;
  }
  const match = key.match(/expert:([a-zA-Z0-9_-]+)/);
  return match?.[1];
}

function appendPromptContext(event: unknown, context: string): void {
  const e = event as {
    context?: {
      prependContext?: string[];
    };
  };
  if (!e.context) {
    return;
  }
  e.context.prependContext = [...(e.context.prependContext ?? []), context];
}
