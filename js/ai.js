// js/ai.js

let embeddingModel = null;

/**
 * Load MiniLM embedding model using feature-extraction pipeline.
 */
export async function loadModel() {
  if (!embeddingModel) {
    const { pipeline } = window.transformers;
    embeddingModel = await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2'
    );
  }
}

function averageVectors(vectors) {
  const length = vectors[0].length;
  const sum = new Array(length).fill(0);

  for (const vec of vectors) {
    for (let i = 0; i < length; i++) {
      sum[i] += vec[i];
    }
  }

  return sum.map(val => val / vectors.length);
}


/**
 * Process a journal entry: generate summary and embedding.
 * @param {string} text
 * @returns {Promise<{summary: string, embedding: number[]}>}
 */
export async function processEntry(text) {
  await loadModel();

  const result = await embeddingModel(text); // result = Proxy with .data
  const flat = result.data; // Float32Array(16896)
  const numTokens = result.dims[1]; // 44
  const dim = result.dims[2]; // 384

  // Reconstruct token vectors
  const tokenEmbeddings = [];
  for (let i = 0; i < numTokens; i++) {
    const start = i * dim;
    const slice = flat.slice(start, start + dim);
    tokenEmbeddings.push(Array.from(slice));
  }

  const embedding = averageVectors(tokenEmbeddings);
  const summary = text.split('. ')[0].trim().slice(0, 80);

  return {
    summary,
    embedding
  };
}



/**
 * Compute cosine similarity between two embedding vectors.
 */
function cosineSimilarity(vecA, vecB) {
  const dot = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const normA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const normB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return dot / (normA * normB);
}

/**
 * Score relevance based on cosine similarity of embeddings.
 */
export function scoreRelevance(newEntry, pastEntry) {
  if (
    !Array.isArray(newEntry.embedding) ||
    !Array.isArray(pastEntry.embedding)
  ) {
    console.warn("Missing or invalid embeddings:", { newEntry, pastEntry });
    return 0;
  }

  return cosineSimilarity(newEntry.embedding, pastEntry.embedding);
}
