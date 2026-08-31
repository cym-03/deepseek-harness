ALTER TABLE tickets
  DROP INDEX idx_tickets_sla,
  DROP CHECK chk_tickets_priority,
  DROP COLUMN first_agent_response_at,
  DROP COLUMN resolution_due_at,
  DROP COLUMN first_response_due_at,
  DROP COLUMN priority;

DROP TABLE service_group_policies;
