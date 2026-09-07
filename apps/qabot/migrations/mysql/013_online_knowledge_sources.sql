ALTER TABLE knowledge_sources
  ADD COLUMN service_group VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT '其他' COMMENT '后台维护归属：人事、行政、IT、财务或其他' AFTER owner_employee_id,
  ADD COLUMN submitter_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT '系统迁移' COMMENT '提交人真实姓名' AFTER service_group,
  ADD COLUMN sync_status VARCHAR(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'pending' COMMENT '同步状态：pending、syncing、ready或failed' AFTER enabled,
  ADD COLUMN last_synced_at DATETIME(3) NULL COMMENT '最后一次成功同步时间' AFTER sync_status,
  ADD COLUMN last_error TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '最后一次同步错误' AFTER last_synced_at,
  ADD COLUMN removed_at DATETIME(3) NULL COMMENT '软移除时间' AFTER last_error,
  ADD KEY idx_knowledge_sources_active (enabled, removed_at, service_group, sync_status),
  ADD CONSTRAINT chk_knowledge_sources_group CHECK (service_group IN ('人事', '行政', 'IT', '财务', '其他')),
  ADD CONSTRAINT chk_knowledge_sources_sync_status CHECK (sync_status IN ('pending', 'syncing', 'ready', 'failed'));

UPDATE knowledge_sources
SET owner_employee_id = COALESCE(owner_employee_id, 'system-migration'),
    submitter_name = '系统迁移',
    service_group = '其他',
    sync_status = CASE WHEN enabled = 1 THEN 'ready' ELSE 'failed' END,
    last_synced_at = CASE WHEN enabled = 1 THEN updated_at ELSE NULL END;
