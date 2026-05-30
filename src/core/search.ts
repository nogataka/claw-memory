// src/core/search.ts
//
// Token-efficient layered search (claude-mem-style). search() returns a light
// index of ids+titles; callers fetch full bodies with getChunksByIds() only for
// the entries they care about.

import { embedQuery } from "./embeddings.js";
import {
  searchSimilar,
  searchKeyword,
  type ChunkRow,
  type ChunkFilter,
} from "./vector-memory.js";

export interface SearchHit {
  id: string;
  title: string;
  date: string;
  source: "semantic" | "keyword";
  obsType: string | null;
  distance?: number;
}

const MAX_DISTANCE = Number(process.env.MEMORY_SIMILARITY_MAX_DISTANCE ?? 0.6);

/**
 * Hybrid search: semantic (vector) first, augmented with FTS5 keyword hits so
 * exact-token queries that embeddings miss still surface. De-duplicated by id.
 * Optional metadata filters (type / concept / file / date) narrow both passes.
 */
export async function searchIndex(
  projectId: string,
  query: string,
  limit = 8,
  filter?: ChunkFilter
): Promise<SearchHit[]> {
  const hits = new Map<string, SearchHit>();

  if (query.trim()) {
    try {
      const emb = await embedQuery(query);
      for (const c of searchSimilar(emb, projectId, limit, MAX_DISTANCE, filter)) {
        hits.set(c.id, toHit(c, "semantic", c.distance));
      }
    } catch (err) {
      console.error("[claw-memory] semantic search failed:", err);
    }
    for (const c of searchKeyword(query, projectId, limit, filter)) {
      if (!hits.has(c.id)) hits.set(c.id, toHit(c, "keyword"));
    }
  }

  return [...hits.values()]
    .sort((a, b) => (a.distance ?? 1) - (b.distance ?? 1))
    .slice(0, limit);
}

function toHit(
  c: ChunkRow & { distance?: number },
  source: SearchHit["source"],
  distance?: number
): SearchHit {
  const title = c.userText.replace(/\s+/g, " ").slice(0, 80);
  return {
    id: c.id,
    title,
    date: c.createdAt.split("T")[0],
    source,
    obsType: c.obsType,
    distance,
  };
}
