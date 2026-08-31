# Agent Note: Establish the governed Qabot knowledge schema

Status: implemented

English | [中文](2026-08-27-qabot-knowledge-center-schema.zh.md)

## Problem

Qabot stored directly searchable chunks in one SQLite table. Feishu synchronization could replace those chunks immediately, so a source change had no draft, review, publication, version history, department scope, or reliable audit target.

## Decision

MySQL migration 2 introduces separate knowledge sources, documents, document versions, applicable departments, chunks, assets, embeddings, reviews, and synchronization jobs. Document versions use the fixed lifecycle `draft`, `pending_review`, `published`, `archived`, and `rejected`. Content and asset hashes are durable fields. Text and vision embeddings record their target type, modality, model key, dimensions, and source-content hash, so vectors from different models or modalities cannot be treated as interchangeable.

The schema keeps document identity separate from immutable versions. A document may have one version under review while its prior published version remains available. Department applicability belongs to the version because policy scope may change between releases. Synchronization jobs have idempotency keys and counters, while reviews retain the reviewer, decision, optional note, and time.

The SQLite retrieval provider records synchronized source changes as `pending_review` versions. Staging preserves the currently published chunks and vectors. A reviewer publishes a version through the signed knowledge API; publication replaces that source's chunks, archives its prior version, and computes only missing embeddings. Rejected versions never enter retrieval. The MySQL tables remain the production projection for the same lifecycle and audit data.

## Alternatives considered

- **Add a status column to the existing chunk table:** rejected because replacing chunks would still destroy the prior published version before review completes.
- **Store review state only in the source configuration:** rejected because one source may contain many independently versioned documents.
- **Combine text and vision vectors without model metadata:** rejected because their dimensions and similarity spaces are not compatible.

## Consequences

The `hr_system` database has nine governed-knowledge tables, and migration version 2 is clean. Every table and column has a Chinese comment. Qabot enforces publication before synchronized text changes affect employee answers; the SQLite provider preserves this behavior for local operation while the MySQL projection supports production reporting and later repository consolidation. Visual assets stay on their last published data when a changed document is staged, so synchronization does not replace returned images before text review completes.
