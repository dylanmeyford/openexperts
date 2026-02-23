---
name: openexperts-message-received
description: "Dispatch incoming channel messages to expert channel triggers"
metadata: { "openclaw": { "emoji": "📨", "events": ["message:received"] } }
---

# OpenExperts Message Received

When a message arrives on any channel, checks all active expert manifests for
channel-type triggers. If a trigger matches, dispatches the message payload
through the concurrency queue to the target process.
