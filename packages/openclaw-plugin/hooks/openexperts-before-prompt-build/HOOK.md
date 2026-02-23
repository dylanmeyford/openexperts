---
name: openexperts-before-prompt-build
description: "Inject expert context and learnings into expert session prompts"
metadata: { "openclaw": { "emoji": "📋", "events": ["agent:bootstrap"] } }
---

# OpenExperts Before Prompt Build

When an expert session is being bootstrapped, injects the assembled expert
context (persona, orchestrator, function/knowledge indexes, policy tiers,
learnings) into the session's prepended context.
