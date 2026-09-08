# Agent Note: Project Qabot conversation messages into MySQL

Status: implemented

English | [中文](2026-08-31-qabot-conversation-message-projection.zh.md)

## Problem

Qabot stored conversation metadata in the business database while employee and assistant messages remained available only through local DSH session files. The portal could therefore list a conversation whose transcript temporarily appeared empty when the service started from a different directory or could not discover the corresponding session file. Ticket replies were durable, but combining them with model messages at read time still depended on local files.

## Decision

DSH session events remain the authoritative model-visible history. Qabot additionally maintains an idempotent `conversation_messages` projection in the configured MySQL business database. Each projected row is identified by session, source type, and source id, and carries source order, role, content, media references, and creation time. Reading a conversation first incorporates available DSH events and ticket replies, then returns the database projection in chronological order. An empty or temporarily unavailable DSH read never deletes already projected messages.

MySQL also stores one monotonic read position per role-scoped employee and conversation. Employee lists count assistant, human-agent, and system messages after the employee position; service-desk lists count employee messages after the agent position. Opening the authorized conversation advances that reader only through the greatest message id included in the response, so a concurrent later message remains unread. The migration records the greatest existing message id as a rollout baseline, so historical rows do not become unread backlog while every later message remains countable.

The `project-messages` command backfills every known conversation without invoking a language, text-embedding, or visual-embedding model. Normal conversation reads keep the projection current. MySQL is the production implementation; SQLite and PostgreSQL continue to use the existing read-time timeline until they receive equivalent message repositories.

Qabot reuses a conversation as the single pending blank only when both its projected message count is zero and its title remains `新对话`. A titled conversation is never reused as blank even if delayed projection or recovery temporarily leaves its metadata count at zero.

## Alternatives considered

- **Keep local session files as the only employee transcript source:** rejected because business UI availability would remain coupled to process launch paths and local file discovery.
- **Replace DSH events with the business message table:** rejected because model-visible inputs must remain reconstructable from the DSH session log.
- **Copy messages without stable source identities:** rejected because retries and repeated reads would create duplicate chat rows.
- **Keep read positions in browser storage:** rejected because first-load initialization, browser changes, and cleared storage cannot preserve a shared unread state.

## Consequences

The employee and service-desk interfaces can recover complete chat history from MySQL even when a later DSH read is empty. Unread badges survive refreshes and browser changes, opening one conversation clears only that reader's position, and creating a new conversation cannot silently reopen a titled conversation with stale count metadata. Existing model memory semantics remain unchanged. Projection and read-position writes add small database transactions to timeline reads, and deployments using MySQL apply migrations `008_conversation_messages.sql` and `009_conversation_message_reads.sql` before serving traffic. The backfill command is safe to rerun because its source key is unique.
