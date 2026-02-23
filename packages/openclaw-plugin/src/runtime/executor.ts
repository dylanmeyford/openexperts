import path from "node:path";
import { spawn } from "node:child_process";
import { exists } from "../fs-utils.js";
import type { ExpertManifest } from "../types.js";
import { ApprovalService } from "./approvals.js";

export interface RunProcessInput {
  expertName: string;
  processName: string;
  compiledDir: string;
  payload: Record<string, unknown>;
  manifest: ExpertManifest;
}

export interface RunProcessResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export class ProcessExecutor {
  constructor(
    private readonly approvalService: ApprovalService,
    private readonly onApprovalRequired: (requestId: string, prompt: string) => Promise<void>,
    private readonly lobsterTimeoutMs: number,
  ) {}

  async run(input: RunProcessInput): Promise<RunProcessResult> {
    const workflowPath = path.join(input.compiledDir, input.expertName, `${input.processName}.lobster`);
    if (!(await exists(workflowPath))) {
      return { ok: false, error: `Compiled workflow not found for process '${input.processName}'` };
    }

    const retry = input.manifest.execution?.retry;
    const maxAttempts = retry?.max_attempts ?? 1;
    const backoff = retry?.backoff ?? "exponential";
    const delayMs = parseDurationMs(retry?.delay ?? "30s");
    const timeoutMs = parseDurationMs(input.manifest.execution?.timeout ?? "0s");
    const failures: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await runLobster(workflowPath, input.payload, timeoutMs || this.lobsterTimeoutMs);
      const parsedApproval = parseApprovalSignal([result.output, result.error].filter(Boolean).join("\n"));
      if (parsedApproval?.resumeToken) {
        const tier = parsedApproval.tier ?? "confirm";
        const request = await this.approvalService.createRequest({
          expertName: input.expertName,
          operation: parsedApproval.operation ?? "unknown.operation",
          tier,
          reason: parsedApproval.reason ?? "Lobster step requires approval",
          payload: input.payload,
          resumeToken: parsedApproval.resumeToken,
          workflowPath,
          processName: input.processName,
          timeoutMs: parseDurationMs(input.manifest.policy?.approval?.timeout ?? "0s"),
        });
        await this.onApprovalRequired(
          request.id,
          `Approval required for ${request.operation}. requestId=${request.id}`,
        );
        return { ok: false, error: `Paused awaiting approval. requestId=${request.id}` };
      }
      if (result.ok) {
        return result;
      }
      failures.push(`attempt ${attempt}: ${result.error ?? "unknown error"}`);
      if (attempt >= maxAttempts) {
        break;
      }
      const sleep = backoff === "exponential" ? delayMs * 2 ** (attempt - 1) : delayMs;
      await wait(sleep);
    }
    return {
      ok: false,
      error: failures.join("; "),
    };
  }

  async resume(requestId: string, approve: boolean): Promise<RunProcessResult> {
    const pending = await this.approvalService.getById(requestId);
    if (!pending) {
      return { ok: false, error: `No pending approval request '${requestId}'` };
    }
    if (!pending.resumeToken) {
      await this.approvalService.resolve(requestId);
      return { ok: true, output: "Resolved non-token approval request." };
    }
    const result = await runLobsterResume(pending.resumeToken, approve, this.lobsterTimeoutMs);
    await this.approvalService.resolve(requestId);
    return result;
  }
}

function runLobster(workflowPath: string, payload: Record<string, unknown>, timeoutMs: number): Promise<RunProcessResult> {
  return new Promise((resolve) => {
    const child = spawn("lobster", ["run", workflowPath, "--args-json", JSON.stringify(payload)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (buf) => {
      stdout += String(buf);
    });
    child.stderr.on("data", (buf) => {
      stderr += String(buf);
    });
    let timeout: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ ok: false, error: `lobster timed out after ${timeoutMs}ms` });
      }, timeoutMs);
    }
    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({ ok: false, error: error.message });
    });
    child.on("exit", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (code === 0) {
        resolve({ ok: true, output: stdout.trim() });
      } else {
        const error = stderr.trim() || `lobster exited with code ${code}`;
        resolve({ ok: false, error, output: stdout.trim() || stderr.trim() });
      }
    });
  });
}

function runLobsterResume(resumeToken: string, approve: boolean, timeoutMs: number): Promise<RunProcessResult> {
  return new Promise((resolve) => {
    const child = spawn("lobster", ["resume", "--token", resumeToken, "--approve", approve ? "true" : "false"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (buf) => {
      stdout += String(buf);
    });
    child.stderr.on("data", (buf) => {
      stderr += String(buf);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, error: `lobster resume timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, error: error.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ ok: true, output: stdout.trim() });
      } else {
        resolve({ ok: false, error: stderr.trim() || `lobster resume exited with code ${code}` });
      }
    });
  });
}

function parseDurationMs(duration: string): number {
  const match = duration.trim().match(/^(\d+)(ms|s|m|h)$/);
  if (!match) {
    return 0;
  }
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === "ms") {
    return value;
  }
  if (unit === "s") {
    return value * 1000;
  }
  if (unit === "m") {
    return value * 60 * 1000;
  }
  return value * 60 * 60 * 1000;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseApprovalSignal(output: string): {
  resumeToken?: string;
  operation?: string;
  reason?: string;
  tier?: "confirm" | "manual";
} | null {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const status = String(parsed.status ?? parsed.event ?? "");
      if (!status.includes("approval")) {
        continue;
      }
      const token = parsed.resumeToken ?? parsed.resume_token ?? parsed.token;
      if (typeof token !== "string") {
        continue;
      }
      return {
        resumeToken: token,
        operation: typeof parsed.operation === "string" ? parsed.operation : undefined,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
        tier: parsed.tier === "manual" ? "manual" : "confirm",
      };
    } catch {
      // Continue to regex fallback.
    }
  }
  const tokenMatch = output.match(/resumeToken["\s:=-]+([a-zA-Z0-9._-]+)/i) ?? output.match(/token["\s:=-]+([a-zA-Z0-9._-]+)/i);
  if (!tokenMatch) {
    return null;
  }
  const operation = output.match(/operation["\s:=-]+([a-zA-Z0-9._-]+)/i)?.[1];
  const tierRaw = output.match(/tier["\s:=-]+(confirm|manual)/i)?.[1]?.toLowerCase();
  const reason = output.match(/reason["\s:=-]+(.+)/i)?.[1];
  return {
    resumeToken: tokenMatch[1],
    operation,
    reason,
    tier: tierRaw === "manual" ? "manual" : "confirm",
  };
}
