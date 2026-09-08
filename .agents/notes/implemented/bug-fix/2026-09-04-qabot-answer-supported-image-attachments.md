# Agent Note: Attach images named by Qabot answers

Status: implemented

English | [中文](2026-09-04-qabot-answer-supported-image-attachments.zh.md)

## Problem

Visual retrieval scored only the employee question. An answer could identify captioned images from text retrieval while the visual query selected only a related board, so the message named images that its attachment list omitted.

## Decision

Qabot keeps the question-based visual-vector search and then prepends eligible active assets whose explicit image caption or board title appears in the generated answer. Automatic results may come from any active source, but a board title must share a specific, non-generic topic with the employee question and its OCR text must contain that same topic. The answer can rank an eligible board but cannot introduce another topic. An explicit employee-lifecycle question accepts only a board titled with the same lifecycle stage. Results require a strong score of `0.45`, or two captioned results above `0.40` whose scores differ by at most `0.02`; explicit answer mentions remain eligible below those thresholds but still pass topic and OCR checks. The deterministic merge reuses the existing asset rows and query vector, deduplicates by asset ID, preserves mention order, and applies the configured result limit.

Text retrieval requests more candidates than it returns, moves OCR-backed board content ahead of other selected rows, and removes a board placeholder when the same candidate set contains OCR text for that board. The system prompt requires the model to use recognized board text and prohibits describing that board as unparsed.

Generic document-image labels do not qualify as mentions because a cited document title can belong to many uncaptioned images. The assistant text is used only to select already-indexed assets; it does not trigger another embedding request.

## Alternatives considered

- **Embed the complete generated answer:** rejected because every distinct answer would consume another visual-query request and create a low-value cache entry.
- **Lower the global visual similarity threshold:** rejected because unrelated images from the same handbook would return for ordinary questions.
- **Trust only the original question:** rejected because text retrieval can identify exact captioned assets that the broader question does not name.

## Consequences

An answer that names a captioned image displays that image before high-confidence vector-only matches, and available board OCR text takes precedence over its placeholder. A process diagram that overlaps only through generic terms such as “application,” “approval,” or “process,” weakly related assets, and generic unlabeled assets remain excluded. Relevant images from another source remain eligible. Each employee question still performs at most the existing cached visual-query lookup or one visual embedding request.
