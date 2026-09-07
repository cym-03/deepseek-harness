# dsh-qabot — Employee intelligent Q&A service

English | [中文](README.zh.md)

An internal employee Q&A service embedded in DeepSeek Harness and called through the employee service desk portal's NestJS proxy.

The current baseline includes persistent text and visual indexes, signed portal identity, employee conversation authorization, per-conversation serialized execution, versioned conversation APIs, and MySQL-authoritative online knowledge-source management. Ticket and operations endpoints remain available through the compatibility `/api` routes until their domain migrations are complete.

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
| `GET /v1/knowledge/sources` | List active online sources and their synchronization health |
| `POST /v1/knowledge/sources` | Add `{ title, url, group }` and start the first synchronization |
| `PATCH /v1/knowledge/sources/:id` | Edit the source title or maintenance group |
| `POST /v1/knowledge/sources/:id/sync` | Synchronize one source immediately |
| `DELETE /v1/knowledge/sources/:id` | Soft-remove a source from synchronization and retrieval |
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
| `QABOT_SYNC_INTERVAL_MINUTES` | 5 | Scheduled knowledge synchronization; 0 disables it |
| `QABOT_API_TOKEN` | required | Shared `X-Qabot-Token`; startup fails when missing |
| `QABOT_PORTAL_INTERNAL_URL` | `http://127.0.0.1:3000/api/internal/qabot` | Portal credential broker used for submitter-scoped Feishu synchronization |
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

The MySQL provider stores conversations, messages, tickets, audit records, Outbox rows, service-team configuration, online knowledge-source configuration, internal knowledge versions, source-image binaries and vectors, query-vector cache entries, and raw DSH model events in `hr_system`. A source's first successful synchronization becomes available to employee retrieval immediately. Later successful synchronizations atomically replace its current content, while a failed update retains the last usable content. `kb.db` is a rebuildable working index used to parse synchronized content and calculate missing embeddings; it is not the production source registry or retrieval authority. Projection copies stored vectors without requesting embeddings. Model retrieval reads active MySQL sources and automatically combines text and related-image recall for every non-empty employee question. A visual query vector is generated only when eligible image candidates exist and is reused by normalized query hash and model key. Business dates use Asia/Shanghai `DATETIME(3)` columns so operators see `YYYY-MM-DD HH:mm:ss.SSS` values directly; repositories convert them to Unix milliseconds at the application boundary. Configure `QABOT_DATABASE_BACKEND=mysql` and `QABOT_MYSQL_URL`; startup applies pending migrations. Real integration tests read only `QABOT_TEST_MYSQL_URL` and must not remain pointed at production.

Image attachments combine the question's cached visual-vector matches with active captioned images or boards named explicitly by the generated answer. Answer-supported selection does not request another embedding, and generic document-image labels never attach every unlabeled image from a cited source.

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
| `VISION_OCR_MODEL` | `qwen-vl-ocr` | OpenAI-compatible model that extracts searchable text from changed board snapshots |
| `VISION_OCR_MAX_TOKENS` | 4096 | Maximum output for each board OCR request; dense snapshots are divided into overlapping regions when this limit is reached |

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
- **Online knowledge sources:** administrators add Feishu links directly. Each source synchronizes with its submitter's Feishu user authorization; the system never falls back to a bot or another employee when that authorization is missing. Direct Docx, Sheets, and Bitable links are supported, and Wiki nodes backed by those types become searchable records. Sheets preserve worksheet names, column headers, and row field names; a link that names one worksheet indexes only that worksheet. A SystemAdmin can claim a migrated source by submitting its link again. The fixed group controls maintenance ownership, not employee visibility. Sources synchronize every five minutes by default; a successful content change archives prior published versions atomically, and retrieval reads only the greatest published version number for each document. Soft removal immediately excludes source text, vectors, and images from retrieval, and re-adding the same link reuses unchanged data.
- **Visual retrieval:** `VISION_EMBED_MODEL=qwen3-vl-embedding` downloads Feishu document images and embedded boards, creates incremental visual vectors during ingestion, and stores their binaries and vectors in MySQL. A board uses its nearest heading as retrieval context and refreshes its exported snapshot on every source synchronization. The configured `VISION_OCR_MODEL` extracts board text during ingestion and stores it in searchable knowledge chunks; an unchanged snapshot reuses both that text and its visual vector without another model request. A changed snapshot replaces the current asset and recalculates only its OCR text and vector. Dense boards use overlapping OCR regions only after the full snapshot reaches the output limit; blank regions contribute no text, and a smallest region can retain complete text fields from an otherwise incomplete structured response. SVG boards are converted to PNG, and only assets exceeding the provider request limit are resized and compressed. Every non-empty employee question can recall board text and related visual assets without image- or board-specific wording. Matching assets render as cards after the answer. Query vectors are cached, and no visual query call occurs when no eligible candidate exists.
- **Feishu media access:** ordinary embedded images need `docs:document.media:download`, embedded boards need `board:whiteboard:node:read`, and the source submitter must retain access to the corresponding document or board. The portal stores that user's renewable OAuth credential encrypted and brokers only a short-lived access token to Qabot. Ordinary image synchronization sends the parent Docx context and falls back from media download to the source-file preview stream (`preview_type=16`) and temporary URL; boards use Feishu's board-image export endpoint. A denied visual download leaves the last synchronized text and existing asset available, records a source-level warning, and does not spend visual-model quota. MySQL projection preserves each unchanged asset ID so images attached to conversation history remain readable. Automatic visual retrieval requires the asset title to share a specific, non-generic term with the question or answer and uses a `0.45` strong-match threshold or a corroborating pair above `0.40` within a `0.02` margin. Matching assets may come from any active source, and an image explicitly named by the answer remains eligible. Deployments may tune `VISION_MEDIA_STRONG_SCORE`, `VISION_MEDIA_CLUSTER_SCORE`, and `VISION_MEDIA_CLUSTER_MARGIN`.
- **Feishu permission:** the application needs scopes such as `im:message:send_as_bot`; failed notifications degrade to logs.
- Tools use `defineTool`; direct registration does not convert parameters to JSON Schema and is rejected by the relay.
