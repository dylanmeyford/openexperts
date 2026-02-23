---
name: inbound-email-triage
description: End-to-end handling of an inbound sales email
trigger: new_email
inputs:
  - name: message_id
    type: string
outputs:
  - name: draft_response
    type: object
  - name: classification
    type: object
functions:
  - classify-email-intent
  - determine-next-action
  - compose-response
tools:
  - crm
  - email
scratchpad: scratch/triage-{message_id}.md
context:
  - state/pipeline.md
  - knowledge/meddpicc.md
delivery:
  format: both
  channel: main
  sla: 5m
  sla_breach: escalate
---

## Inbound Email Triage

Run this process whenever a new prospect email arrives.
Follow every step in order and check it off after completion.
If resuming after a failure, read the scratchpad first and skip any already-completed steps.

### Steps

- [ ] Open or read scratchpad at `scratch/triage-{message_id}.md`. If it exists, resume from the first unchecked step.
- [ ] Fetch the inbound email using `email.get_email` and record sender, subject, body.
- [ ] Fetch contact details from `crm.get_contact` using sender email and record account context.
- [ ] Fetch active deal details from `crm.get_deal` and record stage, amount, competitors.
- [ ] Run `classify-email-intent` function using email body and CRM context; record output.
- [ ] Run `determine-next-action` function using classification and deal context; record output.
- [ ] Run `compose-response` function using context and action; record draft.
- [ ] Submit draft via `email.send` (manual — draft only, requires human review).
- [ ] Log triage summary via `crm.create_note` on the contact record.
- [ ] Update `state/pipeline.md` with any deal movement or risk changes.

### Completion

Return:
- Draft response
- Classification
