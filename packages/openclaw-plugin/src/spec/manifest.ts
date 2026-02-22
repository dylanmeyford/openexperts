import path from "node:path";
import yaml from "js-yaml";
import { exists, readUtf8 } from "../fs-utils.js";
import type { ExpertManifest } from "../types.js";

export async function loadManifest(expertDir: string): Promise<ExpertManifest> {
  const filePath = path.join(expertDir, "expert.yaml");
  if (!(await exists(filePath))) {
    throw new Error(`Missing expert manifest at ${filePath}`);
  }
  const raw = await readUtf8(filePath);
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid manifest YAML at ${filePath}`);
  }
  return parsed as ExpertManifest;
}
