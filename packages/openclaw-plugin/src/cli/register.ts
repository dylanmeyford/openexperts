import type { OpenClawPluginApi } from "../openclaw-types.js";
import { OpenExpertsRuntime } from "../runtime/runtime.js";

export function registerCli(api: OpenClawPluginApi, runtime: OpenExpertsRuntime): void {
  api.registerCli(({ program }) => {
    const expert = program.command("expert").description("Manage OpenExperts packages");

    expert
      .command("install <source>")
      .option("--link", "For local source, symlink instead of copy")
      .description("Install an expert package from github/npm/local source")
      .action(async (source: string, options: { link?: boolean }) => {
        const msg = await runtime.install(source, { linkLocal: options.link === true });
        api.logger.info(msg);
      });

    expert
      .command("list")
      .description("List installed experts")
      .action(async () => {
        api.logger.info(await runtime.list());
      });

    expert
      .command("validate <name>")
      .description("Validate an expert package and its bindings")
      .action(async (name: string) => {
        api.logger.info(await runtime.validate(name));
      });

    expert
      .command("bind <name> <tool>")
      .option("--mcp <server>", "Bind tool to MCP server")
      .option("--skill <skill>", "Bind tool to skill")
      .description("Bind a required abstract tool")
      .action(async (name: string, tool: string, options: { mcp?: string; skill?: string }) => {
        if (options.mcp) {
          api.logger.info(await runtime.bind(name, tool, { type: "mcp", server: options.mcp }));
          return;
        }
        if (options.skill) {
          api.logger.info(await runtime.bind(name, tool, { type: "skill", skill: options.skill }));
          return;
        }
        api.logger.error("Specify either --mcp or --skill.");
      });

    expert
      .command("bind-wizard <name>")
      .description("Show missing required bindings and suggested commands")
      .action(async (name: string) => {
        api.logger.info(await runtime.bindingWizard(name));
      });

    expert
      .command("activate <name>")
      .description("Validate and activate an expert package")
      .action(async (name: string) => {
        api.logger.info(await runtime.activate(name));
      });

    expert
      .command("run <name> <process>")
      .option("--payload <json>", "Process input JSON payload")
      .description("Run a compiled expert process")
      .action(async (name: string, process: string, options: { payload?: string }) => {
        api.logger.info(await runtime.run(name, process, options.payload));
      });

    expert
      .command("doctor")
      .description("Check plugin runtime health and dependencies")
      .action(async () => {
        api.logger.info(await runtime.doctor());
      });

    expert
      .command("setup")
      .description("Validate dependencies and patch config for Lobster/llm-task")
      .action(async () => {
        api.logger.info(await runtime.setup());
      });

    expert
      .command("learn <name>")
      .option("--scope <scope>", "Learning scope: package or function name")
      .option("--title <title>", "Learning title")
      .option("--source <source>", "Learning source")
      .option("--observation <observation>", "Observation text")
      .option("--correction <correction>", "Correction text")
      .option("--confidence <confidence>", "high|medium|low")
      .description("Submit a learning proposal")
      .action(
        async (
          name: string,
          options: {
            scope?: string;
            title?: string;
            source?: string;
            observation?: string;
            correction?: string;
            confidence?: "high" | "medium" | "low";
          },
        ) => {
          const missing = ["scope", "title", "source", "observation", "correction", "confidence"].filter(
            (key) => !options[key as keyof typeof options],
          );
          if (missing.length > 0) {
            api.logger.error(`Missing required options: ${missing.join(", ")}`);
            return;
          }
          api.logger.info(
            await runtime.proposeLearning(name, {
              scope: options.scope!,
              title: options.title!,
              source: options.source!,
              observation: options.observation!,
              correction: options.correction!,
              confidence: options.confidence!,
            }),
          );
        },
      );

    expert
      .command("learn-approve <requestId>")
      .description("Approve and persist a pending learning proposal")
      .action(async (requestId: string) => {
        api.logger.info(await runtime.applyApprovedLearning(requestId));
      });
  });
}
