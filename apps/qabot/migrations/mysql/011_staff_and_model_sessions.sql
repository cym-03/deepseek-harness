CREATE TABLE qabot_data_imports (
  import_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '一次性数据迁移唯一标识',
  imported_at DATETIME(3) NOT NULL COMMENT '迁移完成时间，Asia/Shanghai',
  detail_json JSON NULL COMMENT '迁移结果明细JSON',
  PRIMARY KEY (import_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Qabot历史数据迁移记录';

CREATE TABLE service_staff_members (
  employee_open_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '服务人员飞书Open ID',
  group_name VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'default' COMMENT '服务组名称',
  employee_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '员工真实姓名',
  active TINYINT NOT NULL DEFAULT 1 COMMENT '是否启用服务资格',
  created_at DATETIME(3) NOT NULL COMMENT '创建时间，Asia/Shanghai',
  updated_at DATETIME(3) NOT NULL COMMENT '更新时间，Asia/Shanghai',
  PRIMARY KEY (employee_open_id, group_name),
  KEY idx_service_staff_group (group_name, active),
  CONSTRAINT chk_service_staff_active CHECK (active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能问答服务人员配置';

CREATE TABLE dsh_model_sessions (
  session_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT 'DSH模型会话唯一标识',
  format_version INT NOT NULL COMMENT 'DSH会话日志格式版本',
  created_at DATETIME(3) NOT NULL COMMENT '会话创建时间，Asia/Shanghai',
  working_directory VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '会话工作目录',
  parent_session_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '父会话标识',
  seed_length INT NULL COMMENT '创建时种子事件数量',
  origin VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '会话来源类型',
  delegation_depth INT NULL COMMENT '委派深度',
  agent_preset VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '代理预设名称',
  incarnation CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL COMMENT '会话物化实例标识',
  revision BIGINT NOT NULL DEFAULT 0 COMMENT '会话事件修订号',
  updated_at DATETIME(3) NOT NULL COMMENT '最近事件持久化时间，Asia/Shanghai',
  PRIMARY KEY (session_id),
  KEY idx_dsh_model_sessions_updated (updated_at),
  KEY idx_dsh_model_sessions_parent (parent_session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='DSH模型原始会话头';

CREATE TABLE dsh_model_session_events (
  session_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '关联DSH模型会话标识',
  event_seq INT NOT NULL COMMENT '会话内连续事件序号',
  event_type VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT 'DSH事件类型',
  event_time DATETIME(3) NOT NULL COMMENT '事件发生时间，Asia/Shanghai',
  event_data JSON NOT NULL COMMENT '事件业务数据JSON',
  source_event_seqs JSON NULL COMMENT '界面投影来源事件序号JSON',
  surface_operation JSON NULL COMMENT '界面投影操作JSON',
  ignorable TINYINT NULL COMMENT '未知事件是否允许旧版本忽略',
  PRIMARY KEY (session_id, event_seq),
  KEY idx_dsh_model_events_time (event_time),
  CONSTRAINT fk_dsh_model_events_session FOREIGN KEY (session_id) REFERENCES dsh_model_sessions (session_id) ON DELETE CASCADE,
  CONSTRAINT chk_dsh_model_events_ignorable CHECK (ignorable IS NULL OR ignorable = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='DSH模型原始会话事件日志';

CREATE TABLE knowledge_query_embeddings (
  query_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL COMMENT '规范化查询文本SHA256',
  model_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '向量模型及版本标识',
  vector_json JSON NOT NULL COMMENT '已计算查询向量JSON',
  created_at DATETIME(3) NOT NULL COMMENT '首次计算时间，Asia/Shanghai',
  last_used_at DATETIME(3) NOT NULL COMMENT '最近复用时间，Asia/Shanghai',
  PRIMARY KEY (query_hash, model_key),
  KEY idx_knowledge_query_embeddings_used (last_used_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='知识检索查询向量缓存';

CREATE TABLE knowledge_submissions (
  submission_id BIGINT NOT NULL COMMENT '原知识库待审核条目ID',
  source_url VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '待录入知识链接',
  title VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '待录入知识标题',
  status VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '审核状态：待审核、已通过或已拒绝',
  created_at DATETIME(3) NOT NULL COMMENT '提交时间，Asia/Shanghai',
  updated_at DATETIME(3) NOT NULL COMMENT '最近状态更新时间，Asia/Shanghai',
  PRIMARY KEY (submission_id),
  KEY idx_knowledge_submissions_status (status, created_at),
  CONSTRAINT chk_knowledge_submissions_status CHECK (status IN ('pending', 'approved', 'rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='知识库链接录入审核队列';
