ALTER TABLE tickets
  ADD COLUMN satisfaction_comment TEXT NULL COMMENT '员工满意度文字评价，可为空' AFTER satisfaction;
