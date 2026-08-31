CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at BIGINT NOT NULL
);

CREATE TABLE conversations (
  user_key TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '新对话',
  created_at BIGINT NOT NULL,
  last_message_at BIGINT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  archived_at BIGINT,
  PRIMARY KEY (user_key, session_id)
);
CREATE INDEX idx_conversations_user ON conversations (user_key, last_message_at DESC);

CREATE TABLE tickets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ai' CHECK (kind IN ('ai', 'human')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'waiting_agent', 'in_service', 'waiting_employee', 'resolved', 'closed', 'reopened')
  ),
  department TEXT,
  assignee TEXT,
  question TEXT NOT NULL DEFAULT '',
  service_start BIGINT,
  service_end BIGINT,
  satisfaction INTEGER CHECK (satisfaction BETWEEN 1 AND 5),
  satisfaction_note TEXT,
  handoff_reason TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX idx_tickets_session ON tickets (session_id);
CREATE INDEX idx_tickets_status ON tickets (status, updated_at DESC);
CREATE INDEX idx_tickets_department ON tickets (department, status, updated_at DESC);

CREATE TABLE ticket_replies (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES tickets (id),
  message TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_ticket_replies_ticket ON ticket_replies (ticket_id, id);

CREATE TABLE audit_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  detail TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_audit_resource ON audit_records (resource_type, resource_id, id DESC);
CREATE INDEX idx_audit_actor ON audit_records (actor_id, id DESC);

CREATE TABLE outbox_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at BIGINT NOT NULL,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  completed_at BIGINT,
  claimed_at BIGINT,
  claimed_by TEXT
);
CREATE INDEX idx_outbox_pending ON outbox_messages (status, available_at, id);
