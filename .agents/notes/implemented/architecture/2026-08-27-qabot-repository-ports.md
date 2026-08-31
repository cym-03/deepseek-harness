# Agent Note: Isolate Qabot persistence behind awaitable repositories

Status: implemented

English | [中文](2026-08-27-qabot-repository-ports.zh.md)

## Problem

Qabot application code depended directly on synchronous SQLite store classes. A PostgreSQL implementation necessarily performs asynchronous I/O, so replacing those stores would otherwise require changing conversation, ticket, reporting, satisfaction, HTTP, and outbox behavior at the same time.

## Decision

Conversation, Ticket, Audit, and Outbox persistence expose domain Repository interfaces. Their return values are awaitable: the SQLite implementations may complete synchronously, while network database implementations return promises. Application consumers await every result whose implementation can vary.

The existing SQLite stores implement these interfaces and remain the development and test providers. `migrations/postgres/001_service_desk.sql` defines the first production schema for conversation projections, versioned tickets and replies, audit records, and claimed Outbox rows. PostgreSQL migrations use a monotonic `schema_migrations` table and retain millisecond integer timestamps so application data semantics do not change during backend migration. The `migrate-postgres` command loads consecutive `NNN_name.sql` files, holds a database advisory lock, runs each pending file in one transaction, and records its version only after success.

The PostgreSQL driver and migration runner require `QABOT_DATABASE_URL`. PostgreSQL providers implement Conversation, Ticket, Audit, and Outbox. Ticket preserves the SQLite state, transaction, optimistic-version, rating, and statistics behavior. Outbox claims rows with `FOR UPDATE SKIP LOCKED`, identifies the worker, and restores abandoned claims after a lease. `QABOT_DATABASE_BACKEND` selects `sqlite` or `postgres`; PostgreSQL startup applies pending migrations before composing the service. The Qabot engine, HTTP service, Outbox worker, and model-facing handoff tool receive the same Repository bundle, so one operation cannot split across backends.

The deployed company database is MySQL `hr_system`. A MySQL migration runner and initial schema exist separately from the PostgreSQL dialect. The runner serializes with `GET_LOCK` and records a dirty migration before executing DDL because MySQL DDL implicitly commits; startup refuses to continue past a dirty version. MySQL implements all four Repository providers, including transactional ticket replies, optimistic updates, leased Outbox claims, and abandoned-claim recovery. Runtime selection accepts `mysql`, requires `QABOT_MYSQL_URL`, and applies pending MySQL migrations before composing the service.

## Alternatives considered

- **Keep application services typed to SQLite classes:** rejected because database selection would leak connection and query behavior into every domain workflow.
- **Require promises from SQLite methods:** rejected because wrapping each local operation in an artificial promise adds implementation noise; await accepts both immediate and promised results.
- **Add PostgreSQL configuration before its providers exist:** rejected because a production-looking option that silently uses SQLite or fails after startup is unsafe.
- **Change timestamps to PostgreSQL timestamp values:** rejected for the first migration because it would combine storage replacement with API and arithmetic changes.

## Consequences

Application workflows no longer require concrete SQLite classes and already accommodate network latency. SQLite remains the default and PostgreSQL fails startup without an explicit URL; no fallback can direct production writes into local files. Migration filenames must remain consecutive, failed files leave no recorded version, and concurrent migrators serialize on the advisory lock. PostgreSQL integration coverage exercises Ticket concurrency and rating together with the other repositories only with an explicit `QABOT_TEST_POSTGRES_URL`, and cleans its uniquely identified records. Deployment still requires a reachable database and verified connection credentials.

MySQL cannot provide transactional rollback for schema DDL, so a failed migration may require manual repair before clearing its dirty record. MySQL integration coverage runs only with an explicit `QABOT_TEST_MYSQL_URL`; it never implicitly reuses the production URL. Migration 1 has been applied to `hr_system`, every table and column has a Chinese comment, the migration is clean, and a temporary-record smoke test passed before removing all business rows.
