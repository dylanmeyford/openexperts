# openexperts Specification

Version: `1.0`

## 1. Overview

openexperts is an open format for packaging professional expertise into files that AI frameworks can consume.

An expert package captures:

- Role judgment (how to think)
- Decision heuristics (how to decide)
- Workflows (how to execute)
- Domain references (what to reference)

### Design Principles

- **No code in the package**: packages are markdown and YAML only.
- **Framework agnostic**: any agent framework can consume the files.
- **Agentic-loop native**: processes are playbooks for an agent loop, not an executable DSL.
- **Portable and readable**: experts can author and review files directly.

## 2. Package Structure

An expert package is a directory with the following structure:

```text
expert-package/
  README.md
  expert.yaml
  orchestrator.md
  persona/
    identity.md
    rules.md
  functions/
    *.md
  processes/            # optional
    *.md
  tools/                # optional
    *.yaml
  knowledge/            # optional
    *.md
  state/                # optional
    *.md
```

### Required Components

- `README.md`
- `expert.yaml`
- `orchestrator.md`
- `persona/` (at least one persona file)
- `functions/` (at least one function file)

### Optional Components

- `processes/`
- `tools/`
- `knowledge/`
- `state/`

### Naming Conventions

- Use kebab-case file names where practical (for example `classify-email-intent.md`).
- Function and process files use markdown with YAML frontmatter.
- Tool files use YAML.

## 3. Manifest (`expert.yaml`)

The manifest is the package index and metadata source.

### Required Fields

- `spec` (string): spec version for this package format, for example `"1.0"`.
- `name` (string): package name.
- `version` (string): package version (SemVer recommended).
- `description` (string): short package summary.
- `components` (object): lists package component files.

### Optional Fields

- `author` (string)
- `license` (string)
- `requires` (object): dependencies such as abstract tools.
- `triggers` (array): automation entry points that invoke processes on events.
- `concurrency` (object): package-level concurrency defaults inherited by all triggers.
- `execution` (object): package-level process execution defaults inherited by all processes.

### `requires.tools`

`requires.tools` is an array of abstract tool names the package expects at runtime.

Example:

```yaml
requires:
  tools:
    - crm
    - email
    - calendar
```

### `concurrency`

`concurrency` sets the default execution model for all triggers in the package. Individual triggers inherit these defaults and may override them.

#### Concurrency Fields

- `default` (string): default concurrency mode. One of `parallel`, `serial`, or `serial_per_key`. Defaults to `parallel` if omitted.
- `key` (string): default `concurrency_key` field path applied when `default` is `serial_per_key`. Individual triggers may override this with their own `concurrency_key`.

#### When to set a package-level default

Set a package-level default when most or all triggers share the same concurrency model. This avoids repeating the same setting on every trigger and prevents silent bugs from a missed per-trigger declaration.

| Expert type | Recommended default |
|---|---|
| Sales agent | `serial_per_key`, key: `contact_id` |
| Support agent | `serial_per_key`, key: `ticket_id` |
| Legal agent | `serial_per_key`, key: `matter_id` |
| Marketing agent | `parallel` |
| Report generator | `serial` |

#### Example

```yaml
# All triggers process in order per contact by default.
# Any trigger can override this locally if it needs different behavior.
concurrency:
  default: serial_per_key
  key: contact_id
```

### `execution`

`execution` sets the default runtime guarantees for all processes in the package. Individual processes inherit these defaults and may override them in their own frontmatter.

#### Execution Fields

- `timeout` (string): maximum wall-clock time a process may run before the framework considers it failed. Use human-readable durations such as `5m`, `30m`, `2h`. Defaults to no timeout if omitted.
- `idempotent` (boolean): declares whether it is safe to re-run the full process from step 1 on failure. When `true`, the framework may retry without risk of duplicate side-effects. When `false`, the framework must use scratchpad-based resumption rather than a full restart. Defaults to `false`.
- `retry` (object): retry policy applied when a process fails.
  - `max_attempts` (integer): maximum number of attempts including the first. Defaults to `1` (no retry).
  - `backoff` (string): `fixed` or `exponential`. Defaults to `exponential`.
  - `delay` (string): initial delay between attempts. Defaults to `30s`.
- `on_failure` (string): action taken when all retry attempts are exhausted. One of:
  - `escalate` (default): notify the main agent and user that the process failed and requires attention.
  - `abandon`: log the failure silently and drop the task. Use only for non-critical background tasks.
  - `dead_letter`: queue the failed invocation for manual review and reprocessing.
- `resume_from_execution_log` (boolean): when `true`, the framework maintains an opaque execution log tracking which steps have completed, retry count, and failure details. On retry, the framework passes this context to the agent so it can resume from the last completed step rather than restarting from step 1. The execution log is framework-owned infrastructure — package authors never read or write it directly. It is separate from the process `scratchpad`, which is agent-owned working notes. Requires `idempotent: false`. Defaults to `true` when a scratchpad is declared on the process.

#### Why these defaults matter

Without explicit execution policy, a failed process silently disappears. For a sales agent, a failed email triage is a missed deal signal. Package authors should always declare a policy — even just `on_failure: escalate` — so failures are visible.

#### Example

```yaml
# Processes get 10 minutes, retry up to 3 times with exponential backoff,
# resume from scratchpad on retry, and escalate if still failing.
execution:
  timeout: 10m
  idempotent: false
  retry:
    max_attempts: 3
    backoff: exponential
    delay: 30s
  on_failure: escalate
  resume_from_execution_log: true
```

### `triggers`

`triggers` declares the automation entry points for this package. Each trigger defines when a process runs, how it is invoked, and what runtime behavior the framework should apply.

Triggers are declarative. The framework (or loader) is responsible for wiring each trigger to the underlying runtime mechanism (webhook, cron schedule, channel event, etc.). Package authors declare intent; they do not configure infrastructure.

#### Trigger Fields

Required:

- `name` (string): unique trigger name within the package. Must match the `trigger` field on the target process.
- `type` (string): one of `webhook`, `cron`, or `channel`.
- `process` (string): name of the process to invoke when this trigger fires.

Optional:

- `preset` (string): maps to a built-in runtime preset (for example `gmail` for the OpenClaw Gmail hook). When set, the framework uses its built-in handling for this event source.
- `requires_tool` (string): abstract tool name that provides this trigger when no preset covers it. The framework must resolve this tool before the trigger can be active.
- `expr` (string): cron expression (5-field standard or 6-field with seconds). Required when `type` is `cron`.
- `tz` (string): IANA timezone for the cron expression. Defaults to UTC.
- `dedupe_key` (string): field path in the incoming payload used to identify duplicate events. The framework should skip processing if an event with the same key was already handled within a reasonable window.
- `session` (string): `isolated` (default, recommended) or `main`. `isolated` runs each trigger invocation in its own session. `main` enqueues an event into the primary agent session.
- `concurrency` (string): overrides the package-level `concurrency.default` for this trigger. One of:
  - `parallel`: each invocation runs immediately in its own session, with no coordination. Use for independent workloads such as processing multiple articles or documents at the same time.
  - `serial`: all invocations of this trigger queue globally and run one at a time. Use when overlap would cause duplicate work or corrupted output, such as a nightly report that must not run twice.
  - `serial_per_key`: invocations queue per a grouping key derived from the trigger payload. Invocations with the same key run in order; invocations with different keys run in parallel. Use for entity-scoped workflows such as a sales agent that must process emails for the same deal sequentially, while handling different deals concurrently.
- `concurrency_key` (string): overrides the package-level `concurrency.key` for this trigger. Required when this trigger's effective concurrency mode is `serial_per_key` and no package-level key is set. A dot-notation path into the trigger payload identifying the grouping field (for example `contact_id`, `deal_id`, `thread_id`).
- `description` (string): human-readable explanation of when this trigger fires.

#### Trigger Types

**`webhook`** — fires when an inbound HTTP event is received. The framework maps the trigger to a webhook endpoint or preset handler. Use this for email (Gmail PubSub), external app notifications, and any event-driven push source.

**`cron`** — fires on a schedule defined by `expr` and `tz`. Use this for proactive tasks: scanning for opportunities, generating daily summaries, sending follow-up reminders.

**`channel`** — fires when a message arrives on a connected messaging channel (for example iMessage, WhatsApp, Telegram, Slack). The framework routes incoming channel messages to the process when the message matches the trigger's channel source.

#### Example Triggers Block

```yaml
triggers:
  # serial_per_key: emails for the same deal are processed in order,
  # but emails for different deals run in parallel.
  - name: new_email
    type: webhook
    preset: gmail
    dedupe_key: message_id
    session: isolated
    concurrency: serial_per_key
    concurrency_key: contact_id
    process: inbound-email-triage
    description: Fires when a new email arrives in the monitored inbox.

  # serial: the morning scan must not overlap with itself.
  - name: opportunity_scan
    type: cron
    expr: "0 8 * * 1-5"
    tz: Australia/Sydney
    session: isolated
    concurrency: serial
    process: scan-for-opportunities
    description: Runs every weekday morning to scan for new signals on active accounts.

  # parallel: each article is independent; process them all at the same time.
  - name: new_article
    type: webhook
    requires_tool: content_feed
    dedupe_key: article_id
    session: isolated
    concurrency: parallel
    process: process-article
    description: Fires when a new article is published to the monitored feed.

  # serial_per_key: LinkedIn DMs serialized per sender.
  - name: linkedin_dm
    type: webhook
    requires_tool: linkedin
    dedupe_key: message_id
    session: isolated
    concurrency: serial_per_key
    concurrency_key: sender_id
    process: handle-linkedin-dm
    description: Fires when a new LinkedIn DM is received. Requires a LinkedIn tool binding.
```

### `components`

`components` lists files by component type so frameworks can discover them without scanning every file.

### Complete Example Manifest

```yaml
spec: "1.0"
name: radiant-sales-expert
version: "0.1.0"
description: B2B sales expertise for inbound deal triage and next-best-action
author: Openexperts Community
license: MIT

requires:
  tools:
    - crm
    - email

# All triggers default to serial_per_key on contact_id.
# The opportunity scan overrides to serial (global queue, no per-key needed).
concurrency:
  default: serial_per_key
  key: contact_id

# All processes get 10 minutes, retry 3 times, resume from scratchpad, escalate on failure.
execution:
  timeout: 10m
  idempotent: false
  retry:
    max_attempts: 3
    backoff: exponential
    delay: 30s
  on_failure: escalate
  resume_from_execution_log: true

triggers:
  - name: new_email
    type: webhook
    preset: gmail
    dedupe_key: message_id
    session: isolated
    process: inbound-email-triage
    description: Fires when a new email arrives in the monitored inbox.

  - name: opportunity_scan
    type: cron
    expr: "0 8 * * 1-5"
    tz: Australia/Sydney
    session: isolated
    concurrency: serial        # override: global queue, not per-contact
    process: scan-for-opportunities
    description: Runs every weekday morning to scan for new signals on active accounts.

components:
  orchestrator: orchestrator.md
  persona:
    - persona/identity.md
    - persona/rules.md
  functions:
    - functions/classify-email-intent.md
    - functions/determine-next-action.md
    - functions/compose-response.md
  processes:
    - processes/inbound-email-triage.md
    - processes/scan-for-opportunities.md
  tools:
    - tools/crm.yaml
    - tools/email.yaml
  knowledge:
    - knowledge/meddpicc.md
    - knowledge/competitive-battle-cards.md
  state:
    - state/pipeline.md
    - state/session-notes.md
```

## 4. Orchestrator (`orchestrator.md`)

The orchestrator is the package entry point. It tells the agent:

- When to use this expert package
- Which functions or processes to reach for
- How to route between scenarios

### Format

- Plain markdown
- No frontmatter required

### Runtime Consumption

Frameworks should load orchestrator content into persistent context (for example, system prompt/bootstrap context) so the agent can route correctly at runtime.

## 5. Persona (`persona/`)

Persona files define identity and behavior.

Recommended files:

- `persona/identity.md`: role, voice, and style
- `persona/rules.md`: behavioral constraints, priorities, and guardrails

Additional persona files are allowed.

### Runtime Consumption

Frameworks should load persona content into persistent context with the orchestrator.

## 6. Functions (`functions/*.md`)

A function is a self-contained capability. Functions contain domain instructions, heuristics, and output expectations that can be used on demand inside an agent loop.

### Required Format

Each function file must include:

1. YAML frontmatter
2. Markdown instruction body

### Function Frontmatter Fields

Required:

- `name` (string)
- `description` (string)

Optional:

- `inputs` (array of objects with `name`, `type`, optional `description`)
- `outputs` (array of objects with `name`, `type`, optional `description`, optional `enum`)
- `tools` (array of abstract tool names)
- `knowledge` (array of knowledge file references)

### Function Body Requirements

The markdown body should include:

- Clear instructions
- Decision rules / evaluation heuristics
- Output formatting guidance

### Example Function

```markdown
---
name: classify-email-intent
description: Determine the intent and urgency of an inbound email
inputs:
  - name: email_body
    type: string
  - name: sender_context
    type: object
    description: CRM context for sender, deal stage, and history
outputs:
  - name: intent
    type: string
    enum: [objection, question, buying_signal, churn_risk, scheduling, other]
  - name: urgency
    type: string
    enum: [high, medium, low]
  - name: reasoning
    type: string
tools:
  - crm
knowledge:
  - knowledge/competitive-battle-cards.md
---

## Classify Email Intent

Given email body and sender CRM context, classify intent and urgency.

### Decision Rules

- If the sender is in a late deal stage and mentions a competitor, classify as `objection` and `high`.
- If there has been >14 days of inactivity and the reply is short/hesitant, classify as `churn_risk`.
- If the email asks product or technical details, classify as `question`.

### Output

Return:
- Intent
- Urgency
- Reasoning (1-2 sentences)
```

### Runtime Consumption

Frameworks should expose functions as readable/invokable capabilities (for example, skills) and load them on demand instead of always preloading all function content.

## 7. Processes (`processes/*.md`)

A process is a multi-step workflow that coordinates tool usage and function usage.

Processes are authored as markdown playbooks, not executable workflow code.

### Process Frontmatter Fields

Required:

- `name` (string)
- `description` (string)

Optional:

- `trigger` (string): event that commonly initiates the process
- `inputs` (array): starting data requirements
- `outputs` (array): expected final outputs
- `functions` (array of function names): discovery and indexing support
- `tools` (array of abstract tool names): discovery and indexing support
- `scratchpad` (string): recommended working file path pattern
- `execution` (object): overrides the package-level execution defaults for this process. Supports the same fields as the package-level `execution` block (`timeout`, `idempotent`, `retry`, `on_failure`, `resume_from_execution_log`). Only specified fields are overridden; unspecified fields inherit from the package default.

### Process Body Requirements

A process body should include:

- Context preamble: when and why this process runs
- Ordered steps section
- Completion section with expected output

### Checklist Pattern (Required for resumable processes)

Use markdown checkboxes for step tracking:

- `- [ ] Step ...`

This gives the agent explicit progress cues in agentic loops and is the mechanism by which the agent knows which steps are complete when resuming from a scratchpad.

### Scratchpad Pattern (Required when `resume_from_execution_log: true`)

Processes that declare a `scratchpad` path must instruct the agent to write intermediate step results to that file as they complete. This enables:

- **Resumption**: on retry, the agent reads the scratchpad and continues from the last completed step rather than restarting from step 1, preventing duplicate side-effects such as double CRM writes or duplicate email sends.
- **Auditability**: every process run leaves a record of what happened and what was decided at each step.
- **Context recovery**: if context is compacted or the session is interrupted, the scratchpad preserves the working state.

The first step of any resumable process must always be: create (or read if it already exists) the scratchpad file.

### Example Process

```markdown
---
name: inbound-email-triage
description: End-to-end handling of an inbound sales email
trigger: new_email
inputs:
  - name: message_id
    type: string
outputs:
  - name: draft_response
    type: object
  - name: classification
    type: object
  - name: recommended_action
    type: object
functions:
  - classify-email-intent
  - determine-next-action
  - compose-response
tools:
  - email
  - crm
scratchpad: ./scratch/triage-{message_id}.md
execution:
  timeout: 10m
  # inherits retry and on_failure from package-level execution defaults
---

## Inbound Email Triage

Run this process whenever a new prospect email arrives.
Follow every step in order and check it off after completion.
If resuming after a failure, read the scratchpad first and skip any already-completed steps.

### Steps

- [ ] Open (or create) the scratchpad at `./scratch/triage-{message_id}.md`. If it exists, read it and resume from the first unchecked step.
- [ ] Fetch the inbound email using the `email` tool and record sender, subject, body.
- [ ] Fetch contact details from `crm` using sender email and record account context.
- [ ] Fetch active deal details from `crm` and record stage, amount, competitors.
- [ ] Read and apply `classify-email-intent` using email + CRM context; record output.
- [ ] Read and apply `determine-next-action`; record output.
- [ ] Read and apply `compose-response`; record draft response.

### Completion

Return:
- Draft response
- Classification
- Recommended action
```

## 8. Tools (`tools/*.yaml`)

Tool files define abstract interfaces to external systems.

They define what operations are needed, not how integrations are implemented.

### Tool Fields

- `name` (string): abstract tool name referenced by functions/processes
- `description` (string)
- `operations` (array)

Each operation includes:

- `name` (string)
- `description` (string)
- `input` (object shape using simple type declarations)
- `output` (object shape using simple type declarations)

### Type System

Use readable simple types:

- `string`
- `number`
- `boolean`
- `object`
- `array`

Complex fields can define nested `properties` using the same simple types.

### Example Tool

```yaml
name: crm
description: Customer relationship management interface
operations:
  - name: get_contact
    description: Retrieve a contact by email address
    input:
      type: object
      properties:
        email:
          type: string
    output:
      type: object
      properties:
        contact_id:
          type: string
        name:
          type: string
        company:
          type: string
        deal_stage:
          type: string
        last_activity:
          type: string
        notes:
          type: array
          items:
            type: string

  - name: get_deal
    description: Retrieve active deal details for a contact
    input:
      type: object
      properties:
        contact_id:
          type: string
    output:
      type: object
      properties:
        deal_name:
          type: string
        amount:
          type: number
        stage:
          type: string
        competitors:
          type: array
          items:
            type: string
        close_date:
          type: string
```

### Runtime Binding

Frameworks bind tool names declared in expert package files to concrete implementations (for example MCP servers, API clients, or internal services).

## 9. Knowledge (`knowledge/*.md`)

Knowledge files contain reference material the agent can use while executing functions and processes.

Examples:

- Methodologies
- Frameworks
- Battle cards
- Templates
- Policy references

### Format

- Plain markdown
- Optional frontmatter fields such as `name`, `description`, `tags`

### Runtime Consumption

Frameworks may:

- Load selected knowledge into persistent context
- Load knowledge on demand via read/skill mechanisms

The strategy should consider context budget and file size.

## 10. State (`state/*.md`)

State files are builder-defined markdown templates for local read/write storage. The expert builder decides what state the expert tracks, what structure it uses, and how the agent should interact with it. The agent reads from and writes to these files at runtime.

This is intentionally opinionated: the builder designs the files, not the framework. State files are not generic scratch space — they represent deliberate, named storage that the builder has decided this expert needs.

### Format

- Plain markdown
- Optional YAML frontmatter

### State Frontmatter Fields

Optional:

- `name` (string)
- `description` (string)
- `scope` (string): `session` for state that resets each run, `persistent` for state retained across runs. Defaults to `persistent`.

### Example State File

```markdown
---
name: pipeline
description: Running tracker of active deals and risks
scope: persistent
---

## Active Deals

<!-- Agent writes active deal summaries here -->

## Deal Risks

<!-- Agent writes flagged risks, stalled deals, or churn signals here -->

## Recently Closed

<!-- Agent writes recently closed deals here -->
```

### Referencing State Files

Functions and processes that need to read or write state should reference the file path explicitly in their body or frontmatter. The builder decides which files each function or process uses.

Example in a function body:

```markdown
Before evaluating next action, read `./state/pipeline.md` to load current deal context.
After determining next action, update `./state/pipeline.md` with any changes to deal status or risk flags.
```

### Runtime Consumption

Frameworks should:

- Make state files readable and writable by the agent at runtime
- Preserve state file contents across agent calls when `scope` is `persistent`
- Reset state files to their template contents between sessions when `scope` is `session`

The framework should not impose a structure on state files. The builder's template is the contract.

## 11. Consumption Model (Framework Authors)

This spec does not require a workflow engine. It defines portable artifacts that frameworks can map into their own agent runtime model.

### Recommended Runtime Flow

1. Parse `expert.yaml` to discover package metadata and components.
2. Load `orchestrator.md` and persona files into persistent agent context.
3. Register functions/processes as readable capabilities (for example skills).
4. Bind abstract tools to concrete integrations.
5. Initialize state files: provision `state/*.md` files at a known writable location, resetting any `scope: session` files to their template contents.
6. At runtime, the agent reads the relevant process, follows checklist steps, reads functions on demand, calls tools, reads and writes state files as instructed, and returns outputs.
7. Optionally use scratchpad files for intermediate process state.

### Portability Rules

- A consumer framework may adapt runtime mechanics.
- A consumer framework should preserve file semantics and intent.
- Packages should remain valid without framework-specific code.

## 12. Versioning

### Spec Version

Packages should include a `spec` field in `expert.yaml`.

Current spec version: `1.0`.

### Package Versioning

Package authors should use SemVer for `version`.

Recommended interpretation:

- `MAJOR`: breaking changes to package structure or function/process contracts
- `MINOR`: backward-compatible capability additions
- `PATCH`: backward-compatible fixes and clarifications

## Non-Goals

To keep openexperts portable and simple, this specification intentionally does not define:

- Template interpolation syntax (for example `{{step.output}}`)
- A typed executable workflow DSL
- A mandatory execution engine
- Full JSON Schema requirements for tool declarations
