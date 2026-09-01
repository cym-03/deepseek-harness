# dsh-qabot — Employee intelligent Q&A service

English | [中文](README.zh.md)

An internal employee Q&A service embedded in DeepSeek Harness and called through the employee service desk portal's NestJS proxy.

The current baseline includes persistent text and visual indexes, signed portal identity, employee conversation authorization, per-conversation serialized execution, and versioned conversation APIs. Ticket, knowledge-management, and operations endpoints remain available through the compatibility `/api` routes until their domain migrations are complete.

## Architecture

```
Portal App.vue (smart-qa/qa-admin) ──HTTP──→ Qabot service (node:http, port 3100)
                                              │
                          ┌───────────────────┴───────────────┐
                          │ In-process dsh Qabot engine        │
                          │  agent-spine + llm-deepseek        │
                          │  kb_search + request_human_handoff │
                          │  MySQL repositories + session log  │
                          └───────────────────┬───────────────┘
                                              └─→ Feishu notification adapter
```

## Running

Prerequisites: run `pnpm install`; provide `DEEPSEEK_API_KEY`, `FEISHU_APP_ID`, and `FEISHU_APP_SECRET` through the untracked root `.env`; export `DEEPSEEK_BASE_URL` in the launch environment.

```sh
pnpm --filter @deepseek-ai/dsh-qabot run dev:ingest   # Index the docs/ knowledge base
DEEPSEEK_BASE_URL=http://<relay>/v1 pnpm --filter @deepseek-ai/dsh-qabot run dev:serve   # Start HTTP
```

The primary variables are `QABOT_PORT` (default 3100), `QABOT_API_TOKEN` (required for compatibility routes), `QABOT_IDENTITY_SECRET` (shared by the portal and Qabot), `PORTAL_URL` (service-card destination), and `QABOT_STAFF_OPEN_IDS` (comma-separated agents). Secrets come only from the deployment environment or an untracked `.env`.

The portal base64url-encodes the UTF-8 JSON identity claims and signs that encoded string with HMAC-SHA256. The token format is `payload.signature` and requests use `Authorization: Bearer <token>`. Claims contain `subjectId`, `employeeId`, `displayName`, `departmentIds`, `roles`, `issuedAt`, and `expiresAt`.

## Versioned employee API

| Method/path | Description |
|---|---|
| `POST /v1/conversations` | Create a conversation using the signed employee identity |
| `GET /v1/conversations` | List the current employee's conversations |
| `GET /v1/conversations/:id/messages` | Read messages in an owned conversation |
| `POST /v1/conversations/:id/messages` | Submit `{ message }` to an owned conversation |
| `DELETE /v1/conversations/:id` | Archive an owned conversation |
| `POST /v1/conversations/:id/rating` | Submit `{ ticketId, rating, version }` in the conversation |
| `GET /v1/events` | Stream identity-filtered conversation and ticket invalidations over SSE |
| `GET /v1/agent/tickets` | List tickets in the agent's service groups; SystemAdmin sees all |
| `GET /v1/agent/tickets/:id` | Read an authorized ticket and its public replies |
| `POST /v1/agent/tickets/:id/accept` | Accept using the signed `employeeId` and `{ version }` |
| `POST /v1/agent/tickets/:id/reply` | Append `{ message, version }` and enter `waiting_employee` |
| `POST /v1/knowledge/versions/:id/publish` | Publish a reviewed version with optional `{ effectiveAt, expiresAt }` |
| `POST /v1/knowledge/:source/publication` | Set `{ online }` without deleting versions or vectors |
| `GET /v1/system/audit` | Let SystemAdmin query privileged-operation audit records |

## HTTP API

| Method/path | Description |
|---|---|
| `POST /api/chat` | `{ userId, message }` → `{ text, ticketId, handoffRequested, serviceMs }` |
| `GET /api/tickets` | List tickets with `?status=&limit=` |
| `GET /api/tickets/:id` | Read ticket details and conversation transcript |
| `POST /api/tickets/:id/accept` | Accept with `{ assignee }` and enter `in_service` |
| `POST /api/tickets/:id/reply` | Add a public employee-visible reply `{ message }` |
| `POST /api/tickets/:id/close` | Close with `{ satisfaction? }` |
| `GET /api/kb` | List knowledge entries |
| `POST /api/kb/ingest` | Ingest `{ title, content }` manually |
| `DELETE /api/kb/:source` | Remove a knowledge source |
| `GET /api/stats` | Read service statistics |

## Authentication

- Every environment requires `QABOT_API_TOKEN`; startup fails when it is missing so an internal client cannot bypass the portal and call port 3100 directly.
- Except for `/`, `/chat.html`, and `/api/health`, every `/api/*` request carries `X-Qabot-Token: <token>` or receives HTTP 401.
- Deployment owns the token value and supplies the same value to Qabot and the portal proxy.
- The portal smart-QA proxy includes `X-Qabot-Token` on every compatibility request. The static test page stores a manually entered token in localStorage.
- Rotate the token in the Qabot and portal deployment environments together.

## Directory

```
src/
  bin.ts            Entry point: console | feishu | serve | ingest
  compose.ts        dsh composition: persona, model, persistence, plugins
  runner.ts         Per-employee Qabot sessions, Q&A, ticket creation, transcript
  http/server.ts    Dependency-free node:http server
  feishu/           Notification adapter and legacy bot gateway
  kb/               SQLite FTS5 and hybrid text/visual retrieval
  ticket/           SQLite development ticket store
  migrations/       Monotonic PostgreSQL and MySQL migrations
  plugins/          kb_search and request_human_handoff tools
docs/               Sample knowledge documents
data/               Gitignored runtime data and service-agent configuration
```

## Internal deployment

### Manual startup
```sh
# Windows launcher with deployment environment
apps/qabot/start-qabot.bat

# Or start directly:
cd d:\deepseek_q&a
DEEPSEEK_BASE_URL=http://<relay>/v1 node --import tsx/esm apps/qabot/src/bin.ts serve
```

### Environment variables
| Variable | Default | Description |
|---|---|---|
| `DEEPSEEK_BASE_URL` | required | OpenAI-compatible relay URL; export it at launch |
| `QABOT_PORT` | 3100 | Service port |
| `QABOT_HOST` | 0.0.0.0 | Listener address |
| `QABOT_SYNC_INTERVAL_MINUTES` | 30 | Scheduled knowledge synchronization; 0 disables it |
| `QABOT_API_TOKEN` | required | Shared `X-Qabot-Token`; startup fails when missing |
| `QABOT_IDENTITY_SECRET` | required | Verifies short-lived portal identities; never commit it |
| `QABOT_MAX_BODY_BYTES` | 1048576 | Maximum HTTP request body size |
| `QABOT_MAX_MESSAGE_LENGTH` | 8000 | Maximum employee message length |
| `QABOT_IDLE_CONVERSATION_MS` | 3600000 | Idle timeout for AI and accepted human conversations |
| `QABOT_IDLE_SWEEP_MS` | 60000 | Idle conversation scan interval |
| `QABOT_OUTBOX_INTERVAL_MS` | 1000 | External-notification polling interval, minimum 100 ms |
| `QABOT_DATABASE_URL` | none | PostgreSQL URL; use database `hr_system` |
| `QABOT_DATABASE_BACKEND` | sqlite | Business repository: `sqlite`, `mysql`, or `postgres` |
| `QABOT_MYSQL_URL` | none | Required when the business repository is MySQL |

The service desk presents four states: pending, waiting for acceptance, processing, and completed. AI-only tickets remain pending and are visible only to supervisors. An idle AI conversation or accepted human conversation completes after the idle timeout and immediately exposes employee rating controls. An unaccepted human handoff remains in the selected group's shared waiting queue and notifies every active group member without choosing an assignee. The first member to accept owns the ticket. A later transfer selects both a service group and a specific member.

Ticket responses contain a monotonically increasing `version`. Agent mutations submit the most recently read version; a stale version or invalid state returns HTTP 409 so the client can refresh before deciding whether to retry.

Application services depend on Conversation, Ticket, Audit, and Outbox repository interfaces. Callers await both synchronous and asynchronous implementations, so SQLite, MySQL, and PostgreSQL providers preserve the same business rules. Startup applies the selected provider's pending migrations before composing Qabot, HTTP, and handoff tools with one repository set.

PostgreSQL deployment example:

```env
QABOT_DATABASE_BACKEND=postgres
QABOT_DATABASE_URL=postgres://<user>:<password>@<host>:<port>/hr_system
```

PostgreSQL mode fails instead of falling back to SQLite when the connection URL is absent.

The PostgreSQL Outbox claims messages with `FOR UPDATE SKIP LOCKED` and records a worker with a five-minute lease. Multiple processes do not claim the same message, and an abandoned claim becomes available after its lease expires.

Apply migrations only to an explicitly selected PostgreSQL database:

```sh
QABOT_DATABASE_URL=postgres://user:password@host:5432/qabot pnpm --filter @deepseek-ai/dsh-qabot run db:migrate:postgres
```

The migration command fails when `QABOT_DATABASE_URL` is absent. Keep connection strings only in the deployment environment.

The deployed business database is MySQL `hr_system`. MySQL migrations use consecutive `migrations/mysql/NNN_name.sql` names and serialize through `GET_LOCK`. Because MySQL DDL commits implicitly, the migrator records `dirty=1` before execution and refuses to continue after an interrupted migration until an operator verifies the database state.

```sh
pnpm --filter @deepseek-ai/dsh-qabot run db:migrate:mysql
```

The MySQL provider stores conversations, messages, tickets, audit records, Outbox rows, service-team configuration, knowledge submissions, knowledge versions and vectors, query-vector cache entries, and raw DSH model events in `hr_system`. Model retrieval reads published effective MySQL versions directly; `kb.db` is a rebuildable ingestion index for synchronization, review, and embedding calculation. Projection copies stored vectors without requesting embeddings, while repeated semantic queries reuse MySQL query vectors by query hash and model key. Business dates use Asia/Shanghai `DATETIME(3)` columns so operators see `YYYY-MM-DD HH:mm:ss.SSS` values directly; repositories convert them to Unix milliseconds at the application boundary. Configure `QABOT_DATABASE_BACKEND=mysql` and `QABOT_MYSQL_URL`; startup applies pending migrations. Real integration tests read only `QABOT_TEST_MYSQL_URL` and must not remain pointed at production.

Employee, assistant, and public service-desk messages are projected into MySQL `conversation_messages` with stable source identifiers. `dsh_model_sessions` and `dsh_model_session_events` retain the complete model-visible history needed for resume, while portal timeline reads use the durable business projection. Migration 11 imports legacy JSONL sessions and service-team rows once, records completion in `qabot_data_imports`, and retains the source files as rollback evidence. Run `pnpm --filter @deepseek-ai/dsh-qabot run db:project-messages` only when an older deployment still needs its conversation projection backfilled; the command is idempotent and does not invoke language or embedding models.

MySQL `conversation_message_reads` stores independent employee and service-desk read positions. Conversation lists expose role-filtered `unreadCount` values, and an authorized detail read advances only that viewer's position. Migration `009_conversation_message_reads.sql` records existing messages as the rollout baseline so only later replies begin unread accounting.

Feishu handoff notifications first enter the Outbox and fan out to every active member of the selected service group. Delivery retries with exponential backoff up to eight times, and one idempotency key creates only one notification job. A stale handoff notification completes without sending when the ticket state has already changed.

Employees submit satisfaction scores in the portal conversation rather than Feishu. An employee can rate an owned `resolved` or `closed` ticket once with a score from 1 to 5 and the latest ticket `version`. Duplicate scores and version conflicts return HTTP 409. Tickets do not store a service-comment field.
| `PORTAL_URL` | http://localhost:5173 | Service-card administration destination |
| `VISION_EMBED_MODEL` | disabled | Visual model; `qwen3-vl-embedding` enables image ingestion and text-to-image retrieval |
| `VISION_EMBED_API_KEY` | `EMBED_API_KEY` | DashScope key for the multimodal endpoint |
| `VISION_EMBED_BASE_URL` | `https://dashscope.aliyuncs.com/api/v1` | DashScope multimodal API base URL |
| `VISION_EMBED_DIMENSION` | 1024 | Visual vector dimension; changing it invalidates visual vectors |
| `VISION_EMBED_MAX_PER_SYNC` | 20 | Maximum missing or invalid visual vectors generated by one synchronization run |

### Logging
- Console and timestamped `apps/qabot/data/qabot.log` output.
- `apps/qabot/data/` contains the rebuildable ingestion index, local development repositories, Feishu source configuration, logs, and retained pre-MySQL migration evidence. Production business state lives in `hr_system`.

### Windows scheduled startup
```powershell
# Register an on-login task from an elevated PowerShell; use the actual local path
schtasks /Create /TN "qabot-service" /TR "cmd /c D:\deepseek_q&a\apps\qabot\start-qabot.bat" /SC ONLOGON /RL HIGHEST /F
# Run it once for verification
schtasks /Run /TN "qabot-service"
# Remove the task
schtasks /Delete /TN "qabot-service" /F
```

### LAN access
The service listens on `0.0.0.0:3100`; internal clients reach the test page at `http://<host-ip>:3100/`.
Allow inbound TCP port 3100 in Windows Firewall when the host policy requires it.

## Known constraints

- **Relay balance:** the configured relay can return `Insufficient Balance`, which closes model streams until provider balance is available.
- **Empty-response retry:** a relay-induced empty turn retries once; a second empty result returns a readable temporary-service error and hides the retry instruction from the transcript.
- **Persistent incremental vectors:** MySQL retains production text and visual vectors; the ingestion index recalculates only when content hash, model, or dimension changes and projects those rows without a second model call. Query-vector caching avoids repeated embedding calls for the same normalized question and model.
- **Knowledge publication:** offline, not-yet-effective, and expired documents are excluded from keyword, text-vector, visual-vector, and returned-image retrieval. Reactivation reuses unchanged vectors.
- **Visual retrieval:** `VISION_EMBED_MODEL=qwen3-vl-embedding` downloads Feishu document images and enables text-to-image retrieval. The application needs permission to download cloud-document media.
- **Feishu permission:** the application needs scopes such as `im:message:send_as_bot`; failed notifications degrade to logs.
- Tools use `defineTool`; direct registration does not convert parameters to JSON Schema and is rejected by the relay.
