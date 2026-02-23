export interface OpenClawPluginApi {
  config?: Record<string, unknown>;
  registerHook?: (event: string, handler: (event: unknown) => Promise<void> | void) => void;
  registerPluginHooksFromDir?: (hooksDir: string) => void;
  logger: {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
  };
  cron?: {
    add?: (job: OpenClawCronJob) => Promise<unknown> | unknown;
    remove?: (id: string) => Promise<unknown> | unknown;
  };
  gateway?: {
    cron?: {
      add?: (job: OpenClawCronJob) => Promise<unknown> | unknown;
      remove?: (id: string) => Promise<unknown> | unknown;
    };
  };
  registerCli: (
    registerer: (ctx: { program: CommandRegistry }) => void,
    options?: { commands?: string[] },
  ) => void;
  registerService: (service: {
    id: string;
    start: () => Promise<void> | void;
    stop: () => Promise<void> | void;
  }) => void;
  registerCommand?: (command: {
    name: string;
    description?: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: { args?: string; channel?: string; senderId?: string }) => Promise<{ text: string }> | { text: string };
  }) => void;
}

export interface OpenClawCronJob {
  id: string;
  schedule: {
    kind: "cron";
    expr: string;
    tz: string;
  };
  sessionTarget: "main" | "isolated";
  payload: {
    kind: "systemEvent";
    expert: string;
    trigger: string;
    process: string;
  };
  delivery: {
    mode: "announce";
  };
  task?: string;
}

export interface CommandRegistry {
  command: (name: string) => CommandBuilder;
}

export interface CommandBuilder {
  description: (text: string) => CommandBuilder;
  option: (flags: string, description: string) => CommandBuilder;
  action: (fn: (...args: unknown[]) => Promise<void> | void) => CommandBuilder;
  command: (name: string) => CommandBuilder;
}
