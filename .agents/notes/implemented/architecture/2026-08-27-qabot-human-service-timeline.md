# Agent Note: Qabot human-service ownership and timeline

Status: implemented

English | [中文](2026-08-27-qabot-human-service-timeline.zh.md)

## Problem

Automatic group selection made a handoff notification precede the employee's service choice. Model turns and staff replies could then compete for ownership, while separate session and ticket projections grouped messages by author instead of preserving conversation order. Bootstrap staff records also reappeared after deletion.

## Decision

The agent proposes the portal's handoff action without selecting or notifying a service group. The durable session tool event keeps the AI ticket open and expands the portal's single-choice service card; loading that conversation restores the card until the employee chooses or dismisses it. The employee selects HR, Administration, IT, Finance, or Other. Other maps to the general-service group. Only this selection writes the handoff reason, moves the ticket to `waiting_agent`, and emits one idempotent notification job that fans out to every active member of the selected group. The ticket has no assignee until one notified member accepts it. A group without an active member leaves the ticket unassigned for manager handling.

While a ticket has human-service ownership, employee messages enter the ticket timeline repository and model context. Qabot first checks retrieval relevance: a reliable knowledge hit permits one AI answer, while a miss starts no model turn and leaves the response to staff. Human replies enter the same business timeline and model context but reach the employee only through the portal timeline.

Conversation projections merge employee, assistant, and human messages by persisted timestamps. Session sequence and reply id break timestamp ties deterministically. Every employee, assistant, and human message also updates the conversation summary's activity time and visible-message count. The portal sorts summaries by that activity time and stores a per-browser read count; messages added to inactive conversations produce an unread badge until the employee opens them.

An existing conversation resumes its persisted session instead of creating a new session under the same id. Session discovery recognizes the repository-root and legacy `apps/qabot` working directories.

The staff JSON file is a one-time bootstrap source. The staff database is authoritative after import.

## Alternatives considered

**Let the model select the service group.** This removes one employee click but can misroute a ticket and sends a notification before the employee confirms the handoff.

**Assign one group member automatically.** Rejected because a small service group can coordinate ownership directly, while automatic assignment can name an unavailable member and hide the ticket from peers who could take it.

**Continue model turns during human service.** This can answer known questions, but interleaves AI and staff ownership in one unresolved service interaction. A new conversation provides an explicit route back to AI service.

**Send staff replies through Feishu.** This duplicates the portal timeline and adds an external navigation path for employees.

## Consequences

The portal becomes the employee's only human-service conversation interface, while Feishu remains a staff notification channel. Routed tickets appear in the selected group's shared queue and every active group member receives the notification. The first successful optimistic accept owns the ticket; other members then see the assigned owner. Groups without active staff require manager handling. Active human-service tickets receive AI answers only for knowledge-backed questions. Employee and staff messages persist before their HTTP requests complete, and restarting Qabot preserves the complete timeline. Cross-store timestamps provide a unified display order; clock precision remains the ordering limit, with persisted ids resolving ties. Unread state is browser-local rather than shared across devices. Staff-file changes after the initial import require an explicit database update.
