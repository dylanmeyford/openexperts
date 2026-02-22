import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { copyDir, ensureDir, exists, readUtf8, writeUtf8 } from "../fs-utils.js";

export async function initializeStateTemplates(expertDir: string, stateRoot: string, expertName: string): Promise<void> {
  const source = path.join(expertDir, "state");
  if (!(await exists(source))) {
    return;
  }
  const target = path.join(stateRoot, expertName, "state");
  if (!(await exists(target))) {
    await copyDir(source, target);
  }
}

export async function resetSessionScopedState(expertDir: string, stateRoot: string, expertName: string): Promise<void> {
  const source = path.join(expertDir, "state");
  const target = path.join(stateRoot, expertName, "state");
  if (!(await exists(source)) || !(await exists(target))) {
    return;
  }

  const files = await fs.readdir(source);
  for (const fileName of files) {
    const sourceFile = path.join(source, fileName);
    const targetFile = path.join(target, fileName);
    const sourceContent = await readUtf8(sourceFile);
    const scope = parseScopeFromFrontmatter(sourceContent);
    if (scope === "session") {
      await writeUtf8(targetFile, sourceContent);
    }
  }
}

export async function ensureScratchDir(stateRoot: string, expertName: string): Promise<string> {
  const dir = path.join(stateRoot, expertName, "scratch");
  await ensureDir(dir);
  return dir;
}

function parseScopeFromFrontmatter(content: string): "session" | "persistent" {
  if (!content.startsWith("---")) {
    return "persistent";
  }
  const end = content.indexOf("\n---", 3);
  if (end < 0) {
    return "persistent";
  }
  const frontmatter = content.slice(4, end);
  const parsed = yaml.load(frontmatter);
  if (!parsed || typeof parsed !== "object") {
    return "persistent";
  }
  const rawScope = (parsed as { scope?: unknown }).scope;
  return rawScope === "session" ? "session" : "persistent";
}
