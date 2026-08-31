ALTER TABLE knowledge_documents
  ADD COLUMN publication_status VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'online' COMMENT '文档发布状态：上线或下架' AFTER confidentiality,
  ADD COLUMN publication_updated_at BIGINT NOT NULL DEFAULT 0 COMMENT '文档上下架状态更新时间戳，Unix毫秒' AFTER publication_status,
  ADD KEY idx_knowledge_documents_publication (publication_status, publication_updated_at),
  ADD CONSTRAINT chk_knowledge_documents_publication CHECK (publication_status IN ('online', 'offline'));
