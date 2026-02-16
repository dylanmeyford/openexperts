# openexperience Specification v0.1

## Overview

An **experience package** is a directory of markdown and YAML files that encodes professional expertise in a framework-agnostic format. Any AI agent framework can consume it -- by reading the markdown directly as prompts, mapping functions to agent definitions, or mapping processes to workflow chains.

This document defines the structure, file formats, and schemas that all experience packages must follow.

## Design Principles

- **Framework-agnostic**: No code. Markdown instructions, YAML definitions. Any framework can consume it.
- **Human-readable**: A person can read the package and understand the expertise without any tooling.
- **Ports and adapters**: The experience declares what it needs (tools, data shapes). The host project provides concrete implementations.
- **Progressive complexity**: Only a few components are required. Everything else is opt-in.

## Consumption Model

An experience package contains no code. It is a set of files that a framework reads, interprets, and executes. This section describes the end-to-end flow from installation to runtime.

### Installation

Installation means getting the files into your project. There is no build step, no runtime to install, no dependencies to resolve. The package is a directory of markdown and YAML.

```bash
# Clone the package
git clone https://github.com/openexperience/radiant-sales-expert

# Or copy it into your project
cp -r radiant-sales-expert/ ./experiences/radiant-sales-expert
```

### Tool Binding

The manifest declares abstract tool names the package requires:

```yaml
requires:
  tools: [crm, email, calendar]
```

The user must **bind** each abstract name to a concrete implementation in their environment. What that implementation looks like depends on the framework -- it might be an MCP server, an API client, a database query layer, or anything else that can satisfy the declared operations.

The binding is a simple mapping from abstract names to concrete providers:

```yaml
# Example binding (format varies by framework)
tools:
  crm: my-hubspot-integration
  email: my-nylas-integration
  calendar: my-nylas-integration
```

The experience package does not care how the tools are implemented. It only requires that when it references `crm.fetch_contacts`, something answers with data matching the declared output shape.

### Runtime Flow

When a framework executes a function from the package:

1. **Load persona** -- `persona/identity.md` and `persona/instructions.md` are injected into the system prompt
2. **Load knowledge** -- any knowledge files referenced by the function are included as context
3. **Resolve context** -- for each item in the function's `context` declarations (top to bottom):
   - Look up the abstract tool name in the user's bindings
   - Call the bound implementation with the declared operation and params
   - Store the result for use by downstream context items and template variables
4. **Populate template** -- replace all `{{variable}}` placeholders in the function body with the resolved data
5. **Invoke the LLM** -- send the fully populated prompt to the model
6. **Validate output** -- if the function is part of a process that produces actions, validate the output against the relevant action schemas

Frameworks may parallelize context items that have no interdependencies (i.e., items that don't reference `$context.<previous_item>`).

### Schema Handling

Schemas (`schemas/*.yaml`) define the data shapes the experience expects. They serve as **contracts** between the package and the host:

- **Required fields** must be present in the data returned by the bound tool. If a required field is missing, the framework should warn or error.
- **Optional fields** are best-effort. The experience will work without them, but the agent's output quality may be reduced.
- **Field naming**: Frameworks should be lenient with minor naming differences. If the bound tool returns `fullName` instead of `name`, or `jobTitle` instead of `role`, most LLMs will handle this gracefully. Strict schema validation is not required at v0.1 -- the schemas exist primarily as documentation for the integration boundary.

### For Framework Authors

To consume openexperience packages, a framework needs to:

1. **Parse the manifest** (`experience.yaml`) to discover what the package contains and requires
2. **Provide a tool binding mechanism** so users can map abstract tool names to concrete implementations
3. **Implement context resolution** -- the ability to read a function's `context` declarations, call the bound tools, and inject results into template variables
4. **Support template population** -- replace `{{variable}}` placeholders with serialized data (JSON, markdown tables, XML tags, or whatever format suits the model)
5. **Optionally support processes** -- read `processes/*.yaml` and orchestrate multi-step function chains with branching and parallelism

Frameworks that only support functions (not processes) can still consume any package -- they just invoke functions individually rather than orchestrating them as workflows.

## Package Structure

```
<package-name>/
  experience.yaml          # REQUIRED -- package manifest
  README.md                # REQUIRED -- human overview and installation guide
  persona/                 # REQUIRED -- agent identity and behavior
    identity.md            #   Who the agent is
    instructions.md        #   Behavioral rules
  functions/               # REQUIRED -- individual capabilities
    <name>.md              #   One file per function
  processes/               # OPTIONAL -- multi-step workflows
    <name>.yaml            #   One file per process
  actions/                 # OPTIONAL -- output vocabulary
    <name>.yaml            #   One file per action type
  tools/                   # OPTIONAL -- external integration interfaces
    <name>.yaml            #   One file per tool
  schemas/                 # OPTIONAL -- data contracts
    <name>.yaml            #   One file per schema
  knowledge/               # OPTIONAL -- reference material
    <name>.md              #   One file per topic
  integrations/            # OPTIONAL -- framework-specific install guides
    <framework>.md         #   One file per framework
```

---

## 1. Manifest (`experience.yaml`)

**Required.** The root manifest declares package metadata and what the package contains.

### Schema

```yaml
# -- Required fields --
name: string                    # Package identifier (kebab-case, e.g. "radiant-sales-expert")
version: string                 # Semantic version (e.g. "0.1.0")
description: string             # One-line description of what this experience provides
author: string                  # Author name or organization

# -- Optional fields --
license: string                 # License identifier (e.g. "MIT", "Apache-2.0")
category: string                # Domain category (e.g. "sales", "support", "engineering", "marketing", "legal")
tags: string[]                  # Searchable tags (e.g. ["b2b", "crm", "meddpicc"])
repository: string              # URL to the package repository
homepage: string                # URL to the package homepage

# -- Dependency declarations --
requires:
  tools: string[]               # Abstract tool names this package needs (e.g. ["crm", "email", "calendar"])
  schemas: string[]             # Data shapes the host must provide (e.g. ["contact", "opportunity", "activity"])

# -- Component listing --
components:
  functions: string[]           # List of function names (matching filenames without .md)
  processes: string[]           # List of process names (matching filenames without .yaml)
  actions: string[]             # List of action type names (matching filenames without .yaml)
  tools: string[]               # List of tool interface names (matching filenames without .yaml)
  schemas: string[]             # List of schema names (matching filenames without .yaml)
  knowledge: string[]           # List of knowledge file names (matching filenames without .md)
```

### Example

```yaml
name: radiant-sales-expert
version: 0.1.0
description: B2B sales expertise -- deal intelligence, next-best-action, content composition
author: Radiant AI
license: MIT
category: sales
tags: [b2b, crm, meddpicc, sales-intelligence]
repository: https://github.com/openexperience/radiant-sales-expert

requires:
  tools: [crm, email, calendar, playbooks]
  schemas: [contact, opportunity, activity, pipeline-stage]

components:
  functions:
    - summarise-activity
    - contact-intelligence
    - deal-intelligence
    - next-best-action
    - evaluate-actions
    - compose-content
    - playbook-selection
  processes:
    - activity-pipeline
    - next-best-action
    - action-reevaluation
    - content-composition
  actions:
    - email
    - call
    - meeting
    - task
    - linkedin-message
    - lookup
    - add-contact
    - update-pipeline-stage
    - no-action
  tools:
    - crm
    - email
    - calendar
    - playbooks
  schemas:
    - contact
    - opportunity
    - activity
    - pipeline-stage
  knowledge:
    - sales-methodologies
    - objection-handling
    - sales-process
    - email-composition
```

---

## 2. Persona (`persona/`)

**Required.** Defines the agent's identity and behavioral rules. Contains two files.

### `persona/identity.md`

Free-form markdown describing who the agent is. This typically becomes the opening section of a system prompt.

Should include:
- Professional background and expertise level
- Areas of specialization
- Communication voice and tone
- Referenced methodologies or frameworks

### `persona/instructions.md`

Free-form markdown defining behavioral rules. This typically becomes the rules/constraints section of a system prompt.

Should include:
- What the agent should always do
- What the agent should never do
- Decision-making principles
- Quality standards and output expectations

### Example

**`persona/identity.md`:**
```markdown
You are a senior B2B sales executive with over two decades of experience closing 
enterprise deals. You are a master of the MEDDPICC framework and draw on methodologies 
from Founding Sales, The Challenger Sale, and The Sales Acceleration Formula.

You communicate with confidence but without arrogance. You are direct, data-driven, 
and always focused on advancing the deal.
```

**`persona/instructions.md`:**
```markdown
## Core Rules

- Always base recommendations on observable evidence from activities and communications
- Never fabricate information about contacts, companies, or deal history
- When uncertain, say so explicitly rather than guessing
- Prioritize actions that advance the deal over actions that maintain the status quo

## Output Standards

- Return empty arrays when no data exists -- never fill with placeholders
- Keep reasoning concise (10-500 characters) but specific
- Always cite the source activity that informed a recommendation
```

---

## 3. Functions (`functions/`)

**Required.** Each function is a single capability the agent can perform, defined as a markdown file with YAML frontmatter.

### Frontmatter Schema

```yaml
---
# -- Required fields --
name: string                    # Function identifier (matches filename without .md)
description: string             # What this function does (one line)

# -- Optional fields --
model: string                   # Recommended model (e.g. "gpt-5", "claude-4")
reasoning: string               # Recommended reasoning effort (e.g. "high", "medium", "low")
input: string                   # Free-text description of expected input
output: string                  # Free-text description of expected output
tools: string[]                 # Abstract tool names this function uses (subset of manifest requires.tools)
requires:
  schemas: string[]             # Data shapes this function expects (subset of manifest requires.schemas)
  knowledge: string[]           # Knowledge files this function references (by name, without .md)
  functions: string[]           # Other functions this function may call (by name)

# -- Context declarations (optional) --
context:
  - name: string                # Variable name (used as {{name}} in the body)
    description: string         # What this data represents
    schema: string              # Schema reference (append [] for arrays, e.g. "contact[]")
    source:                     # Where to fetch this data
      tool: string              #   Which tool to call
      operation: string         #   Which operation on that tool
      params:                   #   Parameters to pass -- values can reference:
                                #     $input.<field>          -- from the function's input
                                #     $context.<name>         -- from a previously resolved context item
                                #     $context.<name>[*].field -- array field projection
        <param>: <value>
---
```

### Context Resolution

Functions can declare data dependencies via the `context` field. The framework resolves these **before** calling the function:

1. The framework reads the `context` declarations in order
2. For each item, it calls the specified `tool.operation` with the mapped `params`
3. Items can depend on previously resolved items (via `$context.<name>`)
4. The resolved data is injected into the function body wherever `{{name}}` template variables appear

**Resolution order**: Context items are resolved top-to-bottom. An item can reference any item declared above it via `$context.<name>`. Frameworks may parallelize items that have no interdependencies.

**Param references**:

| Reference | Meaning |
|---|---|
| `$input.<field>` | From the function's input (passed by a process step or direct call) |
| `$context.<name>` | A previously resolved context item (the full object) |
| `$context.<name>[*].field` | Project a single field from each item in an array context |
| Literal values | Static strings, numbers, booleans |

### Body

The markdown body contains the actual instructions -- the expertise. This is what becomes the system prompt or agent instructions when consumed by a framework.

The body should:
- Be written as direct instructions to the agent (second person: "You should...", "Analyze the...")
- Be cleaned of framework-specific references (no imports, no TypeScript, no Zod)
- Replace product-specific references with generic placeholders (e.g., "your product/service")
- Preserve the full depth of the original expertise -- do not summarize
- Use `{{variable_name}}` template variables to reference data from context declarations

### Template Variables

Template variables use double curly braces: `{{name}}`. They are replaced with the resolved context data before the prompt is sent to the LLM.

The framework is responsible for serializing the data into a readable format (e.g., JSON, XML tags, markdown tables) appropriate for the model. The function body can provide formatting hints by wrapping variables in markup:

```markdown
## Current Deal
{{opportunity}}

## Stakeholders
{{contacts}}
```

Functions that don't need pre-fetched data (e.g., they receive everything via direct input) can omit the `context` field entirely and won't use template variables.

### Example

```markdown
---
name: next-best-action
description: Decide the optimal next steps to advance a deal
model: gpt-5
reasoning: high
input: An opportunity ID and optional evaluation trigger
output: Ranked list of recommended actions with reasoning, type, and priority
tools: [crm, calendar]
requires:
  schemas: [opportunity, contact, activity]
  knowledge: [sales-methodologies, sales-process]
  functions: [compose-content]
context:
  - name: opportunity
    description: The deal being analyzed
    schema: opportunity
    source:
      tool: crm
      operation: fetch_opportunity
      params:
        opportunity_id: $input.opportunity_id

  - name: contacts
    description: All contacts on the deal with engagement intelligence
    schema: contact[]
    source:
      tool: crm
      operation: fetch_contacts
      params:
        opportunity_id: $input.opportunity_id

  - name: recent_activities
    description: Recent communications and interactions
    schema: activity[]
    source:
      tool: crm
      operation: fetch_activities
      params:
        opportunity_id: $input.opportunity_id
        limit: 50

  - name: upcoming_events
    description: Scheduled calendar events involving deal contacts
    source:
      tool: calendar
      operation: fetch_upcoming_events
      params:
        contact_ids: $context.contacts[*].id
---

# Next Best Action

You are an elite B2B sales strategist analyzing this opportunity to determine 
the optimal next steps.

## Current Deal

{{opportunity}}

## Stakeholders

{{contacts}}

## Recent Activity

{{recent_activities}}

## Upcoming Events

{{upcoming_events}}

## Strategic Analysis Framework

Follow these steps in order:

### Step 1: Identify Clear Next Steps
Review the recent activities for any explicit next steps, commitments, 
or follow-up requests...

### Step 2: If No Clear Next Steps
Analyze the full context using sales best practices to determine 
the highest-impact action...

...
```

A simpler function that receives data directly (no pre-fetching needed):

```markdown
---
name: summarise-activity
description: Summarize a CRM activity into structured, actionable intelligence
model: gpt-5
reasoning: high
input: A raw CRM activity (email, call transcript, meeting notes)
output: Structured summary with relevance score, key insights, MEDDPICC extractions, and action items
tools: [crm]
requires:
  schemas: [activity, contact]
  knowledge: [sales-methodologies]
---

# Summarise Activity

You are analyzing a CRM activity to extract actionable sales intelligence.

## Actor Attribution Rules

Clearly distinguish between:
- **Seller offered**: "We offered to send an executive summary"
- **Prospect requested**: "They requested an executive summary as a prerequisite"  
- **Prospect accepted**: "They accepted our offer to review the materials"

Do NOT conflate these. If the seller offered something and the prospect said "yes", 
that is ACCEPTANCE, not a REQUIREMENT.

## Relevance Filtering

For EVERY mentioned tool, product, or company, determine:
1. Is this about a problem your product/service solves?
2. Is this a requirement for purchasing your product?
3. Is this a competitor or alternative?
4. Or is this just casual conversation?

...
```

---

## 4. Processes (`processes/`)

**Optional.** YAML files defining multi-step workflows that chain functions together.

### Schema

```yaml
# -- Required fields --
name: string                    # Process identifier (matches filename without .yaml)
description: string             # What this process does

# -- Optional fields --
trigger: string                 # Event that starts this process (e.g. "activity.created", "ticket.opened")

# -- Steps (at least one required) --
steps:
  - id: string                  # Unique step identifier
    function: string            # Function to call (by name)
    input: object               # Input mapping -- values can reference:
                                #   $trigger.<field>     -- data from the trigger event
                                #   $context.<field>     -- data from the host context
                                #   $steps.<id>.output   -- output from a previous step
    output: string              # Named output key for downstream steps (optional)
    condition: string           # When to execute (simple boolean expression, optional)
    approval: string            # "required" or "optional" (optional)

# -- Branching (optional) --
branches:
  - condition: string           # Expression to evaluate
    steps: []                   # Steps to execute if condition is true (same schema as above)

# -- Parallelism (optional) --
parallel:
  - group: string               # Group identifier
    steps: []                   # Steps that can run concurrently (same schema as above)
```

### Input Mapping

Steps receive input through a mapping object. Values can reference:

| Reference | Meaning |
|---|---|
| `$trigger.<field>` | Data from the event that started the process |
| `$steps.<id>.output` | Output from a previously completed step |
| Literal values | Static strings, numbers, booleans |

Note: Functions handle their own data fetching via `context` declarations (see Section 3). Process steps only need to pass the **seed inputs** that functions need to start their context resolution (e.g., an opportunity ID). The function then auto-resolves its full context from tools.

### Example

```yaml
name: activity-pipeline
description: Process new CRM activities into intelligence and actionable next steps
trigger: activity.created

steps:
  - id: summarize
    function: summarise-activity
    input:
      activity: $trigger.activity

  - id: deal-intel
    function: deal-intelligence
    input:
      opportunity_id: $trigger.opportunity_id

parallel:
  - group: contact-intelligence
    steps:
      - id: contact-intel
        function: contact-intelligence
        input:
          contact_id: $trigger.contact_id
          opportunity_id: $trigger.opportunity_id

branches:
  - condition: $steps.deal-intel.output.existing_actions_count > 0
    steps:
      - id: reevaluate
        function: evaluate-actions
        input:
          opportunity_id: $trigger.opportunity_id
        approval: required

  - condition: $steps.deal-intel.output.existing_actions_count == 0
    steps:
      - id: decide
        function: next-best-action
        input:
          opportunity_id: $trigger.opportunity_id
        approval: required
```

The process steps are lightweight because the heavy lifting (fetching contacts, activities, events, intelligence) is declared in each function's `context` field and resolved automatically by the framework.

---

## 5. Actions (`actions/`)

**Optional.** YAML files defining what the agent can recommend or do. This is the **output vocabulary** -- the set of concrete things the agent can propose.

Not all experiences need actions. An analytics expert might only produce insights. A sales expert might have 9 action types. The spec supports both.

### Schema

```yaml
# -- Required fields --
name: string                    # Action type identifier (matches filename without .yaml)
description: string             # When this action should be used

# -- Required: detail schema --
schema:
  fields:
    - name: string              # Field name
      type: string              # Type: string, number, boolean, date, datetime, email, enum, array, object
      required: boolean         # Whether this field must be provided
      description: string       # What this field is for
      constraints:              # Optional validation constraints
        min: number             #   Minimum value or length
        max: number             #   Maximum value or length
        pattern: string         #   Regex pattern
        values: string[]        #   Enum values (for type: enum)
        items: object           #   Item schema (for type: array)

# -- Optional: content composition --
requires_composition: boolean   # Whether this action needs AI-generated content (default: false)
content_strategy: string        # Markdown instructions for how to compose this action's content
                                # Only relevant when requires_composition is true

composed_fields:                # Fields that are AI-generated (subset of schema.fields)
  - name: string                # Field name (must match a field in schema.fields)
    description: string         # What the composed content should contain
    constraints:                # Output constraints
      min_length: number
      max_length: number
      format: string            # e.g. "html", "markdown", "plain"
```

### Example

```yaml
name: email
description: Send an email to one or more contacts. Use for outreach, follow-ups, replies, and scheduled communications.

schema:
  fields:
    - name: to
      type: array
      required: true
      description: Recipient email addresses
      constraints:
        min: 1
        items: { type: email }
    - name: cc
      type: array
      required: false
      description: CC email addresses
      constraints:
        items: { type: email }
    - name: subject
      type: string
      required: false
      description: Email subject line (composed by content agent)
      constraints:
        max: 200
    - name: body
      type: string
      required: false
      description: Email body (composed by content agent)
      constraints:
        max: 5000
        format: html
    - name: scheduled_for
      type: datetime
      required: true
      description: When to send the email (ISO 8601)
    - name: reply_to_message_id
      type: string
      required: false
      description: Message ID to reply to (for threading)
    - name: priority
      type: enum
      required: false
      description: Email priority
      constraints:
        values: [low, normal, high]

requires_composition: true
content_strategy: |
  ## Email Composition Guidelines

  Write as a B2B sales professional. Tone: friendly but professional, 
  low-friction replies, avoid sales jargon.

  ### Rules
  - Single CTA per email
  - No signature block (sign-off only, e.g., "Best, [Name]")
  - If replying to a thread, do not re-state context already discussed
  - If new outreach, include a personalization anchor in the first 1-2 sentences

  ### Personalization Anchor
  The opening must connect something specific about the prospect's situation 
  to the reason for the email. Do not just name-drop a factoid.

composed_fields:
  - name: subject
    description: Concise, relevant subject line
    constraints:
      min_length: 1
      max_length: 200
  - name: body
    description: Professional email body in HTML
    constraints:
      min_length: 10
      max_length: 5000
      format: html
```

---

## 6. Tools (`tools/`)

**Optional.** YAML files declaring abstract integration interfaces -- **contracts** that the host project must satisfy.

An experience package never contains API clients, SDKs, or integration code. Instead, each `tools/*.yaml` file declares: "I need something that can perform these operations with these inputs and return these outputs." The host project provides the concrete implementation via tool binding (see Consumption Model).

This is the ports-and-adapters pattern: the experience knows *what* data it needs and *when* to fetch it. The host knows *how* to fetch it and *where* it lives.

### How Tool Binding Works

When the manifest declares `requires: tools: [crm, email, calendar]`, the user maps each abstract name to whatever they already have:

- `crm` might map to a HubSpot MCP server, a Salesforce API client, or a direct database connection
- `email` might map to a Nylas integration, a Gmail API wrapper, or a SendGrid service
- `calendar` might map to the same provider as `email` (many providers handle both)

The tool declaration is the **contract**. The bound implementation is the **adapter**. The experience doesn't know or care which adapter is used -- only that it satisfies the declared operations.

### Schema

```yaml
# -- Required fields --
name: string                    # Tool identifier (matches filename without .yaml)
description: string             # What this tool provides access to

# -- Required: operations --
operations:
  - name: string                # Operation identifier (e.g. "fetch_contacts")
    description: string         # What this operation does
    input:                      # Named parameters
      <param_name>:
        type: string            # Type: string, number, boolean, object, array
        required: boolean
        description: string
    output:                     # Return shape
      <field_name>:
        type: string
        description: string
```

### Example

```yaml
name: crm
description: Access to CRM data -- contacts, deals/opportunities, and activities

operations:
  - name: fetch_contacts
    description: Get contacts associated with a deal
    input:
      opportunity_id:
        type: string
        required: true
        description: The deal/opportunity identifier
    output:
      contacts:
        type: array
        description: List of contacts with name, email, role, company, and last activity date

  - name: fetch_opportunity
    description: Get deal/opportunity details
    input:
      opportunity_id:
        type: string
        required: true
        description: The deal/opportunity identifier
    output:
      opportunity:
        type: object
        description: Deal details including name, stage, amount, close date, and custom fields

  - name: fetch_activities
    description: Get recent activities for a contact or deal
    input:
      contact_id:
        type: string
        required: false
        description: Filter by contact
      opportunity_id:
        type: string
        required: false
        description: Filter by deal
      limit:
        type: number
        required: false
        description: Maximum number of activities to return
    output:
      activities:
        type: array
        description: List of activities with type, subject, body, date, participants, and direction
```

---

## 7. Schemas (`schemas/`)

**Optional.** YAML files defining the data shapes the experience expects the host project to provide. Schemas are the **integration boundary** -- they decouple the experience from any specific data source.

Schemas serve two purposes:

1. **Documentation** -- a developer wiring up tool bindings can read the schemas to understand exactly what data the experience expects, which fields are critical, and which are nice-to-have.
2. **Validation** (optional) -- frameworks may validate data returned by bound tools against the declared schemas. However, strict validation is not required. Required fields should be present; optional fields are best-effort. Minor naming differences between the schema and the actual data (e.g., `fullName` vs `name`) are generally handled well by the LLM and should not cause hard failures.

### Schema

```yaml
# -- Required fields --
name: string                    # Schema identifier (matches filename without .yaml)
description: string             # What this data represents

# -- Required: fields --
fields:
  - name: string                # Field name
    type: string                # Type: string, number, boolean, date, datetime, object, array
    required: boolean           # Whether the host must provide this field
    description: string         # What this field represents
    fields: []                  # Nested fields (for type: object)
    items: object               # Item schema (for type: array)
```

### Example

```yaml
name: contact
description: A person involved in a deal or interaction

fields:
  - name: id
    type: string
    required: true
    description: Unique identifier for the contact
  - name: name
    type: string
    required: true
    description: Full name
  - name: email
    type: string
    required: true
    description: Primary email address
  - name: role
    type: string
    required: false
    description: Job title or role in the organization
  - name: company
    type: string
    required: false
    description: Company or organization name
  - name: last_activity
    type: datetime
    required: false
    description: Timestamp of most recent interaction
```

---

## 8. Knowledge (`knowledge/`)

**Optional.** Pure markdown reference documents containing domain expertise, frameworks, methodologies, and guidelines that functions reference.

### Conventions

- One file per topic
- Filename should be descriptive and kebab-case (e.g., `sales-methodologies.md`, `escalation-policies.md`)
- No YAML frontmatter required (but may be added for metadata if desired)
- Content should be well-structured with headers, lists, and examples
- Functions reference knowledge files by name (without `.md`) in their frontmatter `requires.knowledge` field

### Example

A `sales-methodologies.md` file might cover MEDDPICC, Challenger Sale, and SPIN selling frameworks with detailed explanations of when and how to apply each.

---

## 9. Integrations (`integrations/`)

**Optional.** Markdown files with framework-specific installation and configuration guides. One file per supported framework.

These are not part of the formal spec -- they're documentation that helps users install the experience into their specific setup.

### Conventions

- Filename matches the framework name (e.g., `openclaw.md`, `mastra.md`, `langchain.md`)
- Should include:
  - How to map functions to the framework's agent/skill definitions
  - How to map processes to the framework's workflow system
  - How to wire up abstract tool interfaces to concrete implementations
  - Any framework-specific configuration

---

## Validation Rules

A valid experience package must satisfy:

1. **`experience.yaml` exists** and contains all required fields (`name`, `version`, `description`, `author`)
2. **`README.md` exists** and is non-empty
3. **`persona/identity.md` exists** and is non-empty
4. **`persona/instructions.md` exists** and is non-empty
5. **`functions/` contains at least one `.md` file**, and each file has valid frontmatter with `name` and `description`
6. **Every function, process, action, tool, schema, and knowledge file** listed in `experience.yaml` `components` has a corresponding file in the correct directory
7. **Every tool referenced** in function frontmatter `tools` fields is listed in `experience.yaml` `requires.tools`
8. **Every schema referenced** in function frontmatter `requires.schemas` fields is listed in `experience.yaml` `requires.schemas`
9. **Every knowledge file referenced** in function frontmatter `requires.knowledge` fields exists in `knowledge/`
10. **Every function referenced** in process step `function` fields exists in `functions/`

---

## File Naming Conventions

- All filenames use **kebab-case** (e.g., `next-best-action.md`, `activity-pipeline.yaml`)
- Function files use `.md` extension
- Process, action, tool, and schema files use `.yaml` extension
- Knowledge files use `.md` extension
- Integration files use `.md` extension

---

## Type Reference

The following types are available for use in schema fields, action fields, and tool parameters:

| Type | Description |
|---|---|
| `string` | Text value |
| `number` | Numeric value (integer or float) |
| `boolean` | True or false |
| `date` | Date without time (YYYY-MM-DD) |
| `datetime` | Date with time (ISO 8601) |
| `email` | Email address |
| `enum` | One of a fixed set of values (specify in `constraints.values`) |
| `array` | Ordered list (specify item type in `constraints.items` or `items`) |
| `object` | Nested structure (specify fields in `fields`) |

---

## Versioning

Experience packages follow [Semantic Versioning](https://semver.org/):

- **MAJOR**: Breaking changes to schemas, tool interfaces, or function contracts
- **MINOR**: New functions, processes, actions, or knowledge files (backward compatible)
- **PATCH**: Improvements to instructions, knowledge content, or bug fixes

The spec itself is versioned separately. This document is **v0.1**.
