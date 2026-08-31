# Agent Note: Stream Qabot service-desk changes

Status: implemented

English | [中文](2026-08-31-qabot-live-service-events.zh.md)

## Problem

The employee conversation page and agent ticket workspace polled their complete list and selected detail every two seconds. Replies appeared late, idle pages generated continuous database and HTTP traffic, and simultaneous polling could replace optimistic chat state while a model response was still streaming.

## Decision

Qabot exposes one authenticated `GET /v1/events` Server-Sent Events stream. Ticket mutations publish a monotonic process-local revision after the repository write completes. Each event is an invalidation signal rather than a message payload; the portal reloads the authorized list and selected detail through the existing versioned APIs, which remain the source of response fields and access checks.

Events carry only the employee id, service group, assignee, and revision needed for filtering. Employees receive changes for their own identity. System administrators receive every change. Other service-desk identities receive changes for their active service group or tickets assigned to their display name. The NestJS BFF signs the upstream identity and proxies the byte stream; browser `EventSource` owns reconnect behavior. Qabot sends comment heartbeats and removes listeners when the client connection closes.

The existing model-answer stream remains separate because it carries ordered answer deltas, citations, handoff recommendations, completion, and errors for one submitted message. The live service stream only replaces employee-message and ticket polling.

## Alternatives considered

- **Keep two-second polling:** rejected because delay and background load grow with every open employee and agent page.
- **Send complete transcripts in change events:** rejected because it duplicates authorization and timeline projection outside the read APIs.
- **Use WebSocket:** deferred because this flow is server-to-browser invalidation only, and browser-managed SSE reconnection is sufficient.

## Consequences

Employee replies, acceptance, transfer, closure, and ratings now refresh immediately without fixed polling. Lost connections reconnect automatically and the next event reloads authoritative state. Revisions are process-local invalidation markers, not durable cursors; a reconnect does not replay missed events, so pages also load current state when mounted and after their own mutations.
