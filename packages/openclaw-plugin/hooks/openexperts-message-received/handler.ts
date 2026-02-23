import type { OpenExpertsRuntime } from "../../src/runtime/runtime.js";

interface HookEvent {
  type: string;
  action: string;
  context?: {
    from?: string;
    content?: string;
    channelId?: string;
  };
  messages: string[];
}

const handler = async (event: HookEvent): Promise<void> => {
  if (event.type !== "message" || event.action !== "received") {
    return;
  }
  const runtime = (globalThis as { __openexpertsRuntime?: OpenExpertsRuntime }).__openexpertsRuntime;
  if (!runtime) {
    return;
  }
  await runtime.onMessageReceived(event);
};

export default handler;
