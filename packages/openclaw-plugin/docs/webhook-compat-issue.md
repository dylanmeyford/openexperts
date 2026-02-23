## Upstream Issue Draft: OpenExperts Webhook Trigger Contract Gap

### Summary

OpenExperts expert manifests define webhook triggers that dispatch directly to a named expert process (`trigger.process`).  
OpenClaw `2026.2.x` currently validates `hooks.mappings` as webhook-to-`wake`/`agent` mappings, which cannot represent native OpenExperts process dispatch metadata.

### Repro

1. Install OpenExperts plugin and activate an expert with a webhook trigger.
2. Write custom mapping object with OpenExperts fields (`expert`, `trigger`, `process`, optional `preset`/`requiresTool`) into `hooks.mappings`.
3. Start OpenClaw.

Expected:

- Config accepts process-targeted webhook trigger registrations.

Actual:

- Config validation rejects unknown mapping fields.

### Impact

- Expert activation can succeed, but webhook auto-registration must be deferred to keep config valid.
- Manual process runs and cron/channel triggers still work.

### Requested Upstream Options

1. Add first-class webhook mapping action for process dispatch (for example `action: "process"` with `expert` + `process`).
2. Add plugin API for runtime webhook trigger registration that bypasses raw config mutation.
3. Document supported extension point for external runtimes that need deterministic webhook-to-process dispatch.
