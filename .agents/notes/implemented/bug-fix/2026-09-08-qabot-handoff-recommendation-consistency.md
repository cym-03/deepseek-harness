# Agent Note: Keep Qabot handoff recommendations consistent

Status: implemented

English | [中文](2026-09-08-qabot-handoff-recommendation-consistency.zh.md)

## Problem

The model could state that a request required human handling without calling `request_human_handoff`. The employee saw prose directing them to a person but did not receive the handoff control. The evaluation set also represented normal answers, missing knowledge, safety refusals, out-of-scope requests, and mandatory human work with one handoff boolean, which made its aggregate score misleading.

## Decision

The model prompt requires `request_human_handoff` whenever the answer concludes that human handling is needed and requires the visible phrase `推荐人工处理` after the call. Qabot also recognizes narrowly worded explicit human-handling recommendations in the completed assistant text and exposes the same handoff recommendation in the immediate response and reconstructed conversation. Mere mentions of artificial-service hours or human-owned approval steps do not trigger the fallback.

The employee-service evaluation data records one of `normal_answer`, `manual_required`, `knowledge_missing`, `safe_refusal`, or `out_of_scope` for every case. Human Resources, Finance, IT, Administration, Attendance, and visual content each contain at least three questions. Text terms and expected visual topics remain separate assertions.

## Alternatives considered

**Trust the tool call only.** Rejected because an otherwise useful answer could explicitly direct the employee to human handling while omitting the tool, leaving the interface inconsistent with its text.

**Treat every refusal or unavailable answer as a handoff.** Rejected because safety refusals and requests outside the employee-service scope are distinct outcomes and do not always justify an internal service ticket.

**Match every occurrence of “人工”.** Rejected because service-hour notices and descriptions of human approval steps would produce false recommendations.

## Consequences

Explicit human-handling conclusions reliably display the handoff choice even when the model omitted its tool call, including after a conversation reload. The narrow fallback can miss novel phrasing, so the prompt remains the primary mechanism and tests pin accepted and rejected wording. Evaluation reports can measure answer quality, routing, safety, scope, and visual precision independently instead of collapsing them into one percentage.
