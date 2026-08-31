CREATE TABLE knowledge_sources (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '知识来源内部自增ID',
  source_type VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '来源类型：手工、飞书文档、多维表格或知识库',
  source_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '外部来源稳定唯一标识',
  name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '知识来源名称',
  source_url VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '外部来源访问链接',
  owner_employee_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '知识负责人员工标识',
  enabled TINYINT NOT NULL DEFAULT 1 COMMENT '是否启用自动同步',
  created_at BIGINT NOT NULL COMMENT '创建时间戳，Unix毫秒',
  updated_at BIGINT NOT NULL COMMENT '更新时间戳，Unix毫秒',
  PRIMARY KEY (id),
  UNIQUE KEY uq_knowledge_sources_key (source_key),
  CONSTRAINT chk_knowledge_sources_enabled CHECK (enabled IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='知识来源配置';

CREATE TABLE knowledge_documents (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '知识文档内部自增ID',
  source_id BIGINT NOT NULL COMMENT '关联知识来源ID',
  external_document_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '来源内文档稳定标识',
  title VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '知识文档标题',
  owner_employee_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '文档负责人员工标识',
  confidentiality VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'internal' COMMENT '保密级别',
  created_at BIGINT NOT NULL COMMENT '创建时间戳，Unix毫秒',
  updated_at BIGINT NOT NULL COMMENT '更新时间戳，Unix毫秒',
  PRIMARY KEY (id),
  UNIQUE KEY uq_knowledge_documents_source (source_id, external_document_key),
  CONSTRAINT fk_knowledge_documents_source FOREIGN KEY (source_id) REFERENCES knowledge_sources (id),
  CONSTRAINT chk_knowledge_documents_confidentiality CHECK (confidentiality IN ('public', 'internal', 'restricted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='知识文档主记录';

CREATE TABLE knowledge_document_versions (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '知识文档版本内部自增ID',
  document_id BIGINT NOT NULL COMMENT '关联知识文档ID',
  version_no INT NOT NULL COMMENT '文档单调版本号',
  status VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'draft' COMMENT '版本状态：草稿、待审核、已发布、已归档或已拒绝',
  content_hash CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '规范化文档内容SHA256',
  source_url VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '该版本原文访问链接',
  effective_at BIGINT NULL COMMENT '版本生效时间戳，Unix毫秒',
  expires_at BIGINT NULL COMMENT '版本失效时间戳，Unix毫秒',
  created_by VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '版本创建人员工标识',
  created_at BIGINT NOT NULL COMMENT '创建时间戳，Unix毫秒',
  published_at BIGINT NULL COMMENT '发布时间戳，Unix毫秒',
  archived_at BIGINT NULL COMMENT '归档时间戳，Unix毫秒',
  PRIMARY KEY (id),
  UNIQUE KEY uq_knowledge_versions_no (document_id, version_no),
  UNIQUE KEY uq_knowledge_versions_hash (document_id, content_hash),
  KEY idx_knowledge_versions_status (status, effective_at, expires_at),
  CONSTRAINT fk_knowledge_versions_document FOREIGN KEY (document_id) REFERENCES knowledge_documents (id),
  CONSTRAINT chk_knowledge_versions_status CHECK (status IN ('draft', 'pending_review', 'published', 'archived', 'rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='知识文档版本';

CREATE TABLE knowledge_version_departments (
  version_id BIGINT NOT NULL COMMENT '关联知识文档版本ID',
  department_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '允许访问的部门标识',
  PRIMARY KEY (version_id, department_id),
  CONSTRAINT fk_knowledge_departments_version FOREIGN KEY (version_id) REFERENCES knowledge_document_versions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='知识版本适用部门';

CREATE TABLE knowledge_chunks (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '知识分块内部自增ID',
  version_id BIGINT NOT NULL COMMENT '关联知识文档版本ID',
  chunk_no INT NOT NULL COMMENT '版本内分块顺序号',
  content MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '分块文本内容',
  content_hash CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '分块内容SHA256',
  section_title VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '分块所属章节标题',
  page_no INT NULL COMMENT '分块所在页码',
  created_at BIGINT NOT NULL COMMENT '创建时间戳，Unix毫秒',
  PRIMARY KEY (id),
  UNIQUE KEY uq_knowledge_chunks_no (version_id, chunk_no),
  KEY idx_knowledge_chunks_hash (content_hash),
  CONSTRAINT fk_knowledge_chunks_version FOREIGN KEY (version_id) REFERENCES knowledge_document_versions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='知识文档文本分块';

CREATE TABLE knowledge_assets (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '知识资产内部自增ID',
  version_id BIGINT NOT NULL COMMENT '关联知识文档版本ID',
  asset_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '版本内资产稳定标识',
  asset_type VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '资产类型',
  mime_type VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '资产MIME类型',
  storage_url VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '资产存储访问地址',
  content_hash CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '资产内容SHA256',
  description TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '资产可检索文字说明',
  created_at BIGINT NOT NULL COMMENT '创建时间戳，Unix毫秒',
  PRIMARY KEY (id),
  UNIQUE KEY uq_knowledge_assets_key (version_id, asset_key),
  CONSTRAINT fk_knowledge_assets_version FOREIGN KEY (version_id) REFERENCES knowledge_document_versions (id) ON DELETE CASCADE,
  CONSTRAINT chk_knowledge_assets_type CHECK (asset_type IN ('image', 'file'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='知识文档图片和文件资产';

CREATE TABLE knowledge_embeddings (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '知识向量内部自增ID',
  target_type VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '向量目标类型：文本分块或资产',
  target_id BIGINT NOT NULL COMMENT '分块或资产内部ID',
  vector_kind VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '向量模态：文本或视觉',
  model_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '向量模型及版本标识',
  dimensions INT NOT NULL COMMENT '向量维度',
  content_hash CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '计算向量时的内容SHA256',
  vector_json JSON NOT NULL COMMENT '向量数值JSON数组',
  created_at BIGINT NOT NULL COMMENT '创建时间戳，Unix毫秒',
  updated_at BIGINT NOT NULL COMMENT '更新时间戳，Unix毫秒',
  PRIMARY KEY (id),
  UNIQUE KEY uq_knowledge_embeddings_target (target_type, target_id, vector_kind, model_key),
  KEY idx_knowledge_embeddings_hash (content_hash),
  CONSTRAINT chk_knowledge_embeddings_target CHECK (target_type IN ('chunk', 'asset')),
  CONSTRAINT chk_knowledge_embeddings_kind CHECK (vector_kind IN ('text', 'vision'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='知识文本与视觉向量';

CREATE TABLE knowledge_reviews (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '知识审核内部自增ID',
  version_id BIGINT NOT NULL COMMENT '关联知识文档版本ID',
  reviewer_employee_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '审核人员工标识',
  decision VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '审核决定：通过或拒绝',
  note TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '审核说明',
  created_at BIGINT NOT NULL COMMENT '审核时间戳，Unix毫秒',
  PRIMARY KEY (id),
  KEY idx_knowledge_reviews_version (version_id, id),
  CONSTRAINT fk_knowledge_reviews_version FOREIGN KEY (version_id) REFERENCES knowledge_document_versions (id),
  CONSTRAINT chk_knowledge_reviews_decision CHECK (decision IN ('approved', 'rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='知识版本审核记录';

CREATE TABLE knowledge_sync_jobs (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '知识同步任务内部自增ID',
  source_id BIGINT NOT NULL COMMENT '关联知识来源ID',
  idempotency_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '同步任务幂等键',
  status VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'pending' COMMENT '同步任务状态',
  documents_seen INT NOT NULL DEFAULT 0 COMMENT '本次发现文档数量',
  versions_created INT NOT NULL DEFAULT 0 COMMENT '本次创建待审核版本数量',
  last_error TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '最后一次失败原因',
  started_at BIGINT NULL COMMENT '任务开始时间戳，Unix毫秒',
  completed_at BIGINT NULL COMMENT '任务完成时间戳，Unix毫秒',
  created_at BIGINT NOT NULL COMMENT '创建时间戳，Unix毫秒',
  PRIMARY KEY (id),
  UNIQUE KEY uq_knowledge_sync_jobs_key (idempotency_key),
  KEY idx_knowledge_sync_jobs_source (source_id, id DESC),
  CONSTRAINT fk_knowledge_sync_jobs_source FOREIGN KEY (source_id) REFERENCES knowledge_sources (id),
  CONSTRAINT chk_knowledge_sync_jobs_status CHECK (status IN ('pending', 'running', 'completed', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='知识来源同步任务';
