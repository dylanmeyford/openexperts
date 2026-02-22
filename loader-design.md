# OpenExperts → OpenClaw Loader Design

Version: `draft-2`

## Overview

The loader bridges an openexperts package into an OpenClaw sub-agent session. It validates the package, assembles a system prompt (including resolved approval policy), binds abstract tools to concrete implementations (MCP servers or ClawHub skills), wires triggers to OpenClaw's event system with concurrency control, and enforces execution guarantees (timeout, retry, resumption) and delivery settings at runtime.

## How It Works

```
expert-package/          loader           OpenClaw
─────────────────    ─────────────    ─────────────────
expert.yaml        →  parse manifest
                      ├─ validate    →  error / warn
                      ├─ triggers    →  webhook / cron / channel handlers
                      ├─ concurrency →  queue config per trigger
                      ├─ execution   →  timeout / retry / resume policy
                      ├─ delivery    →  output routing config
                      ├─ policy      →  approval tier enforcement
                      ┘
orchestrator.md    →  ┐
persona/*.md       →  ├─ assemble   →  system prompt
                      ┘
functions/*.md     →  skill index   →  on-demand skills
processes/*.md     →  skill index   →  on-demand skills
tools/*.yaml       →  tool binding  →  MCP servers / ClawHub skills
knowledge/*.md     →  context plan  →  preloaded / on-demand
state/*.md         →  state init    →  workspace files
scratch/           →  runtime dir   →  ephemeral process working files
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

The loader wraps each process invocation with execution policy:

1. **Timeout**: start a wall-clock timer. If the process hasn't completed within `execution.timeout`, treat it as a failure.
2. **Retry**: on failure, check `retry.max_attempts`. If attempts remain, wait `delay` (with `backoff` strategy) and re-invoke. If `resume_from_execution_log` is true, inject step-completion context into the retry prompt so the agent resumes rather than restarts.
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

### Approval Enforcement

The loader intercepts every tool call during execution:

1. Look up the operation in the resolved approval map.
2. **auto**: execute immediately, return result to agent.
3. **confirm**: pause execution, present the proposed action (operation name, inputs, reasoning) to the user via the main chat channel. Wait for approval. On approval, execute and continue. On rejection or timeout, treat as a failed step and follow `on_failure`.
4. **manual**: the agent prepares the action as a draft. The loader delivers the draft to the user via the escalation channel and marks the step complete. The agent never executes it.

## 6. Trigger Wiring

The loader reads `triggers` from the manifest and registers each one with OpenClaw's runtime.

### Trigger Types

**`webhook`** — The loader registers a webhook handler. When a preset is declared (e.g. `preset: gmail`), the loader uses OpenClaw's built-in handler for that event source (Gmail PubSub push notification). When `requires_tool` is declared instead, the loader expects the bound MCP server to provide the webhook endpoint.

**`cron`** — The loader registers an OpenClaw cron job using the trigger's `expr` and `tz`.

**`channel`** — The loader registers a channel message handler. OpenClaw normalizes incoming channel messages into a standard payload shape (`sender_id`, `message_text`, `channel_name`).

### Trigger → Process Invocation

When a trigger fires:

1. **Dedupe**: if `dedupe_key` is set, check whether an event with this key was already processed recently. Skip if duplicate.
2. **Payload mapping**: resolve `payload_mapping` to map trigger payload fields to process input names.
3. **Concurrency check**: apply the effective concurrency policy (see below).
4. **Session creation**: if `session: isolated` (default), spawn a new sub-agent session. If `session: main`, enqueue into the primary agent session.
5. **Process execution**: invoke the target process with resolved inputs, preloading any declared `context` files.

### Concurrency

The loader applies concurrency policy per trigger. Each trigger inherits from `concurrency.default` in the manifest unless it declares its own override.

**`parallel`** — each invocation runs immediately in its own session. No coordination.

**`serial`** — all invocations of this trigger queue globally. The loader maintains a per-trigger FIFO queue and processes one at a time.

**`serial_per_key`** — invocations queue per grouping key. The loader resolves `concurrency_key` against the (possibly enriched) trigger payload. Invocations with the same key run in order; different keys run in parallel. If the key can't be resolved, fall back to `serial` for that invocation and log a warning.

```
# Example: new_email trigger inherits serial_per_key on contact_id
# from package-level concurrency defaults.
#
# Email from sarah@acme.com arrives → preset enriches payload with contact_id
# → queued behind any in-flight process for this contact_id
# → meanwhile, email from bob@megacorp.com runs in parallel (different key)
```

### Example: Wired Triggers

```yaml
# What the loader registers with OpenClaw runtime:

triggers:
  - name: new_email
    handler: webhook/gmail          # from preset: gmail
    dedupe_key: message_id
    concurrency: serial_per_key
    concurrency_key: contact_id     # inherited from package-level concurrency
    session: isolated
    process: inbound-email-triage
    payload_mapping:
      message_id: messages[0].id

  - name: opportunity_scan
    handler: cron
    expr: "0 8 * * 1-5"
    tz: Australia/Sydney
    concurrency: serial             # override: global queue
    session: isolated
    process: scan-for-opportunities
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

### Runtime (automatic — webhook trigger)

```
[Gmail PubSub push] → new_email trigger fires
  → Dedupe check: message_id not seen → proceed
  → Concurrency check: serial_per_key on contact_id
    → No in-flight process for this contact → proceed
  → Spawn isolated session for inbound-email-triage
  → Open scratchpad at scratch/triage-{message_id}.md
  → Fetch email via email.get_email (auto → executes immediately)
  → Fetch contact via crm.get_contact (auto → executes immediately)
  → Fetch deal via crm.get_deal (auto → executes immediately)
  → Execute classify-email-intent (inline or isolated per function session mode) → buying_signal, high urgency
  → Execute determine-next-action (inline or isolated per function session mode) → schedule demo, multi-thread
  → Execute compose-response (inline or isolated per function session mode) → draft email
  → email.send is MANUAL tier → draft delivered to user, step marked done
  → crm.create_note (auto → executes immediately, logs triage summary)
  → Update state/pipeline.md with deal movement
  → Clean up scratchpad (success)
  → Deliver to main agent (narrative + structured):
    "Buying signal from Sarah at Acme (Stage 3, $45k).
     She's asking about enterprise pricing — looks ready to move.
     Draft reply ready for your review. Recommend scheduling demo
     this week and looping in their VP Engineering (your champion)."
  → Main agent relays to Dylan via chat
```

### Runtime (automatic — failure with retry)

```
[Gmail PubSub push] → new_email trigger fires
  → Spawn isolated session for inbound-email-triage
  → Open scratchpad, fetch email, fetch contact... (steps 1-3 complete)
  → crm.get_deal fails (API timeout)
  → Scratchpad preserved with steps 1-3 results
  → Retry attempt 2 (after 30s backoff)
    → Read scratchpad → resume from step 4
    → crm.get_deal succeeds → continue
    → Process completes normally
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

8. **~~Approval UX~~** — Inline chat confirmations, one at a time, with structured events for future UIs. ✓

   **Tier mapping for OpenClaw**:
   - **`auto`**: Tool call executes immediately. No interception.
   - **`confirm`**: The loader pauses execution and delivers an approval request inline in the main chat channel. The message includes: operation name, input summary, the expert's reasoning, and a clear approve/reject prompt. The user responds in chat. If `policy.approval.timeout` is set, a timer starts. On timeout, apply `on_timeout` behavior (`reject` or `escalate`).
   - **`manual`**: The expert prepares a complete draft. The loader delivers it to the main chat with a "DRAFT — for your review" label. The step is marked complete immediately. The user executes the action themselves or discards it.

   **Batch approvals**: Approvals are presented **one at a time**, matching the serial nature of process step execution. The agent pauses at each `confirm` step and waits. No batch mode for v1 — serial approval is simpler, safer, and easier to reason about.

   **Future extensibility**: The loader should emit structured approval events (operation, inputs, expert name, reasoning, timestamp) so a future dedicated approval queue or dashboard UI can consume them. For v1, inline chat is the UX surface.
