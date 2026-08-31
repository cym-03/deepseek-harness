# Agent Note: Qabot session discovery uses the repository root

Status: implemented

English | [中文](2026-08-31-qabot-session-discovery-uses-repository-root.zh.md)

## Problem

Qabot stores conversation metadata in its selected business database while DSH stores the model-visible conversation events under `apps/qabot/data/sessions`. A Qabot process launched with `apps/qabot` as its working directory could still list MySQL conversations, but session discovery constructed `apps/qabot/data/sessions` relative to `process.cwd()`. The resulting duplicated path did not contain the durable logs, so Qabot created an empty in-memory session for an existing id and returned an empty transcript.

## Decision

`bin.ts` derives the repository root from its module location and passes that absolute path to `Qabot`. Session discovery and historical workspace selection resolve `apps/qabot/data/sessions` only from that injected root. Process working directory remains the agent workspace recorded in a session; it is not a storage locator.

Existing logs retain both supported historical workspace encodings: repository-root sessions resume with the repository root, and directories whose encoded workspace contains `apps-qabot` resume with `apps/qabot`. The session persistence backend still owns unique-id discovery and log decoding after Qabot confirms that a durable artifact exists.

## Alternatives considered

- **Require every launcher to change into the repository root.** The batch launcher already does this, but package scripts and service managers commonly launch from `apps/qabot`. Startup discipline cannot protect the storage lookup from future entry points.
- **Copy conversation events into MySQL.** This would duplicate the DSH event log and introduce reconciliation and ordering rules. MySQL remains the business-query projection; the DSH log remains the model-visible event authority.
- **Use `process.cwd()` with more parent-directory heuristics.** Heuristics still couple persistence to launch context and can resolve the wrong repository when Qabot is invoked through another wrapper.

## Consequences

Conversation history resumes identically from the repository root, `apps/qabot`, or a service manager's working directory. Existing on-disk logs require no migration. Qabot now requires its repository root at construction, making an incorrect storage root explicit at the application assembly point.

## Testing

The Qabot unit test creates both historical project-directory layouts beneath a temporary repository root and verifies durable-log discovery and workspace resolution without consulting the test process working directory. The employee portal browser check verifies that an existing MySQL conversation renders its restored DSH messages after the service restarts.
