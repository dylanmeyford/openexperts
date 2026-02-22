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
