UPDATE knowledge_document_versions AS stale_version
JOIN (
  SELECT document_id, MAX(version_no) AS current_version_no
  FROM knowledge_document_versions
  WHERE status = 'published'
  GROUP BY document_id
  HAVING COUNT(*) > 1
) AS current_version
  ON current_version.document_id = stale_version.document_id
SET stale_version.status = 'archived',
    stale_version.archived_at = COALESCE(stale_version.archived_at, NOW(3))
WHERE stale_version.status = 'published'
  AND stale_version.version_no <> current_version.current_version_no;
