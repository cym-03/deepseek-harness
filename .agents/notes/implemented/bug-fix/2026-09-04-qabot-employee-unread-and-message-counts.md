# Agent Note: Use the employee-visible timeline for unread state and message counts

Status: implemented

English | [中文](2026-09-04-qabot-employee-unread-and-message-counts.zh.md)

## Problem

The employee conversation list counted raw DSH user and assistant events. Retry events and messages injected only for agent context made that number differ from the bubbles returned by the durable conversation timeline. A service-desk reply also emitted its live change before the reply had been projected into `conversation_messages`, so an employee refreshing the list at that event observed no unread message. Message submission and background refresh then advanced the employee reader automatically, while the browser suppressed unread badges on the open conversation.

## Decision

The conversation-list response reads each session's count from `conversation_messages`, the same MySQL timeline used by conversation detail. Service-desk reply routes project the completed reply before publishing the live ticket change. Message submission and background refresh do not advance the employee reader. A conversation-detail request advances the reader only when it explicitly carries `markRead=1`, and only through the greatest message ID included in that response. The browser shows unread badges for both open and inactive conversations until that explicit request completes.

Employee messages sent during human takeover remain in the DSH session as agent context but are omitted from DSH event projection because their ticket reply is the durable employee-visible copy.

## Alternatives considered

- **Keep the DSH event count:** rejected because internal retries and injected context are not employee-visible messages.
- **Calculate unread state in the browser:** rejected because another browser or a refreshed page would lose the reader position.
- **Treat an open conversation as implicitly read:** rejected because a reply can arrive while the employee is not looking at the latest message.
- **Project after publishing the live event:** rejected because the first list refresh would still race ahead of the new reply.

## Consequences

The sidebar count equals the messages rendered when the employee opens the conversation. Every new AI or human reply produces a durable unread badge, including in the open conversation. Explicitly entering that conversation clears the badge without marking a later message as read. A page reload opens the selected conversation and therefore marks the messages returned by that initial detail request as read.
