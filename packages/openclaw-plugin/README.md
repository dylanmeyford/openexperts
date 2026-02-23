# OpenExperts OpenClaw Plugin

This package implements an OpenClaw plugin runtime for OpenExperts packages.

## What it includes

- Plugin manifest (`openclaw.plugin.json`)
- CLI surface (`openclaw expert install|list|validate|bind|bind-wizard|activate|run|doctor|learn`)
- Expert installer and local discovery
- Spec validation and binding validation
- State lifecycle helpers
- Trigger runtime scaffolding (dedupe + concurrency)
- Lobster workflow compilation (`processes/*.md` -> `.lobster`)
- Approval queue for confirm/manual operations
- Learning persistence and prompt injection hooks
- Registry generation (`EXPERTS.md`)

## Development

```bash
npm install
npm run build
npm test
```

## Webhook Trigger Compatibility

OpenClaw `2026.2.x` validates `hooks.mappings` as `HookMappingConfig[]` (webhook -> wake/agent mapping). OpenExperts webhook triggers are process-targeted (`trigger.process`) and do not map 1:1 to that schema yet.

Current behavior in this plugin:

- `openclaw expert activate` keeps expert activation successful.
- `hooks.enabled` may be set when webhook triggers exist.
- The plugin does **not** write custom `hooks.mappings` objects that would invalidate `openclaw.json`.
- A compatibility notice is returned in activation output for deferred webhook auto-registration.

Temporary operator guidance:

- Use manual process runs (`openclaw expert run ...`) for webhook-targeted processes.
- Keep using cron/channel triggers, which are unaffected.
- Track upstream work for first-class webhook-to-process dispatch support in OpenClaw/OpenExperts integration.
