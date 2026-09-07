UPDATE knowledge_documents child_document
JOIN knowledge_sources child_source ON child_source.id = child_document.source_id
JOIN knowledge_sources parent_source
  ON parent_source.source_key = SUBSTRING_INDEX(child_source.source_key, ':board-text:', 1)
JOIN knowledge_documents parent_document ON parent_document.source_id = parent_source.id
  AND parent_document.external_document_key = child_document.external_document_key
SET child_document.external_document_key = CONCAT(child_document.external_document_key, ':legacy-duplicate:', child_document.id),
    child_document.publication_status = 'offline',
    child_document.updated_at = NOW(3)
WHERE child_source.source_key LIKE '%:board-text:%'
  AND child_source.id <> parent_source.id;

UPDATE knowledge_documents child_document
JOIN knowledge_sources child_source ON child_source.id = child_document.source_id
JOIN knowledge_sources parent_source
  ON parent_source.source_key = SUBSTRING_INDEX(child_source.source_key, ':board-text:', 1)
SET child_document.source_id = parent_source.id,
    child_document.updated_at = NOW(3)
WHERE child_source.source_key LIKE '%:board-text:%'
  AND child_source.id <> parent_source.id;

UPDATE knowledge_sources
SET enabled = 0,
    sync_status = 'failed',
    last_error = '派生画板文字已归并到原始知识源',
    removed_at = COALESCE(removed_at, NOW(3)),
    updated_at = NOW(3)
WHERE source_key LIKE '%:board-text:%';
