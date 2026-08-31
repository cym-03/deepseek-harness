# Agent Note: Document every Qabot MySQL column in Chinese

Status: implemented

English | [中文](2026-08-27-qabot-mysql-schema-comments.zh.md)

## Problem

The company data warehouse is operated and inspected directly by Chinese-speaking administrators. MySQL columns without database-native descriptions force operators to find application source before they can distinguish employee identifiers, timestamps, workflow states, and integration fields.

## Decision

Every Qabot MySQL column carries a non-empty Chinese `COMMENT`, and every table carries a non-empty Chinese table comment. Text columns explicitly declare `CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`; each table uses the same defaults. Comments state business meaning and include units or allowed values when those facts affect interpretation.

The rule applies to migration-owned business tables and the migration metadata table created by the runner. `apps/qabot/AGENTS.md` records the standing development requirement. A keyless schema-style test scans MySQL migration SQL and the runner-owned DDL, rejecting missing Chinese comments, missing table comments, and text collation drift.

## Alternatives considered

- **Document fields only in TypeScript:** rejected because database administrators and reporting tools inspect MySQL without loading application types.
- **Rely on table-level comments:** rejected because one table contains identifiers, states, timestamps, and content with different interpretation requirements.
- **Use table defaults without explicit text-column collation:** rejected because explicit declarations make generated and reviewed DDL consistent with the company schema convention.
- **Review comments manually:** rejected because later migrations can omit comments without producing a runtime failure.

## Consequences

MySQL schema inspection exposes Chinese business meaning for every field, and text comparison follows one verified MySQL 8 collation. DDL becomes longer, but an automated test prevents the documentation from drifting. PostgreSQL and SQLite do not support the same inline MySQL syntax; this rule governs MySQL migrations while their application types retain concise contracts.
