UPDATE tickets
SET assignee = NULL,
  updated_at = UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000,
  version = version + 1
WHERE status = 'waiting_agent'
  AND assignee IS NOT NULL;
