import path from "node:path";
import { exists } from "../fs-utils.js";
import type { ExpertManifest, ValidationMessage, ValidationResult } from "../types.js";
import { buildComponentIndex, parseMarkdownFrontmatter } from "./components.js";

const REQUIRED_FIELDS: Array<keyof ExpertManifest> = ["spec", "name", "version", "description", "components"];

export async function validateManifest(expertDir: string, manifest: ExpertManifest): Promise<ValidationResult> {
  const messages: ValidationMessage[] = [];

  for (const field of REQUIRED_FIELDS) {
    if (manifest[field] === undefined || manifest[field] === null || manifest[field] === "") {
      messages.push(err("required_field_missing", `Missing required manifest field: ${String(field)}`, `expert.yaml:${String(field)}`));
    }
  }

  const components = manifest.components;
  if (!components) {
    return summarize(messages);
  }

  const requiredComponents: Array<keyof ExpertManifest["components"]> = ["orchestrator", "persona", "functions", "processes"];
  for (const key of requiredComponents) {
    if (!components[key] || (Array.isArray(components[key]) && (components[key] as unknown[]).length === 0)) {
      messages.push(err("required_component_missing", `Missing required components.${String(key)}`, `expert.yaml:components.${String(key)}`));
    }
  }

  const declaredPaths = collectComponentPaths(components);
  for (const relPath of declaredPaths) {
    const absolute = path.join(expertDir, relPath);
    if (!(await exists(absolute))) {
      messages.push(err("component_path_missing", `Component path not found: ${relPath}`, relPath));
    }
  }

  const index = await buildComponentIndex(expertDir, {
    processes: components.processes ?? [],
    functions: components.functions ?? [],
    tools: components.tools ?? [],
    knowledge: components.knowledge ?? [],
  });

  const triggers = manifest.triggers ?? [];
  for (const trigger of triggers) {
    if (!index.processNames.has(trigger.process)) {
      messages.push(err("trigger_process_unresolved", `Trigger '${trigger.name}' references unknown process '${trigger.process}'`, "expert.yaml:triggers"));
    }
  }

  for (const relPath of components.processes ?? []) {
    const parsed = await parseMarkdownFrontmatter(path.join(expertDir, relPath));
    if (!parsed) {
      continue;
    }
    const triggerName = typeof parsed.trigger === "string" ? parsed.trigger : undefined;
    if (triggerName && !(manifest.triggers ?? []).some((trigger) => trigger.name === triggerName)) {
      messages.push(warn("process_trigger_unresolved", `Process trigger '${triggerName}' does not exist in manifest triggers`, relPath));
    }
    for (const fnName of asStringArray(parsed.functions)) {
      if (!index.functionNames.has(fnName)) {
        messages.push(warn("process_function_unresolved", `Process references unknown function '${fnName}'`, relPath));
      }
    }
    const requiredTools = new Set(manifest.requires?.tools ?? []);
    for (const toolName of asStringArray(parsed.tools)) {
      if (!requiredTools.has(toolName)) {
        messages.push(err("process_tool_not_declared", `Process references tool '${toolName}' not declared under requires.tools`, relPath));
      }
    }
  }

  for (const relPath of components.functions ?? []) {
    const parsed = await parseMarkdownFrontmatter(path.join(expertDir, relPath));
    if (!parsed) {
      continue;
    }
    const requiredTools = new Set(manifest.requires?.tools ?? []);
    for (const toolName of asStringArray(parsed.tools)) {
      if (!requiredTools.has(toolName)) {
        messages.push(err("function_tool_not_declared", `Function references tool '${toolName}' not declared under requires.tools`, relPath));
      }
    }
    for (const knowledgePath of asStringArray(parsed.knowledge)) {
      if (!index.knowledgePaths.has(knowledgePath.replaceAll("\\", "/"))) {
        messages.push(warn("function_knowledge_unresolved", `Function references knowledge '${knowledgePath}' not listed in components.knowledge`, relPath));
      }
    }
  }

  const overrides = manifest.policy?.approval?.overrides ?? {};
  for (const [key, _tier] of Object.entries(overrides)) {
    const [tool, operation] = key.split(".");
    if (!tool || !operation) {
      messages.push(warn("policy_override_format", `Policy override '${key}' should use format tool.operation`, "expert.yaml:policy.approval.overrides"));
      continue;
    }
    if (!(manifest.requires?.tools ?? []).includes(tool)) {
      messages.push(warn("policy_override_tool_unknown", `Policy override '${key}' references undeclared tool '${tool}'`, "expert.yaml:policy.approval.overrides"));
      continue;
    }
    const operations = index.toolOperations.get(tool);
    if (operations && !operations.has(operation)) {
      messages.push(warn("policy_override_operation_unknown", `Policy override '${key}' references unknown operation '${operation}'`, "expert.yaml:policy.approval.overrides"));
    }
  }

  const learningApproval = manifest.learning?.approval;
  if (learningApproval && !["auto", "confirm", "manual"].includes(learningApproval)) {
    messages.push(err("learning_approval_invalid", `learning.approval must be auto, confirm, or manual`, "expert.yaml:learning.approval"));
  }

  return summarize(messages);
}

function collectComponentPaths(components: ExpertManifest["components"]): string[] {
  const paths: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string") {
      paths.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          paths.push(item);
        }
      }
    }
  };
  for (const value of Object.values(components)) {
    push(value);
  }
  return paths;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function summarize(messages: ValidationMessage[]): ValidationResult {
  return {
    ok: !messages.some((m) => m.severity === "error"),
    messages,
  };
}

function err(code: string, message: string, path?: string): ValidationMessage {
  return { severity: "error", code, message, path };
}

function warn(code: string, message: string, path?: string): ValidationMessage {
  return { severity: "warn", code, message, path };
}
