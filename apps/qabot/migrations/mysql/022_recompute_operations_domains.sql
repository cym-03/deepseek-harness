UPDATE tickets t
SET analytics_domain = COALESCE(
  (SELECT h.service_group FROM qa_handoff_events h
   WHERE h.session_id = t.session_id AND h.event_type = 'selected'
   ORDER BY h.created_at DESC, h.id DESC LIMIT 1),
  (SELECT q.service_group FROM qa_turn_analytics q
   WHERE q.session_id = t.session_id AND q.faq_id IS NOT NULL
   ORDER BY q.created_at DESC, q.id DESC LIMIT 1),
  (SELECT q.service_group FROM qa_turn_analytics q
   WHERE q.session_id = t.session_id AND q.knowledge_source_id IS NOT NULL AND q.relevance IS NOT NULL
   ORDER BY q.relevance DESC, q.created_at DESC, q.id DESC LIMIT 1),
  CASE WHEN t.department IN ('人事', '行政', 'IT', '财务') THEN t.department ELSE '其他' END
);
