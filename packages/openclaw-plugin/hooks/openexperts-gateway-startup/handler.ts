import type { OpenExpertsRuntime } from "../../src/runtime/runtime.js";

interface HookEvent {
  type: string;
  action: string;
  messages: string[];
}

const handler = async (event: HookEvent): Promise<void> => {
  if (event.type !== "gateway" || event.action !== "startup") {
    return;
  }
  const runtime = (globalThis as { __openexpertsRuntime?: OpenExpertsRuntime }).__openexpertsRuntime;
  if (!runtime) {
    return;
  }
  await runtime.onGatewayStartup();
};

export default handler;
