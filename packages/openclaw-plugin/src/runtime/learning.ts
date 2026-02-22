import path from "node:path";
import { ensureDir, exists, readUtf8, writeUtf8 } from "../fs-utils.js";
import type { LearningEntry, LearningProposal } from "../types.js";

export class LearningService {
  constructor(private readonly learningsRoot: string) {}

  async appendApprovedLearning(expertName: string, proposal: LearningProposal, maxEntries: number): Promise<void> {
    const filePath = this.getFilePath(expertName, proposal.scope);
    await ensureDir(path.dirname(filePath));
    const current = (await this.readEntries(filePath)).slice(-(maxEntries - 1));
    current.push({
      title: proposal.title,
      date: proposal.date,
      source: proposal.source,
      observation: proposal.observation,
      correction: proposal.correction,
      confidence: proposal.confidence,
    });
    await writeUtf8(filePath, renderEntries(current, proposal.scope));
  }

  async loadScopeLearnings(expertName: string, scope: string): Promise<string> {
    const packageFile = this.getFilePath(expertName, "package");
    const scopeFile = this.getFilePath(expertName, scope);
    const snippets: string[] = [];
    if (await exists(packageFile)) {
      snippets.push(await readUtf8(packageFile));
    }
    if (scope !== "package" && (await exists(scopeFile))) {
      snippets.push(await readUtf8(scopeFile));
    }
    return snippets.join("\n\n");
  }

  private async readEntries(filePath: string): Promise<LearningEntry[]> {
    if (!(await exists(filePath))) {
      return [];
    }
    const content = await readUtf8(filePath);
    const blocks = content.split("\n### ").filter(Boolean);
    const entries: LearningEntry[] = [];
    for (const block of blocks) {
      const normalized = block.startsWith("### ") ? block : `### ${block}`;
      const titleLine = normalized.split("\n")[0]?.replace("### ", "").trim() ?? "";
      const date = matchBullet(normalized, "Date");
      const source = matchBullet(normalized, "Source");
      const observation = matchBullet(normalized, "Observation");
      const correction = matchBullet(normalized, "Correction");
      const confidence = (matchBullet(normalized, "Confidence") as "high" | "medium" | "low" | "") || "medium";
      if (!titleLine) {
        continue;
      }
      entries.push({
        title: titleLine,
        date: date || new Date().toISOString().slice(0, 10),
        source,
        observation,
        correction,
        confidence,
      });
    }
    return entries;
  }

  private getFilePath(expertName: string, scope: string): string {
    const fileName = scope === "package" ? "_package.md" : `${scope}.md`;
    return path.join(this.learningsRoot, expertName, fileName);
  }
}

function renderEntries(entries: LearningEntry[], scope: string): string {
  const header = `---\nscope: ${scope}\nentry_count: ${entries.length}\n---\n`;
  const body = entries
    .map(
      (entry) =>
        [
          `### ${entry.title}`,
          `- **Date**: ${entry.date}`,
          `- **Source**: ${entry.source}`,
          `- **Observation**: ${entry.observation}`,
          `- **Correction**: ${entry.correction}`,
          `- **Confidence**: ${entry.confidence}`,
        ].join("\n"),
    )
    .join("\n\n");
  return `${header}\n${body}\n`;
}

function matchBullet(block: string, key: string): string {
  const match = block.match(new RegExp(`\\*\\*${key}\\*\\*: (.+)`));
  return match?.[1]?.trim() ?? "";
}
