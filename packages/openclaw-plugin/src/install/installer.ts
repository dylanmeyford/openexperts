import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDir, exists } from "../fs-utils.js";
import { loadManifest } from "../spec/manifest.js";
import type { ExpertRecord } from "../types.js";

export type InstallSourceType = "github" | "npm" | "local";

export interface InstallSource {
  type: InstallSourceType;
  value: string;
}

export function resolveInstallSource(input: string): InstallSource {
  if (input.startsWith("http://") || input.startsWith("https://") || input.endsWith(".git") || input.includes("github.com/")) {
    return { type: "github", value: input };
  }
  if (input.startsWith(".") || input.startsWith("/") || input.startsWith("~")) {
    return { type: "local", value: input };
  }
  return { type: "npm", value: input };
}

export async function installExpertPackage(source: InstallSource, expertsDir: string, options?: { linkLocal?: boolean }): Promise<string> {
  await ensureDir(expertsDir);
  if (source.type === "github") {
    const repoName = inferRepoName(source.value);
    const target = path.join(expertsDir, repoName);
    await run("git", ["clone", source.value, target]);
    return target;
  }

  if (source.type === "local") {
    const sourceDir = source.value.startsWith("~") ? path.join(process.env.HOME ?? "", source.value.slice(1)) : source.value;
    const repoName = path.basename(sourceDir);
    const target = path.join(expertsDir, repoName);
    if (options?.linkLocal) {
      await ensureDir(path.dirname(target));
      try {
        await fs.rm(target, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures.
      }
      await fs.symlink(sourceDir, target, "dir");
      return target;
    }
    await copyDirLocal(sourceDir, target);
    return target;
  }

  const target = path.join(expertsDir, source.value.replace("/", "__"));
  await ensureDir(target);
  await run("npm", ["pack", source.value], { cwd: target });
  const files = await fs.readdir(target);
  const tarball = files.find((name) => name.endsWith(".tgz"));
  if (!tarball) {
    throw new Error(`Failed to pack npm package ${source.value}`);
  }
  await run("tar", ["-xzf", tarball, "--strip-components", "1"], { cwd: target });
  return target;
}

export async function listInstalledExperts(expertsDir: string): Promise<ExpertRecord[]> {
  if (!(await exists(expertsDir))) {
    return [];
  }
  const entries = await fs.readdir(expertsDir, { withFileTypes: true });
  const records: ExpertRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const rootDir = path.join(expertsDir, entry.name);
    const manifestPath = path.join(rootDir, "expert.yaml");
    if (!(await exists(manifestPath))) {
      continue;
    }
    const manifest = await loadManifest(rootDir);
    records.push({
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      rootDir,
    });
  }
  records.sort((a, b) => a.name.localeCompare(b.name));
  return records;
}

function inferRepoName(url: string): string {
  const cleaned = url.replace(/\.git$/, "");
  const parts = cleaned.split("/");
  return parts[parts.length - 1] || "expert-package";
}

function run(command: string, args: string[], options?: { cwd?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options?.cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

async function copyDirLocal(source: string, target: string): Promise<void> {
  await ensureDir(target);
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirLocal(from, to);
    } else {
      await ensureDir(path.dirname(to));
      await fs.copyFile(from, to);
    }
  }
}
