# Agent Note: Persist Qabot embeddings by content and model identity

Status: implemented

English | [中文](2026-08-26-qabot-persistent-embedding-index.zh.md)

## Problem

Qabot stores knowledge chunks in SQLite and derives an embedding for semantic retrieval. Recreating the embedding table at process startup discards valid vectors, delays service readiness, and repeats paid provider calls even when neither the documents nor the configured model changed.

Text and visual embeddings also have different request formats and retrieval semantics. Storing them as interchangeable vectors would allow incompatible dimensions or models to enter one cosine search.

## Decision

The `embeddings` table persists in `kb.db`. Each text-vector row records the document id, serialized vector, SHA-256 content hash, embedding model identity, and `vector_kind = 'text'`. `embedMissing()` reuses a row only when its content hash and model identity match the current document and configuration. A changed remote model invalidates all text vectors; changed remote-model content invalidates only its affected chunks.

The local character TF-IDF model includes a deterministic corpus fingerprint in its model identity because IDF weights depend on every indexed chunk. Any local-corpus change therefore updates all local vectors. Rows from the earlier schema lack trustworthy model and content metadata and are recalculated once instead of being labeled with the current model without evidence.

Text retrieval selects only `vector_kind = 'text'`. The visual index persists downloaded Feishu images in `vision_assets`, stores `vector_kind = 'vision'` embeddings under the same document id, and calls the DashScope multimodal endpoint with `qwen3-vl-embedding` by configuration. Employee text queries are embedded by that visual model and compared only with current visual rows before the results join text retrieval. The `(doc_id, vector_kind)` key permits both representations without mixing their dimensions.

Visual retrieval runs only when the employee query explicitly requests a picture, chart, screenshot, photo, diagram, or comparable visual material. Its query vectors persist in `vision_query_cache`, keyed by the visual model identity and the SHA-256 hash of the normalized employee query. Repeated retrieval of the same query, including conversation polling and answer-media selection, reuses that vector. When a visual result is returned with an assistant message, `conversation_media` records the session id, assistant event sequence, document id, and rank. Conversation history therefore restores the same images without another model call, while image bytes remain in `vision_assets` and are delivered through an authenticated portal proxy.

Image synchronization treats the Feishu image token as the durable source identity. A token already present in `vision_assets` is not downloaded again. A 403 media response stops the remaining downloads for that document because the denial applies to the application or document permission rather than one image. `VISION_EMBED_MAX_PER_SYNC` limits the number of missing or invalid visual vectors created by one synchronization run; the content hash and visual model identity still determine which rows are eligible.

## Alternatives considered

- **Rebuild every vector at startup:** rejected because unchanged content produces identical provider work and makes availability depend on a full reindex.
- **Track only the document hash:** rejected because vectors from an earlier model or dimension remain incompatible after `EMBED_MODEL` changes.
- **Backfill legacy metadata with the current model name:** rejected because the stored vector's producer is unknown; relabeling it can silently mix models.
- **Use one vector kind for text and images:** rejected because multimodal APIs, dimensions, and ranking behavior differ from the current text-only `/embeddings` request.

## Consequences

Repeated startup with unchanged documents and model performs no embedding calls. Remote-model document updates recalculate only changed chunks, while a model change performs one deliberate refresh spread across synchronization runs by the configured limit. Local TF-IDF remains correct at the cost of a full refresh after any corpus change. Existing databases perform a one-time refresh of legacy rows. Configured visual ingestion downloads each Feishu image token once, retains its bytes for model changes, prunes images removed from the source document, and supports cross-modal text-to-image retrieval without exposing visual vectors to text cosine search. Repeated identical text-to-image queries reuse the persisted query vector, and returned images survive refresh through message-linked references. Visual ingestion requires Feishu media-download permission and a DashScope API key; without `VISION_EMBED_MODEL` it remains inactive.
