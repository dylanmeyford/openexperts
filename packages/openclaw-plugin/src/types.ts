export type ApprovalTier = "auto" | "confirm" | "manual";
export type TriggerType = "webhook" | "cron" | "channel";
export type ConcurrencyMode = "parallel" | "serial" | "serial_per_key";

export interface ExpertManifest {
  spec: string;
  name: string;
  version: string;
  description: string;
  requires?: {
    tools?: string[];
    [key: string]: unknown;
  };
  concurrency?: {
    default?: ConcurrencyMode;
    key?: string;
  };
  execution?: {
    timeout?: string;
    idempotent?: boolean;
    retry?: {
      max_attempts?: number;
      backoff?: "fixed" | "exponential";
      delay?: string;
    };
    on_failure?: "escalate" | "abandon" | "dead_letter";
    resume_from_execution_log?: boolean;
  };
  delivery?: {
    format?: "narrative" | "structured" | "both";
    channel?: string;
    sla_breach?: "warn" | "escalate";
  };
  learning?: {
    enabled?: boolean;
    approval?: ApprovalTier;
    max_entries_per_file?: number;
  };
  policy?: {
    approval?: {
      default?: ApprovalTier;
      overrides?: Record<string, ApprovalTier>;
      timeout?: string;
      on_timeout?: "reject" | "escalate";
    };
    escalation?: {
      channel?: string;
      on_low_confidence?: boolean;
      on_manual_ready?: boolean;
    };
  };
  triggers?: ExpertTrigger[];
  components: {
    orchestrator: string;
    persona: string[];
    functions: string[];
    processes: string[];
    tools?: string[];
    knowledge?: string[];
    state?: string[];
    [key: string]: unknown;
  };
}

export interface ExpertTrigger {
  name: string;
  type: TriggerType;
  process: string;
  preset?: string;
  requires_tool?: string;
  expr?: string;
  tz?: string;
  dedupe_key?: string;
  session?: "isolated" | "main";
  concurrency?: ConcurrencyMode;
  concurrency_key?: string;
  payload_mapping?: Record<string, string>;
  description?: string;
}

export interface ValidationMessage {
  severity: "error" | "warn";
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  ok: boolean;
  messages: ValidationMessage[];
}

export interface ExpertRecord {
  name: string;
  version: string;
  description: string;
  rootDir: string;
}

export interface ToolBinding {
  type: "mcp" | "skill";
  server?: string;
  skill?: string;
  operations?: Record<string, string>;
}

export interface BindingFile {
  tools: Record<string, ToolBinding>;
}

export interface LearningEntry {
  title: string;
  date: string;
  source: string;
  observation: string;
  correction: string;
  confidence: "high" | "medium" | "low";
}

export interface LearningProposal extends LearningEntry {
  scope: "package" | string;
}

export interface ApprovalRequest {
  id: string;
  expertName: string;
  operation: string;
  tier: ApprovalTier;
  reason: string;
  timeoutAt?: number;
  payload: Record<string, unknown>;
  resumeToken?: string;
  workflowPath?: string;
  processName?: string;
}
