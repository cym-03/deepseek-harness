# Agent Note: Project Qabot conversation messages into MySQL

Status: implemented

English | [中文](2026-08-31-qabot-conversation-message-projection.zh.md)

## Problem

Qabot stored conversation metadata in the business database while employee and assistant messages remained available only through local DSH session files. The portal could therefore list a conversation whose transcript temporarily appeared empty when the service started from a different directory or could not discover the corresponding session file. Ticket replies were durable, but combining them with model messages at read time still depended on local files.

## Decision

DSH session events remain the authoritative model-visible history. Qabot additionally maintains an idempotent `conversation_messages` projection in the configured MySQL business database. Each projected row is identified by session, source type, and source id, and carries source order, role, content, media references, and creation time. Reading a conversation first incorporates available DSH events and ticket replies, then returns the database projection in chronological order. An empty or temporarily unavailable DSH read never deletes already projected messages.

The `project-messages` command backfills every known conversation without invoking a language, text-embedding, or visual-embedding model. Normal conversation reads keep the projection current. MySQL is the production implementation; SQLite and PostgreSQL continue to use the existing read-time timeline until they receive equivalent message repositories.

## Alternatives considered

- **Keep local session files as the only employee transcript source:** rejected because business UI availability would remain coupled to process launch paths and local file discovery.
- **Replace DSH events with the business message table:** rejected because model-visible inputs must remain reconstructable from the DSH session log.
- **Copy messages without stable source identities:** rejected because retries and repeated reads would create duplicate chat rows.

## Consequences

The employee and service-desk interfaces can recover complete chat history from MySQL even when a later DSH read is empty. Existing model memory semantics remain unchanged. Projection writes add a small database transaction to timeline reads, and deployments using MySQL must apply migration `008_conversation_messages.sql` before serving traffic. The backfill command is safe to rerun because its source key is unique.
