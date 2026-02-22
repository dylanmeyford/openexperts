import type { BindingFile, ExpertManifest } from "../types.js";

export interface BindingPrompt {
  tool: string;
  prompt: string;
}

export function buildBindingPrompts(manifest: ExpertManifest, bindings: BindingFile): BindingPrompt[] {
  const prompts: BindingPrompt[] = [];
  const required = manifest.requires?.tools ?? [];
  for (const tool of required) {
    if (bindings.tools[tool]) {
      continue;
    }
    prompts.push({
      tool,
      prompt: [
        `Tool '${tool}' is not bound.`,
        `Choose one:`,
        `  - openclaw expert bind ${manifest.name} ${tool} --mcp <server-name>`,
        `  - openclaw expert bind ${manifest.name} ${tool} --skill <skill-name>`,
      ].join("\n"),
    });
  }
  return prompts;
}
