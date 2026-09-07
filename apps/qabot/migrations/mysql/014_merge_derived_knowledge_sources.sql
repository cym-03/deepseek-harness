UPDATE knowledge_documents child_document
JOIN knowledge_sources child_source ON child_source.id = child_document.source_id
JOIN knowledge_sources parent_source ON parent_source.source_key = CASE
  WHEN child_source.source_key LIKE '%:img:%' THEN SUBSTRING_INDEX(child_source.source_key, ':img:', 1)
  WHEN child_source.source_key LIKE '%:vision:%' THEN SUBSTRING_INDEX(child_source.source_key, ':vision:', 1)
  WHEN child_source.source_key LIKE '%:image' THEN LEFT(child_source.source_key, LENGTH(child_source.source_key) - LENGTH(':image'))
  ELSE child_source.source_key
END
SET child_document.source_id = parent_source.id
WHERE child_source.id <> parent_source.id;

DELETE child_source
FROM knowledge_sources child_source
LEFT JOIN knowledge_documents child_document ON child_document.source_id = child_source.id
WHERE child_document.id IS NULL
  AND (child_source.source_key LIKE '%:img:%'
    OR child_source.source_key LIKE '%:vision:%'
    OR child_source.source_key LIKE '%:image');
