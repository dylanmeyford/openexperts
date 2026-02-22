import { writeUtf8 } from "../fs-utils.js";
import type { BindingFile, ExpertManifest, ExpertRecord } from "../types.js";

export async function writeExpertsRegistry(
  filePath: string,
  entries: Array<{ record: ExpertRecord; manifest: ExpertManifest; bindings: BindingFile }>,
): Promise<void> {
  const lines: string[] = ["# Available Experts", ""];
  for (const entry of entries) {
    const { record, manifest, bindings } = entry;
    lines.push(`## ${record.name}`);
    lines.push(`- Description: ${record.description}`);
    lines.push(`- Version: ${record.version}`);
    lines.push(`- Triggers: ${(manifest.triggers ?? []).length}`);
    lines.push(`- Tools bound: ${Object.keys(bindings.tools).length}`);
    lines.push("");
  }
  await writeUtf8(filePath, lines.join("\n"));
}
