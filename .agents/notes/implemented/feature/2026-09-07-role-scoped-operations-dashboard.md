# Agent Note: Role-scoped Qabot operations dashboard

Status: implemented

English | [中文](2026-09-07-role-scoped-operations-dashboard.zh.md)

## Problem

The weekly report mixed approximate timestamps, raw audit codes, ticket openings, and unscoped totals. It could not distinguish an AI handoff suggestion from an employee entering human service or preserve configurable direct answers.

## Decision

Qabot persists effective question turns, actual and suggested handoff events, configured questions, attachments, usage, employee-voice cache entries, and unified audit rows in MySQL. Reporting uses explicit Asia/Shanghai half-open periods and compares the current range with the preceding equal-length range. A ticket's service domain is recomputed from durable evidence in this order: actual human assignment, configured-question match, then strongest reliable knowledge source. Similar unanswered questions and written low-rating comments are clustered within their service group before ranking so wording variants contribute to one operational issue; low ratings without a written comment remain in satisfaction metrics and employee voice but are excluded from reason attribution. Domain metrics count each ticket once. The handoff rate divides conversations with an actual employee-selected handoff by all conversations in the same period. Headline duration averages valid service processing intervals and excludes time when a conversation remains idle before closure.

Managers can query all groups or one group. HR, administration, IT, and finance operators are scoped to their mapped group in the service, regardless of query parameters. Operations analytics exposes only the overview: four numeric operational metrics with hover definitions, a filterable conversation table split between human and robot service, compact cause panels, and the submitted rating with each employee comment. The conversation table uses the selected report period, paginates ten rows at a time, and opens the authorized ticket evidence from a row. Rating metrics and employee voices use the rating submission period rather than the ticket creation period. Configured questions are a peer Qabot administration section. Manager-only server-paginated audit records appear under the portal's Data Reports module instead of Qabot administration.

Attribution results retain authorized ticket identifiers so operators can open the supporting conversation without exposing employee names in the summary. Handoff groups use a text model to derive concise business-reason titles from the complete employee, assistant, and human conversation; the handoff request itself is not treated as the reason when earlier context identifies the unresolved need. The overview returns cached or deterministic evidence-bound titles immediately and refreshes missing model summaries in the background, so model latency does not block metrics and tables. An in-process evidence hash reuses unchanged results. The filtered report export is a UTF-8 CSV containing the period, core metrics, domain table, and attribution evidence.

Failed knowledge synchronization and configured-question mutations append readable failure rows to the unified audit log before the original error is returned. Audit persistence failure is reported separately and does not replace the business error.

The unanswered ranking includes only effective questions with no reliable configured or knowledge answer for which Qabot also emitted a human-service suggestion. A model-generated response without a human-service suggestion is not classified as unanswered.

Each group can enable at most five configured questions under a database transaction. Exact matches and high-confidence candidates that clearly lead the runner-up return the stored answer, up to three MySQL-backed images, and up to five links without a model call. Other questions continue through ordinary knowledge retrieval and model answering.

## Alternatives considered

**Keep extending the fixed weekly report** — rejected because its ticket-level projection cannot represent per-turn knowledge evidence, actual handoff decisions, role isolation, or arbitrary time ranges without conflicting definitions.

**Treat every AI transfer suggestion as a transfer** — rejected because it overstates human-service demand when an employee does not choose a group and enter the queue.

**Always use semantic matching for configured answers** — rejected because a weak match can bypass the broader knowledge system with an incorrect canned answer. Direct semantic answers require both a high threshold and a clear margin.

**Store FAQ images on disk** — rejected because the product requires MySQL to remain the recoverable authority for operations configuration and its attachments.

## Consequences

Operations results are reproducible from durable records, permissions are enforced at the service, and common questions can answer without model cost. Historical closure timestamps remain estimates, but they do not inflate the active-processing average. Conservative direct matching sends ambiguous questions through normal retrieval, which costs more but avoids false FAQ answers. MySQL attachment growth must be monitored because original image binaries are deliberately retained.

## Verification

Unit tests cover effective-question filtering, direct-match normalization, similar-issue clustering, domain precedence, role-scoped operations inputs, and configured-question limits. MySQL migration checks cover schema style and startup progression. Portal builds and browser tests cover date and group filters, attribution panels, configured questions, direct-answer attachments, and ten-row audit pagination.
