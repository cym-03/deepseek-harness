# Agent Note: Make MySQL authoritative for Qabot production data

Status: implemented

English | [中文](2026-09-01-qabot-mysql-authoritative-storage.zh.md)

## Problem

Qabot split production state across MySQL projections, local SQLite databases, and DSH JSONL files. A process restart or launch from another host could therefore expose different service-team configuration, knowledge retrieval results, or model history even when `hr_system` was healthy.

## Decision

Qabot uses MySQL `hr_system` as the authoritative production store when `QABOT_DATABASE_BACKEND=mysql`. Conversations, projected messages, tickets, audit records, Outbox rows, service-team configuration, knowledge documents and vectors, knowledge submissions, query-vector cache entries, and raw DSH model session events share the migrated MySQL database. SQLite remains the explicit development and test provider.

Model knowledge retrieval reads currently published and effective MySQL versions directly. Keyword matching runs before semantic ranking, and semantic query vectors are cached by normalized query hash and embedding model key. Knowledge ingestion incrementally embeds document images before projection and stores their binaries and vectors in MySQL. Every non-empty employee question can automatically recall related images without image-specific wording. The visual query provider runs only when eligible image candidates exist, and repeated equivalent questions reuse the stored visual query vector.

DSH session persistence appends a session header and contiguous events transactionally to `dsh_model_sessions` and `dsh_model_session_events`. Resume discovers sessions from MySQL metadata rather than filesystem paths. The one-time importer copies readable legacy JSONL sessions and service-team rows into MySQL and records completion in `qabot_data_imports`; it retains source files as rollback evidence and never recreates a later MySQL deletion.

Knowledge-source configuration and production retrieval use MySQL as their authority. The local ingestion index only parses synchronized content and calculates missing embeddings before the result is projected to MySQL. The online-source lifecycle and maintenance permissions are specified in [Manage Qabot knowledge as synchronized online sources](2026-09-02-qabot-online-knowledge-sources.md).

## Alternatives considered

- **Keep MySQL as a reporting projection:** rejected because production answers and assignments would continue to depend on host-local files.
- **Store only rendered conversation messages:** rejected because an assistant resume requires the complete typed DSH event log, including tool calls and turn markers.
- **Recompute query vectors for every request:** rejected because repeated questions would spend embedding quota without changing retrieval quality.
- **Delete legacy files after import:** rejected because retaining them provides non-destructive rollback evidence while the MySQL cutover is verified.
- **Move every development test to MySQL:** rejected because fast isolated SQLite tests remain useful and production selection already fails loudly without an explicit MySQL URL.

## Consequences

Production restarts and host changes recover service teams, searchable knowledge, and model history from one schema. Migration 11 creates the staff, session, import-marker, query-cache, and knowledge-submission tables with Asia/Shanghai `DATETIME(3)` business dates. MySQL availability is required for production startup and question handling. The ingestion index must project successfully before a new source participates in retrieval, while an existing MySQL version remains available if ingestion or synchronization fails.

MySQL integration tests use an explicit `QABOT_TEST_MYSQL_URL`, unique record identifiers, and cleanup. A live acceptance check must demonstrate a knowledge answer, a persisted raw event batch, and successful resume after a Qabot restart without reading a legacy session file.
