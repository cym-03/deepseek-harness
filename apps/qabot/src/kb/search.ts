/** Minimal knowledge retrieval API shared by the model tool and HTTP routing. */
export interface KnowledgeSearch {
  search(query: string, limit?: number): Promise<string>
  hasRelevantContent(query: string): Promise<boolean>
}
