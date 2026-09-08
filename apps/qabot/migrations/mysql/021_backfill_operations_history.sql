INSERT INTO qa_turn_analytics
(session_id,ticket_id,question,normalized_question,answer,service_group,knowledge_hit,knowledge_source_id,relevance,faq_id,created_at)
SELECT m.session_id,t.id,m.content,
  LOWER(REGEXP_REPLACE(m.content,'[[:space:]，。！？、；：,.!?;:''"“”‘’（）()【】\\[\\]]','')),
  COALESCE((SELECT a.content FROM conversation_messages a
    WHERE a.session_id=m.session_id AND a.role IN ('assistant','human') AND a.created_at>=m.created_at
    ORDER BY a.created_at,a.id LIMIT 1),''),
  COALESCE(t.analytics_domain,'其他'),
  EXISTS(SELECT 1 FROM conversation_messages a WHERE a.session_id=m.session_id AND a.role='assistant'
    AND a.created_at>=m.created_at AND (a.content LIKE '%参考文档%' OR JSON_LENGTH(a.media_json)>0)),
  NULL,NULL,NULL,m.created_at
FROM conversation_messages m
JOIN tickets t ON t.session_id=m.session_id
WHERE m.role='user' AND CHAR_LENGTH(TRIM(m.content))>=2
  AND TRIM(m.content) NOT IN ('你好','您好','在吗','谢谢','谢谢你','再见','好的','收到','转人工','人工服务','人工客服','测试','测试成功')
  AND m.content NOT LIKE '%回答测试成功%'
  AND NOT EXISTS(SELECT 1 FROM qa_turn_analytics q WHERE q.session_id=m.session_id AND q.created_at=m.created_at);

INSERT INTO qa_handoff_events
(session_id,ticket_id,event_type,trigger_question,reason_type,reason_text,service_group,created_at)
SELECT t.session_id,t.id,'selected',COALESCE((SELECT m.content FROM conversation_messages m
  WHERE m.session_id=t.session_id AND m.role='user' ORDER BY m.created_at DESC,m.id DESC LIMIT 1),t.question),
  '历史转人工',t.handoff_reason,
  CASE WHEN t.department IN ('人事','行政','IT','财务') THEN t.department ELSE '其他' END,
  COALESCE(t.service_start,t.updated_at)
FROM tickets t
WHERE (t.handoff_reason IS NOT NULL OR t.kind='human')
  AND NOT EXISTS(SELECT 1 FROM qa_handoff_events h WHERE h.session_id=t.session_id AND h.event_type='selected');
