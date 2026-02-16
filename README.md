# openexperience

**Professional expertise for AI agents.**

openexperience is an open specification for packaging professional expertise -- the judgment, processes, and domain knowledge that professionals use daily -- into a format any AI agent framework can consume.

## The Problem

LLMs have knowledge, but not experience. They can write an email, but they don't know when to send it, who to CC, whether to use a case study or a pricing sheet, or that this prospect went quiet after the demo and needs a breakup sequence. That judgment comes from years of professional practice.

openexperience bridges that gap. It defines a standard way to capture professional expertise as portable, framework-agnostic packages that give AI agents the judgment of a seasoned professional.

## What's in an Experience Package?

An experience package is a directory of markdown and YAML files:

| Component | Format | Purpose |
|---|---|---|
| **Manifest** | `experience.yaml` | Package metadata, dependencies, component listing |
| **Functions** | `functions/*.md` | Individual capabilities (markdown instructions + YAML frontmatter) |
| **Processes** | `processes/*.yaml` | Multi-step workflows that chain functions together |
| **Actions** | `actions/*.yaml` | What the agent can DO (the output vocabulary) |
| **Tools** | `tools/*.yaml` | Abstract interfaces to external systems |
| **Schemas** | `schemas/*.yaml` | Data contracts the host must provide |
| **Knowledge** | `knowledge/*.md` | Reference material (methodologies, frameworks, guidelines) |
| **Persona** | `persona/` | Agent identity and behavioral rules |

Only `experience.yaml`, `functions/`, `persona/`, and `README.md` are required. Everything else is opt-in based on what the expertise demands.

## How It Works

### 1. Get the package

An experience package is a directory of files. There's no code to install and no runtime dependencies. Clone it, download it, or copy it into your project.

```bash
git clone https://github.com/openexperience/radiant-sales-expert
```

### 2. Bind your tools

The package manifest declares what tools it needs (e.g., `crm`, `email`, `calendar`). You map each abstract name to whatever you already have -- your HubSpot instance, your Nylas integration, your Google Calendar API. The package doesn't care how your tools work, only that they can answer the declared operations.

```yaml
# Example: binding abstract tools to your concrete implementations
tools:
  crm: my-hubspot-mcp-server
  email: my-nylas-integration
  calendar: my-google-calendar-api
```

### 3. Your framework consumes the package

The framework reads the package files and uses them at runtime:
- **Persona** becomes the agent's system prompt
- **Functions** become capabilities the agent can invoke
- **Knowledge** becomes reference material loaded into context
- **Context declarations** tell the framework what data to fetch (from your bound tools) before each function runs
- **Processes** orchestrate multi-step workflows across functions

### 4. The agent has professional judgment

Your AI agent now knows *when* to send the email, *who* to CC, *which* methodology applies, and *what* the next best action is -- using your real data from your real tools.

### No code in the package

This is the key design choice. An experience package is a **prompt engineering artifact with structure**, not a software dependency. It contains expert instructions, data requirements, and process definitions -- all in human-readable markdown and YAML. Any framework can consume it:

- Read the markdown directly as system prompts
- Map functions to agent/skill definitions
- Map processes to workflow chains
- Map tools to your integration layer (MCP servers, API clients, database queries, etc.)

## For Framework Authors

To make your framework consume openexperience packages:

1. **Parse `experience.yaml`** to discover components and requirements
2. **Provide a tool binding mechanism** so users can map abstract tool names to concrete implementations
3. **Implement context resolution** -- read function `context` declarations, call bound tools, inject results into `{{template}}` variables
4. **Load persona and knowledge** into the agent's prompt
5. **Optionally support processes** for multi-step orchestration

See the full [specification](spec.md) for details on each component type and the runtime consumption model.

## Specification

The full specification is in [spec.md](spec.md). It covers every component type, their YAML schemas, and required vs. optional fields.

## Example Packages

- [radiant-sales-expert](https://github.com/openexperience/radiant-sales-expert) -- B2B sales expertise: deal intelligence, next-best-action, content composition, MEDDPICC framework

## Contributing

openexperience is open source. To create your own experience package:

1. Read the [specification](spec.md)
2. Create a new repo following the directory structure
3. Package your professional expertise as functions, processes, and knowledge
4. Open a PR to add your package to the directory above

## License

MIT
