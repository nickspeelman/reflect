// js/ai.js



let embeddingModel = null;
let embeddingModelPromise = null;

export async function loadModel() {
  if (embeddingModel) return embeddingModel;
  if (embeddingModelPromise) return embeddingModelPromise;

  const { pipeline } = window.transformers;

  embeddingModelPromise = pipeline(
    'feature-extraction',
    'Xenova/all-MiniLM-L6-v2',
    { quantized: true } // must match the ONNX file you included
  ).then(p => (embeddingModel = p))
   .catch(e => { embeddingModelPromise = null; throw e; });

  return embeddingModelPromise;
}


// ai.js (hardened local sentiment loader)
let _sentClf = null;
let _sentClfPromise = null;

export function ensureSentimentClassifier() {
  if (_sentClf) return Promise.resolve(_sentClf);
  if (_sentClfPromise) return _sentClfPromise;

  const tf = window.transformers;
  if (!tf) return Promise.reject(new Error('transformers library not loaded'));
  const { env, pipeline } = tf;

  // --- WASM runtime (must 200 for ort-wasm*.wasm) ---
  if (env?.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = '/vendor/transformers-2.17.2/dist/';
    console.log('wasmPaths:', env.backends.onnx.wasm.wasmPaths);
  }

  // --- Local models under /models/<repo_id>/** ---
  env.allowRemoteModels = false;
  env.localModelPath = '/models';

  const MODEL_ID = 'Xenova/distilbert-base-uncased-finetuned-sst-2-english';
  const root = `${env.localModelPath.replace(/\/$/, '')}/${MODEL_ID}`;
  console.log('root:', root);

  const check = async (url) => {
    const r = await fetch(url);
    const bytes = r.ok ? (await r.arrayBuffer()).byteLength : 0;
    console.log(`[check] ${url} -> ${r.status} (${bytes} bytes)`);
    return r.ok;
  };

  _sentClfPromise = (async () => {
    // Ensure required files exist
    const okCfg = await check(`${root}/config.json`);
    const okTok = await check(`${root}/tokenizer.json`); // or swap to vocab.txt/merges.txt if that’s your setup
    const okOnnx = await check(`${root}/onnx/model.onnx`); // <-- ONLY model.onnx

    if (!okCfg) throw new Error(`Missing config.json at ${root}/config.json`);
    if (!okTok) throw new Error(`Missing tokenizer.json at ${root}/tokenizer.json`);
    if (!okOnnx) throw new Error(`Missing ONNX at ${root}/onnx/model.onnx`);

    // Create pipeline, explicitly full precision
    const clf = await pipeline('text-classification', MODEL_ID, {
      quantized: false, // <-- force model.onnx
      progress_callback: (x) => console.log('[sentiment model]', x),
    });

    _sentClf = clf;
    return clf;
  })();

  _sentClfPromise = _sentClfPromise.catch(err => {
    console.error('[ensureSentimentClassifier] init failed:', err);
    _sentClfPromise = null;
    throw err;
  });

  return _sentClfPromise;
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

// ========== Phase 1: Summary v2 with Aggregated Facets ==========

// Keep these module-level caches so we only embed anchors once
const _anchorVecCache = {};

// --- Public API ---

/**
 * Attach Summary v2 + Facets to an entry (non-destructive).
 * Adds: entry.summary_v2, entry.summary_v2_method, entry.summary_facets
 */
export async function attachSummaryV2(entry, opts = {}) {
  const text = (entry?.response || "").trim();
  if (!text) {
    entry.summary_v2 = "";
    entry.summary_v2_method = "empty";
    entry.summary_facets = makeEmptyFacetReport();
    return entry;
  }
  const s = await summarizeV2WithFacets(text, opts);
  entry.summary_v2 = s.text;
  entry.summary_v2_method = s.method;
  entry.summary_facets = s.facets;     // { facets:[...], top:"", scores:{...} }
  // optional: keep old summary field aligned
  entry.summary = entry.summary_v2;
  return entry;
}

/**
 * Build a short extractive summary AND facet strengths from all sentences.
 */
export async function summarizeV2WithFacets(text, {
  maxChars = 220,
  allowTwoSentences = true,
  mmrLambda = 0.75,          // λ for relevance vs diversity when picking 2nd sentence
  positionBonus = 0.03       // slight bonus for earlier sentences
} = {}) {

  const cleaned = normalizeWhitespace(text);
  const sents = splitSentences(cleaned);
  if (sents.length === 0) {
    return { text: "", method: "empty", facets: makeEmptyFacetReport() };
  }

  // Ensure model ready
  await ensureEmbeddingModel();

  // Embed sentences (mean-pooled) and compute centroid + salience
  const sentVecs = [];
  for (const s of sents) sentVecs.push(await embedTextMean(s));
  const centroid = meanVec(sentVecs);

  // Normalize salience into [0,1]
  const rawSal = sentVecs.map(v => cosineSim(v, centroid));
  const saliences = normalize01(rawSal);

  // ---------- Facets over ALL sentences ----------
  const facetReport = await computeAggregatedFacets(sents, sentVecs, saliences);

  // ---------- Extractive summary (1–2 sentences) ----------
  // base relevance = cosine to centroid + position bonus
  const baseScores = sentVecs.map((v, i) => cosineSim(v, centroid) + positionBonus * (1 - i / sents.length));

  // 1st pick
  let firstIdx = argMax(baseScores);
  const chosen = [firstIdx];

  // Optional 2nd pick via MMR
  if (allowTwoSentences && sents.length > 1) {
    let bestIdx = -1, best = -Infinity;
    for (let i = 0; i < sents.length; i++) {
      if (i === firstIdx) continue;
      const rel = baseScores[i];
      const simToChosen = cosineSim(sentVecs[i], sentVecs[firstIdx]);
      const mmr = mmrLambda * rel - (1 - mmrLambda) * simToChosen;
      if (mmr > best) { best = mmr; bestIdx = i; }
    }
    if (bestIdx !== -1) chosen.push(bestIdx);
    chosen.sort((a,b)=>a-b); // chronological
  }

  // Build final summary under char budget
  let out = "";
  for (const idx of chosen) {
    const next = sents[idx].trim();
    if (!next) continue;
    const candidate = out ? `${out} ${next}` : next;
    if (candidate.length <= maxChars) out = candidate; else break;
  }
  if (!out) out = clampToChars(sents[firstIdx], maxChars);

  return {
    text: out,
    method: chosen.length === 2 ? "extractive+mmr" : "extractive",
    facets: facetReport
  };
}

// --- Facet engine (sentence-level → entry-level) ---

const FACETS = ["feeling","event","intent"];

// Short, general anchors per facet (kept tiny on purpose)
const FACET_ANCHORS = {
  feeling: [
    "I feel", "I'm feeling", "the emotion I'm noticing",
    "I am anxious", "I am hopeful", "I am grateful", "I feel calm", "I feel overwhelmed"
  ],
  event: [
    "Today I", "I started", "I finished", "I met", "I called", "I decided",
    "It happened", "The meeting ended", "I ran", "I wrote"
  ],
  intent: [
    "I will", "I plan to", "I'm going to", "next step", "first step",
    "today I'll", "my goal is", "I intend to"
  ]
};

// Tiny lexical cues (dozens, not hundreds)
const FEELING_WORDS = ["anxious","anxiety","hopeful","grateful","tired","energized","angry","sad","calm","excited","overwhelmed","nervous","confident","peaceful","lonely","stressed","worried","relieved","proud"];
const EVENT_VERBS  = ["met","called","finished","started","planned","decided","wrote","emailed","talked","visited","learned","presented","cooked","ran","walked","published","shipped","fixed","broke","launched"];
const INTENT_PATTERNS = [
  /\b(i (will|plan to|intend to|am going to))\b/i,
  /\b(next|first) step\b/i,
  /\bgoal\b/i,
  /\btomorrow\b/i,
  /\btoday i('|’)ll\b/i
];

function makeEmptyFacetReport() {
  return {
    facets: FACETS.map(f => ({ facet: f, score: 0, evidence: [] })),
    top: null,
    scores: { feeling:0, event:0, intent:0 }
  };
}

/**
 * Compute facet strengths by scoring each sentence, then salience-weighted aggregation.
 * Returns: { facets:[{facet, score, evidence:[{text, weight, idx}]}], top, scores:{...} }
 */
async function computeAggregatedFacets(sentences, sentVecs, saliences) {
  // Precompute anchors
  const anchorSets = {};
  for (const facet of FACETS) {
    anchorSets[facet] = await getAnchorVecs(facet, FACET_ANCHORS[facet]);
  }

  // Per-sentence facet strengths
  // strength = α * (max anchor cosine) + β * lexical cues + γ * context bonus
  const ALPHA = 0.35, BETA = 0.15, GAMMA = 0.5;

  const perSentence = sentences.map((sent, i) => {
    const vec = sentVecs[i];
    const row = { idx:i, text:sent, sal: saliences[i], scores: {feeling:0,event:0,intent:0} };

    // Anchor similarities
    for (const facet of FACETS) {
      const anchors = anchorSets[facet];
      let maxCos = 0;
      for (const av of anchors) {
        const c = cosineSim(vec, av);
        if (c > maxCos) maxCos = c;
      }

      // Lexical cues
      let lex = 0;
      if (facet === "feeling") {
        const t = sent.toLowerCase();
        let hits = 0;
        for (const w of FEELING_WORDS) if (t.includes(w)) hits++;
        lex = Math.min(1, hits / 3); // soft cap
      } else if (facet === "event") {
        const t = sent.toLowerCase();
        let hits = 0;
        for (const v of EVENT_VERBS) if (t.includes(v)) hits++;
        // also give a tiny bump to ! or past-tense-ish endings
        const extra = /!/.test(sent) || /\b\w+ed\b/.test(t) ? 0.2 : 0;
        lex = Math.min(1, hits / 3 + extra);
      } else if (facet === "intent") {
        const t = sent;
        let hits = 0;
        for (const re of INTENT_PATTERNS) if (re.test(t)) hits++;
        lex = Math.min(1, hits / 2);
      }

      // Context bonuses (tiny)
      let ctx = 0;
      if (facet === "intent" && /\b(next week|tomorrow|later today|soon)\b/i.test(sent)) ctx += 0.4;
      if (facet === "event"  && /\b(today|yesterday|this morning|this afternoon)\b/i.test(sent)) ctx += 0.3;
      if (facet === "feeling" && /(?:but|however|still)\b/i.test(sent)) ctx += 0.2; // emotional contrast often shows up with conjunctions

      const strength = clamp01(ALPHA * maxCos + BETA * lex + GAMMA * ctx);

      row.scores[facet] = strength;
    }

    return row;
  });

  // Aggregate to entry-level by salience-weighting
  const agg = { feeling:0, event:0, intent:0 };
  const contrib = { feeling:[], event:[], intent:[] };

  for (const s of perSentence) {
    for (const facet of FACETS) {
      const w = s.sal * s.scores[facet];
      agg[facet] += w;
      if (w > 0) contrib[facet].push({ idx: s.idx, text: s.text, weight: w });
    }
  }

  // Normalize across facets to 0..1 (relative strengths)
  const maxScore = Math.max(agg.feeling, agg.event, agg.intent, 1e-6);
  const norm = {
    feeling: agg.feeling / maxScore,
    event:   agg.event   / maxScore,
    intent:  agg.intent  / maxScore
  };

  // Pick evidence sentences (top 1–2 per facet)
  const evidence = {};
  for (const facet of FACETS) {
    const sorted = contrib[facet].sort((a,b)=>b.weight-a.weight).slice(0,2);
    evidence[facet] = sorted;
  }

  // Assemble report
  const facets = FACETS.map(f => ({
    facet: f,
    score: round2(norm[f]),
    evidence: evidence[f]
  }));
  const top = facets.slice().sort((a,b)=>b.score-a.score)[0]?.facet ?? null;

  return { facets, top, scores: norm };
}

// --- Embedding helpers ---

// --- Embedding helpers (replace both functions with these) ---

async function ensureEmbeddingModel() {
  // Reuse your existing loader so the model is created exactly once
  await loadModel(); // this sets the module-scoped `embeddingModel`
}

async function embedTextMean(text) {
  // Call the model the same way `processEntry` does (no special options)
  const out = await embeddingModel(text);

  // Case 1: Your current format: object with .data (flat Float32Array) and .dims [1, numTokens, dim]
  if (out && out.data && out.dims && out.dims.length >= 3) {
    const flat = out.data;
    const numTokens = out.dims[1];
    const dim = out.dims[2];
    const tokenEmbeddings = [];
    for (let i = 0; i < numTokens; i++) {
      const start = i * dim;
      const slice = flat.slice(start, start + dim);
      tokenEmbeddings.push(Array.from(slice));
    }
    // Use your existing averager for consistency
    return averageVectors(tokenEmbeddings);
  }

  // Case 2: Nested array (some Transformers.js configs return [[...],[...],...])
  const candidate = Array.isArray(out) ? out : out?.tensor || out?.data || out;
  if (Array.isArray(candidate) && Array.isArray(candidate[0])) {
    return meanPool(candidate);
  }

  // Case 3: Already a single vector
  if (Array.isArray(candidate) && typeof candidate[0] === 'number') {
    return candidate;
  }

  console.warn('[embedTextMean] Unrecognized model output shape:', out);
  return [];
}

async function getAnchorVecs(facet, phrases) {
  if (_anchorVecCache[facet]) return _anchorVecCache[facet];
  const vecs = [];
  for (const p of phrases) vecs.push(await embedTextMean(p));
  _anchorVecCache[facet] = vecs;
  return vecs;
}

// --- Small math + text utils ---

function meanPool(tokenVectors) {
  const dims = tokenVectors?.[0]?.length || 0;
  const acc = new Array(dims).fill(0);
  let n = 0;
  for (const tv of tokenVectors || []) {
    if (!tv || tv.length !== dims) continue;
    for (let d=0; d<dims; d++) acc[d]+=tv[d];
    n++;
  }
  if (n===0) return acc;
  for (let d=0; d<dims; d++) acc[d]/=n;
  return acc;
}
function meanVec(vecs) {
  if (!vecs.length) return [];
  const dims = vecs[0].length, acc = new Array(dims).fill(0);
  for (const v of vecs) for (let d=0; d<dims; d++) acc[d]+=v[d];
  for (let d=0; d<dims; d++) acc[d]/=vecs.length;
  return acc;
}
function cosineSim(a,b){
  let dot=0, na=0, nb=0;
  const n = Math.min(a.length, b.length);
  for (let i=0;i<n;i++){ dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; }
  if (na===0||nb===0) return 0;
  return dot/(Math.sqrt(na)*Math.sqrt(nb));
}
function argMax(arr){ let i0=0, best=-Infinity; for (let i=0;i<arr.length;i++) if (arr[i]>best){best=arr[i]; i0=i;} return i0; }
function normalizeWhitespace(s){ return s.replace(/\s+/g," ").trim(); }
function splitSentences(text){
  const out = text.split(/(?<=[.?!])\s+(?=[A-Z(“"'])/).map(s=>s.trim()).filter(Boolean);
  return out.length ? out : [text];
}
function clampToChars(s,max){ if (s.length<=max) return s; const soft=s.slice(0,max).replace(/[,;:]\s+\S*$/,"").trim(); return soft.length>=max*0.6?soft:s.slice(0,max).trim(); }
function normalize01(arr){
  if (!arr.length) return arr;
  const min = Math.min(...arr), max = Math.max(...arr);
  if (max - min < 1e-9) return arr.map(_=>0.5);
  return arr.map(v => (v - min) / (max - min));
}
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function round2(x){ return Math.round(x*100)/100; }

// --- Quick console tests ---

/**
 * Smoke test: run in DevTools -> await window.runFacetSelfTest()
 */
export async function runFacetSelfTest(){
  const samples = [
    `I feel scattered but hopeful about fall routines. I sketched a schedule that fits. Evenings are the sticking point when my energy is low.`,
    `Calls went better than expected once I started. My heart still races beforehand. Tomorrow I’ll draft the outline before I can overthink.`,
    `Got the promotion! I’m proud and a little nervous. Next step: meet the team and map the first 30 days.`
  ];
  for (const s of samples){
    const out = await summarizeV2WithFacets(s, { allowTwoSentences: true });
    // Show core signals
    console.log({
      input: s,
      summary_v2: out.text,
      method: out.method,
      facet_top: out.facets.top,
      facet_scores: out.facets.scores,
      evidence_feeling: out.facets.facets.find(f=>f.facet==='feeling')?.evidence?.map(e=>e.text),
      evidence_event:   out.facets.facets.find(f=>f.facet==='event')?.evidence?.map(e=>e.text),
      evidence_intent:  out.facets.facets.find(f=>f.facet==='intent')?.evidence?.map(e=>e.text)
    });
  }
  return "✅ facet self-test complete (see console)";
}

// ========== Phase 2: Emergent Themes (multi-tag, incremental) ==========

// Tunables
const THEME_JOIN_THRESHOLD = 0.78;   // assign sentence to a theme if >= this cosine
const THEME_MERGE_THRESHOLD = 0.87;  // merge themes if centroids this close
const THEME_EMA_ALPHA = 0.2;         // recency weight when updating centroids
const THEME_K = 3;                   // max nearest themes per sentence
const ENTRY_TAG_LIMIT = 4;           // keep top N tags per entry
const ENTRY_TAG_FLOOR = 0.25;        // drop tags below this (after normalize)

// Public API: assign themes for one entry and update theme list (no persistence here)
export async function assignThemesForEntry(entry, existingThemes = []) {
  const text = (entry?.response || "").trim();
  if (!text) return { entryTags: [], themes: existingThemes };

  await ensureEmbeddingModel();

  // 1) Sentence vectors + salience
  const sents = splitSentences(text);
  const sentVecs = [];
  for (const s of sents) sentVecs.push(await embedTextMean(s));
  const centroid = meanVec(sentVecs);
  const sal = normalize01(sentVecs.map(v => cosineSim(v, centroid)));

  // 2) For each sentence, find up to K nearest themes above threshold
  const themes = cloneThemes(existingThemes);
  const sentenceAssignments = []; // [{idx, themeId, weight}]
  for (let i = 0; i < sentVecs.length; i++) {
    const v = sentVecs[i];

    // rank themes by cosine
    const sims = themes.map(t => ({ id: t.id, idx: t._idx, cos: cosineSim(v, t.centroid) }))
                       .sort((a,b)=>b.cos-a.cos);

    const matches = sims.filter(x => x.cos >= THEME_JOIN_THRESHOLD).slice(0, THEME_K);

    if (matches.length === 0) {
      // create a new theme seeded by this sentence
    // create a new theme seeded by this sentence, name it via LLM (fallback to default)
    const id = crypto.randomUUID();
    const centroid0 = normalizeVec(v);

    let themeLabel = null;
    let themeAlias = null;
    let themeDesc  = null;
    try {
      const named = await llmLabelTheme([sents[i]]);
      themeLabel = named.label || null;
      themeAlias = named.alias || null;
      themeDesc  = named.description || null;
    } catch { /* keep nulls; we'll fallback below */ }

    // Fallback if LLM not ready / invalid
    if (!themeLabel) themeLabel = "Theme";

    const newTheme = {
      id,
      label: themeLabel,
      alias: themeAlias,
      description: themeDesc,
      centroid: centroid0,
      coherence: 1,
      count: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    newTheme._idx = themes.length;
    themes.push(newTheme);
    sentenceAssignments.push({ idx: i, themeId: id, weight: 1 });

    } else {
      // softmax weights over the matched themes (sharpen with beta)
      const beta = 10;
      const exps = matches.map(m => Math.exp(beta * m.cos));
      const Z = exps.reduce((a,b)=>a+b,0) || 1;
      matches.forEach((m, k) => {
        sentenceAssignments.push({ idx: i, themeId: m.id, weight: exps[k] / Z });
      });
    }
  }

  // 3) Update centroids (EMA) using sentence contributions grouped per theme
  const byTheme = new Map(); // themeId -> {vec: mean(sentence vecs), mass: sum weights}
  for (const a of sentenceAssignments) {
    const svec = sentVecs[a.idx];
    const mass = sal[a.idx] * a.weight;
    if (!byTheme.has(a.themeId)) byTheme.set(a.themeId, { sum: new Array(svec.length).fill(0), mass: 0 });
    const row = byTheme.get(a.themeId);
    for (let d=0; d<svec.length; d++) row.sum[d] += svec[d] * mass;
    row.mass += mass;
  }

  for (const t of themes) {
    const row = byTheme.get(t.id);
    if (row && row.mass > 0) {
      const delta = row.sum.map(x => x / row.mass);
      const mixed = addVec(scaleVec(t.centroid, (1 - THEME_EMA_ALPHA)), scaleVec(delta, THEME_EMA_ALPHA));
      t.centroid = normalizeVec(mixed);
      t.count = (t.count || 0) + 1;
      t.updated_at = new Date().toISOString();
    }
  }

  // 4) Merge very-close themes
  // Build a fresh index
  themes.forEach((t, i) => (t._idx = i));
  const toRemove = new Set();
  for (let i = 0; i < themes.length; i++) {
    if (toRemove.has(themes[i].id)) continue;
    for (let j = i + 1; j < themes.length; j++) {
      if (toRemove.has(themes[j].id)) continue;
      const sim = cosineSim(themes[i].centroid, themes[j].centroid);
      if (sim >= THEME_MERGE_THRESHOLD) {
        // merge j into i
        const w1 = themes[i].count || 1, w2 = themes[j].count || 1;
        const mixed = addVec(scaleVec(themes[i].centroid, w1), scaleVec(themes[j].centroid, w2));
        themes[i].centroid = normalizeVec(mixed);
        themes[i].label = preferLabel(themes[i].label, themes[j].label);
        themes[i].count = w1 + w2;
        toRemove.add(themes[j].id);
      }
    }
  }
  const mergedThemes = themes.filter(t => !toRemove.has(t.id)).map((t,i)=>({ ...t, _idx:i }));

  // 5) Entry-level tags: aggregate sentence weights -> normalize -> keep top 2–4
  const entryThemeWeights = new Map(); // id -> weight
  for (const a of sentenceAssignments) {
    if (toRemove.has(a.themeId)) continue; // skip merged-away
    const w = sal[a.idx] * a.weight;
    entryThemeWeights.set(a.themeId, (entryThemeWeights.get(a.themeId) || 0) + w);
  }
  // normalize across themes
  const total = Array.from(entryThemeWeights.values()).reduce((a,b)=>a+b,0) || 1;
  const normalized = Array.from(entryThemeWeights.entries()).map(([id,w]) => ({ id, weight: w/total }));
  normalized.sort((a,b)=>b.weight-a.weight);
  const limited = normalized.filter(x => x.weight >= ENTRY_TAG_FLOOR).slice(0, ENTRY_TAG_LIMIT);

  // attach labels for convenience
  const entryTags = limited.map(x => ({
    id: x.id,
    label: (mergedThemes.find(t => t.id === x.id)?.label) || "",
    weight: Math.round(x.weight * 100) / 100
  }));

  // ---- LLM multi-tags for this entry (optional but useful for UI and mapping) ----
  try {
    const evidence = topEvidenceFromSaliences(sents, sal);  // 2–3 most salient sentences
    const { tags } = await llmTagEntry(evidence);

    // Attach readable tag strings to the entry (the caller will persist them)
    entry.llm_tags = tags;

    // Gently map each tag to the nearest theme (if very close), or create a tiny new one.
    // We only nudge weights; we don't override the sentence-based tags.
    const TAG_JOIN_THRESHOLD = 0.86;
    const TAG_WEIGHT_BONUS = 0.25;

    for (const tag of tags) {
      const tagVec = await embedTextMean(tag);
      // find best theme
      let bestIdx = -1, bestCos = -1;
      for (let i = 0; i < themes.length; i++) {
        const cos = cosineSim(tagVec, themes[i].centroid);
        if (cos > bestCos) { bestCos = cos; bestIdx = i; }
      }
      if (bestIdx !== -1 && bestCos >= TAG_JOIN_THRESHOLD) {
        // bump weight for that theme so it’s more likely to appear among entry tags
        const id = themes[bestIdx].id;
        const found = entryTags.find(t => t.id === id);
        if (found) {
          found.weight = Math.min(1, Math.round((found.weight + TAG_WEIGHT_BONUS) * 100) / 100);
        } else {
          entryTags.push({ id, label: themes[bestIdx].label || "", weight: TAG_WEIGHT_BONUS });
        }
      } else {
        // create a lightweight theme from the tag (centroid = tagVec); name via LLM labeler
        const id = crypto.randomUUID();
        let label = tag, alias = null, description = null;
        try {
          const named = await llmLabelTheme(evidence);
          if (named.label) { label = named.label; alias = named.alias; description = named.description; }
        } catch {}
        const t = {
          id,
          label,
          alias,
          description,
          centroid: normalizeVec(tagVec),
          coherence: 1,
          count: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        t._idx = themes.length;
        themes.push(t);
        entryTags.push({ id, label, weight: 0.3 });
      }
    }

  // Re-normalize entry tag weights, trim to your limits
  const sumW = entryTags.reduce((a,b)=>a + (b.weight||0), 0) || 1;
  entryTags.forEach(t => t.weight = Math.round((t.weight / sumW) * 100) / 100);
  entryTags.sort((a,b)=>b.weight-a.weight);
  // Keep your original ENTRY_TAG_LIMIT if defined
  while (entryTags.length > (typeof ENTRY_TAG_LIMIT === 'number' ? ENTRY_TAG_LIMIT : 4)) entryTags.pop();

} catch (err) {
  console.warn('[llmTagEntry] skipped (LLM not ready?)', err);
}

  
  return { entryTags, themes: stripPrivateFields(mergedThemes) };
}

// --- helpers for vectors / labels / themes ---
function normalizeVec(v){ const n = Math.sqrt(v.reduce((a,b)=>a+b*b,0)) || 1; return v.map(x=>x/n); }
function addVec(a,b){ const out=new Array(Math.min(a.length,b.length)); for(let i=0;i<out.length;i++) out[i]=a[i]+b[i]; return out; }
function scaleVec(a,s){ return a.map(x=>x*s); }
function cloneThemes(themes){ return themes.map((t,i)=>({ ...t, _idx:i })); }
function stripPrivateFields(themes){ return themes.map(({_idx, ...t}) => t); }

function preferLabel(a,b){
  // pick the more specific-looking label (longer up to 32 chars)
  const ca = (a||"").trim(), cb = (b||"").trim();
  if (!ca) return cb || "theme";
  if (!cb) return ca;
  const la = Math.min(ca.length, 32), lb = Math.min(cb.length, 32);
  return lb > la ? cb : ca;
}

function inferThemeLabelFromSentences(sentences) {
  // simple noun-ish keywords from up to 2 sentences; no PII
  const stop = new Set(["the","a","an","and","or","but","to","of","in","on","for","with","my","our","your","their","is","are","was","were","be","been","am","i","it","this","that","these","those","at","from","as","by","about","into","over","after","before","up","down"]);
  const text = sentences.slice(0,2).join(" ").toLowerCase();
  const words = text.match(/[a-z][a-z'-]{1,}/g) || [];
  const freq = new Map();
  for (const w of words) if (!stop.has(w)) freq.set(w, (freq.get(w)||0)+1);
  const top = Array.from(freq.entries()).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([w])=>w);
  const label = top.join(" ").trim();
  return label || "theme";
}

// ========== Local LLM helpers (text2text-generation; fully in-browser) ==========

function buildTagPrompt(evidence) {
  // evidence: array of 2–4 short sentences
  const esc = (s) => s.replace(/"/g, '\\"');
  const lines = evidence.map(s => `- "${esc(s)}"`).join("\n");
  return `
You extract short theme tags from journaling snippets.

Rules:
- Return JSON ONLY.
- 1–4 tags, each 1–3 words, lowercase except proper nouns.
- No names, emails, dates, or locations. No advice, no diagnosis.
- Prefer concrete topics over generic words.
- Keep outputs stable: temperature=0.

EVIDENCE
${lines}

SCHEMA
{"tags":["tag1","tag2"], "rationales":{"tag1":"<=10 words", "tag2":"<=10 words"}}
`.trim();
}

function buildLabelPrompt(evidence) {
  const esc = s => String(s).replace(/"/g, '\\"');
  const lines = evidence.map(s => `- "${esc(s)}"`).join('\n');

  return [
    'Please summarize the themese of this journal entry in one to three words: ',   
    '',
    lines,
    '',
    'Please respond with only the one to three words that summarize the themes.',
    'For example, if you were given the text: ',
    '',
    'I need to wake up early tomorrow to workout and get some homework done.',
    '',
    'You would respond with something like:',
    '',
    'Morning plans',
    '',
    'You must not answer like this:',
    '',
    'Themes of this journal entry include Morning Plans.',
    '',
    'Instead, you must wrap your response in brackets. And it must be formatted like this without any other words or preamble:',
    '',
    '{Theme: Morning Plans}',
  ].join('\n');
}



function sanitizeTags(obj) {
  const out = [];
  const raw = Array.isArray(obj?.tags) ? obj.tags : [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const s = t.trim().replace(/\s+/g, ' ');
    if (!s) continue;
    // reject if contains @, urls, long numbers/dates
    if (/@|https?:\/\//.test(s) || /\b\d{3,}\b/.test(s)) continue;
    // 1–3 words
    if ((s.split(/\s+/).length) > 3) continue;
    out.push(s);
    if (out.length >= 4) break;
  }
  return out;
}

// Public: tag entry from evidence sentences
export async function llmTagEntry(evidenceSentences) {
  await ensureGenerationModel();
  const prompt = buildTagPrompt(evidenceSentences.slice(0, 4));
  const gen = await generationModel(prompt, { max_new_tokens: 96, temperature: 0 });
  const text = Array.isArray(gen) ? gen[0]?.generated_text ?? "" : gen?.generated_text ?? "";
  const parsed = safeParseJSON(text) || {};
  const tags = sanitizeTags(parsed);
  const rationales = parsed?.rationales && typeof parsed.rationales === 'object' ? parsed.rationales : {};
  return { tags, rationales };
}

// --- small helpers (put near llmLabelTheme) ---
function normEvidence(ev) {
  if (Array.isArray(ev)) return ev.filter(Boolean).map(String);
  if (typeof ev === 'string') return ev.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  if (ev && typeof ev === 'object') {
    const s = ev.response || ev.text || ev.content || ev.note || '';
    return s ? [String(s)] : [];
  }
  return [];
}

function extractGenText(gen) {
  // Common cases across transformers.js pipelines
  if (gen == null) return '';
  if (typeof gen === 'string') return gen;
  if (Array.isArray(gen)) {
    // text-generation: [{ generated_text: '...' }, ...]
    const g0 = gen[0];
    if (g0 && typeof g0 === 'object') {
      return g0.generated_text ?? g0.summary_text ?? g0.text ?? '';
    }
    // array of strings?
    if (typeof gen[0] === 'string') return gen[0];
    return '';
  }
  if (typeof gen === 'object') {
    return gen.generated_text ?? gen.summary_text ?? gen.text ?? '';
  }
  return '';
}

function safeParseJSON(s) {
  if (!s) return null;
  // 1) try strict
  try { return JSON.parse(s); } catch {}
  // 2) try fenced ```json ... ```
  const m = s.match(/```json\s*([\s\S]*?)```/i) || s.match(/```\s*([\s\S]*?)```/);
  if (m?.[1]) { try { return JSON.parse(m[1]); } catch {} }
  // 3) try first balanced {...}
  const i0 = s.indexOf('{');
  if (i0 >= 0) {
    let d = 0;
    for (let i = i0; i < s.length; i++) {
      if (s[i] === '{') d++;
      else if (s[i] === '}' && --d === 0) {
        const block = s.slice(i0, i + 1);
        try { return JSON.parse(block); } catch {}
        break;
      }
    }
  }
  return null;

}

function tryRepairLabelJSON(s) {
  if (!s) return null;
  let t = s.trim();

  // If it already looks like JSON, try as-is first
  try { return JSON.parse(t); } catch {}

  // Extract a likely block that starts with "label":
  const i = t.toLowerCase().indexOf('"label"');
  if (i >= 0) t = t.slice(i);

  // Insert commas where a string is followed by the next quoted key or "null"
  t = t
    .replace(/"\s{0,}"\s{0,}([a-z"])/gi, '", $1')   // ..."value" "alias" -> ..."value", "alias"
    .replace(/\s{2,}/g, ' ')                        // squeeze spaces
    .replace(/"null":/g, '"alias":')                // common model glitch you showed
    .replace(/("alias":)\s*"null"/i, '$1 null');    // normalize alias 
    
  console.log("T: ", t)

  // Wrap braces if missing
  if (!t.trim().startsWith('{')) t = '{' + t;
  if (!t.trim().endsWith('}')) t = t + '}';

  // Remove trailing commas
  t = t.replace(/,\s*([}\]])/g, '$1');

  console.log("Repaired JSON:", JSON.parse(t))

  try { return JSON.parse(t); } catch { return null; }
}

function cleanLabel(s) {
  if (!s) return null;
  // strip quotes/fences and keep letters/numbers/'- and spaces
  let t = String(s)
    .replace(/```[\s\S]*?```/g, '')   // remove fenced blocks if any
    .replace(/^["'\s]+|["'\s]+$/g, '')// trim quotes
    .replace(/[^\p{L}\p{N}'’\- ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Title Case
  t = t.replace(/\b\w+/g, w => w[0].toUpperCase() + w.slice(1));
  // guard against empties/generic junk
  const bad = new Set(['', 'Label', 'Theme', 'Them', 'General', 'Misc']);
  if (bad.has(t) || t.length < 3) return null;
  // cap length
  return t.slice(0, 32);
}


export async function llmLabelTheme(evidenceSentences) {
  const ev = normEvidence(evidenceSentences).slice(0, 3);
  const prompt = buildLabelPrompt(ev);

  const model = await ensureGenerationModel(); // must RETURN the pipeline
    let text = '';
    try {
      const gen = await model(prompt, {
      max_new_tokens: 12,      // just enough for 1–3 words
      temperature: 0.0,        // deterministic
      top_k: 0,
      top_p: 1,
      // return_full_text: false // uncomment if your pipeline supports it
    });

  text = extractGenText(gen);
  text = (text || '').trim();   // <- strip the spaces you’re seeing

  } catch (e) {
    console.warn('[llmLabelTheme] generation error:', e);
    return { label: null, alias: null, description: null, _raw: null };
  }

  const label = cleanLabel(text);
  if (!label) {
    console.warn('[llmLabelTheme] empty/invalid label; falling back.');
    return { label: null, alias: null, description: null, _raw: text };
  }

  return { label, alias: null, description: null, _raw: text };
}



// ai.js
let generationModel;

export async function ensureGenerationModel() {
  if (generationModel) return generationModel;
  const { pipeline } = window.transformers;

  // Instruction-following, fast-ish in browser:
  // 77M is tiniest; 248M is better but heavier.
  generationModel = await pipeline(
    'text2text-generation',
    'Xenova/LaMini-Flan-T5-77M' // or 'Xenova/LaMini-Flan-T5-248M'
  );
  return generationModel;
}


// Normalize Transformers.js outputs (array of strings OR array of { generated_text })
function extractGeneratedText(gen) {
  if (Array.isArray(gen) && gen.length) {
    const first = gen[0];
    if (typeof first === 'string') return first;
    if (first && typeof first.generated_text === 'string') return first.generated_text;
  }
  if (typeof gen === 'string') return gen;
  if (gen && typeof gen.generated_text === 'string') return gen.generated_text;
  return '';
}

// One-shot generate with options
async function _generateOnce(prompt, opts = {}) {
  const model = await ensureGenerationModel();
  const out = await model(prompt, {
    temperature: 0,
    max_new_tokens: 96,
    ...opts,
  });
  let text = extractGeneratedText(out);
  if (typeof text !== 'string') text = String(text || '');
  return text;
}

/**
 * Generate text intended to be JSON. Retries with stricter params,
 * and finally falls back to flan-t5-base if needed.
 */
async function generateJSONText(prompt) {
  // Try 1: default (greedy) — fast path
  let text = (await _generateOnce(prompt)).trim();

  // Some builds emit only whitespace; trim and check again
  if (!text) {
    // Try 2: require some tokens + beams, discourage repetition
    text = (await _generateOnce(prompt, {
      min_new_tokens: 12,
      num_beams: 4,
      do_sample: false,
      repetition_penalty: 1.15,
      length_penalty: 0.9,
    })).trim();
  }

  // Try 3: fallback to a slightly larger checkpoint for better adherence
  if (!text) {
    await ensureGenerationModel('Xenova/flan-t5-base'); // switch model
    text = (await _generateOnce(prompt, {
      min_new_tokens: 12,
      num_beams: 4,
      do_sample: false,
      repetition_penalty: 1.15,
      length_penalty: 0.9,
    })).trim();
  }

  return text;
}


// ===== Sentiment (POS/NEG/NEU) =====

// Negative sentiment subtypes (fill with your semantic thread’s phrases)
const NEG_GROUPS = {
  anxiety:   ["I feel anxious", "I feel worried", "I’m nervous"],
  overwhelm: ["I’m overwhelmed", "I feel stressed", "Too much at once"],
  fatigue:   ["I felt tired", "I’m exhausted", "I feel drained"],
  anger:     ["I feel angry", "I’m frustrated", "I’m irritated"],
  sadness:   ["I’m disappointed", "I felt discouraged", "I feel sad"],
  shame:     ["I feel ashamed", "I feel guilty", "I regret this"]
};


// Minimal cue lists (journaling tone)
const NEG_CUES = [
  "anxious","worried","overwhelmed","tired","angry","upset",
  "frustrated","discouraged","sad","lonely","stressed","disappointed","afraid","ashamed","guilty","regret"
];
const POS_CUES = [
  "grateful","calm","hopeful","confident","content","excited","energized","relieved","proud","peaceful","happy","joyful"
];

function countCues(text, list) {
  const t = String(text || "").toLowerCase();
  let hits = 0;
  for (const w of list) if (t.includes(w)) hits++;
  return hits;
}


// User-provided anchors (keep them tiny & unambiguous)
const SENTIMENT_ANCHORS = {
  positive: [
    "I feel grateful",
    "I’m proud of myself",
    "I felt calm",
    "I feel hopeful",
    "I’m confident today",
    "I feel content",
    "I’m excited inside",
    "I felt energized"
  ],
  negative: [
    "I feel anxious",
    "I’m overwhelmed",
    "I felt tired",
    "I feel angry",
    "I’m disappointed",
    "I feel worried",
    "I’m frustrated",
    "I felt discouraged"
  ],
  neutral: [
    "I noted my schedule",
    "I updated tasks",
    "I reviewed the list",
    "I wrote some notes",
    "I logged the entry",
    "I recorded details",
    "I organized the files",
    "I tracked the steps"
  ]
};

// Cache for embedded anchors + centroids
const _sentimentCache = {
  ready: false,
  posVecs: null, negVecs: null, neuVecs: null,
  posCentroid: null, negCentroid: null, neuCentroid: null,
};

function normalizeClfTriplet(result, modelId) {
  const arr = Array.isArray(result[0]) ? result[0] : result;

  // Maps for different models
  // twitter-roberta: LABEL_0=negative, LABEL_1=neutral, LABEL_2=positive
  const map_roberta = { LABEL_0: 'negative', LABEL_1: 'neutral', LABEL_2: 'positive' };
  // distilbert sst2: NEGATIVE/POSITIVE (binary)
  // bert-multilingual stars: 1..5
  const out = { positive: 0, negative: 0, neutral: 0 };

  const model = (modelId || '').toLowerCase();
  if (model.includes('twitter-roberta-base-sentiment-latest')) {
    for (const r of arr) {
      const k = map_roberta[r.label] || r.label.toLowerCase();
      if (k in out) out[k] = r.score;
    }
  } else if (model.includes('distilbert-base-uncased-finetuned-sst-2-english')) {
    // Binary → spread into 3 classes with tiny neutral
    const pos = (arr.find(x => x.label.toUpperCase().includes('POS'))?.score) ?? 0;
    const neg = (arr.find(x => x.label.toUpperCase().includes('NEG'))?.score) ?? 0;
    const Z = Math.max(1e-9, pos + neg);
    out.positive = pos / Z * 0.97;
    out.negative = neg / Z * 0.97;
    out.neutral  = 1 - (out.positive + out.negative);
  } else if (model.includes('bert-base-multilingual-uncased-sentiment')) {
    // Stars → 1,2=neg; 3=neutral; 4,5=pos
    let scores = {1:0,2:0,3:0,4:0,5:0};
    for (const r of arr) {
      const key = String(r.label).match(/\d/)?.[0];
      if (key) scores[+key] = r.score;
    }
    const neg = scores[1] + scores[2];
    const neu = scores[3];
    const pos = scores[4] + scores[5];
    const Z = Math.max(1e-9, pos + neg + neu);
    out.positive = pos / Z; out.negative = neg / Z; out.neutral = neu / Z;
  } else {
    // Generic best-effort
    for (const r of arr) {
      const k = String(r.label).toLowerCase();
      if (k in out) out[k] = r.score;
    }
    const Z = Math.max(1e-9, out.positive + out.negative + out.neutral);
    out.positive /= Z; out.negative /= Z; out.neutral /= Z;
  }

  // margin for ensemble weighting
  const sorted = Object.values(out).sort((a,b)=>b-a);
  const margin = (sorted[0] - sorted[1]) || 0;
  return { ...out, margin };
}

async function classifyTriplet(clf, text) {
  const res = await clf(text, { top_k: 3 }); // NOTE: key is top_k (underscore)
  const modelId = clf.model?.id || clf.model_id || '';
  return normalizeClfTriplet(res, modelId);
}

// Blend weight from classifier margin (0..1)
// Higher margin → trust classifier more.
function ensembleWeight(margin) {
  if (margin >= 0.40) return 0.80;
  if (margin >= 0.25) return 0.70;
  if (margin >= 0.15) return 0.60;
  if (margin >= 0.08) return 0.50;
  return 0.40; // low confidence → lean more on anchors
}

// Classifier-only, calibrated to avoid extreme 1.00 / 0.00 outputs.
export async function inferEntrySentimentEnsemble(
  text,
  {
    mode = 'full',    // 'full' | 'per_sentence'
    T = 3,          // temperature >1 softens confidences (try 1.8–3.0)
    gamma = 1.15,     // curve for the neutral band (higher => more neutral)
    neutral_min = 0.05, // never show neutral below this
    min_tokens = 3    // per_sentence: ignore very short sentences
  } = {}
) {
  const t = String(text || '').trim();
  if (!t) return { label: 'neutral', confidence: 0, breakdown: { pos: 0, neg: 0, neutral: 1 } };

  const clf = await ensureSentimentClassifier();

  const logit = (p) => Math.log(Math.max(1e-12, Math.min(1 - 1e-12, p))) - Math.log(1 - Math.max(1e-12, Math.min(1 - 1e-12, p)));
  const sigmoid = (x) => 1 / (1 + Math.exp(-x));

  // Convert raw binary probs -> softened pos/neg and add a neutral band from the margin.
  function softenToTriplet(posRaw) {
    // 1) soften with temperature
    const posT = sigmoid(logit(posRaw) / T);
    const negT = 1 - posT;

    // 2) margin from the decision boundary
    const m = Math.abs(posT - 0.5) * 2;   // 0..1 (0 = ambiguous, 1 = extreme)

    // 3) neutral mass grows as confidence shrinks (with a gentle curve)
    const neutral = Math.max(neutral_min, Math.pow(1 - m, gamma));

    // 4) distribute remaining mass to pos/neg proportionally
    const nonNeutral = Math.max(0, 1 - neutral);
    const pos = nonNeutral * posT;
    const neg = nonNeutral * negT;

    // normalized already, but clamp for safety
    const s = pos + neg + neutral || 1;
    return { pos: pos / s, neg: neg / s, neutral: neutral / s, margin: m };
  }

  async function classifyText(chunk) {
    const out = await classifyTriplet(clf, chunk);
    // accept either {pos,neg,neutral} or pipeline-style {label, score}
    let ppos;
    if (typeof out?.pos === 'number') {
      ppos = out.pos; // already probability of positive
    } else if (Array.isArray(out)) {
      // pipeline('text-classification') often returns [{label:'POSITIVE', score:x}, {label:'NEGATIVE', score:y}]
      const posItem = out.find(o => /pos/i.test(o.label)) || out[0];
      ppos = posItem?.score ?? 0.5;
    } else if (typeof out?.positive === 'number') {
      ppos = out.positive;
    } else {
      ppos = 0.5; // fallback
    }
    return softenToTriplet(ppos);
  }

  if (mode === 'per_sentence') {
    const sents = splitSentences(t);
    let Spos = 0, Sneg = 0, Sneu = 0, W = 0;

    for (const s of sents) {
      const tokens = (s.match(/\w+/g) || []).length;
      if (tokens < min_tokens) continue;
      const trip = await classifyText(s);
      const w = Math.max(1, tokens);
      Spos += w * trip.pos;
      Sneg += w * trip.neg;
      Sneu += w * trip.neutral;
      W += w;
    }

    if (W === 0) return { label: 'neutral', confidence: 0, breakdown: { pos: 0, neg: 0, neutral: 1 } };
    const pos = Spos / W, neg = Sneg / W, neu = Sneu / W;
    return decideLabel(pos, neg, neu);
  }

  // default: single pass on whole text
  const trip = await classifyText(t);
  return decideLabel(trip.pos, trip.neg, trip.neutral);

  function decideLabel(pos, neg, neu) {
    const sum = pos + neg + neu || 1;
    const Ppos = pos / sum, Pneg = neg / sum, Pneu = neu / sum;

    const ranked = [
      {k:'positive', v:Ppos},
      {k:'negative', v:Pneg},
      {k:'neutral',  v:Pneu}
    ].sort((a,b)=>b.v-a.v);

    let label = ranked[0].k;
    const margin = ranked[0].v - ranked[1].v;

    return {
      label,
      confidence: Math.max(0, Math.min(1, margin)),
      breakdown: {
        pos: Number(Ppos.toFixed(2)),
        neg: Number(Pneg.toFixed(2)),
        neutral: Number(Pneu.toFixed(2)),
      }
    };
  }
}





async function ensureSentimentAnchors() {
  if (_sentimentCache.ready) return;
  await ensureEmbeddingModel(); // uses your existing loader:contentReference[oaicite:2]{index=2}

  const embedList = async (arr) => {
    const out = [];
    for (const s of arr) out.push(await embedTextMean(s));
    return out;
  };

  _sentimentCache.posVecs = await embedList(SENTIMENT_ANCHORS.positive);
  _sentimentCache.negVecs = await embedList(SENTIMENT_ANCHORS.negative);
  _sentimentCache.neuVecs = await embedList(SENTIMENT_ANCHORS.neutral);

  const nc = (v) => normalizeVec(v); // you already have normalizeVec in ai.js

  _sentimentCache.posCentroid = nc(meanVec(_sentimentCache.posVecs));
  _sentimentCache.negCentroid = nc(meanVec(_sentimentCache.negVecs));  
  _sentimentCache.neuCentroid = nc(meanVec(_sentimentCache.neuVecs));

    _sentimentCache.negGroupCentroids = {};
  for (const [k, arr] of Object.entries(NEG_GROUPS)) {
    const vecs = [];
    for (const s of arr) vecs.push(await embedTextMean(s));
    _sentimentCache.negGroupCentroids[k] = normalizeVec(meanVec(vecs));
  }

  _sentimentCache.ready = true;
}

function softmax3_t(a, b, c, t = 0.6) {
  // lower t (<1) = sharper; 0.6 is a good start for MiniLM
  const s = (x) => x / Math.max(1e-8, t);
  const m = Math.max(s(a), s(b), s(c));
  const ea = Math.exp(s(a) - m), eb = Math.exp(s(b) - m), ec = Math.exp(s(c) - m);
  const Z = ea + eb + ec || 1;
  return { pos: ea / Z, neg: eb / Z, neu: ec / Z };
}

function scoreSentenceAnchors(text, vec) {
  const {
    posCentroid,
    neuCentroid,
    negCentroid,            // fallback if groups aren't initialized
    negGroupCentroids       // { subtype -> centroid }
  } = _sentimentCache;

  // Base cosine signals: pos & neutral are single centroids
  let sp = cosineSim(vec, posCentroid);
  let su = cosineSim(vec, neuCentroid);

  // --- NEGATIVE: max-over subcentroids (Tolstoy mode) ---
  let sn, negSubtype = null;
  const groups = negGroupCentroids && Object.keys(negGroupCentroids).length ? negGroupCentroids : null;
  if (groups) {
    let bestK = null, bestS = -1;
    for (const [k, c] of Object.entries(groups)) {
      const s = cosineSim(vec, c);
      if (s > bestS) { bestS = s; bestK = k; }
    }
    sn = bestS;
    negSubtype = bestK;
  } else {
    // graceful fallback: single negative centroid
    sn = cosineSim(vec, negCentroid);
  }

  // --- Lexical priors (tiny, deterministic) ---
  const posHits = countCues(text, POS_CUES);
  const negHits = countCues(text, NEG_CUES);
  sp += Math.min(0.06, 0.02 * posHits);
  sn += Math.min(0.08, 0.025 * negHits); // slightly stronger for negatives

  // If any affect words present, nudge neutral down a hair
  if (posHits + negHits > 0) su -= 0.015;

  // Polarity-aware intensity bump
  const intense = /\b(so|really|very)\b/i.test(text) || /!/.test(text);
  if (intense) {
    if (negHits > 0 && posHits === 0) sn += 0.03;
    else {
      const m = Math.max(sp, sn, su);
      if (m === sp) sp += 0.02;
      else if (m === sn) sn += 0.02;
      else su += 0.02;
    }
  }

  // Tiny priors to counter neutral dominance
  sp += 0.02;
  sn += 0.02;

  // Sharpened softmax → probabilities
  const probs = softmax3_t(sp, sn, su, 0.55);
  return { ...probs, negSubtype }; // <— include subtype for entry-level aggregation
}


function hasNegationFlip(text) {
  // Very light heuristic: "not/never/no" within 3 tokens of a valence cue
  // We keep it generic: if negation exists at all, allow a small nudge later.
  return /\b(not|never|no)\b/i.test(text);
}
function intensityBump(text) {
  return /\b(so|really|very)\b/i.test(text) || /!/.test(text);
}


// Public: get sentence vectors + saliences (reuses your logic):contentReference[oaicite:3]{index=3}
export async function getSentenceVectors(text) {
  const cleaned = normalizeWhitespace(text);
  const sents = splitSentences(cleaned);
  await ensureEmbeddingModel();
  const vecs = [];
  for (const s of sents) vecs.push(await embedTextMean(s));
  const centroid = meanVec(vecs);
  const salRaw = vecs.map(v => cosineSim(v, centroid));
  const saliences = normalize01(salRaw);
  return { sentences: sents, vectors: vecs, saliences };
}

// Public: infer sentiment for an entry’s raw text
export async function inferEntrySentimentFromText(text) {
  await ensureSentimentAnchors();
  const { sentences, vectors, saliences } = await getSentenceVectors(text);

  let Spos = 0, Sneg = 0, Sneu = 0;
  for (let i = 0; i < sentences.length; i++) {
    const w = saliences[i] ?? 1;
    const trip = scoreSentenceSentimentFromVec(sentences[i], vectors[i]);
    Spos += w * trip.pos;
    Sneg += w * trip.neg;
    Sneu += w * trip.neu;
  }
  const sum = Spos + Sneg + Sneu || 1;
  const Ppos = Spos / sum, Pneg = Sneg / sum, Pneu = Sneu / sum;

  // Decision rule w/ neutral preference on low margin
  const arr = [{k:'positive', v:Ppos}, {k:'negative', v:Pneg}, {k:'neutral', v:Pneu}].sort((a,b)=>b.v-a.v);
  let label = arr[0].k;
  const margin = arr[0].v - arr[1].v;
  const TAU_LOW = 0.03;  // was 0.06
  

  if (margin < TAU_LOW) label = 'neutral';

  return {
    label,
    confidence: Math.max(0, Math.min(1, margin)),
    breakdown: { pos: round2(Ppos), neg: round2(Pneg), neutral: round2(Pneu) }
  };
}
