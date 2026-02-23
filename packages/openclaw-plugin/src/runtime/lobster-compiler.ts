import path from "node:path";
import yaml from "js-yaml";
import { ensureDir, readUtf8, writeUtf8 } from "../fs-utils.js";
import type { BindingFile, ExpertManifest } from "../types.js";
import { parseMarkdownFrontmatter } from "../spec/components.js";

export interface CompileResult {
  processName: string;
  outputPath: string;
}

interface LobsterStep {
  id: string;
  command: string;
  approval?: "required";
  operation?: string;
}

interface LobsterWorkflow {
  name: string;
  args?: Record<string, { type: string }>;
  steps: LobsterStep[];
}

interface ToolMeta {
  operations: Map<string, { inputSchema?: Record<string, unknown> }>;
}

export async function compileExpertProcessesToLobster(
  expertDir: string,
  compiledDir: string,
  manifest: ExpertManifest,
  bindings: BindingFile,
): Promise<CompileResult[]> {
  const outDir = path.join(compiledDir, manifest.name);
  await ensureDir(outDir);
  const adapterPath = path.join(outDir, "openexperts-exec.mjs");
  await writeUtf8(adapterPath, OPENEXPERTS_EXEC_SOURCE);
  const results: CompileResult[] = [];
  for (const processRel of manifest.components.processes ?? []) {
    const processPath = path.join(expertDir, processRel);
    const content = await readUtf8(processPath);
    const frontmatter = (await parseMarkdownFrontmatter(processPath)) ?? {};
    const processName = typeof frontmatter.name === "string" ? frontmatter.name : path.basename(processRel, path.extname(processRel));
    const checklist = extractChecklistSteps(content);
    const contextFiles = asStringArray(frontmatter.context);
    const processFunctions = asStringArray(frontmatter.functions);
    const processInputs = normalizeInputs(frontmatter.inputs);
    const scratchpadPattern = typeof frontmatter.scratchpad === "string" ? frontmatter.scratchpad : undefined;
    const functionMeta = await loadFunctionMeta(expertDir, manifest.components.functions ?? []);
    const toolMeta = await loadToolMeta(expertDir, manifest.components.tools ?? []);

    const preSteps: LobsterStep[] = [];
    if (scratchpadPattern) {
      preSteps.push({
        id: "scratchpad_init",
        command: buildAdapterCommand(adapterPath, "write-file", {
          expertDir,
          path: scratchpadPattern,
          content: "# Scratchpad\n",
        }),
      });
    }
    for (const contextFile of contextFiles) {
      preSteps.push({
        id: `context_${sanitizeId(contextFile)}`,
        command: buildAdapterCommand(adapterPath, "read-file", { expertDir, path: contextFile }),
      });
    }
    for (const fnName of processFunctions) {
      const meta = functionMeta.get(fnName);
      if (meta?.session === "isolated") {
        preSteps.push({
          id: `function_${sanitizeId(fnName)}_isolated`,
          command: `lobster run ${path.posix.join("functions", `${fnName}.lobster`)}`,
        });
      } else {
        preSteps.push({
          id: `function_${sanitizeId(fnName)}_inline`,
          command: buildAdapterCommand(adapterPath, "llm-task", {
            prompt: `Run function ${fnName}. Use declared outputs only.`,
            schema: JSON.stringify({
              type: "object",
              properties: meta?.outputs ?? {},
            }),
          }),
        });
      }
    }
    const workflow: LobsterWorkflow = {
      name: processName,
      args: processInputs,
      steps: [
        ...preSteps,
        ...checklist.map((stepText, index) => {
        const rawOp = extractOperation(stepText);
        const op = rawOp && isBoundOperation(rawOp, bindings) ? rawOp : undefined;
        const command = buildCommandForStep(stepText, op, bindings, toolMeta, adapterPath);
        const tier = op ? resolveTier(manifest, op) : "auto";
        return {
          id: `step_${preSteps.length + index + 1}`,
          command,
          operation: op,
          approval: tier === "auto" ? undefined : ("required" as const),
        };
        }),
      ],
    };
    const outputPath = path.join(outDir, `${processName}.lobster`);
    await writeUtf8(outputPath, yaml.dump(workflow));
    results.push({ processName, outputPath });
  }
  return results;
}

function extractChecklistSteps(markdown: string): string[] {
  const steps = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- [ ] "))
    .map((line) => line.slice(6).trim());
  if (steps.length === 0) {
    return ["Run process using declared body instructions."];
  }
  return steps;
}

function extractOperation(stepText: string): string | undefined {
  const match = stepText.match(/([a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/);
  if (!match) {
    return undefined;
  }
  return match[1];
}

function resolveTier(manifest: ExpertManifest, operation: string): "auto" | "confirm" | "manual" {
  const override = manifest.policy?.approval?.overrides?.[operation];
  if (override) {
    return override;
  }
  return manifest.policy?.approval?.default ?? "confirm";
}

function isBoundOperation(operation: string, bindings: BindingFile): boolean {
  const parts = operation.split(".");
  if (parts.length !== 2) {
    return false;
  }
  const [tool] = parts;
  return Boolean(bindings.tools[tool]);
}

function buildCommandForStep(
  stepText: string,
  operation: string | undefined,
  bindings: BindingFile,
  toolMeta: Map<string, ToolMeta>,
  adapterPath: string,
): string {
  if (!operation) {
    return buildAdapterCommand(adapterPath, "llm-task", { prompt: stepText });
  }
  const [tool, op] = operation.split(".");
  const binding = bindings.tools[tool];
  if (!binding) {
    return buildAdapterCommand(adapterPath, "llm-task", { prompt: stepText });
  }
  const target = binding.type === "mcp" ? (binding.server ?? tool) : (binding.skill ?? tool);
  const mapped = binding.operations?.[op] ?? op;
  const inputSchema = toolMeta.get(tool)?.operations.get(op)?.inputSchema;
  return buildAdapterCommand(adapterPath, "invoke-bound-op", {
    prompt: stepText,
    tool,
    operation: op,
    bindingType: binding.type,
    target,
    mappedOperation: mapped,
    ...(inputSchema ? { inputSchema: JSON.stringify(inputSchema) } : {}),
    ...(binding.operations ? { operationMap: JSON.stringify(binding.operations) } : {}),
  });
}

function buildAdapterCommand(adapterPath: string, action: string, args: Record<string, unknown>): string {
  const parts = ["node", shellQuote(adapterPath), shellQuote(action)];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) {
      continue;
    }
    parts.push(`--${key}`);
    parts.push(shellQuote(String(value)));
  }
  return parts.join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function sanitizeId(input: string): string {
  return input.replace(/[^a-zA-Z0-9_]+/g, "_");
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeInputs(value: unknown): Record<string, { type: string }> {
  if (!Array.isArray(value)) {
    return {};
  }
  const result: Record<string, { type: string }> = {};
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as { name?: unknown; type?: unknown };
    if (typeof row.name === "string" && typeof row.type === "string") {
      result[row.name] = { type: row.type };
    }
  }
  return result;
}

async function loadFunctionMeta(
  expertDir: string,
  functionFiles: string[],
): Promise<Map<string, { session?: string; outputs?: Record<string, unknown> }>> {
  const map = new Map<string, { session?: string; outputs?: Record<string, unknown> }>();
  for (const relPath of functionFiles) {
    const file = path.join(expertDir, relPath);
    const fm = await parseMarkdownFrontmatter(file);
    if (!fm || typeof fm.name !== "string") {
      continue;
    }
    const outputs = toOutputSchema(fm.outputs);
    map.set(fm.name, {
      session: typeof fm.session === "string" ? fm.session : undefined,
      outputs,
    });
  }
  return map;
}

async function loadToolMeta(expertDir: string, toolFiles: string[]): Promise<Map<string, ToolMeta>> {
  const meta = new Map<string, ToolMeta>();
  for (const relPath of toolFiles) {
    const file = path.join(expertDir, relPath);
    const raw = await readUtf8(file).catch(() => "");
    if (!raw) {
      continue;
    }
    const parsed = (yaml.load(raw) ?? {}) as {
      name?: unknown;
      operations?: Array<{ name?: unknown; input?: unknown }>;
    };
    if (typeof parsed.name !== "string") {
      continue;
    }
    const ops = new Map<string, { inputSchema?: Record<string, unknown> }>();
    for (const op of parsed.operations ?? []) {
      if (!op || typeof op !== "object" || typeof op.name !== "string") {
        continue;
      }
      const inputSchema = (op.input && typeof op.input === "object" && !Array.isArray(op.input))
        ? (op.input as Record<string, unknown>)
        : undefined;
      ops.set(op.name, { inputSchema });
    }
    meta.set(parsed.name, { operations: ops });
  }
  return meta;
}

function toOutputSchema(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) {
    return {};
  }
  const props: Record<string, unknown> = {};
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as { name?: unknown; type?: unknown; enum?: unknown };
    if (typeof row.name !== "string" || typeof row.type !== "string") {
      continue;
    }
    props[row.name] = {
      type: row.type,
      ...(Array.isArray(row.enum) ? { enum: row.enum } : {}),
    };
  }
  return props;
}

const OPENEXPERTS_EXEC_SOURCE = `#!/usr/bin/env node
// Generated by openexperts at activate time. Do not edit manually.
// Actions: read-file | write-file | llm-task | invoke-bound-op
// llm-task routes through OpenClaw gateway /tools/invoke so the agent
// can reason over process instructions and shape tool arguments.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const action = args[0];
const flags = parseFlags(args.slice(1));

try {
  if (action === "read-file") {
    const expertDir = must(flags, "expertDir");
    const relPath = must(flags, "path");
    const filePath = path.join(expertDir, relPath);
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    printJson({ ok: true, action, path: relPath, content });
    process.exit(0);
  }

  if (action === "write-file") {
    const expertDir = must(flags, "expertDir");
    const relPath = must(flags, "path");
    const content = flags.content ?? "";
    const filePath = path.join(expertDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    printJson({ ok: true, action, path: relPath });
    process.exit(0);
  }

  if (action === "llm-task") {
    const prompt = must(flags, "prompt");
    const call = invokeGatewayTool("llm-task", {
      prompt,
      ...(flags.schema ? { schema: safeJson(flags.schema) } : {}),
    });
    if (!call.ok) {
      printJson({ ok: false, error: call.error, action });
      process.exit(1);
    }
    printJson({ ok: true, action, result: call.result });
    process.exit(0);
  }

  if (action === "invoke-bound-op") {
    const prompt = must(flags, "prompt");
    const tool = must(flags, "tool");
    const operation = must(flags, "operation");
    const target = must(flags, "target");
    const mappedOperation = must(flags, "mappedOperation");
    const inputSchema = safeJson(flags.inputSchema);
    const operationMap = safeJson(flags.operationMap);

    const stepPrompt = [
      "You are generating JSON args for a bound tool operation in an OpenExperts workflow.",
      "Use only data explicitly present in the instruction.",
      "Do not invent IDs, emails, or message contents.",
      "If a field is unknown, use null.",
      "",
      "Instruction:",
      prompt,
    ].join("\\n");

    let args = {};
    if (inputSchema && typeof inputSchema === "object") {
      const planned = invokeGatewayTool("llm-task", {
        prompt: stepPrompt,
        schema: inputSchema,
      });
      if (!planned.ok) {
        printJson({ ok: false, action, error: planned.error });
        process.exit(1);
      }
      args = coerceArgs(planned.result);
    }

    const candidates = buildToolCandidates({
      tool,
      operation,
      target,
      mappedOperation,
      operationMap,
    });

    const failures = [];
    for (const toolName of candidates) {
      const invoke = invokeGatewayTool(toolName, args);
      if (invoke.ok) {
        printJson({
          ok: true,
          action,
          tool: toolName,
          operation,
          args,
          result: invoke.result,
        });
        process.exit(0);
      }
      failures.push({ tool: toolName, error: invoke.error });
      if (!isToolMissingError(invoke.error)) {
        printJson({
          ok: false,
          action,
          tool: toolName,
          operation,
          args,
          error: invoke.error,
        });
        process.exit(1);
      }
    }

    printJson({
      ok: false,
      action,
      operation,
      args,
      error: "No matching bound tool operation was invokable",
      attempts: failures,
    });
    process.exit(1);
  }

  printJson({ ok: false, error: "Unknown action: " + action });
  process.exit(1);
} catch (err) {
  printJson({ ok: false, error: String(err instanceof Error ? err.message : err), action });
  process.exit(1);
}

function invokeGatewayTool(toolName, args) {
  const base = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_TOKEN || "";
  if (!token) {
    return { ok: false, error: "Set OPENCLAW_GATEWAY_TOKEN so the adapter can reach the gateway" };
  }
  const body = JSON.stringify({
    tool: toolName,
    arguments: args && typeof args === "object" ? args : {},
  });
  const res = spawnSync(
    "curl",
    ["-sS", "-H", "Content-Type: application/json", "-H", "Authorization: Bearer " + token,
      "-X", "POST", base.replace(/\\/$/, "") + "/tools/invoke", "-d", body],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    return { ok: false, error: res.stderr || "gateway call failed" };
  }
  const parsed = safeJson((res.stdout || "").trim());
  if (parsed && typeof parsed === "object") {
    const err = parsed.error || parsed.message;
    if (err) {
      return { ok: false, error: String(err) };
    }
  }
  return { ok: true, result: parsed ?? (res.stdout || "").trim() };
}

function coerceArgs(raw) {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  if (raw.result && typeof raw.result === "object") {
    return raw.result;
  }
  if (raw.output && typeof raw.output === "object") {
    return raw.output;
  }
  return raw;
}

function buildToolCandidates(input) {
  const items = [
    input.mappedOperation,
    input.target + "." + input.mappedOperation,
    input.target + "_" + input.mappedOperation,
    input.tool + "." + input.mappedOperation,
    input.tool + "_" + input.mappedOperation,
    input.operation,
  ];
  if (input.operationMap && typeof input.operationMap === "object") {
    for (const value of Object.values(input.operationMap)) {
      if (typeof value === "string") {
        items.push(value);
      }
    }
  }
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== "string") continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function isToolMissingError(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("not found") || text.includes("unknown tool") || text.includes("no such tool");
}

function must(flags, key) {
  const v = flags[key];
  if (typeof v !== "string" || !v) throw new Error("Missing required --" + key);
  return v;
}

function parseFlags(raw) {
  const out = {};
  for (let i = 0; i < raw.length; i += 1) {
    const token = raw[i];
    if (!token.startsWith("--")) continue;
    out[token.slice(2)] = raw[i + 1] ?? "";
    i += 1;
  }
  return out;
}

function safeJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
`;
