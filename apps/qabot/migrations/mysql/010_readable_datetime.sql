SET time_zone = '+08:00';

ALTER TABLE schema_migrations
  ADD COLUMN applied_at_readable DATETIME(3) NULL COMMENT '迁移完成时间，精确到毫秒';
UPDATE schema_migrations
SET applied_at_readable = FROM_UNIXTIME(applied_at / 1000.0)
WHERE applied_at IS NOT NULL;
ALTER TABLE schema_migrations
  DROP COLUMN applied_at,
  CHANGE COLUMN applied_at_readable applied_at DATETIME(3) NULL COMMENT '迁移完成时间，精确到毫秒';

ALTER TABLE conversations
  DROP INDEX idx_conversations_user,
  ADD COLUMN created_at_readable DATETIME(3) NULL COMMENT '创建时间，精确到毫秒',
  ADD COLUMN last_message_at_readable DATETIME(3) NULL COMMENT '最后消息时间，精确到毫秒',
  ADD COLUMN archived_at_readable DATETIME(3) NULL COMMENT '归档时间，精确到毫秒';
UPDATE conversations SET
  created_at_readable = FROM_UNIXTIME(created_at / 1000.0),
  last_message_at_readable = FROM_UNIXTIME(last_message_at / 1000.0),
  archived_at_readable = IF(archived_at IS NULL, NULL, FROM_UNIXTIME(archived_at / 1000.0));
ALTER TABLE conversations
  DROP COLUMN created_at,
  DROP COLUMN last_message_at,
  DROP COLUMN archived_at,
  CHANGE COLUMN created_at_readable created_at DATETIME(3) NOT NULL COMMENT '创建时间，精确到毫秒',
  CHANGE COLUMN last_message_at_readable last_message_at DATETIME(3) NOT NULL COMMENT '最后消息时间，精确到毫秒',
  CHANGE COLUMN archived_at_readable archived_at DATETIME(3) NULL COMMENT '归档时间，精确到毫秒',
  ADD KEY idx_conversations_user (user_key, last_message_at DESC);

ALTER TABLE tickets
  DROP INDEX idx_tickets_status,
  DROP INDEX idx_tickets_department,
  ADD COLUMN service_start_readable DATETIME(3) NULL COMMENT '服务开始时间，精确到毫秒',
  ADD COLUMN service_end_readable DATETIME(3) NULL COMMENT '服务结束时间，精确到毫秒',
  ADD COLUMN created_at_readable DATETIME(3) NULL COMMENT '创建时间，精确到毫秒',
  ADD COLUMN updated_at_readable DATETIME(3) NULL COMMENT '更新时间，精确到毫秒';
UPDATE tickets SET
  service_start_readable = IF(service_start IS NULL, NULL, FROM_UNIXTIME(service_start / 1000.0)),
  service_end_readable = IF(service_end IS NULL, NULL, FROM_UNIXTIME(service_end / 1000.0)),
  created_at_readable = FROM_UNIXTIME(created_at / 1000.0),
  updated_at_readable = FROM_UNIXTIME(updated_at / 1000.0);
ALTER TABLE tickets
  DROP COLUMN service_start,
  DROP COLUMN service_end,
  DROP COLUMN created_at,
  DROP COLUMN updated_at,
  CHANGE COLUMN service_start_readable service_start DATETIME(3) NULL COMMENT '服务开始时间，精确到毫秒',
  CHANGE COLUMN service_end_readable service_end DATETIME(3) NULL COMMENT '服务结束时间，精确到毫秒',
  CHANGE COLUMN created_at_readable created_at DATETIME(3) NOT NULL COMMENT '创建时间，精确到毫秒',
  CHANGE COLUMN updated_at_readable updated_at DATETIME(3) NOT NULL COMMENT '更新时间，精确到毫秒',
  ADD KEY idx_tickets_status (status, updated_at DESC),
  ADD KEY idx_tickets_department (department, status, updated_at DESC);

ALTER TABLE ticket_replies
  ADD COLUMN created_at_readable DATETIME(3) NULL COMMENT '创建时间，精确到毫秒';
UPDATE ticket_replies SET created_at_readable = FROM_UNIXTIME(created_at / 1000.0);
ALTER TABLE ticket_replies
  DROP COLUMN created_at,
  CHANGE COLUMN created_at_readable created_at DATETIME(3) NOT NULL COMMENT '创建时间，精确到毫秒';

ALTER TABLE audit_records
  ADD COLUMN created_at_readable DATETIME(3) NULL COMMENT '创建时间，精确到毫秒';
UPDATE audit_records SET created_at_readable = FROM_UNIXTIME(created_at / 1000.0);
ALTER TABLE audit_records
  DROP COLUMN created_at,
  CHANGE COLUMN created_at_readable created_at DATETIME(3) NOT NULL COMMENT '创建时间，精确到毫秒';

ALTER TABLE outbox_messages
  DROP INDEX idx_outbox_pending,
  ADD COLUMN available_at_readable DATETIME(3) NULL COMMENT '下次可执行时间，精确到毫秒',
  ADD COLUMN created_at_readable DATETIME(3) NULL COMMENT '创建时间，精确到毫秒',
  ADD COLUMN completed_at_readable DATETIME(3) NULL COMMENT '完成时间，精确到毫秒',
  ADD COLUMN claimed_at_readable DATETIME(3) NULL COMMENT '任务领取时间，精确到毫秒';
UPDATE outbox_messages SET
  available_at_readable = FROM_UNIXTIME(available_at / 1000.0),
  created_at_readable = FROM_UNIXTIME(created_at / 1000.0),
  completed_at_readable = IF(completed_at IS NULL, NULL, FROM_UNIXTIME(completed_at / 1000.0)),
  claimed_at_readable = IF(claimed_at IS NULL, NULL, FROM_UNIXTIME(claimed_at / 1000.0));
ALTER TABLE outbox_messages
  DROP COLUMN available_at,
  DROP COLUMN created_at,
  DROP COLUMN completed_at,
  DROP COLUMN claimed_at,
  CHANGE COLUMN available_at_readable available_at DATETIME(3) NOT NULL COMMENT '下次可执行时间，精确到毫秒',
  CHANGE COLUMN created_at_readable created_at DATETIME(3) NOT NULL COMMENT '创建时间，精确到毫秒',
  CHANGE COLUMN completed_at_readable completed_at DATETIME(3) NULL COMMENT '完成时间，精确到毫秒',
  CHANGE COLUMN claimed_at_readable claimed_at DATETIME(3) NULL COMMENT '任务领取时间，精确到毫秒',
  ADD KEY idx_outbox_pending (status, available_at, id);

ALTER TABLE knowledge_sources
  ADD COLUMN created_at_readable DATETIME(3) NULL COMMENT '创建时间，精确到毫秒',
  ADD COLUMN updated_at_readable DATETIME(3) NULL COMMENT '更新时间，精确到毫秒';
UPDATE knowledge_sources SET
  created_at_readable = FROM_UNIXTIME(created_at / 1000.0),
  updated_at_readable = FROM_UNIXTIME(updated_at / 1000.0);
ALTER TABLE knowledge_sources
  DROP COLUMN created_at,
  DROP COLUMN updated_at,
  CHANGE COLUMN created_at_readable created_at DATETIME(3) NOT NULL COMMENT '创建时间，精确到毫秒',
  CHANGE COLUMN updated_at_readable updated_at DATETIME(3) NOT NULL COMMENT '更新时间，精确到毫秒';

ALTER TABLE knowledge_documents
  DROP INDEX idx_knowledge_documents_publication,
  ADD COLUMN publication_updated_at_readable DATETIME(3) NULL COMMENT '文档上下架状态更新时间，精确到毫秒',
  ADD COLUMN created_at_readable DATETIME(3) NULL COMMENT '创建时间，精确到毫秒',
  ADD COLUMN updated_at_readable DATETIME(3) NULL COMMENT '更新时间，精确到毫秒';
UPDATE knowledge_documents SET
  publication_updated_at_readable = FROM_UNIXTIME(publication_updated_at / 1000.0),
  created_at_readable = FROM_UNIXTIME(created_at / 1000.0),
  updated_at_readable = FROM_UNIXTIME(updated_at / 1000.0);
ALTER TABLE knowledge_documents
  DROP COLUMN publication_updated_at,
  DROP COLUMN created_at,
  DROP COLUMN updated_at,
  CHANGE COLUMN publication_updated_at_readable publication_updated_at DATETIME(3) NOT NULL COMMENT '文档上下架状态更新时间，精确到毫秒',
  CHANGE COLUMN created_at_readable created_at DATETIME(3) NOT NULL COMMENT '创建时间，精确到毫秒',
  CHANGE COLUMN updated_at_readable updated_at DATETIME(3) NOT NULL COMMENT '更新时间，精确到毫秒',
  ADD KEY idx_knowledge_documents_publication (publication_status, publication_updated_at);

ALTER TABLE knowledge_document_versions
  DROP INDEX idx_knowledge_versions_status,
  ADD COLUMN effective_at_readable DATETIME(3) NULL COMMENT '版本生效时间，精确到毫秒',
  ADD COLUMN expires_at_readable DATETIME(3) NULL COMMENT '版本失效时间，精确到毫秒',
  ADD COLUMN created_at_readable DATETIME(3) NULL COMMENT '创建时间，精确到毫秒',
  ADD COLUMN published_at_readable DATETIME(3) NULL COMMENT '发布时间，精确到毫秒',
  ADD COLUMN archived_at_readable DATETIME(3) NULL COMMENT '归档时间，精确到毫秒';
UPDATE knowledge_document_versions SET
  effective_at_readable = IF(effective_at IS NULL, NULL, FROM_UNIXTIME(effective_at / 1000.0)),
  expires_at_readable = IF(expires_at IS NULL, NULL, FROM_UNIXTIME(expires_at / 1000.0)),
  created_at_readable = FROM_UNIXTIME(created_at / 1000.0),
  published_at_readable = IF(published_at IS NULL, NULL, FROM_UNIXTIME(published_at / 1000.0)),
  archived_at_readable = IF(archived_at IS NULL, NULL, FROM_UNIXTIME(archived_at / 1000.0));
ALTER TABLE knowledge_document_versions
  DROP COLUMN effective_at,
  DROP COLUMN expires_at,
  DROP COLUMN created_at,
  DROP COLUMN published_at,
  DROP COLUMN archived_at,
  CHANGE COLUMN effective_at_readable effective_at DATETIME(3) NULL COMMENT '版本生效时间，精确到毫秒',
  CHANGE COLUMN expires_at_readable expires_at DATETIME(3) NULL COMMENT '版本失效时间，精确到毫秒',
  CHANGE COLUMN created_at_readable created_at DATETIME(3) NOT NULL COMMENT '创建时间，精确到毫秒',
  CHANGE COLUMN published_at_readable published_at DATETIME(3) NULL COMMENT '发布时间，精确到毫秒',
  CHANGE COLUMN archived_at_readable archived_at DATETIME(3) NULL COMMENT '归档时间，精确到毫秒',
  ADD KEY idx_knowledge_versions_status (status, effective_at, expires_at);

ALTER TABLE knowledge_chunks
  ADD COLUMN created_at_readable DATETIME(3) NULL COMMENT '创建时间，精确到毫秒';
UPDATE knowledge_chunks SET created_at_readable = FROM_UNIXTIME(created_at / 1000.0);
ALTER TABLE knowledge_chunks
  DROP COLUMN created_at,
  CHANGE COLUMN created_at_readable created_at DATETIME(3) NOT NULL COMMENT '创建时间，精确到毫秒';

ALTER TABLE knowledge_assets
  ADD COLUMN created_at_readable DATETIME(3) NULL COMMENT '创建时间，精确到毫秒';
UPDATE knowledge_assets SET created_at_readable = FROM_UNIXTIME(created_at / 1000.0);
ALTER TABLE knowledge_assets
  DROP COLUMN created_at,
  CHANGE COLUMN created_at_readable created_at DATETIME(3) NOT NULL COMMENT '创建时间，精确到毫秒';

ALTER TABLE knowledge_embeddings
  ADD COLUMN created_at_readable DATETIME(3) NULL COMMENT '创建时间，精确到毫秒',
  ADD COLUMN updated_at_readable DATETIME(3) NULL COMMENT '更新时间，精确到毫秒';
UPDATE knowledge_embeddings SET
  created_at_readable = FROM_UNIXTIME(created_at / 1000.0),
  updated_at_readable = FROM_UNIXTIME(updated_at / 1000.0);
ALTER TABLE knowledge_embeddings
  DROP COLUMN created_at,
  DROP COLUMN updated_at,
  CHANGE COLUMN created_at_readable created_at DATETIME(3) NOT NULL COMMENT '创建时间，精确到毫秒',
  CHANGE COLUMN updated_at_readable updated_at DATETIME(3) NOT NULL COMMENT '更新时间，精确到毫秒';

ALTER TABLE knowledge_reviews
  ADD COLUMN created_at_readable DATETIME(3) NULL COMMENT '审核时间，精确到毫秒';
UPDATE knowledge_reviews SET created_at_readable = FROM_UNIXTIME(created_at / 1000.0);
ALTER TABLE knowledge_reviews
  DROP COLUMN created_at,
  CHANGE COLUMN created_at_readable created_at DATETIME(3) NOT NULL COMMENT '审核时间，精确到毫秒';

ALTER TABLE knowledge_sync_jobs
  ADD COLUMN started_at_readable DATETIME(3) NULL COMMENT '任务开始时间，精确到毫秒',
  ADD COLUMN completed_at_readable DATETIME(3) NULL COMMENT '任务完成时间，精确到毫秒',
  ADD COLUMN created_at_readable DATETIME(3) NULL COMMENT '创建时间，精确到毫秒';
UPDATE knowledge_sync_jobs SET
  started_at_readable = IF(started_at IS NULL, NULL, FROM_UNIXTIME(started_at / 1000.0)),
  completed_at_readable = IF(completed_at IS NULL, NULL, FROM_UNIXTIME(completed_at / 1000.0)),
  created_at_readable = FROM_UNIXTIME(created_at / 1000.0);
ALTER TABLE knowledge_sync_jobs
  DROP COLUMN started_at,
  DROP COLUMN completed_at,
  DROP COLUMN created_at,
  CHANGE COLUMN started_at_readable started_at DATETIME(3) NULL COMMENT '任务开始时间，精确到毫秒',
  CHANGE COLUMN completed_at_readable completed_at DATETIME(3) NULL COMMENT '任务完成时间，精确到毫秒',
  CHANGE COLUMN created_at_readable created_at DATETIME(3) NOT NULL COMMENT '创建时间，精确到毫秒';

ALTER TABLE conversation_messages
  DROP INDEX idx_conversation_messages_timeline,
  ADD COLUMN created_at_readable DATETIME(3) NULL COMMENT '消息创建时间，精确到毫秒',
  ADD COLUMN projected_at_readable DATETIME(3) NULL COMMENT '消息最近投影时间，精确到毫秒';
UPDATE conversation_messages SET
  created_at_readable = FROM_UNIXTIME(created_at / 1000.0),
  projected_at_readable = FROM_UNIXTIME(projected_at / 1000.0);
ALTER TABLE conversation_messages
  DROP COLUMN created_at,
  DROP COLUMN projected_at,
  CHANGE COLUMN created_at_readable created_at DATETIME(3) NOT NULL COMMENT '消息创建时间，精确到毫秒',
  CHANGE COLUMN projected_at_readable projected_at DATETIME(3) NOT NULL COMMENT '消息最近投影时间，精确到毫秒',
  ADD KEY idx_conversation_messages_timeline (session_id, created_at, source_order, id);

ALTER TABLE conversation_message_read_baselines
  ADD COLUMN created_at_readable DATETIME(3) NULL COMMENT '未读功能基线创建时间，精确到毫秒';
UPDATE conversation_message_read_baselines SET created_at_readable = FROM_UNIXTIME(created_at / 1000.0);
ALTER TABLE conversation_message_read_baselines
  DROP COLUMN created_at,
  CHANGE COLUMN created_at_readable created_at DATETIME(3) NOT NULL COMMENT '未读功能基线创建时间，精确到毫秒';

ALTER TABLE conversation_message_reads
  DROP INDEX idx_conversation_message_reads_reader,
  ADD COLUMN updated_at_readable DATETIME(3) NULL COMMENT '最后已读位置更新时间，精确到毫秒';
UPDATE conversation_message_reads SET updated_at_readable = FROM_UNIXTIME(updated_at / 1000.0);
ALTER TABLE conversation_message_reads
  DROP COLUMN updated_at,
  CHANGE COLUMN updated_at_readable updated_at DATETIME(3) NOT NULL COMMENT '最后已读位置更新时间，精确到毫秒',
  ADD KEY idx_conversation_message_reads_reader (reader_key, updated_at);
