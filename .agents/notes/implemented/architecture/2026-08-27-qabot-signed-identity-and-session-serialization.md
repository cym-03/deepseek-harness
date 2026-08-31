# Agent Note: Authenticate Qabot requests with portal identity

Status: implemented

English | [中文](2026-08-27-qabot-signed-identity-and-session-serialization.zh.md)

## Problem

The prototype API accepted employee and assignee identifiers from request bodies and protected every operation with one shared token. Any caller holding that token could select another employee's conversation, while concurrent turns targeting one DSH session could overlap and attribute output to the wrong request.

## Decision

The versioned employee API accepts a short-lived portal identity in the `Authorization` header. The portal encodes the declared identity as base64url JSON and signs the encoded payload with HMAC-SHA256. Qabot validates the signature, timestamps, field types, and closed role set before routing the request. Employee identifiers come only from the verified claim, and conversation lookup verifies ownership before restoring a DSH session.

One keyed executor serializes turns for one employee so requests that select the current conversation and requests that name its id cannot bypass each other's queue. Requests from different employees remain independent. The legacy `/api` routes retain the shared service token temporarily while their callers migrate; they do not define the authorization model for `/v1`.

The `/v1` employee routes create, list, read, update, archive, rate, stream, and cancel conversations. Streaming emits named SSE events; cancellation verifies conversation ownership, calls the agent's public cancellation API, flushes the session, and releases the cancelled handle so the next turn resumes from the durable log. The deployment-configurable DeepSeek stream idle timeout defaults to 30 seconds, while a separate Qabot turn deadline defaults to 45 seconds and also covers a gateway that never returns response headers. A timed-out turn is cancelled, persisted, and returned as a visible fallback instead of leaving the UI generating indefinitely. Rating verifies that the signed employee owns both the conversation and ticket, accepts one score only after resolution or closure, and compares the ticket version. Agent routes require an Agent, DepartmentAdmin, or SystemAdmin role; non-system identities see only tickets assigned to a group in their signed `departmentIds`. Accepting a ticket derives the assignee from the signed employee identity, and ticket, staff, knowledge, and publication mutations append durable audit records. Only SystemAdmin may change service-team membership or list audit records. Request-body and message limits reject oversized input before model execution. Deployment supplies both identity and compatibility secrets; source and launch scripts contain neither value.

## Alternatives considered

- **Trust identity fields forwarded by the BFF:** rejected because an accidental direct route or proxy bug would turn caller-controlled fields into authorization decisions.
- **Use the shared service token with ownership fields:** rejected because possession of one deployment secret grants every employee and administrator identity.
- **Serialize every model request globally:** rejected because different employees do not share DSH session state and may run concurrently.
- **Adopt asymmetric JWT immediately:** deferred because the single-company deployment has one portal issuer and one Qabot verifier; the compact HMAC format removes an external dependency. A multi-issuer or independently operated verifier requires asymmetric signing.

## Consequences

Versioned employee requests cannot select an employee through JSON or query parameters, and guessed conversation identifiers do not restore another employee's session. Agents cannot select their assignee identity or read another service group's assigned tickets. The portal uses signed routes for employee, ticket, staff, knowledge, and analytics operations. Privileged mutations produce a queryable audit trail. One employee processes one turn at a time at the cost of queueing messages sent concurrently to that employee's conversations. HMAC requires the portal and Qabot to share and rotate one secret. Compatibility routes remain available only for direct migration diagnostics and are not used by the portal.
