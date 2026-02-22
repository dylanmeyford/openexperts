import path from "node:path";
import yaml from "js-yaml";
import { exists, readUtf8 } from "../fs-utils.js";
import type { BindingFile, ExpertManifest } from "../types.js";

export interface PromptAssemblyInput {
  expertDir: string;
  manifest: ExpertManifest;
  bindings: BindingFile;
  learningsPackageSnippet?: string;
}

export async function assembleSystemPrompt(input: PromptAssemblyInput): Promise<string> {
  const personaDocs = await Promise.all((input.manifest.components.persona ?? []).map((rel) => readOptional(path.join(input.expertDir, rel))));
  const orchestrator = await readOptional(path.join(input.expertDir, input.manifest.components.orchestrator));
  const functionIndex = await buildNamedIndex(input.expertDir, input.manifest.components.functions ?? []);
  const processIndex = await buildNamedIndex(input.expertDir, input.manifest.components.processes ?? []);
  const knowledgeIndex = await buildNamedIndex(input.expertDir, input.manifest.components.knowledge ?? []);
  const policy = resolvePolicy(input.manifest);

  const sections = [
    "## Identity",
    personaDocs.filter(Boolean).join("\n\n"),
    "## How to Operate",
    orchestrator,
    "## Available Functions",
    functionIndex,
    "## Available Processes",
    processIndex,
    "## Available Knowledge",
    knowledgeIndex,
    "## Tool Bindings",
    renderBindings(input.bindings),
    "## Tool Approval Policy",
    renderPolicy(policy),
  ];

  if (input.learningsPackageSnippet) {
    sections.push("## Learnings");
    sections.push(input.learningsPackageSnippet);
  }

  return sections.join("\n\n").trim();
}

function resolvePolicy(manifest: ExpertManifest): {
  auto: string[];
  confirm: string[];
  manual: string[];
  default: "auto" | "confirm" | "manual";
} {
  const overrides = manifest.policy?.approval?.overrides ?? {};
  const auto: string[] = [];
  const confirm: string[] = [];
  const manual: string[] = [];
  for (const [operation, tier] of Object.entries(overrides)) {
    if (tier === "auto") {
      auto.push(operation);
    } else if (tier === "manual") {
      manual.push(operation);
    } else {
      confirm.push(operation);
    }
  }
  return {
    auto: auto.sort(),
    confirm: confirm.sort(),
    manual: manual.sort(),
    default: manifest.policy?.approval?.default ?? "confirm",
  };
}

function renderPolicy(policy: { auto: string[]; confirm: string[]; manual: string[]; default: string }): string {
  return [
    `AUTO: ${policy.auto.join(", ") || "(none)"}`,
    `CONFIRM: ${policy.confirm.join(", ") || "(none)"}`,
    `MANUAL: ${policy.manual.join(", ") || "(none)"}`,
    `Default: ${policy.default}`,
  ].join("\n");
}

function renderBindings(bindings: BindingFile): string {
  const lines = Object.entries(bindings.tools).map(([toolName, binding]) => {
    if (binding.type === "mcp") {
      return `- ${toolName}: mcp(${binding.server ?? "unknown"})`;
    }
    return `- ${toolName}: skill(${binding.skill ?? "unknown"})`;
  });
  return lines.join("\n");
}

async function buildNamedIndex(expertDir: string, files: string[]): Promise<string> {
  const rows: string[] = [];
  for (const relPath of files) {
    const filePath = path.join(expertDir, relPath);
    const content = await readOptional(filePath);
    if (!content) {
      continue;
    }
    const fm = parseFrontmatter(content);
    const name = typeof fm.name === "string" ? fm.name : path.basename(relPath, path.extname(relPath));
    const description = typeof fm.description === "string" ? fm.description : "";
    rows.push(`- ${name}: ${description}`);
  }
  return rows.join("\n");
}

function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) {
    return {};
  }
  const end = content.indexOf("\n---", 3);
  if (end < 0) {
    return {};
  }
  const parsed = yaml.load(content.slice(4, end));
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  return parsed as Record<string, unknown>;
}

async function readOptional(filePath: string): Promise<string> {
  if (!(await exists(filePath))) {
    return "";
  }
  return readUtf8(filePath);
}
