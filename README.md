# Openexperts

**Professional expertise for AI agents.**

openexperts is an open specification for packaging professional expertise -- the judgment, processes, and domain knowledge that professionals use daily -- into a format any AI agent framework can consume.

## The Problem

LLMs have knowledge, but not experience. For instance, they can write a follow up email, but they don't know when to send it, why they should multi-thread in Sarah, or that this prospect intially mentioned a competitor in a first email, and that their persistent quiet might mean a deal risk and to use a battle card. That judgment comes from years of professional practice performing and training in a role.

Openexperts bridges that gap. It defines a standard way to capture professional expertise as portable, framework-agnostic packages that give AI agents the judgment and workflows of a seasoned professional.

## What's in an Expert Package?

An expert package is a directory of markdown and YAML files:


| Component        | Format            | Purpose                                                            |
| ---------------- | ----------------- | ------------------------------------------------------------------ |
| **Manifest**     | `expert.yaml`     | Package metadata, dependencies, triggers, policy, component listing |
| **Orchestrator** | `orchestrator.md` | Entry point. How the agent should use this expert package.         |
| **Persona**      | `persona/`        | Agent identity and behavioral rules                                |
| **Functions**    | `functions/*.md`  | Individual capabilities (markdown instructions + YAML frontmatter) |
| **Processes**    | `processes/*.md`  | Multi-step workflows that coordinate functions and tools           |
| **Tools**        | `tools/*.yaml`    | Abstract interfaces to external systems                            |
| **Knowledge**    | `knowledge/*.md`  | Reference material (methodologies, frameworks, guidelines)         |
| **State**        | `state/*.md`      | Builder-defined local storage files the agent reads and writes     |
| **Scratch**      | `scratch/*.md`    | Runtime-generated working files for process resumption and audit   |

Only `expert.yaml`, `orchestrator.md`, `functions/`, `persona/`, and `README.md` are required. Everything else is opt-in based on what the expertise demands.

## How It Works

### 1. Get the package

An expert package is a directory of files. There's no code to install and no runtime dependencies. Clone it, download it, or copy it into your project.

```bash
git clone https://github.com/openexperts/radiant-sales-expert
```

### 2. Bind your tools

The package manifest declares what tools it needs (e.g., `crm`, `email`, `calendar`). You map each abstract name to whatever you already have -- your HubSpot instance, your Nylas integration, your Google Calendar API. The expert package doesn't care how your tools work, only that they can answer the declared operations.

```yaml
# Example: binding abstract tools to your concrete implementations
tools:
  crm: my-hubspot-mcp-server
  email: my-nylas-integration
  calendar: my-google-calendar-api
```

### 3. Your framework consumes the package

The framework reads the package files and uses them at runtime:

- **Orchestrator** tells the agent when/how to use this expert package and which capabilities to reach for
- **Persona** becomes the agent's system prompt
- **Functions** become capabilities the agent can invoke
- **Processes** orchestrate multi-step workflows across functions and tools
- **Tools** declare what external systems the package needs — you bind them to your implementations
- **Knowledge** becomes reference material loaded into context
- **State** becomes local read/write storage — the builder decides what files exist, what they track, and how the agent uses them
- **Triggers** (declared in the manifest) wire events to processes — a new email arrives, a cron fires, a message comes in on a channel — and the framework handles concurrency, retries, and delivery

### 4. The agent has professional judgment

Your AI agent now knows *when* to send the email, *who* to CC, *which* methodology applies, and *what* the next best action is -- using your real data from your real tools.

The manifest also declares a **policy** governing which tool operations the agent can execute autonomously (`auto`), which require human approval (`confirm`), and which it should only draft for the human to execute (`manual`). Unknown operations default to `confirm` — the agent never gets silent write access unless the package author explicitly grants it.

### No code in the package

This is the key design choice. An expert package is a **prompt engineering artifact with structure**, not a software dependency. It contains expert instructions, data requirements, and process definitions -- all in human-readable markdown and YAML. Any framework can consume it:

- Read the markdown directly as system prompts
- Map functions to agent/skill definitions
- Map processes to workflow chains
- Map tools to your integration layer (MCP servers, API clients, database queries, etc.)

## For Framework Authors

To make your framework consume openexperts packages:

1. **Parse and validate `expert.yaml`** — discover components, verify required fields and cross-reference integrity (see [Validation](spec.md#13-validation))
2. **Load orchestrator and persona** into the agent's persistent context
3. **Bind abstract tools** to your concrete implementations (MCP servers, API clients, etc.)
4. **Wire triggers** — map `webhook`, `cron`, and `channel` triggers to your runtime's event system, applying concurrency policy (`parallel`, `serial`, `serial_per_key`)
5. **Enforce approval policy** — resolve the effective tier for each tool operation using the [resolution order](spec.md#approval-tier-resolution-order), handle `confirm` approval flow and `manual` draft delivery
6. **Support execution guarantees** — timeouts, retries with backoff, scratchpad-based resumption, and failure escalation
7. **Register functions and processes** as on-demand capabilities the agent can invoke

See the full [specification](spec.md) for the complete runtime consumption model (section 12).

## Specification

The full specification is in [spec.md](spec.md).

## Example Packages

- [radiant-sales-expert](https://github.com/openexperts/radiant-sales-expert) -- B2B sales expertise: deal intelligence, next-best-action, content composition, MEDDPICC framework

## Contributing

openexperts is open source. To create your own expert package:

1. Read the [specification](spec.md)
2. Create a new repo following the directory structure
3. Package your professional expertise as functions, processes, and knowledge
4. Open a PR to add your package to the directory above

## License

MIT