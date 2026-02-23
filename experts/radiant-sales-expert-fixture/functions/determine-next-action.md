---
name: determine-next-action
description: Determine next best action for a deal based on email classification
inputs:
  - name: classification
    type: object
    description: Output from classify-email-intent
  - name: deal_context
    type: object
    description: Current deal details from CRM
outputs:
  - name: action
    type: string
  - name: reasoning
    type: string
  - name: confidence
    type: string
    enum: [high, medium, low]
tools:
  - crm
---

## Determine Next Action

Given an email classification and deal context, determine the next best action.

### Decision Rules

- For `objection` → prepare a competitive rebuttal and schedule a call.
- For `buying_signal` → advance deal stage and prepare a proposal or next-step email.
- For `churn_risk` → flag deal as at-risk and recommend an executive outreach.
- For `question` → draft an informative reply with relevant materials.
- For `scheduling` → check calendar availability and propose meeting times.

### Output

Return:
- Action description
- Reasoning (1-2 sentences)
- Confidence
