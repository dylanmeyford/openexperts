---
name: scan-for-opportunities
description: Morning scan for new signals on active accounts
trigger: opportunity_scan
tools:
  - crm
context:
  - state/pipeline.md
---

## Scan for Opportunities

Run this process every weekday morning to review active deals for new signals.

### Steps

- [ ] Read `state/pipeline.md` to load current deal context.
- [ ] Scan active deals via `crm.get_deal` for each tracked account.
- [ ] Identify stalled or at-risk deals (no activity >7 days, missed close dates, competitor mentions).
- [ ] Update `state/pipeline.md` with new risk flags and status changes.

### Completion

Return a summary of flagged deals and recommended follow-ups.
