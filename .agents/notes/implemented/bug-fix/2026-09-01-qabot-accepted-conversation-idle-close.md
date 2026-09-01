# Agent Note: Close accepted Qabot conversations after inactivity

Status: implemented

English | [中文](2026-09-01-qabot-accepted-conversation-idle-close.zh.md)

## Problem

The idle sweep closed only AI-only `open` tickets. An accepted human-service ticket could remain in `in_service` or `waiting_employee` indefinitely after both participants stopped replying, so the employee conversation never reached `closed` and never exposed its rating controls.

## Decision

The Qabot idle sweep runs at `QABOT_IDLE_SWEEP_MS` and closes a conversation when its ticket `updated_at` is older than `QABOT_IDLE_CONVERSATION_MS`. Eligible tickets are AI-only `open` tickets and accepted human-service tickets in `in_service`, `waiting_employee`, or `reopened`. A `waiting_agent` ticket is not eligible because no service agent has accepted it.

Closing sets `status` to `closed`, records `service_end` when absent, advances the optimistic `version`, and preserves an existing satisfaction score. When a sweep closes at least one ticket, Qabot emits a live change so connected employee and service-desk pages refresh their selected conversation; an employee viewing an affected conversation receives the existing rating controls without reloading the page.

SQLite, MySQL, and PostgreSQL repositories apply the same state predicate. Repository tests pin closure for stale AI and accepted human conversations and preservation of an unaccepted handoff.

## Alternatives considered

- **Close every active ticket after inactivity:** rejected because an unaccepted handoff represents queued work, not a conversation whose assigned service agent stopped participating.
- **Require a service agent to close every accepted ticket manually:** rejected because abandoned browser sessions would continue to occupy the processing queue and withhold the employee rating action.
- **Infer closure only in the frontend:** rejected because ticket state, reporting, authorization, and ratings require one durable database transition.

## Consequences

AI conversations and accepted human conversations complete after the configured inactivity period and become rateable. Unaccepted handoffs remain in the shared waiting queue until a service agent accepts, transfers, or closes them. A sweep with closures broadcasts one refresh event to connected portal clients; it does not invoke a language or embedding model.
