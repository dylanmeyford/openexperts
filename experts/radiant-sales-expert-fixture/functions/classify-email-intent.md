---
name: classify-email-intent
description: Determine the intent and urgency of an inbound email
tags: [analysis, classification, email]
inputs:
  - name: email_body
    type: string
  - name: sender_context
    type: object
    description: CRM context for sender, deal stage, and history
outputs:
  - name: intent
    type: string
    enum: [objection, question, buying_signal, churn_risk, scheduling, other]
  - name: urgency
    type: string
    enum: [high, medium, low]
  - name: reasoning
    type: string
  - name: confidence
    type: string
    enum: [high, medium, low]
tools:
  - crm
knowledge:
  - knowledge/competitive-battle-cards.md
---

## Classify Email Intent

Given email body and sender CRM context, classify intent and urgency.

### Decision Rules

- If the sender is in a late deal stage and mentions a competitor, classify as `objection` with `high` urgency.
- If there has been >14 days of inactivity and the reply is short or hesitant, classify as `churn_risk`.
- If the email asks product or technical details, classify as `question`.
- If the email contains positive language about timelines, budget approval, or next steps, classify as `buying_signal`.
- If the email requests a meeting or proposes times, classify as `scheduling`.

### Output

Return:
- Intent
- Urgency
- Reasoning (1-2 sentences)
- Confidence
