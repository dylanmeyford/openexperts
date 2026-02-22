import path from "node:path";
import yaml from "js-yaml";
import { ensureDir, exists, readUtf8, writeUtf8 } from "../fs-utils.js";
import type { BindingFile, ExpertManifest, ToolBinding, ValidationMessage } from "../types.js";

export function bindingPath(configDir: string, expertName: string): string {
  return path.join(configDir, expertName, "bindings.yaml");
}

export async function readBindings(configDir: string, expertName: string): Promise<BindingFile> {
  const filePath = bindingPath(configDir, expertName);
  if (!(await exists(filePath))) {
    return { tools: {} };
  }
  const content = await readUtf8(filePath);
  const parsed = yaml.load(content);
  if (!parsed || typeof parsed !== "object") {
    return { tools: {} };
  }
  const doc = parsed as Partial<BindingFile>;
  return { tools: doc.tools ?? {} };
}

export async function writeBindings(configDir: string, expertName: string, bindings: BindingFile): Promise<void> {
  const filePath = bindingPath(configDir, expertName);
  await ensureDir(path.dirname(filePath));
  await writeUtf8(filePath, yaml.dump(bindings));
}

export async function upsertBinding(
  configDir: string,
  expertName: string,
  toolName: string,
  binding: ToolBinding,
): Promise<void> {
  const current = await readBindings(configDir, expertName);
  current.tools[toolName] = binding;
  await writeBindings(configDir, expertName, current);
}

export function validateBindings(manifest: ExpertManifest, bindingFile: BindingFile): ValidationMessage[] {
  const messages: ValidationMessage[] = [];
  const requiredTools = manifest.requires?.tools ?? [];
  for (const toolName of requiredTools) {
    const binding = bindingFile.tools[toolName];
    if (!binding) {
      messages.push({
        severity: "error",
        code: "binding_missing",
        message: `Missing binding for required tool '${toolName}'`,
        path: "bindings.yaml",
      });
      continue;
    }
    if (binding.type === "mcp" && !binding.server) {
      messages.push({
        severity: "error",
        code: "binding_mcp_server_missing",
        message: `Binding for '${toolName}' is mcp but server is empty`,
        path: "bindings.yaml",
      });
    }
    if (binding.type === "skill" && !binding.skill) {
      messages.push({
        severity: "error",
        code: "binding_skill_missing",
        message: `Binding for '${toolName}' is skill but skill is empty`,
        path: "bindings.yaml",
      });
    }
  }
  return messages;
}

export function validateBindingReachability(bindingFile: BindingFile, runtimeConfig: unknown): ValidationMessage[] {
  const messages: ValidationMessage[] = [];
  const cfg = (runtimeConfig ?? {}) as Record<string, unknown>;
  const mcpEntries = collectKeys(cfg, ["mcp", "entries"]);
  const skillEntries = collectKeys(cfg, ["skills", "entries"]);

  for (const [tool, binding] of Object.entries(bindingFile.tools)) {
    if (binding.type === "mcp" && binding.server) {
      if (!mcpEntries.includes(binding.server)) {
        messages.push({
          severity: "warn",
          code: "binding_mcp_unreachable",
          message: `Bound MCP server '${binding.server}' for tool '${tool}' not found in runtime config.`,
          path: "bindings.yaml",
        });
      }
    }
    if (binding.type === "skill" && binding.skill) {
      if (!skillEntries.includes(binding.skill)) {
        messages.push({
          severity: "warn",
          code: "binding_skill_unreachable",
          message: `Bound skill '${binding.skill}' for tool '${tool}' not found in runtime config.`,
          path: "bindings.yaml",
        });
      }
    }
  }
  return messages;
}

function collectKeys(source: Record<string, unknown>, pathParts: string[]): string[] {
  let current: unknown = source;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") {
      return [];
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    return [];
  }
  return Object.keys(current as Record<string, unknown>);
}
