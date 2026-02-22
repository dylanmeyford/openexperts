import path from "node:path";
import yaml from "js-yaml";
import { readUtf8 } from "../fs-utils.js";

interface FrontmatterWithName {
  name?: string;
}

export interface ComponentIndex {
  processNames: Set<string>;
  triggerNamesFromProcesses: Set<string>;
  functionNames: Set<string>;
  knowledgePaths: Set<string>;
  toolNames: Set<string>;
  toolOperations: Map<string, Set<string>>;
}

export async function buildComponentIndex(
  expertDir: string,
  components: {
    processes: string[];
    functions: string[];
    tools?: string[];
    knowledge?: string[];
  },
): Promise<ComponentIndex> {
  const processNames = new Set<string>();
  const triggerNamesFromProcesses = new Set<string>();
  const functionNames = new Set<string>();
  const knowledgePaths = new Set<string>((components.knowledge ?? []).map(normalizeSlashes));
  const toolNames = new Set<string>();
  const toolOperations = new Map<string, Set<string>>();

  for (const relPath of components.processes) {
    const parsed = await parseMarkdownFrontmatter(path.join(expertDir, relPath));
    if (parsed?.name) {
      processNames.add(parsed.name);
    }
    if (typeof parsed?.trigger === "string") {
      triggerNamesFromProcesses.add(parsed.trigger);
    }
  }

  for (const relPath of components.functions) {
    const parsed = await parseMarkdownFrontmatter(path.join(expertDir, relPath));
    if (parsed?.name) {
      functionNames.add(parsed.name);
    }
  }

  for (const relPath of components.tools ?? []) {
    const absolute = path.join(expertDir, relPath);
    const toolDoc = (yaml.load(await readUtf8(absolute)) ?? {}) as {
      name?: string;
      operations?: Array<{ name?: string }>;
    };
    if (!toolDoc.name) {
      continue;
    }
    toolNames.add(toolDoc.name);
    toolOperations.set(
      toolDoc.name,
      new Set((toolDoc.operations ?? []).map((op) => op.name).filter((value): value is string => typeof value === "string")),
    );
  }

  return {
    processNames,
    triggerNamesFromProcesses,
    functionNames,
    knowledgePaths,
    toolNames,
    toolOperations,
  };
}

export async function parseMarkdownFrontmatter(filePath: string): Promise<Record<string, unknown> | null> {
  const content = await readUtf8(filePath);
  if (!content.startsWith("---")) {
    return null;
  }
  const end = content.indexOf("\n---", 3);
  if (end < 0) {
    return null;
  }
  const frontmatter = content.slice(4, end);
  const parsed = yaml.load(frontmatter);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function normalizeSlashes(input: string): string {
  return input.replaceAll("\\", "/");
}
