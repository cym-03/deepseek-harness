# Agent Note: Version Qabot ticket transitions

Status: implemented

English | [中文](2026-08-27-qabot-ticket-state-version.zh.md)

## Problem

The prototype represented a pending human handoff as `handoff` and updated tickets without comparing the state a service agent had read. Two agents could accept or reply from one stale screen, overwriting assignment or appending a reply after another transition.

## Decision

Ticket schema version 2 renames persisted `handoff` values to `waiting_agent` and adds an integer `version` initialized to one. Every state-changing store operation increments it. Portal accept, reply, transfer, close, and rating requests submit the last observed version; their SQL updates compare state and version and return a conflict when either changed.

The active service states are `open`, `waiting_agent`, `in_service`, `waiting_employee`, `resolved`, `closed`, and `reopened`, projected in the portal as Pending, Waiting for acceptance, Processing, and Completed. AI-only `open` tickets are visible only to managers and close after one hour without activity. A manager may transfer an `open` AI ticket directly to a destination group and active member; the ticket becomes `waiting_agent`. Assignment does not imply acceptance: a routed ticket remains `waiting_agent` until its assignee accepts it. Only `in_service` or `waiting_employee` tickets accept public replies; a reply atomically appends the message and enters `waiting_employee`. The reply transaction rolls back both changes when its state or version precondition fails. Other active-ticket transfers apply the same destination requirements, clear the current ownership, assign the selected member, and return the ticket to `waiting_agent`.

The ticket database uses SQLite `user_version` as a monotonic migration counter. A database at version one receives the new column and status conversion once; schema version three removes `satisfaction_note`. The employee portal accepts only a numeric score, so Ticket has no service-comment field. Its rating endpoint verifies the conversation owner, ticket id, score, and last observed ticket version without granting the employee access to agent close operations. New databases execute the same ordered migrations. PostgreSQL migration 002 removes the corresponding column after the initial schema.

## Alternatives considered

- **Last write wins:** rejected because assignment and customer-visible replies are business actions whose conflicts require an operator decision.
- **Compare timestamps:** rejected because timestamp resolution and clock semantics do not express which stored revision the caller read.
- **Lock a ticket while an agent page is open:** rejected because browser locks become stale and prevent useful reads; optimistic comparison limits coordination to mutations.
- **Keep `handoff` as the permanent status:** rejected because it describes an event, while `waiting_agent` describes the shared group queue used by routing and visibility rules.

## Consequences

Concurrent agent mutations and stale employee ratings produce HTTP 409 instead of silently overwriting each other. Clients must retain and submit `version`, then refresh after a conflict. An assigned agent must accept before the reply and close controls become available; an unsuitable ticket can be transferred before acceptance by naming its next owner. The one-hour AI timeout bounds unfinished manager-only work without affecting human-service tickets. Employees can rate only their own closed conversation through the employee route; agent close authorization remains separate. Existing ticket databases migrate `handoff` rows and discard the unused service-comment column without rebuilding the database. Direct compatibility callers may still omit versions from accept, transfer, and close, so those calls remain outside the versioned concurrency guarantee.
