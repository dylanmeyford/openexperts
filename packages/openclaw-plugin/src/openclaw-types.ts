export interface OpenClawPluginApi {
  config?: Record<string, unknown>;
  logger: {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
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
  registerHook?: (hook: {
    id: string;
    event: string;
    handler: (event: unknown) => Promise<void> | void;
  }) => void;
  runtime?: {
    updateConfig?: (patch: Record<string, unknown>) => Promise<void>;
    addCronJob?: (job: {
      id: string;
      expr: string;
      tz?: string;
      payload?: Record<string, unknown>;
    }) => Promise<void>;
    removeCronJob?: (id: string) => Promise<void>;
    addWebhookMapping?: (mapping: {
      id: string;
      preset?: string;
      requiresTool?: string;
      payload?: Record<string, unknown>;
    }) => Promise<void>;
    removeWebhookMapping?: (id: string) => Promise<void>;
  };
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
