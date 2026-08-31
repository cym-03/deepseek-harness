CREATE TABLE conversation_messages (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '聊天消息内部自增ID',
  session_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '关联DSH会话唯一标识',
  source_type VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '消息来源类型：DSH事件、工单回复或系统消息',
  source_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '消息在来源系统中的唯一标识',
  source_order BIGINT NOT NULL COMMENT '消息在来源系统中的顺序号',
  role VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '消息角色：员工、智能助手、人工客服或系统',
  content TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '消息正文内容',
  media_json JSON NULL COMMENT '消息关联图片与引用信息JSON',
  created_at BIGINT NOT NULL COMMENT '消息创建时间戳，Unix毫秒',
  projected_at BIGINT NOT NULL COMMENT '消息最近投影时间戳，Unix毫秒',
  PRIMARY KEY (id),
  UNIQUE KEY uq_conversation_messages_source (session_id, source_type, source_id),
  KEY idx_conversation_messages_timeline (session_id, created_at, source_order, id),
  CONSTRAINT fk_conversation_messages_session FOREIGN KEY (session_id) REFERENCES conversations (session_id),
  CONSTRAINT chk_conversation_messages_source CHECK (source_type IN ('dsh_event', 'ticket_reply', 'system')),
  CONSTRAINT chk_conversation_messages_role CHECK (role IN ('user', 'assistant', 'human', 'system'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='员工智能问答聊天消息时间线';
