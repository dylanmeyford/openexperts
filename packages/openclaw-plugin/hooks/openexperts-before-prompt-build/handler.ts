import type { OpenExpertsRuntime } from "../../src/runtime/runtime.js";

interface HookEvent {
  type: string;
  action: string;
  context?: {
    sessionKey?: string;
    bootstrapFiles?: Array<{ path: string; content: string }>;
  };
  messages: string[];
}

const handler = async (event: HookEvent): Promise<void> => {
  if (event.type !== "agent" || event.action !== "bootstrap") {
    return;
  }
  const runtime = (globalThis as { __openexpertsRuntime?: OpenExpertsRuntime }).__openexpertsRuntime;
  if (!runtime) {
    return;
  }
  await runtime.beforePromptBuild(event);
};

export default handler;
