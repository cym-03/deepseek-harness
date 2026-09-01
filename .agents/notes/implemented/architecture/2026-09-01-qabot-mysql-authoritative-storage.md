# Agent Note: Make MySQL authoritative for Qabot production data

Status: implemented

English | [中文](2026-09-01-qabot-mysql-authoritative-storage.zh.md)

## Problem

Qabot split production state across MySQL projections, local SQLite databases, and DSH JSONL files. A process restart or launch from another host could therefore expose different service-team configuration, knowledge retrieval results, or model history even when `hr_system` was healthy.

## Decision

Qabot uses MySQL `hr_system` as the authoritative production store when `QABOT_DATABASE_BACKEND=mysql`. Conversations, projected messages, tickets, audit records, Outbox rows, service-team configuration, knowledge documents and vectors, knowledge submissions, query-vector cache entries, and raw DSH model session events share the migrated MySQL database. SQLite remains the explicit development and test provider.

Model knowledge retrieval reads currently published and effective MySQL versions directly. Keyword matching runs before semantic ranking, and semantic query vectors are cached by normalized query hash and embedding model key. Repeated equivalent queries reuse the stored vector; ordinary text questions do not invoke the visual embedding provider.

DSH session persistence appends a session header and contiguous events transactionally to `dsh_model_sessions` and `dsh_model_session_events`. Resume discovers sessions from MySQL metadata rather than filesystem paths. The one-time importer copies readable legacy JSONL sessions and service-team rows into MySQL and records completion in `qabot_data_imports`; it retains source files as rollback evidence and never recreates a later MySQL deletion.

Knowledge administration still uses the local ingestion index to parse, review, and calculate missing embeddings. Every mutation projects the complete approved state, vectors, assets, version metadata, and submission queue into MySQL before it becomes available to production retrieval. The local index is a rebuildable ingestion source, not the production read authority.

## Alternatives considered

- **Keep MySQL as a reporting projection:** rejected because production answers and assignments would continue to depend on host-local files.
- **Store only rendered conversation messages:** rejected because an assistant resume requires the complete typed DSH event log, including tool calls and turn markers.
- **Recompute query vectors for every request:** rejected because repeated questions would spend embedding quota without changing retrieval quality.
- **Delete legacy files after import:** rejected because retaining them provides non-destructive rollback evidence while the MySQL cutover is verified.
- **Move every development test to MySQL:** rejected because fast isolated SQLite tests remain useful and production selection already fails loudly without an explicit MySQL URL.

## Consequences

Production restarts and host changes recover service teams, searchable knowledge, and model history from one schema. Migration 11 creates the staff, session, import-marker, query-cache, and knowledge-submission tables with Asia/Shanghai `DATETIME(3)` business dates. MySQL availability is required for production startup and question handling. The ingestion index must project successfully before newly reviewed knowledge participates in retrieval, while an existing published MySQL version remains available if ingestion or synchronization fails.

MySQL integration tests use an explicit `QABOT_TEST_MYSQL_URL`, unique record identifiers, and cleanup. A live acceptance check must demonstrate a knowledge answer, a persisted raw event batch, and successful resume after a Qabot restart without reading a legacy session file.
