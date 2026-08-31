CREATE TABLE conversations (
  user_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '员工唯一标识',
  session_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT 'DSH会话唯一标识',
  title TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '会话标题',
  created_at BIGINT NOT NULL COMMENT '创建时间戳，Unix毫秒',
  last_message_at BIGINT NOT NULL COMMENT '最后消息时间戳，Unix毫秒',
  message_count INT NOT NULL DEFAULT 0 COMMENT '会话消息数量',
  archived_at BIGINT NULL COMMENT '归档时间戳，Unix毫秒',
  PRIMARY KEY (user_key, session_id),
  UNIQUE KEY uq_conversations_session (session_id),
  KEY idx_conversations_user (user_key, last_message_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='员工智能问答会话';

CREATE TABLE tickets (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '工单内部自增ID',
  session_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '关联DSH会话唯一标识',
  user_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '发起员工唯一标识',
  kind VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'ai' COMMENT '工单服务类型：AI或人工',
  status VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'open' COMMENT '工单当前状态',
  department VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '所属服务组或部门标识',
  assignee VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '当前处理人员工标识',
  question TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '员工首次问题',
  service_start BIGINT NULL COMMENT '服务开始时间戳，Unix毫秒',
  service_end BIGINT NULL COMMENT '服务结束时间戳，Unix毫秒',
  satisfaction TINYINT NULL COMMENT '满意度评分，1至5分',
  handoff_reason TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '转人工原因',
  created_at BIGINT NOT NULL COMMENT '创建时间戳，Unix毫秒',
  updated_at BIGINT NOT NULL COMMENT '更新时间戳，Unix毫秒',
  version INT NOT NULL DEFAULT 1 COMMENT '乐观并发版本号',
  PRIMARY KEY (id),
  KEY idx_tickets_session (session_id),
  KEY idx_tickets_status (status, updated_at DESC),
  KEY idx_tickets_department (department, status, updated_at DESC),
  CONSTRAINT chk_tickets_kind CHECK (kind IN ('ai', 'human')),
  CONSTRAINT chk_tickets_status CHECK (
    status IN ('open', 'waiting_agent', 'in_service', 'waiting_employee', 'resolved', 'closed', 'reopened')
  ),
  CONSTRAINT chk_tickets_satisfaction CHECK (satisfaction IS NULL OR satisfaction BETWEEN 1 AND 5),
  CONSTRAINT chk_tickets_version CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='员工服务工单';

CREATE TABLE ticket_replies (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '工单回复内部自增ID',
  ticket_id BIGINT NOT NULL COMMENT '关联工单ID',
  message TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '客服公开回复内容',
  created_at BIGINT NOT NULL COMMENT '创建时间戳，Unix毫秒',
  PRIMARY KEY (id),
  KEY idx_ticket_replies_ticket (ticket_id, id),
  CONSTRAINT fk_ticket_replies_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='工单公开回复';

CREATE TABLE audit_records (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '审计记录内部自增ID',
  actor_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '操作人员工标识',
  action VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '审计动作代码',
  resource_type VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '被操作资源类型',
  resource_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '被操作资源唯一标识',
  detail TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '审计补充详情',
  created_at BIGINT NOT NULL COMMENT '创建时间戳，Unix毫秒',
  PRIMARY KEY (id),
  KEY idx_audit_resource (resource_type, resource_id, id DESC),
  KEY idx_audit_actor (actor_id, id DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='后台操作审计记录';

CREATE TABLE outbox_messages (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '外部任务内部自增ID',
  idempotency_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '业务幂等键',
  event_type VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '外部任务事件类型',
  payload_json JSON NOT NULL COMMENT '任务JSON载荷',
  status VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'pending' COMMENT '任务处理状态',
  attempts INT NOT NULL DEFAULT 0 COMMENT '已失败尝试次数',
  available_at BIGINT NOT NULL COMMENT '下次可执行时间戳，Unix毫秒',
  last_error TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '最后一次失败原因',
  created_at BIGINT NOT NULL COMMENT '创建时间戳，Unix毫秒',
  completed_at BIGINT NULL COMMENT '完成时间戳，Unix毫秒',
  claimed_at BIGINT NULL COMMENT '任务领取时间戳，Unix毫秒',
  claimed_by VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '领取任务的工作进程标识',
  PRIMARY KEY (id),
  UNIQUE KEY uq_outbox_idempotency (idempotency_key),
  KEY idx_outbox_pending (status, available_at, id),
  CONSTRAINT chk_outbox_status CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='外部通知任务队列';
