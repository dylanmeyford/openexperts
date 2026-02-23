---
name: openexperts-gateway-startup
description: "Load active expert manifests and clean up dedupe cache on gateway startup"
metadata: { "openclaw": { "emoji": "🧠", "events": ["gateway:startup"] } }
---

# OpenExperts Gateway Startup

Initializes the OpenExperts runtime when the gateway starts:
- Loads all installed expert manifests into the active manifests cache
- Cleans up expired dedupe entries from the trigger runtime
