---
name: compose-response
description: Draft a response email based on classification and recommended action
inputs:
  - name: context
    type: object
    description: Email and deal context
  - name: action
    type: object
    description: Recommended action from determine-next-action
outputs:
  - name: draft
    type: string
  - name: subject
    type: string
tools:
  - email
---

## Compose Response

Draft a professional response email aligned with the recommended action.

### Guidelines

- Match the tone to the sender's style and deal stage.
- Keep responses concise — aim for 3-5 paragraphs maximum.
- Include a clear call to action or next step.
- Reference specific deal details to demonstrate attentiveness.

### Output

Return:
- Draft email body
- Subject line
