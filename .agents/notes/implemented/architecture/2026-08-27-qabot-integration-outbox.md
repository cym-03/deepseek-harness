# Agent Note: Deliver Qabot notifications through an outbox

Status: implemented

English | [中文](2026-08-27-qabot-integration-outbox.zh.md)

## Problem

Ticket requests called Feishu while handling HTTP operations. A temporary Feishu failure could report that an already-applied ticket mutation failed, encouraging the caller to repeat it, while a process restart lost notifications that had not completed.

## Decision

Qabot persists handoff notifications and public agent replies in `outbox.db` before returning the business result. Each message has a unique idempotency key, JSON payload, attempt count, next available time, last error, and terminal status. Re-enqueuing the same business event is a no-op. Satisfaction stays in the employee portal conversation and does not use an external notification event.

One process worker polls pending messages. A configured handler completes successful delivery; a failure records a bounded error and schedules exponential backoff capped at sixty seconds. Eight failed attempts move the message to `failed`. Missing integration handlers leave messages pending so adding Feishu configuration does not discard them.

Handoff payloads include the observed ticket version. The worker completes a stale handoff without sending when the ticket has moved to another version or is no longer waiting for an agent. This prevents a delayed pre-transfer event from notifying an obsolete queue. The deployment runs one Qabot execution process, and the worker rejects overlapping passes inside that process.

## Alternatives considered

- **Send synchronously and return provider failures:** rejected because ticket persistence and external delivery do not share a transaction, so the response cannot truthfully roll back the ticket.
- **Retry only in memory:** rejected because process restarts lose queued work and retry history.
- **Use the ticket row as the notification queue:** rejected because one ticket produces independently retried handoff and reply events.
- **Introduce a message broker immediately:** deferred because the initial single-company deployment has one Qabot process; the SQLite outbox provides durable semantics without another operated service. PostgreSQL migration can retain the same repository behavior.

## Consequences

Feishu outages do not block ticket operations, pending work survives restarts, and repeated enqueue calls do not create duplicate rows. Delivery is at least once when a provider succeeds but the process stops before recording completion; provider-supported idempotency must be added if Feishu exposes a suitable key. Failed messages remain queryable in the database. The single-process worker is not a multi-instance claim protocol and must be replaced with row claiming before multiple Qabot workers consume one database.
