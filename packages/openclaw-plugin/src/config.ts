import os from "node:os";
import path from "node:path";

export interface RuntimeConfig {
  dataDir: string;
  dedupeWindowMs: number;
  approvalPollMs: number;
  lobsterTimeoutMs: number;
  openclawConfigPath?: string;
}

export function resolveConfig(raw: unknown): RuntimeConfig {
  const input = (raw ?? {}) as Partial<RuntimeConfig>;
  return {
    dataDir: expandHome(input.dataDir ?? "~/.openclaw/openexperts"),
    dedupeWindowMs: input.dedupeWindowMs ?? 60 * 60 * 1000,
    approvalPollMs: input.approvalPollMs ?? 5000,
    lobsterTimeoutMs: (input as { lobsterTimeoutMs?: number }).lobsterTimeoutMs ?? 10 * 60 * 1000,
    openclawConfigPath: typeof (input as { openclawConfigPath?: unknown }).openclawConfigPath === "string"
      ? expandHome((input as { openclawConfigPath: string }).openclawConfigPath)
      : undefined,
  };
}

export function expandHome(p: string): string {
  if (!p.startsWith("~")) {
    return p;
  }
  return path.join(os.homedir(), p.slice(1));
}

export interface RuntimePaths {
  expertsDir: string;
  configDir: string;
  stateDir: string;
  learningsDir: string;
  compiledDir: string;
  approvalsDir: string;
  registryFile: string;
}

export function getRuntimePaths(cfg: RuntimeConfig): RuntimePaths {
  return {
    expertsDir: path.join(cfg.dataDir, "experts"),
    configDir: path.join(cfg.dataDir, "expert-config"),
    stateDir: path.join(cfg.dataDir, "state"),
    learningsDir: path.join(cfg.dataDir, "learnings"),
    compiledDir: path.join(cfg.dataDir, "compiled"),
    approvalsDir: path.join(cfg.dataDir, "approvals"),
    registryFile: path.join(cfg.dataDir, "EXPERTS.md"),
  };
}
