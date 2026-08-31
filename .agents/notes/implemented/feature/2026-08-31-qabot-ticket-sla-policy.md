# Agent Note: Qabot ticket priority and SLA policy

Status: implemented

English | [中文](2026-08-31-qabot-ticket-sla-policy.zh.md)

## Problem

Human-service tickets had no priority or response deadline, so the queue could not distinguish urgent work, identify overdue service, or explain whether a policy change affected a ticket. Hard-coding one timeout in the portal would make browser state authoritative and leave API-created tickets unmanaged.

## Decision

MySQL stores one enabled policy per service group with a default priority, first-response duration, and resolution duration. Completing an employee handoff or an agent transfer applies the selected group's policy to the ticket and records absolute millisecond deadlines. The first public staff reply records `first_agent_response_at`; later replies do not replace it.

Ticket priority and SLA timestamps are business projection fields returned with the existing ticket resource. An agent with ticket access may change one ticket's priority using its current version. A SystemAdmin may read and update service-group policies. Both operations append audit records after the database mutation succeeds.

The portal's manager configuration page edits policies and displays recent audit records. The ticket workspace displays priority and the active deadline: first response before a public staff reply, then resolution afterward. Durations use elapsed clock minutes; work schedules and holidays do not pause them.

## Alternatives considered

**Calculate deadlines only in the browser.** Rejected because different clients could disagree, background SLA checks would have no durable value, and API-created tickets would lack deadlines.

**Use one global policy.** Rejected because IT, HR, Administration, Finance, and general service require independently adjustable targets.

**Recalculate every open ticket when a policy changes.** Rejected because it would silently change an already accepted service commitment. Policy changes apply when a ticket enters a group; an explicit transfer reapplies the target group's current policy.

**Implement a business-hours calendar in the first policy version.** Deferred because calendar ownership, regional holidays, and per-group shifts require separate configuration. Elapsed minutes are explicit and testable.

## Consequences

The service desk can sort operational attention by priority and see overdue tickets from durable data. Policy and priority changes are attributable through the audit log, and optimistic versions prevent concurrent priority edits from overwriting each other. A transfer resets both deadlines and the first-response marker for the receiving group. Existing SQLite and PostgreSQL development providers expose neutral priority fields but do not persist configurable policies; production policy management therefore requires the MySQL provider.
