import type { OpenClawPluginApi } from "./openclaw-types.js";
import { OpenExpertsRuntime } from "./runtime/runtime.js";
import { registerCli } from "./cli/register.js";

export default function register(api: OpenClawPluginApi): void {
  // Config is read from plugins.entries.<id>.config in OpenClaw.
  const runtime = new OpenExpertsRuntime(api, api.config ?? {});

  api.registerService({
    id: "openexperts-runtime-service",
    start: async () => {
      await runtime.boot();
      api.logger.info("openexperts-runtime service started");
    },
    stop: async () => {
      api.logger.info("openexperts-runtime service stopped");
    },
  });

  api.registerService({
    id: "openexperts-approval-timeouts",
    start: () => {
      const timer = setInterval(() => {
        void runtime.processApprovalTimeouts();
      }, runtime.cfg.approvalPollMs);
      (globalThis as { __openexpertsApprovalTimer?: NodeJS.Timeout }).__openexpertsApprovalTimer = timer;
    },
    stop: () => {
      const timer = (globalThis as { __openexpertsApprovalTimer?: NodeJS.Timeout }).__openexpertsApprovalTimer;
      if (timer) {
        clearInterval(timer);
      }
    },
  });

  if (api.registerCommand) {
    api.registerCommand({
      name: "approve",
      acceptsArgs: true,
      requireAuth: true,
      description: "Approve a pending OpenExperts request",
      handler: async (ctx) => {
        const id = (ctx.args ?? "").trim();
        if (!id) {
          return { text: "Usage: /approve <request-id>" };
        }
        return { text: await runtime.approve(id) };
      },
    });

    api.registerCommand({
      name: "reject",
      acceptsArgs: true,
      requireAuth: true,
      description: "Reject a pending OpenExperts request",
      handler: async (ctx) => {
        const id = (ctx.args ?? "").trim();
        if (!id) {
          return { text: "Usage: /reject <request-id>" };
        }
        return { text: await runtime.reject(id) };
      },
    });
  }

  registerCli(api, runtime);

  (globalThis as { __openexpertsRuntime?: OpenExpertsRuntime }).__openexpertsRuntime = runtime;
}
