import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, readJson, writeJson } from "../fs-utils.js";
import type { ApprovalRequest, ApprovalTier } from "../types.js";

interface PendingApprovalState {
  approvals: ApprovalRequest[];
}

export class ApprovalService {
  private readonly filePath: string;

  constructor(approvalsDir: string) {
    this.filePath = path.join(approvalsDir, "pending.json");
  }

  async createRequest(input: {
    expertName: string;
    operation: string;
    tier: ApprovalTier;
    reason: string;
    payload: Record<string, unknown>;
    timeoutMs?: number;
    resumeToken?: string;
    workflowPath?: string;
    processName?: string;
  }): Promise<ApprovalRequest> {
    await ensureDir(path.dirname(this.filePath));
    const state = await this.load();
    const now = Date.now();
    const request: ApprovalRequest = {
      id: crypto.randomUUID(),
      expertName: input.expertName,
      operation: input.operation,
      tier: input.tier,
      reason: input.reason,
      payload: input.payload,
      timeoutAt: input.timeoutMs ? now + input.timeoutMs : undefined,
      resumeToken: input.resumeToken,
      workflowPath: input.workflowPath,
      processName: input.processName,
    };
    state.approvals.push(request);
    await this.save(state);
    return request;
  }

  async resolve(requestId: string): Promise<void> {
    const state = await this.load();
    state.approvals = state.approvals.filter((req) => req.id !== requestId);
    await this.save(state);
  }

  async listPending(): Promise<ApprovalRequest[]> {
    return (await this.load()).approvals;
  }

  async getById(requestId: string): Promise<ApprovalRequest | undefined> {
    const state = await this.load();
    return state.approvals.find((req) => req.id === requestId);
  }

  async expireTimedOut(): Promise<ApprovalRequest[]> {
    const state = await this.load();
    const now = Date.now();
    const expired = state.approvals.filter((req) => req.timeoutAt !== undefined && req.timeoutAt <= now);
    if (expired.length === 0) {
      return [];
    }
    state.approvals = state.approvals.filter((req) => !expired.some((e) => e.id === req.id));
    await this.save(state);
    return expired;
  }

  private async load(): Promise<PendingApprovalState> {
    return readJson<PendingApprovalState>(this.filePath, { approvals: [] });
  }

  private async save(state: PendingApprovalState): Promise<void> {
    await writeJson(this.filePath, state);
  }
}
