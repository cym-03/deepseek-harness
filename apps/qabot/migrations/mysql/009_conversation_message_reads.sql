CREATE TABLE conversation_message_read_baselines (
  id TINYINT NOT NULL COMMENT '未读功能基线固定记录ID',
  last_message_id BIGINT NOT NULL COMMENT '启用未读功能时已有消息的最大ID',
  created_at BIGINT NOT NULL COMMENT '未读功能基线创建时间戳，Unix毫秒',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能问答未读消息启用基线';

INSERT INTO conversation_message_read_baselines (id, last_message_id, created_at)
SELECT 1, COALESCE(MAX(id), 0), UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000
FROM conversation_messages;

CREATE TABLE conversation_message_reads (
  session_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '关联DSH会话唯一标识',
  reader_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '阅读者范围与员工唯一标识',
  last_read_message_id BIGINT NOT NULL DEFAULT 0 COMMENT '阅读者最后已读聊天消息ID',
  updated_at BIGINT NOT NULL COMMENT '最后已读位置更新时间戳，Unix毫秒',
  PRIMARY KEY (session_id, reader_key),
  KEY idx_conversation_message_reads_reader (reader_key, updated_at),
  CONSTRAINT fk_conversation_message_reads_session FOREIGN KEY (session_id) REFERENCES conversations (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能问答会话阅读进度';
