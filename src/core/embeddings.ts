// src/core/embeddings.ts
//
// Fully local embeddings via Xenova Transformers.js (multilingual-e5-small,
// 384-dim). No API, no network at inference time, multilingual (Japanese OK).

/* eslint-disable @typescript-eslint/no-explicit-any */
let pipelineInstance: any = null;
let loadingPromise: Promise<any> | null = null;

async function getEmbeddingPipeline() {
  if (pipelineInstance) return pipelineInstance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const { pipeline } = await import("@xenova/transformers");
    pipelineInstance = await pipeline(
      "feature-extraction",
      "Xenova/multilingual-e5-small"
    );
    return pipelineInstance;
  })();

  pipelineInstance = await loadingPromise;
  loadingPromise = null;
  return pipelineInstance;
}

async function embed(text: string): Promise<Float32Array> {
  const extractor = await getEmbeddingPipeline();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return new Float32Array(output.data);
}

/** Embed text for storage. e5 requires the "passage: " prefix. */
export async function embedPassage(text: string): Promise<Float32Array> {
  return embed(`passage: ${text}`);
}

/** Embed text for search. e5 requires the "query: " prefix. */
export async function embedQuery(text: string): Promise<Float32Array> {
  return embed(`query: ${text}`);
}
