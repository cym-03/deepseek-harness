ALTER TABLE tickets
  ADD COLUMN analytics_domain VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '运营分析领域：人事、行政、IT、财务或其他' AFTER handoff_reason,
  ADD COLUMN resolved_at DATETIME(3) NULL COMMENT '会话真正结束时间，精确到毫秒' AFTER analytics_domain,
  ADD COLUMN resolution_time_estimated TINYINT NOT NULL DEFAULT 0 COMMENT '解决时间是否由历史数据估算：0否，1是' AFTER resolved_at,
  ADD KEY idx_tickets_operations (created_at, analytics_domain, status);

UPDATE tickets
SET analytics_domain = CASE
  WHEN department IN ('人事', '行政', 'IT', '财务') THEN department
  ELSE '其他'
END
WHERE analytics_domain IS NULL;

UPDATE tickets
SET resolved_at = COALESCE(service_end, updated_at), resolution_time_estimated = 1
WHERE status IN ('resolved', 'closed') AND resolved_at IS NULL;

CREATE TABLE qa_turn_analytics (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '问答分析记录内部自增ID',
  session_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '关联会话唯一标识',
  ticket_id BIGINT NULL COMMENT '关联工单ID',
  question TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '员工本轮问题',
  normalized_question VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '用于相似问题聚合的标准化问题',
  answer MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '助手本轮回答',
  service_group VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '分析领域分组',
  knowledge_hit TINYINT NOT NULL DEFAULT 0 COMMENT '是否命中可靠知识：0否，1是',
  knowledge_source_id BIGINT NULL COMMENT '最高相关知识源ID',
  relevance DECIMAL(7,6) NULL COMMENT '最高知识相关度',
  faq_id BIGINT NULL COMMENT '命中的常见问题ID',
  created_at DATETIME(3) NOT NULL COMMENT '问答发生时间，精确到毫秒',
  PRIMARY KEY (id),
  KEY idx_qa_turn_period (created_at, service_group),
  KEY idx_qa_turn_session (session_id, id),
  KEY idx_qa_turn_faq (faq_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='每轮智能问答运营分析记录';

CREATE TABLE qa_handoff_events (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '转人工事件内部自增ID',
  session_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '关联会话唯一标识',
  ticket_id BIGINT NULL COMMENT '关联工单ID',
  event_type VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '事件类型：建议或员工选择',
  trigger_question TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '触发转人工的员工原话',
  reason_type VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '可读原因分类',
  reason_text TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '转人工补充原因',
  service_group VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '目标服务分组',
  created_at DATETIME(3) NOT NULL COMMENT '事件发生时间，精确到毫秒',
  PRIMARY KEY (id),
  KEY idx_qa_handoff_period (created_at, service_group, event_type),
  KEY idx_qa_handoff_session (session_id, event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能问答转人工事件';

CREATE TABLE curated_faqs (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '常见问题内部自增ID',
  service_group VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '维护分组',
  question VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '标准问题',
  normalized_question VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '用于直接匹配的标准化问题',
  answer MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '标准答案',
  sort_order INT NOT NULL DEFAULT 0 COMMENT '组内显示顺序',
  enabled TINYINT NOT NULL DEFAULT 1 COMMENT '是否启用：0否，1是',
  usage_count BIGINT NOT NULL DEFAULT 0 COMMENT '累计直接命中次数',
  created_by VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '创建人员工ID',
  created_by_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '创建人姓名',
  updated_by VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '最后更新人员工ID',
  updated_by_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '最后更新人姓名',
  created_at DATETIME(3) NOT NULL COMMENT '创建时间，精确到毫秒',
  updated_at DATETIME(3) NOT NULL COMMENT '更新时间，精确到毫秒',
  PRIMARY KEY (id),
  UNIQUE KEY uq_curated_faq_question (service_group, normalized_question),
  KEY idx_curated_faq_order (service_group, enabled, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='分组常见问题配置';

CREATE TABLE curated_faq_links (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '常见问题文档链接内部自增ID',
  faq_id BIGINT NOT NULL COMMENT '关联常见问题ID',
  title VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '链接显示标题',
  url TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '文档链接',
  sort_order INT NOT NULL DEFAULT 0 COMMENT '显示顺序',
  PRIMARY KEY (id),
  KEY idx_curated_faq_links (faq_id, sort_order, id),
  CONSTRAINT fk_curated_faq_links_faq FOREIGN KEY (faq_id) REFERENCES curated_faqs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='常见问题文档链接';

CREATE TABLE curated_faq_assets (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '常见问题图片内部自增ID',
  faq_id BIGINT NOT NULL COMMENT '关联常见问题ID',
  file_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '原始文件名',
  mime_type VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '图片媒体类型',
  binary_data LONGBLOB NOT NULL COMMENT '图片原始二进制内容',
  sort_order INT NOT NULL DEFAULT 0 COMMENT '显示顺序',
  created_at DATETIME(3) NOT NULL COMMENT '上传时间，精确到毫秒',
  PRIMARY KEY (id),
  KEY idx_curated_faq_assets (faq_id, sort_order, id),
  CONSTRAINT fk_curated_faq_assets_faq FOREIGN KEY (faq_id) REFERENCES curated_faqs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='常见问题图片附件';

CREATE TABLE curated_faq_usage (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '常见问题使用记录内部自增ID',
  faq_id BIGINT NOT NULL COMMENT '关联常见问题ID',
  session_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '关联会话唯一标识',
  employee_question TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '员工实际提问',
  matched_at DATETIME(3) NOT NULL COMMENT '命中时间，精确到毫秒',
  PRIMARY KEY (id),
  KEY idx_curated_faq_usage_period (faq_id, matched_at),
  CONSTRAINT fk_curated_faq_usage_faq FOREIGN KEY (faq_id) REFERENCES curated_faqs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='常见问题实际命中记录';

CREATE TABLE operations_voc_cache (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '员工声音缓存内部自增ID',
  service_group VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '统计分组或全部',
  period_from DATETIME(3) NOT NULL COMMENT '统计开始时间，包含',
  period_to DATETIME(3) NOT NULL COMMENT '统计结束时间，不包含',
  data_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '参与摘要数据的SHA256',
  summary MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '员工声音摘要',
  generated_by VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '生成人员工ID',
  generated_at DATETIME(3) NOT NULL COMMENT '生成时间，精确到毫秒',
  PRIMARY KEY (id),
  UNIQUE KEY uq_operations_voc_cache (service_group, period_from, period_to, data_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='按需生成的员工声音摘要缓存';

CREATE TABLE operations_actions (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '改进行动内部自增ID',
  service_group VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '负责服务分组',
  title VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '改进事项',
  related_issue VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '对应问题或指标',
  current_value VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '当前值',
  target_value VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '目标值',
  owner_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '负责人员工ID',
  owner_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '负责人姓名',
  due_date DATE NULL COMMENT '截止日期',
  status VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'pending' COMMENT '状态：待处理、进行中、已完成或已忽略',
  system_generated TINYINT NOT NULL DEFAULT 0 COMMENT '是否系统草稿：0否，1是',
  created_by VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '创建人员工ID',
  created_at DATETIME(3) NOT NULL COMMENT '创建时间，精确到毫秒',
  updated_at DATETIME(3) NOT NULL COMMENT '更新时间，精确到毫秒',
  PRIMARY KEY (id),
  KEY idx_operations_actions_group (service_group, status, due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='运营改进行动';

CREATE TABLE operation_audit_logs (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '统一操作审计内部自增ID',
  source_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '来源系统幂等键',
  actor_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '操作人员工ID',
  actor_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '操作人姓名',
  action_code VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '内部动作代码',
  action_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '可读操作名称',
  content TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '可读操作内容',
  result VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '操作结果：成功或失败',
  resource_type VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '资源类型',
  resource_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '资源唯一标识',
  created_at DATETIME(3) NOT NULL COMMENT '操作时间，精确到毫秒',
  PRIMARY KEY (id),
  UNIQUE KEY uq_operation_audit_source (source_key),
  KEY idx_operation_audit_time (created_at DESC),
  KEY idx_operation_audit_actor (actor_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='门户与Qabot统一操作审计日志';

INSERT IGNORE INTO operation_audit_logs (
  source_key, actor_id, actor_name, action_code, action_name, content, result,
  resource_type, resource_id, created_at
)
SELECT CONCAT('qabot:', id), actor_id, actor_id, action, action,
  CONCAT(resource_type, ' ', resource_id, IF(detail IS NULL OR detail = '', '', CONCAT('：', detail))),
  IF(action LIKE '%failed%', '失败', '成功'), resource_type, resource_id, created_at
FROM audit_records;
