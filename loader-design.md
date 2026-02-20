# OpenExperts → OpenClaw Loader Design

Version: `draft-1`

## Overview

The loader bridges an openexperts package into an OpenClaw sub-agent session. It validates the package, assembles a system prompt (including resolved approval policy), binds abstract tools to MCP servers, wires triggers to OpenClaw's event system with concurrency control, and enforces execution guarantees (timeout, retry, resumption) and delivery settings at runtime.

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
tools/*.yaml       →  tool binding  →  MCP / tool config
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

The package declares abstract tools. The user binds them to concrete implementations.

### Binding Config

```yaml
# ~/.openclaw/experts/radiant-sales-expert/bindings.yaml
# (user-created, not part of the package)

tools:
  crm:
    type: mcp
    server: hubspot-mcp
    # maps to an MCP server configured in OpenClaw
  email:
    type: mcp
    server: nylas-mcp
  calendar:
    type: mcp
    server: google-calendar-mcp
```

### Operation Mapping

The abstract tool spec declares operations like `crm.get_contact`. The binding config can optionally map these to specific MCP tool names if they don't match 1:1:

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
- Every bound MCP server is configured and reachable
- Warns (not errors) if operation names don't match between tool YAML and MCP server

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

  systemPrompt: |
    {assembled from step 2, including resolved policy tiers}

  workspace: ~/.openclaw/workspace/expert-state/radiant-sales-expert/

  tools:
    - mcp: hubspot-mcp
    - mcp: nylas-mcp
    - mcp: google-calendar-mcp
    - read   # for loading functions/knowledge/state on demand
    - write  # for updating state files and scratchpad
    - edit   # for surgical state updates

  model: "anthropic/claude-sonnet-4-20250514"  # configurable per expert

  persistent: true  # keep session alive between tasks

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
- **Tools bound:** crm → hubspot-mcp, email → nylas-mcp, calendar → google-calendar-mcp
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

# Configure tool bindings
openclaw expert bind radiant-sales-expert crm hubspot-mcp

# Validate a package (check bindings, tool availability)
openclaw expert validate radiant-sales-expert

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

# Bind tools (assumes MCP servers already configured)
openclaw expert bind radiant-sales-expert crm hubspot-mcp
openclaw expert bind radiant-sales-expert email nylas-mcp
openclaw expert bind radiant-sales-expert calendar google-calendar-mcp

# Validate
openclaw expert validate radiant-sales-expert
# ✓ Package structure valid (spec 1.0)
# ✓ Cross-references intact (triggers → processes → functions)
# ✓ All required tools bound
# ✓ MCP servers reachable
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
  → Read and apply classify-email-intent → buying_signal, high urgency
  → Read and apply determine-next-action → schedule demo, multi-thread
  → Read and apply compose-response → draft email
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

### Still Open

4. **Persistent sessions vs. re-spawn:** Should expert sub-agents stay alive between tasks (lower latency, maintains conversation context) or spin up fresh each time (cleaner, cheaper)? The spec's `session: isolated` vs `session: main` on triggers covers the automatic case, but user-initiated routing (main agent delegates to expert) needs a decision. Probably configurable per expert.

5. **Context from main agent:** When the main agent routes a task, how much context does it pass? Just the task, or also relevant user context (timezone, preferences, recent conversation)? Probably a slim context envelope.

6. **Package updates:** When the package author pushes a new version, how does that flow? `openclaw expert update`? Does it preserve runtime state files and bindings? The spec's SemVer guidance (MAJOR = breaking, MINOR = additions, PATCH = fixes) helps the loader decide whether an update is safe, but the migration mechanics are still undefined.

7. **Secrets/credentials:** Tool bindings may need auth. This should defer to OpenClaw's existing MCP server config rather than putting credentials in the expert package or bindings file.

8. **Approval UX:** When a `confirm`-tier operation pauses for human approval, what does the UX look like? Inline in the chat? A separate approval queue? What about batch approvals when a process has multiple confirm steps? The spec defines the semantics but the presentation is framework-specific.
