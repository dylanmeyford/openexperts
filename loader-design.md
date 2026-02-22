# OpenExperts → OpenClaw Loader Design

Version: `draft-3`

## Overview

The loader bridges an openexperts package into an OpenClaw sub-agent session. It validates the package, assembles a system prompt (including resolved approval policy), binds abstract tools to concrete implementations (MCP servers or ClawHub skills), wires triggers to OpenClaw's event system with concurrency control, **compiles spec processes into Lobster workflow files** for deterministic execution with native approval gates and resume tokens, and enforces delivery settings at runtime.

### Why Lobster

Validated against OpenClaw docs, the original plan's custom process executor and `before_tool_call` approval interception were architecturally unsound — OpenClaw plugin hooks cannot pause/resume execution for human approval. [Lobster](https://docs.openclaw.ai/tools/lobster) solves this natively:

- **Approval gates**: `approval: required` on workflow steps pauses execution and returns a `resumeToken`
- **Resume**: `action: "resume"` with the token continues from where it paused
- **Deterministic pipelines**: multi-step tool sequences run as a single operation
- **LLM steps**: `llm-task` plugin enables structured LLM calls within workflows (for spec functions like classify-email-intent)
- **Timeouts + safety**: enforced by the Lobster runtime, not plugin code

## How It Works

```
expert-package/          loader                    OpenClaw
─────────────────    ─────────────────    ─────────────────────
expert.yaml        →  parse manifest
                      ├─ validate       →  error / warn
                      ├─ triggers       →  cron API / hooks.mappings / message_received hook
                      ├─ concurrency    →  custom queue (parallel/serial/serial_per_key)
                      ├─ policy         →  approval tier map
                      ┘
orchestrator.md    →  ┐
persona/*.md       →  ├─ assemble      →  system prompt (via before_prompt_build hook)
                      ┘
functions/*.md     →  skill index      →  on-demand skills
processes/*.md     →  lobster compile  →  .lobster workflow files (with approval gates)
tools/*.yaml       →  tool binding     →  MCP servers / ClawHub skills
knowledge/*.md     →  context plan     →  preloaded / on-demand
state/*.md         →  state init       →  workspace files
scratch/           →  runtime dir      →  ephemeral process working files

                    Runtime execution:
                    trigger fires → concurrency check → lobster run <process>.lobster
                                                        ├─ auto steps: execute immediately
                                                        ├─ confirm steps: pause → resumeToken → chat approval → resume
                                                        ├─ manual steps: pause → draft delivered → step done (never resumed)
                                                        └─ llm-task steps: structured LLM calls for functions
```

## 1. Package Resolution

Expert packages live in a known location:

```
~/.openclaw/experts/
  radiant-sales-expert/
    expert.yaml
    orchestrator.md
    ...
  customer-success-expert/
    expert.yaml
    ...
```

Install is just cloning or copying the directory:

```bash
cd ~/.openclaw/experts
git clone https://github.com/openexperts/radiant-sales-expert
```

The loader discovers packages by scanning `~/.openclaw/experts/*/expert.yaml`.

## 2. System Prompt Assembly

The loader reads the package and assembles a system prompt for the sub-agent session:

```
┌─────────────────────────────────────────────┐
│ SYSTEM PROMPT                               │
│                                             │
│ ## Identity                                 │
│ {persona/identity.md contents}              │
│                                             │
│ ## Rules                                    │
│ {persona/rules.md contents}                 │
│                                             │
│ ## How to Operate                           │
│ {orchestrator.md contents}                  │
│                                             │
│ ## Available Functions                      │
│ (index only — name + description)           │
│ - classify-email-intent: Determine the...   │
│ - determine-next-action: Given a...         │
│ - compose-response: Draft a...              │
│                                             │
│ ## Available Processes                      │
│ (index only — name + description + trigger) │
│ - inbound-email-triage: End-to-end...       │
│                                             │
│ ## Knowledge Available                      │
│ (index only — name + description)           │
│ - meddpicc: MEDDPICC sales methodology     │
│ - competitive-battle-cards: Competitor...   │
│                                             │
│ ## State Files                              │
│ - state/pipeline.md (persistent)            │
│ - state/session-notes.md (session)          │
│                                             │
│ ## Tool Approval Policy                     │
│ Before calling any tool operation, check    │
│ the approval tier:                          │
│                                             │
│ AUTO (execute immediately):                 │
│ - crm.get_contact                           │
│ - crm.get_deal                              │
│ - crm.create_note                           │
│ - email.get_email                           │
│                                             │
│ CONFIRM (present action, wait for approval):│
│ - crm.update_deal_stage                     │
│ Default for any unlisted operation.         │
│                                             │
│ MANUAL (draft only, never execute):         │
│ - email.send                                │
│ - calendar.schedule_meeting                 │
│ Deliver the completed draft and mark the    │
│ step done.                                  │
│                                             │
│ If your confidence in a decision is low,    │
│ escalate to the main agent with your        │
│ reasoning and recommended action.           │
│                                             │
│ ## Instructions                             │
│ When you need a function, read it from:     │
│   {workspace}/functions/{name}.md           │
│ When you need knowledge, read it from:      │
│   {workspace}/knowledge/{name}.md           │
│ State files are at:                         │
│   {workspace}/state/{name}.md               │
│ Scratch files go in:                        │
│   {workspace}/scratch/                      │
│ Read and write them as instructed by        │
│ functions and processes.                    │
└─────────────────────────────────────────────┘
```

### Why Index-Only for Functions/Knowledge

Loading every function and knowledge file into the system prompt would blow the context window. Instead:

- **System prompt** gets an index (name + description) so the agent knows what's available
- **Full content** is loaded on demand when the agent reads the file during execution
- **Persona + orchestrator** are always fully loaded (they're the agent's identity and routing brain)

This mirrors how OpenClaw skills work — SKILL.md is read when needed, not preloaded.

### Policy in the System Prompt

The loader resolves the effective approval tier for every tool operation using the spec's resolution order:

1. Check `policy.approval.overrides` for an explicit entry
2. Fall back to `policy.approval.default`
3. Fall back to `confirm` if no policy block exists

The resolved tiers are rendered into the system prompt grouped by tier (AUTO / CONFIRM / MANUAL) so the agent knows at a glance what it can execute freely, what needs human approval, and what it should only draft. The `approval` field on tool YAML operations is documentation only — the loader ignores it at runtime.

If `policy.escalation.on_low_confidence` is `true`, the loader also injects an instruction telling the agent to escalate rather than act when it judges its own confidence as low.

## 3. Tool Binding

The package declares abstract tools. The user binds them to concrete implementations — either MCP servers or ClawHub skills.

### Binding Config

Bindings are stored outside the package directory so `git pull` never touches them:

```yaml
# ~/.openclaw/expert-config/radiant-sales-expert/bindings.yaml
# (user-created, not part of the package)

tools:
  crm:
    type: skill
    skill: attio
    # maps to an installed ClawHub skill

  email:
    type: mcp
    server: nylas-mcp
    # maps to an MCP server configured in OpenClaw

  calendar:
    type: mcp
    server: google-calendar-mcp
```

### Binding Types

**`type: mcp`** — Binds to an MCP server configured in OpenClaw. The loader adds the MCP server to the expert sub-agent's tool set. Operations map to MCP tool names.

**`type: skill`** — Binds to a ClawHub or local skill installed on the system. The loader ensures the skill is eligible (installed, gating requirements met) and adds it to the expert sub-agent's available skills. The skill's SKILL.md teaches the agent how to use the tool — the expert's `tools/*.yaml` operations serve as documentation for what the expert needs; the skill provides the implementation.

### Operation Mapping

For MCP bindings, the abstract tool spec declares operations like `crm.get_contact`. The binding config can optionally map these to specific MCP tool names if they don't match 1:1:

```yaml
tools:
  crm:
    type: mcp
    server: hubspot-mcp
    operations:
      get_contact: hubspot_get_contact_by_email
      get_deal: hubspot_get_deals_for_contact
```

If no operation mapping is provided, the loader assumes the MCP server exposes tools matching the operation names.

For skill bindings, operation mapping is typically unnecessary — the skill defines its own tool surface and the agent learns how to use it from the skill's instructions. If the skill exposes tool names that differ from the abstract operations, an optional mapping can be provided:

```yaml
tools:
  crm:
    type: skill
    skill: attio
    operations:
      get_contact: attio_find_person
      get_deal: attio_list_deals
```

### Validation

On load, the loader runs two phases of validation:

**Phase 1 — Package validation** (per spec section 13):
- `expert.yaml` exists and has all required fields (`spec`, `name`, `version`, `description`, `components`)
- Every path in `components` points to an existing file (error if missing)
- `triggers[].process` resolves to a process in `components.processes` (error if not)
- Process `functions[]` entries resolve to functions in `components.functions` (warn if not)
- Function/process `tools[]` entries appear in `requires.tools` (error if not)
- Function `knowledge[]` paths match `components.knowledge` entries (warn if not)
- `policy.approval.overrides` keys reference tools in `requires.tools` (warn if not)

**Phase 2 — Binding validation** (OpenClaw-specific):
- Every tool in `requires.tools` has a binding in `bindings.yaml`
- For `type: mcp`: the bound MCP server is configured and reachable. Warns if operation names don't match between tool YAML and MCP server.
- For `type: skill`: the skill is installed (ClawHub, `~/.openclaw/skills`, or workspace `skills/`) and passes gating checks (required bins, env vars, config). Warns if the skill is installed but not eligible.

## 4. State Management

State files need to survive across sub-agent sessions.

### Directory Layout

```
~/.openclaw/experts/radiant-sales-expert/
  state/                    ← package templates (read-only reference)
    pipeline.md
    session-notes.md

~/.openclaw/workspace/expert-state/radiant-sales-expert/
  state/                    ← runtime state (agent reads/writes here)
    pipeline.md
    session-notes.md
```

### Lifecycle

1. **First run:** Loader copies template state files from the package to the runtime location.
2. **Each session spawn:**
   - `scope: persistent` files are left as-is (carry forward)
   - `scope: session` files are reset to template contents
3. **Agent reads/writes** state files at the runtime location during execution.

### Scratchpad

Process scratchpad files (e.g. `./scratch/triage-{id}.md`) are created in the runtime workspace under `{workspace}/scratch/`.

Lifecycle:
- The `scratch/` directory is auto-created on first write.
- On **successful** process completion, the loader cleans up the scratchpad file.
- On **failure with retry pending**, the scratchpad is preserved so the agent can resume from it on the next attempt.
- After all retries are exhausted, scratchpad files are retained for a configurable period (default 7 days) for debugging and auditing, then cleaned up.

## 5. Sub-Agent Session Config

The loader generates a session configuration:

```yaml
# generated — not a real OpenClaw config file,
# but represents what the loader assembles

session:
  label: "expert:radiant-sales-expert"
  agentId: "radiant-sales-expert"
  mode: "run"  # one-shot by default (see section 10, Q4)

  systemPrompt: |
    {assembled from step 2, including resolved policy tiers}

  workspace: ~/.openclaw/workspace/expert-state/radiant-sales-expert/

  tools:
    - skill: attio           # CRM bound to a ClawHub skill
    - mcp: nylas-mcp         # email bound to an MCP server
    - mcp: google-calendar-mcp
    - read   # for loading functions/knowledge/state on demand
    - write  # for updating state files and scratchpad
    - edit   # for surgical state updates

  model: "anthropic/claude-sonnet-4-20250514"  # configurable per expert

  # from package execution defaults (can be overridden per process)
  execution:
    timeout: 10m
    retry:
      max_attempts: 3
      backoff: exponential
      delay: 30s
    on_failure: escalate
    resume_from_execution_log: true

  # from package delivery defaults (can be overridden per process)
  delivery:
    format: both        # narrative summary + structured outputs
    channel: main       # deliver to primary agent session
    sla_breach: warn    # warn if process-level SLA exceeded

  # resolved approval tiers for tool call interception
  approval:
    auto: [crm.get_contact, crm.get_deal, crm.create_note, email.get_email]
    confirm: [crm.update_deal_stage]
    manual: [email.send, calendar.schedule_meeting]
    default: confirm
    timeout: 24h
    on_timeout: escalate
```

### Execution Enforcement

The loader wraps each Lobster invocation with execution policy from the spec:

1. **Timeout**: mapped to Lobster's `timeoutMs` parameter. If the workflow hasn't completed within `execution.timeout`, Lobster kills the subprocess and the plugin treats it as a failure.
2. **Retry**: on failure, the plugin checks `retry.max_attempts`. If attempts remain, it waits `delay` (with `backoff` strategy) and re-invokes the Lobster pipeline. If `resume_from_execution_log` is true, Lobster's built-in resume mechanism handles continuation from the last completed step (via the resume token from the failed run, if available).
3. **On failure**: when all retries are exhausted, apply `on_failure` — `escalate` notifies the main agent and user, `abandon` logs silently, `dead_letter` queues for manual review.

Process-level `execution` overrides (from process frontmatter) take precedence over these package defaults for the specific process.

### Function Invocation Isolation

Functions default to inline execution in the current expert session. If a function declares `session: isolated`, the loader runs it in an ephemeral child sub-agent session.

For `session: isolated` function calls:

1. Resolve the function file and parse frontmatter (`inputs`, `outputs`, `tools`, `knowledge`).
2. Spawn a child session with:
   - Function body as the primary instruction prompt
   - A compact runtime policy block (approval tiers, escalation behavior)
   - Access to only the tools and files required by that function
3. Send the resolved function inputs as the invocation payload.
4. Validate and return only declared outputs (plus framework metadata like timing/confidence if available) to the parent process session.
5. Terminate the child session after completion; do not merge child working context into the parent.

This pattern keeps parent process context compact while preserving strong input/output contracts between function calls.

### Delivery Enforcement

When a process completes:

1. Format the output per `delivery.format` — `narrative` (chat-friendly summary), `structured` (typed outputs object), or `both`.
2. Route the output to `delivery.channel` — `main` delivers to the primary agent session.
3. If a process declares an `sla` and the wall-clock time exceeds it, apply `sla_breach` — `warn` notifies the user, `escalate` flags for human attention.

### Approval Enforcement (via Lobster)

Approval gates are enforced at the Lobster workflow level, not by intercepting tool calls in plugin hooks. The process-to-Lobster compiler inserts `approval: required` on workflow steps based on the resolved policy tier for each tool operation.

**Why Lobster instead of `before_tool_call`**: OpenClaw's `before_tool_call` plugin hook can intercept tool params/results, but it cannot pause execution, send a message to the user, wait for a response, and then resume — the async pause/approve/resume pattern required for `confirm`-tier operations. Lobster natively supports this via `approval: required` steps and resume tokens.

**Tier enforcement in compiled workflows**:

1. **auto**: Lobster step has no `approval` field. Executes immediately.
2. **confirm**: Lobster step has `approval: required`. The workflow pauses and returns a `resumeToken` plus a preview of the proposed action. The plugin:
   - Receives the `needs_approval` response from the Lobster tool.
   - Delivers the approval request inline in the main chat channel (operation name, inputs, expert reasoning).
   - Registers `/approve <id>` and `/reject <id>` auto-reply commands via `api.registerCommand()`.
   - On approve: calls Lobster `resume` with `approve: true`. Execution continues.
   - On reject or timeout: calls Lobster `resume` with `approve: false`. Treated as failed step → follows `execution.on_failure`.
   - If `policy.approval.timeout` is set, a background service timer starts. On expiry, applies `on_timeout` (`reject` or `escalate`).
3. **manual**: Lobster step has `approval: required` and is **never resumed**. The approval preview IS the draft. The plugin delivers the draft to the main chat with a "DRAFT — for your review" label and marks the step complete. The human executes the action themselves.

**Approval token management**: Pending approvals are stored at `{dataDir}/approvals/pending.json`. A background service (via `api.registerService()`) polls for timed-out approvals.

## 6. Process → Lobster Compilation

The loader compiles spec processes into executable `.lobster` workflow files. This is the bridge between the spec's "markdown playbooks for an agent loop" and OpenClaw's deterministic execution runtime.

**The package remains code-free.** Expert authors write markdown processes with checklist steps. The loader generates `.lobster` files at activation time; the expert package never contains generated code.

### Compilation Steps

1. Parse process frontmatter (`name`, `trigger`, `inputs`, `outputs`, `functions`, `tools`, `scratchpad`, `execution`, `delivery`).
2. Parse process body to extract ordered step checklist (`- [ ] Step ...`).
3. For each step, determine the step type and generate the corresponding Lobster step:

**Tool call steps** (e.g., "Fetch the inbound email using the `email` tool"):
```yaml
- id: fetch_email
  command: openclaw.invoke --tool nylas_get_email --args-json '{"message_id":"$message_id"}'
```
The abstract tool name (`email`) and operation (`get_email`) are resolved via bindings to the concrete tool name (`nylas_get_email`). Operation mapping from `bindings.yaml` is applied if present.

**Function invocation steps** (e.g., "Read and apply `classify-email-intent`"):
```yaml
- id: classify
  command: openclaw.invoke --tool llm-task --action json --args-json '{
    "prompt": "<full function body from functions/classify-email-intent.md>",
    "input": {"email_body": "$fetch_email.json.body", "sender_context": "$fetch_contact.json"},
    "schema": {"type": "object", "properties": {"intent": {"type": "string"}, ...}, "required": [...]}
  }'
  stdin: $fetch_email.json
```
The function's markdown body becomes the `llm-task` prompt. Declared `inputs` and `outputs` from frontmatter map to the `input` and `schema` fields.

**State read/write steps** (e.g., "Open scratchpad", "Update state/pipeline.md"):
```yaml
- id: scratchpad
  command: exec --shell 'cat scratch/triage-$message_id.md 2>/dev/null || echo "# Triage"'
```

4. Insert `approval: required` on steps that invoke tool operations at `confirm` or `manual` tier (resolved from `policy.approval`).
5. Wire `stdin: $step.stdout` / `stdin: $step.json` for data flow between steps.
6. Add `condition: $step.approved` gates after approval steps (for `confirm` tier; `manual` steps are terminal).
7. Apply process-level `execution` overrides (timeout maps to Lobster `timeoutMs`).

### Output

Generated `.lobster` files live at `{dataDir}/compiled/<expert>/<process-name>.lobster`. They are regenerated on:
- `openclaw expert activate`
- Package update (`openclaw expert update`)
- Binding change (`openclaw expert bind`)

### Example: Compiled `inbound-email-triage.lobster`

Source: `processes/inbound-email-triage.md` with its checklist steps.

```yaml
name: inbound-email-triage
args:
  message_id:
    type: string
steps:
  - id: scratchpad
    command: exec --shell 'cat scratch/triage-$message_id.md 2>/dev/null || echo "# Triage: $message_id"'

  - id: fetch_email
    command: openclaw.invoke --tool nylas_get_email --args-json '{"message_id":"$message_id"}'

  - id: fetch_contact
    command: openclaw.invoke --tool attio_find_person --args-json '{"email":"$fetch_email.json.sender"}'
    stdin: $fetch_email.json

  - id: fetch_deal
    command: openclaw.invoke --tool attio_list_deals --args-json '{"contact_id":"$fetch_contact.json.contact_id"}'
    stdin: $fetch_contact.json

  - id: classify
    command: openclaw.invoke --tool llm-task --action json --args-json '{
      "prompt": "## Classify Email Intent\n\nGiven email body and sender CRM context, classify intent and urgency.\n\n### Decision Rules\n- If the sender is in a late deal stage and mentions a competitor, classify as objection and high.\n- If there has been >14 days of inactivity and the reply is short/hesitant, classify as churn_risk.\n- If the email asks product or technical details, classify as question.\n\n### Output\nReturn: Intent, Urgency, Reasoning, Confidence",
      "schema": {
        "type": "object",
        "properties": {
          "intent": {"type": "string", "enum": ["objection","question","buying_signal","churn_risk","scheduling","other"]},
          "urgency": {"type": "string", "enum": ["high","medium","low"]},
          "reasoning": {"type": "string"},
          "confidence": {"type": "string", "enum": ["high","medium","low"]}
        },
        "required": ["intent","urgency","reasoning","confidence"]
      }
    }'
    stdin: $fetch_deal.json

  - id: next_action
    command: openclaw.invoke --tool llm-task --action json --args-json '{...determine-next-action...}'
    stdin: $classify.json

  - id: compose
    command: openclaw.invoke --tool llm-task --action json --args-json '{...compose-response...}'
    stdin: $next_action.json

  - id: send_email
    command: openclaw.invoke --tool nylas_send_email --args-json '{"draft":"$compose.json.draft_response"}'
    stdin: $compose.json
    approval: required
    # manual tier: always pauses, preview IS the draft, never resumed

  - id: create_note
    command: openclaw.invoke --tool attio_create_note --args-json '{"contact_id":"$fetch_contact.json.contact_id","body":"Triage: $classify.json.intent ($classify.json.urgency)"}'
```

### Handling Isolated Functions

Functions that declare `session: isolated` cannot be compiled into inline `llm-task` steps. Instead:

1. The compiler generates a separate `.lobster` file for the function.
2. The parent process step invokes it as a nested Lobster workflow.
3. Only declared `outputs` are returned to the parent pipeline.
4. Child working context is not merged back.

### Compilation Limitations

The compiler targets the **checklist pattern** (spec-recommended). Processes that use unstructured prose instead of `- [ ] Step ...` checklists cannot be auto-compiled and will require manual `.lobster` authoring or a fallback to full agent-session execution (where the agent follows the process as a playbook without Lobster).

## 7. Trigger Wiring

The loader reads `triggers` from the manifest and registers each one using OpenClaw's native mechanisms.

### Trigger Types → OpenClaw Mechanisms

**`webhook`** — Uses OpenClaw's `hooks.mappings` system. When a preset is declared (e.g. `preset: gmail`), the loader adds it to `hooks.presets` (e.g., `hooks.presets: ["gmail"]`). When `requires_tool` is declared instead, the loader creates a custom hook mapping under `hooks.mappings` that routes the payload to the expert's process. The webhook endpoint is `POST /hooks/<trigger-name>` with token auth.

**`cron`** — Uses OpenClaw's built-in `cron.add` Gateway API. The loader creates a cron job per trigger:
- `expr` + `tz` → `schedule.kind: "cron"`, `schedule.expr`, `schedule.tz`
- `session: isolated` (default) → `sessionTarget: "isolated"` with `payload.kind: "agentTurn"` containing the Lobster pipeline invocation
- `session: main` → `sessionTarget: "main"` with `payload.kind: "systemEvent"`
- `delivery` → `delivery.mode: "announce"` with channel routing

**`channel`** — Uses the `message_received` plugin hook. The loader registers a handler that matches incoming messages against expert trigger definitions (by channel, sender pattern, or content match). On match, the handler dispatches to the concurrency queue → Lobster pipeline.

### Trigger → Lobster Process Invocation

When a trigger fires:

1. **Dedupe**: if `dedupe_key` is set, check the plugin's LRU/TTL seen-keys map. Skip if key was processed within the `dedupeWindowMs` window.
2. **Payload mapping**: resolve `payload_mapping` to map trigger payload fields to process input names (Lobster workflow `args`).
3. **Concurrency check**: apply the effective concurrency policy (see below). If queued, hold until the lane is free.
4. **Lobster invocation**: call the Lobster tool with `action: "run"`, `pipeline: "{dataDir}/compiled/<expert>/<process>.lobster"`, `argsJson` containing resolved inputs, and `timeoutMs` from execution policy.
5. **Handle result**: if Lobster returns `ok` → deliver output per delivery settings. If `needs_approval` → enter approval flow (section 5). If error → apply retry policy.

### Concurrency (Custom Queue)

OpenClaw's native cron has only `maxConcurrentRuns: 1` globally — insufficient for per-trigger and per-key concurrency modes. The loader implements its own concurrency manager via `api.registerService()`.

**`parallel`** — each invocation dispatches immediately. No coordination.

**`serial`** — all invocations of this trigger queue globally. The service maintains a per-trigger FIFO queue and processes one at a time.

**`serial_per_key`** — invocations queue per grouping key. The service resolves `concurrency_key` against the (possibly enriched) trigger payload. Invocations with the same key run in order; different keys run in parallel. If the key can't be resolved, fall back to `serial` for that invocation and log a warning.

Queue state is held in memory with overflow to `{dataDir}/queue/` for crash recovery.

```
# Example: new_email trigger inherits serial_per_key on contact_id
# from package-level concurrency defaults.
#
# Email from sarah@acme.com arrives → preset enriches payload with contact_id
# → queued behind any in-flight process for this contact_id
# → meanwhile, email from bob@megacorp.com runs in parallel (different key)
```

### Example: How Triggers Map to OpenClaw

```yaml
# spec trigger:
- name: new_email
  type: webhook
  preset: gmail
  dedupe_key: message_id
  session: isolated
  concurrency: serial_per_key
  concurrency_key: contact_id
  payload_mapping:
    message_id: messages[0].id
  process: inbound-email-triage

# → OpenClaw webhook mapping (hooks.presets: ["gmail"])
# → Plugin intercepts gmail webhook payload
# → Dedupe check on message_id
# → Concurrency queue: serial_per_key on enriched contact_id
# → lobster run compiled/radiant-sales-expert/inbound-email-triage.lobster --args-json '{"message_id":"..."}'

# spec trigger:
- name: opportunity_scan
  type: cron
  expr: "0 8 * * 1-5"
  tz: Australia/Sydney
  session: isolated
  concurrency: serial
  process: scan-for-opportunities

# → OpenClaw cron.add:
#   schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "Australia/Sydney" }
#   sessionTarget: "isolated"
#   payload: { kind: "agentTurn", message: "lobster run ..." }
#   delivery: { mode: "announce", channel: "last" }
```

## 7. Main Agent Integration

### Expert Registry

The main agent needs to know what experts are available. The loader writes a registry file:

```markdown
<!-- ~/.openclaw/workspace/EXPERTS.md (auto-generated) -->

# Available Experts

## radiant-sales-expert
- **Description:** B2B sales expertise for inbound deal triage and next-best-action
- **Session:** expert:radiant-sales-expert
- **Triggers:**
  - new_email (webhook/gmail) → inbound-email-triage [serial_per_key: contact_id]
  - opportunity_scan (cron: weekdays 8am AEST) → scan-for-opportunities [serial]
- **Capabilities:** email classification, next-action determination, response composition
- **Tools bound:** crm → attio (skill), email → nylas-mcp (mcp), calendar → google-calendar-mcp (mcp)
- **Policy:** confirm by default, email.send and calendar.schedule_meeting are manual (draft-only)

## customer-success-expert
- ...
```

This gets loaded into the main agent's context so it knows what it can delegate.

### Routing

When the main agent receives a task, it checks EXPERTS.md and routes:

```
User: "Handle that email from the Acme lead"
  ↓
Main agent reads EXPERTS.md
  ↓
Matches: radiant-sales-expert (email classification, response composition)
  ↓
sessions_send(label="expert:radiant-sales-expert", message="...")
  ↓
Expert sub-agent runs inbound-email-triage process
  ↓
Returns result to main agent (per delivery settings: narrative + structured)
  ↓
Main agent relays to user
```

## 8. CLI Commands (Proposed)

```bash
# Install a package
openclaw expert install https://github.com/openexperts/radiant-sales-expert

# List installed experts
openclaw expert list

# Configure tool bindings (MCP server or ClawHub skill)
openclaw expert bind radiant-sales-expert crm --skill attio
openclaw expert bind radiant-sales-expert email --mcp nylas-mcp
openclaw expert bind radiant-sales-expert calendar --mcp google-calendar-mcp

# Validate a package (check bindings, tool availability)
openclaw expert validate radiant-sales-expert

# Update a package (git pull with SemVer safety checks)
openclaw expert update radiant-sales-expert
openclaw expert update --all

# Remove a package
openclaw expert remove radiant-sales-expert

# Spawn an expert session manually
openclaw expert run radiant-sales-expert "Triage this email: ..."
```

## 9. Full Flow Example

### Setup (one-time)

```bash
# Install the expert package
openclaw expert install https://github.com/openexperts/radiant-sales-expert

# Bind tools — mix of ClawHub skills and MCP servers
openclaw expert bind radiant-sales-expert crm --skill attio
openclaw expert bind radiant-sales-expert email --mcp nylas-mcp
openclaw expert bind radiant-sales-expert calendar --mcp google-calendar-mcp

# Validate
openclaw expert validate radiant-sales-expert
# ✓ Package structure valid (spec 1.0)
# ✓ Cross-references intact (triggers → processes → functions)
# ✓ All required tools bound
#   crm → attio (skill, eligible ✓)
#   email → nylas-mcp (mcp, reachable ✓)
#   calendar → google-calendar-mcp (mcp, reachable ✓)
# ✓ State files initialized
# ✓ Triggers registered (new_email: webhook/gmail, opportunity_scan: cron)
```

### Runtime (automatic — webhook trigger via Lobster)

```
[Gmail PubSub push] → new_email trigger fires
  → Plugin intercepts via hooks.mappings
  → Dedupe check: message_id not seen → proceed
  → Concurrency check: serial_per_key on contact_id
    → No in-flight process for this contact → proceed
  → Lobster tool call: { action: "run", pipeline: "compiled/radiant-sales-expert/inbound-email-triage.lobster", argsJson: '{"message_id":"..."}', timeoutMs: 600000 }
  → Lobster executes deterministic pipeline:
    → fetch_email via nylas_get_email (auto → no approval gate)
    → fetch_contact via attio_find_person (auto)
    → fetch_deal via attio_list_deals (auto)
    → classify via llm-task (structured LLM call with classify-email-intent prompt) → buying_signal, high urgency
    → next_action via llm-task → schedule demo, multi-thread
    → compose via llm-task → draft email
    → send_email via nylas_send_email — MANUAL tier → approval: required
  → Lobster returns: { status: "needs_approval", resumeToken: "...", output: { draft: "..." } }
  → Plugin delivers draft to main chat: "📝 DRAFT — Email to Sarah at Acme (for your review):\n..."
  → Step marked done (manual tier — never resumed)
  → Lobster continues remaining steps:
    → create_note via attio_create_note (auto)
  → Lobster returns: { status: "ok", output: { classification: {...}, recommended_action: {...} } }
  → Plugin delivers to main agent (narrative + structured):
    "Buying signal from Sarah at Acme (Stage 3, $45k).
     She's asking about enterprise pricing — looks ready to move.
     Draft reply ready for your review. Recommend scheduling demo
     this week and looping in their VP Engineering (your champion)."
  → Main agent relays to Dylan via chat
```

### Runtime (automatic — confirm approval via Lobster)

```
[Trigger fires] → Lobster pipeline reaches crm.update_deal_stage (confirm tier)
  → Lobster returns: { status: "needs_approval", resumeToken: "tok_abc123",
      requiresApproval: { prompt: "Update Acme deal to Stage 4?", items: [{...}] } }
  → Plugin delivers approval request to main chat:
    "⏸️ Approval needed: Update Acme deal stage to Stage 4 (Negotiation)
     Reason: Buying signal detected, demo scheduled.
     Reply /approve tok_abc123 or /reject tok_abc123"
  → Approval timeout timer starts (24h per policy)
  → User replies: /approve tok_abc123
  → Plugin calls Lobster: { action: "resume", token: "tok_abc123", approve: true }
  → Lobster continues pipeline from where it paused
  → Process completes normally
```

### Runtime (automatic — failure with retry)

```
[Gmail PubSub push] → new_email trigger fires
  → Lobster pipeline starts, completes steps 1-3 (fetch_email, fetch_contact, fetch_deal)
  → fetch_deal fails (API timeout)
  → Lobster returns: { status: "error", error: "timeout on step fetch_deal" }
  → Plugin checks retry policy: attempt 1 of 3, backoff: 30s
  → After 30s delay, re-invokes Lobster pipeline
    → Lobster re-executes from step 1 (idempotent: false → relies on scratchpad if present)
    → fetch_deal succeeds → pipeline continues to completion
```

### Runtime (user-initiated)

```
Dylan: "What's my pipeline looking like?"
  → Main agent routes to Sales AE
  → Sales AE reads state/pipeline.md
  → Returns summary (narrative format)
  → Main agent relays to Dylan
```

## 10. Open Questions

### Resolved by Spec

1. **~~Multi-expert coordination~~** — The spec defines hub-and-spoke routing through the main agent session as the recommended pattern. Direct expert-to-expert communication is out of scope. ✓

2. **~~Expert-to-expert communication~~** — Same as above. Start with hub-and-spoke; main agent as router. ✓

3. **~~State conflicts~~** — The spec's concurrency model (`serial_per_key`) serializes operations per entity key, preventing concurrent writes to the same state. For the same expert, triggers with `serial_per_key` on `contact_id` guarantee no two processes for the same contact overlap. For user-initiated runs that bypass triggers, the loader should queue them behind any in-flight process for the same expert session. ✓

### Resolved by Loader Design

4. **~~Persistent sessions vs. re-spawn~~** — Default to one-shot (`mode: "run"`). Expert sub-agents spin up fresh for each task and announce their result back to the requester. ✓

   **Trigger-invoked tasks**: `session: isolated` spawns a fresh `mode: "run"` session per invocation. `session: main` enqueues into the primary agent session. Both are already defined by the spec.

   **User-initiated tasks**: The main agent uses `sessions_spawn` with `mode: "run"` by default. The expert does its work, announces the result, and the session archives per OpenClaw's `archiveAfterMinutes`.

   **Why one-shot is the right default**: Expert continuity lives in **state files**, not conversation history. The persona and orchestrator are static package content reloaded each time. There is no inherent need to keep a session alive — the "memory" is already durable in `~/.openclaw/workspace/expert-state/<name>/state/`. One-shot sessions are cheaper (no idle context window), cleaner (no stale context), and simpler to reason about.

   **Interactive exception**: If the main agent judges a task is conversational (e.g., back-and-forth email drafting), it may spawn with `mode: "session"` and `thread: true` for follow-ups. This is the main agent's routing decision at invocation time, not a package-level declaration. The expert package does not need a `persistent` field.

5. **~~Context from main agent~~** — Slim, structured context envelope. The main agent assembles it using its knowledge of the expert from EXPERTS.md. ✓

   When the main agent routes a task via `sessions_spawn`, the `task` parameter should include a context envelope with:

   - **`task`** (required): The specific instruction or question.
   - **`user_context`** (optional): Lightweight user metadata — `timezone`, `name`, `preferences`. Already available in the main agent's session.
   - **`conversation_excerpt`** (optional): The last few relevant messages the main agent selects. The main agent decides what's relevant — it does not dump the full conversation history.
   - **`entity_hint`** (optional): Pre-fetched entity identifiers (e.g., contact email, deal ID) that save the expert a lookup.

   The envelope stays minimal by design. The expert has its own tools to fetch what it needs. Passing the entire main session context would blow the expert's context window and create unnecessary coupling.

   This is prompt engineering in the main agent's EXPERTS.md instructions, not loader machinery. The loader documents the recommended envelope shape; the main agent follows it.

6. **~~Package updates~~** — Git-based update with SemVer-aware safety checks. State and bindings are always preserved. ✓

   **Mechanics**:
   - `openclaw expert update <name>` runs `git pull` in the package directory (`~/.openclaw/experts/<name>/`).
   - Before applying, the loader compares the incoming `expert.yaml` version against the installed version using SemVer:
     - **PATCH** (e.g., 0.1.0 → 0.1.1): Pull and reload. No user action needed.
     - **MINOR** (e.g., 0.1.0 → 0.2.0): Pull and reload. Log new capabilities. Initialize any new state templates.
     - **MAJOR** (e.g., 0.1.0 → 1.0.0): Warn the user and show a diff summary. Require `--force` to proceed.
   - `openclaw expert update --all` updates all installed experts.

   **State preservation**: Runtime state files at `~/.openclaw/workspace/expert-state/<name>/state/` are **never deleted** on update. New templates from the package are initialized at the runtime location. Changed templates do not overwrite existing runtime state — the user's data takes precedence.

   **Binding preservation**: Bindings live at `~/.openclaw/expert-config/<name>/bindings.yaml`, outside the package directory. `git pull` cannot touch them. If the updated package adds new `requires.tools` entries, the loader warns that new bindings are needed.

   **Trigger re-registration**: After update, the loader re-validates the package and re-registers triggers. Handlers for removed triggers are cleaned up. Changed triggers are re-wired.

7. **~~Secrets/credentials~~** — Defer entirely to OpenClaw's existing auth model. No credentials in the expert layer. ✓

   - Expert packages **never** contain credentials. Nor do bindings files.
   - `bindings.yaml` maps abstract tools to implementation names (MCP server or skill). It contains no secrets.
   - **MCP server auth** is configured via OpenClaw's existing mechanisms: `~/.openclaw/openclaw.json`, per-agent auth profiles at `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`, or OpenClaw's OAuth flow.
   - **Skill auth** is configured via OpenClaw's `skills.entries.<name>.apiKey` and `skills.entries.<name>.env` in `openclaw.json`, following the existing skill auth pattern.
   - The loader validates at `openclaw expert validate` time that bound implementations have working auth.
   - Expert tool YAML files may include a `requires_auth` string (e.g., `"OAuth2"`) as documentation for human readers, but this is informational only — the loader does not enforce it.

8. **~~Approval UX~~** — Lobster-native approval gates with inline chat UX. ✓

   **Tier mapping via Lobster**:
   - **`auto`**: Lobster step has no `approval` field. Executes immediately.
   - **`confirm`**: Lobster step has `approval: required`. Pipeline pauses and returns a `resumeToken`. The plugin delivers the approval request inline in the main chat channel (operation name, inputs, reasoning) and registers `/approve <id>` and `/reject <id>` auto-reply commands. On approve, the plugin calls `lobster resume --approve true`. On reject or timeout, calls `lobster resume --approve false` → follows `on_failure`.
   - **`manual`**: Lobster step has `approval: required` but is **never resumed**. The preview IS the draft. The plugin delivers the draft to the main chat with a "DRAFT — for your review" label and marks the step complete.

   **Why Lobster instead of custom interception**: The original plan assumed `before_tool_call` could pause/resume agent execution for human approval. OpenClaw docs confirmed this hook can intercept tool params/results but cannot implement async pause/approve/resume patterns. Lobster solves this natively.

   **Batch approvals**: Approvals are presented **one at a time**, matching the serial nature of Lobster pipeline execution. No batch mode for v1.

   **Future extensibility**: The plugin emits structured approval events (operation, inputs, expert name, reasoning, timestamp, resume token) so a future dedicated approval queue or dashboard UI can consume them. For v1, inline chat + `/approve` commands are the UX surface.

9. **~~Process execution engine~~** — Lobster-based compilation, not custom executor. ✓

   The original plan called for a custom process executor with timeout, retry, resume, and delivery handling. Validated against OpenClaw docs, this is replaced by:

   - **Process compilation**: spec processes (markdown playbooks with checklist steps) are compiled into `.lobster` workflow files at activation time.
   - **Lobster execution**: the Lobster tool runs compiled workflows with deterministic step execution, JSON piping between steps, and native approval gates.
   - **LLM judgment steps**: functions that require LLM reasoning (classify, compose, determine) use the `llm-task` plugin within Lobster pipelines for structured outputs.
   - **Timeout/retry**: `timeoutMs` is handled by Lobster; retry with backoff is managed by the plugin wrapper.
   - **Resume**: Lobster resume tokens handle continuation from paused (approval) states. For failure retry, the plugin re-invokes the full pipeline (scratchpad provides domain-level state recovery).

   **Dependency**: Lobster CLI must be installed on the Gateway host. The `llm-task` plugin must be enabled. Both are validated at `openclaw expert doctor` time.
