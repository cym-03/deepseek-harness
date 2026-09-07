# Agent Note: Keep derived knowledge documents under their submitted online source

Status: implemented

English | [中文](2026-09-04-derived-knowledge-documents-belong-to-online-source.zh.md)

## Problem

Board OCR creates searchable text documents whose stable keys append `:board-text:<token>` to the submitted Feishu source key. MySQL projection treated those documents as independent knowledge sources. The source page and five-minute scheduler therefore exposed and synchronized internal OCR records that had no submitter identity, while removing the submitted document could leave its derived text eligible for retrieval.

## Decision

The MySQL projection maps board text, document images, and visual assets to the submitted source key used by the [online-source lifecycle](../architecture/2026-09-02-qabot-online-knowledge-sources.md). A migration moves existing board-text documents to that parent source and soft-removes the accidental source rows. If the parent already contains the same document key, the migrated duplicate remains offline under a collision-free historical key.

The migration changes ownership metadata only. Existing chunks, assets, and embeddings remain attached to their document versions, so cleanup does not invoke embedding or vision providers.

## Alternatives considered

**Hide derived rows only in the source page.** Rejected because the scheduler, retrieval filter, and source removal behavior would still treat them as independent sources.

**Delete the derived documents and regenerate them.** Rejected because it would discard valid OCR text and vectors and spend model quota rebuilding unchanged data.

**Manage each board as an online source.** Rejected because boards inherit the submitted document's access, synchronization, and removal lifecycle rather than having independent submitters or URLs.

## Consequences

The source registry contains only submitted online documents, and one scheduled synchronization covers all text and media derived from each document. Removing a source excludes its board OCR content with the rest of the source. Historical accidental source rows remain soft-removed for traceability, while their usable documents and vectors belong to the active parent.
