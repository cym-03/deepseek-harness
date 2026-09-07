# Agent Note: Persist Qabot feedback and derive knowledge-gap analytics

Status: implemented

English | [中文](2026-09-02-qabot-feedback-and-knowledge-gap-analytics.zh.md)

## Problem

A numeric satisfaction score does not explain why an employee was satisfied or dissatisfied. Operations reporting also loses most conversation context when it counts only each ticket's opening question, and raw audit identifiers make routine review difficult for portal users.

## Decision

Tickets persist an optional satisfaction comment beside the required one-to-five score. The employee rating card submits both values once, and the weekly operations report exposes every rating with its optional comment.

The report derives repeated question types from every persisted employee message in each included conversation. A deterministic local normalizer combines character similarity with stable employee-service topic rules, so report generation does not call an embedding or language model. Greetings, acknowledgements, tests, and transfer commands are excluded. The final substantive employee question in a transferred conversation is marked as handoff-linked; its cluster remains visible even when it occurred only once because it identifies a potential knowledge gap.

The portal translates known audit actions, actors, and resource types into Chinese labels. Unknown values receive a readable fallback while the original code remains available as a title for diagnosis. Audit rows paginate locally at ten records per page.

## Alternatives considered

**Call a model to summarize and cluster every reporting period** — rejected because report refreshes would consume model quota and produce unstable groupings. Deterministic local grouping is sufficient for the current service volume.

**Keep only ticket opening questions** — rejected because later questions frequently cause the handoff and carry the useful knowledge-gap signal.

**Store free-text feedback in audit detail** — rejected because feedback is ticket data used by reporting and must survive independently of audit presentation.

## Consequences

Operations staff can review ratings and comments, see similar questions as one hotspot, and prioritize clusters associated with human handoffs. The grouping rules are deliberately conservative and require maintenance when new business topics become common. Audit pagination operates over the latest records returned by the API rather than adding another server-side paging protocol.

## Verification

Repository tests cover SQLite migration and persisted comments, and report tests cover approximate grouping plus one-off handoff gaps. Portal browser tests cover optional comment submission, persistent display, human-readable audit labels, feedback analytics, handoff markers, and ten-row pagination.
