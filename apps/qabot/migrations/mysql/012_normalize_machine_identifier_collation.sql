ALTER TABLE dsh_model_sessions
  MODIFY COLUMN incarnation CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '会话物化实例标识';

ALTER TABLE knowledge_query_embeddings
  MODIFY COLUMN query_hash CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '规范化查询文本SHA256';
