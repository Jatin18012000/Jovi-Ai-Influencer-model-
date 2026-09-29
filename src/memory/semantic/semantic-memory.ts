import { overlapScore, tokenize } from '../text.js';

export interface SemanticDocument {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface SemanticMatch {
  id: string;
  score: number;
  text: string;
  metadata?: Record<string, unknown>;
}

/**
 * Semantic memory contract. Phase 6 ships a lexical baseline; a vector
 * implementation (e.g. sqlite-vec + local embeddings served by LM Studio) can replace
 * it later without touching callers.
 */
export interface SemanticMemory {
  readonly implementation: string;
  readonly isVectorBacked: boolean;
  index(document: SemanticDocument): Promise<void>;
  remove(id: string): Promise<void>;
  search(query: string, limit?: number): Promise<SemanticMatch[]>;
}

/**
 * In-process lexical baseline. NOT true semantic search — it is labeled as
 * such (`isVectorBacked: false`) so nothing downstream over-trusts it.
 */
export class KeywordSemanticMemory implements SemanticMemory {
  readonly implementation = 'keyword-baseline';
  readonly isVectorBacked = false;
  private readonly docs = new Map<string, SemanticDocument & { tokens: string[] }>();

  async index(document: SemanticDocument): Promise<void> {
    this.docs.set(document.id, { ...document, tokens: tokenize(document.text) });
  }

  async remove(id: string): Promise<void> {
    this.docs.delete(id);
  }

  async search(query: string, limit = 5): Promise<SemanticMatch[]> {
    const q = tokenize(query);
    return [...this.docs.values()]
      .map((d) => ({
        id: d.id,
        text: d.text,
        score: overlapScore(q, d.tokens),
        ...(d.metadata ? { metadata: d.metadata } : {}),
      }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
