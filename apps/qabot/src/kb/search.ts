import type { KbMediaRef } from './store.ts'

/** Minimal knowledge retrieval API shared by the model tool and HTTP routing. */
export interface KnowledgeSearch {
  search(query: string, limit?: number): Promise<string>
  hasRelevantContent(query: string): Promise<boolean>
}

export interface KnowledgeVisionStatus {
  configured: boolean
  model: string | null
  assets: number
  embeddings: number
  cachedQueries: number
  returnedImages: number
}

/** MySQL-capable visual retrieval used by employee chat and asset delivery. */
export interface KnowledgeMediaSearch {
  findVisionMedia(query: string, limit?: number): Promise<KbMediaRef[]>
  visionAsset(id: number): Promise<{ mime: string; image: Buffer } | undefined>
  visionStatus(): Promise<KnowledgeVisionStatus>
}
