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

export async function compileExpertProcessesToLobster(
  expertDir: string,
  compiledDir: string,
  manifest: ExpertManifest,
  bindings: BindingFile,
): Promise<CompileResult[]> {
  const outDir = path.join(compiledDir, manifest.name);
  await ensureDir(outDir);
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

    const preSteps: LobsterStep[] = [];
    if (scratchpadPattern) {
      preSteps.push({
        id: "scratchpad_init",
        command: `openclaw.invoke --tool write --args-json ${jsonArg({
          path: scratchpadPattern,
          content: "# Scratchpad\n",
        })}`,
      });
    }
    for (const contextFile of contextFiles) {
      preSteps.push({
        id: `context_${sanitizeId(contextFile)}`,
        command: `openclaw.invoke --tool read --args-json ${jsonArg({ path: contextFile })}`,
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
          command: `openclaw.invoke --tool llm-task --action json --args-json ${jsonArg({
            prompt: `Run function ${fnName}. Use declared outputs only.`,
            schema: {
              type: "object",
              properties: meta?.outputs ?? {},
            },
          })}`,
        });
      }
    }
    const workflow: LobsterWorkflow = {
      name: processName,
      args: processInputs,
      steps: [
        ...preSteps,
        ...checklist.map((stepText, index) => {
        const op = extractOperation(stepText);
        const command = buildCommandForStep(stepText, op, bindings);
        const tier = op ? resolveTier(manifest, op) : "auto";
        return {
          id: `step_${preSteps.length + index + 1}`,
          command,
          operation: op,
          approval: tier === "auto" ? undefined : "required",
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

function buildCommandForStep(stepText: string, operation: string | undefined, bindings: BindingFile): string {
  if (!operation) {
    return `openclaw.invoke --tool llm-task --action json --args-json ${JSON.stringify(
      JSON.stringify({
        prompt: stepText,
      }),
    )}`;
  }
  const [tool, op] = operation.split(".");
  const binding = bindings.tools[tool];
  if (!binding) {
    return `openclaw.invoke --tool llm-task --action json --args-json ${JSON.stringify(
      JSON.stringify({
        prompt: `Missing binding for ${tool}. Step: ${stepText}`,
      }),
    )}`;
  }
  const mapped = binding.operations?.[op] ?? op;
  if (binding.type === "mcp") {
    return `openclaw.invoke --tool ${binding.server ?? tool} --action ${mapped}`;
  }
  return `openclaw.invoke --tool ${binding.skill ?? tool} --action ${mapped}`;
}

function jsonArg(value: unknown): string {
  return JSON.stringify(JSON.stringify(value));
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
