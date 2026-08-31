# Agent Note: Qabot shared service-group queue

Status: implemented

English | [中文](2026-08-31-qabot-shared-group-queue.zh.md)

## Problem

Per-ticket priority, configurable SLA deadlines, and automatic assignee selection added operational controls for a volume the company does not have. The extra fields and configuration page made a small service group manage policy instead of answering employees, while automatic assignment could select the only unavailable member without giving a peer the opportunity to accept the ticket.

## Decision

Human handoff routes a ticket to a service group without a priority, SLA deadline, or assignee. One idempotent Outbox job sends the handoff card to every active member returned by the group's staff configuration. The ticket remains `waiting_agent` in the shared group queue until one member accepts it with the existing optimistic version check. That successful accept records the assignee and prevents another member from claiming the same version.

Agent-initiated transfer remains different from an employee handoff: the agent selects both the destination group and a specific destination member because an active owner is deliberately relinquishing responsibility.

MySQL migration 006 removes the priority and SLA projection introduced by migration 005 and drops the service-policy table. Migration 007 clears assignees from legacy `waiting_agent` tickets so the shared queue applies immediately without changing tickets already in service. The portal removes the separate configuration tab and presents audit records inside operations analysis. Audit records continue to cover ticket, knowledge, and staff mutations; there is no priority mutation to record.

## Alternatives considered

**Keep priority but hide it in the portal.** Rejected because hidden fields and APIs would still create an unsupported operational rule and retain unused database state.

**Notify only one automatically selected member.** Rejected because selection cannot know availability, and the expected service groups are small enough for all members to receive the same claim opportunity.

**Remove audit records with the configuration page.** Rejected because knowledge publication, staff membership, ticket transfer, and closure remain privileged operations that need attribution. Operations analysis is their presentation home.

## Consequences

Every new handoff is visible to and notified to the whole selected group, and the first successful accept establishes ownership. Duplicate notification delivery remains bounded by the Outbox idempotency key. Service desk pages no longer display or configure priority and SLA. The system gives up deadline-based escalation and urgency sorting; chronological queue order and the existing four ticket states remain sufficient for the expected workload.
