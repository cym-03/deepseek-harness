ALTER TABLE tickets
  ADD COLUMN priority VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'normal' COMMENT '工单优先级：低、普通、高或紧急' AFTER status,
  ADD COLUMN first_response_due_at BIGINT NULL COMMENT '首次人工响应截止时间戳，Unix毫秒' AFTER handoff_reason,
  ADD COLUMN resolution_due_at BIGINT NULL COMMENT '工单解决截止时间戳，Unix毫秒' AFTER first_response_due_at,
  ADD COLUMN first_agent_response_at BIGINT NULL COMMENT '首次人工回复时间戳，Unix毫秒' AFTER resolution_due_at,
  ADD KEY idx_tickets_sla (status, first_response_due_at, resolution_due_at),
  ADD CONSTRAINT chk_tickets_priority CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

CREATE TABLE service_group_policies (
  group_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '服务组唯一标识',
  display_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '服务组显示名称',
  default_priority VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'normal' COMMENT '新转入工单默认优先级',
  first_response_minutes INT NOT NULL COMMENT '首次人工响应时限，分钟',
  resolution_minutes INT NOT NULL COMMENT '工单解决时限，分钟',
  enabled TINYINT NOT NULL DEFAULT 1 COMMENT '服务组策略是否启用',
  created_at BIGINT NOT NULL COMMENT '创建时间戳，Unix毫秒',
  updated_at BIGINT NOT NULL COMMENT '更新时间戳，Unix毫秒',
  PRIMARY KEY (group_key),
  CONSTRAINT chk_service_policy_priority CHECK (default_priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT chk_service_policy_response CHECK (first_response_minutes > 0),
  CONSTRAINT chk_service_policy_resolution CHECK (resolution_minutes >= first_response_minutes),
  CONSTRAINT chk_service_policy_enabled CHECK (enabled IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='服务组工单优先级与SLA配置';

INSERT INTO service_group_policies (
  group_key, display_name, default_priority, first_response_minutes, resolution_minutes, enabled, created_at, updated_at
) VALUES
  ('default', '综合服务', 'normal', 30, 480, 1, UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000, UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000),
  ('IT', 'IT服务', 'normal', 30, 480, 1, UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000, UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000),
  ('人事', '人事服务', 'normal', 60, 1440, 1, UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000, UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000),
  ('行政', '行政服务', 'normal', 60, 1440, 1, UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000, UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000),
  ('财务', '财务服务', 'normal', 60, 1440, 1, UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000, UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000);
