/* ===================================================================
   Swimming Brain — Brain Engine (client-side)
   Stores sources in localStorage, searches with BM25 ranking,
   generates answers with extractive Q&A — no API calls.
   =================================================================== */

const Brain = (() => {
  const STORAGE_KEY = "sb-sources";
  const HISTORY_KEY = "sb-history";
  const CHUNK_SIZE = 1500;
  const CHUNK_OVERLAP = 150;

  // ----- Stopwords & Tokenizer -----
  const STOPWORDS = new Set([
    "a","an","the","and","or","but","in","on","at","to","for","of","with",
    "by","from","is","it","as","be","was","are","were","been","has","have",
    "had","do","does","did","will","would","could","should","can","may",
    "not","no","so","if","my","me","i","we","you","he","she","they","this",
    "that","what","how","when","where","which","who","its","our","your",
    "their","up","out","about","into","over","after","than","just","also",
    "more","some","any","all","each","every","much","very","too","only"
  ]);

  function tokenize(text) {
    return text.toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 1 && !STOPWORDS.has(w));
  }

  // ----- Source Storage (localStorage) -----
  function _loadSources() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
    catch { return []; }
  }

  function _saveSources(sources) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sources));
  }

  function getAllSources() {
    return _loadSources().sort((a, b) => b.uploadedAt - a.uploadedAt);
  }

  function addSource(source) {
    const sources = _loadSources();
    sources.push(source);
    _saveSources(sources);
  }

  function deleteSource(id) {
    const sources = _loadSources().filter(s => s.id !== id);
    _saveSources(sources);
  }

  // ----- Chat History -----
  function getHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
    catch { return []; }
  }

  function saveMessage(role, text, citations) {
    const history = getHistory();
    history.push({ role, text, time: Date.now(), citations: citations || [] });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }

  function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
  }

  // ----- Text Chunking -----
  function chunkText(text) {
    text = text.trim();
    if (!text) return [];
    if (text.length <= CHUNK_SIZE) return [text];

    const chunks = [];
    let start = 0;

    while (start < text.length) {
      let end = start + CHUNK_SIZE;
      if (end >= text.length) {
        chunks.push(text.slice(start).trim());
        break;
      }

      const slice = text.slice(start, end);
      const paraBreak = slice.lastIndexOf("\n\n");
      if (paraBreak > CHUNK_SIZE * 0.3) {
        end = start + paraBreak + 2;
      } else {
        for (const sep of [". ", "! ", "? ", ".\n", "\n"]) {
          const sentBreak = slice.lastIndexOf(sep);
          if (sentBreak > CHUNK_SIZE * 0.3) {
            end = start + sentBreak + sep.length;
            break;
          }
        }
      }

      const chunk = text.slice(start, end).trim();
      if (chunk) chunks.push(chunk);
      start = end - CHUNK_OVERLAP;
      if (start <= end - CHUNK_SIZE) start = end;
    }

    return chunks;
  }

  // ----- PDF Extraction (pdf.js) -----
  async function extractPdfText(file) {
    const arrayBuffer = await file.arrayBuffer();
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str).join(" "));
    }
    return pages.join("\n\n");
  }

  // ----- Process Upload -----
  async function processFile(file, title) {
    const id = crypto.randomUUID().slice(0, 12);
    const ext = file.name.split(".").pop().toLowerCase();
    let text = "";

    if (ext === "pdf") {
      text = await extractPdfText(file);
    } else {
      text = await file.text();
    }

    if (!text.trim()) {
      throw new Error("Could not extract text from this file.");
    }

    const chunks = chunkText(text);
    const source = {
      id,
      title: title || file.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " "),
      type: ext === "pdf" ? "pdf" : "txt",
      chunks,
      chunkCount: chunks.length,
      uploadedAt: Date.now(),
    };

    addSource(source);
    return source;
  }

  function processNote(title, content) {
    const id = crypto.randomUUID().slice(0, 12);
    const fullText = `${title}\n\n${content}`;
    const chunks = chunkText(fullText);

    const source = {
      id,
      title,
      type: "note",
      chunks,
      chunkCount: chunks.length,
      uploadedAt: Date.now(),
    };

    addSource(source);
    return source;
  }

  // ----- BM25 Search Engine -----
  function buildIndex(sources) {
    const docs = [];
    let totalLen = 0;

    for (const source of sources) {
      for (let i = 0; i < source.chunks.length; i++) {
        const tokens = tokenize(source.chunks[i]);
        const tf = new Map();
        for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
        docs.push({
          tokens, tf, len: tokens.length,
          sourceId: source.id, sourceTitle: source.title,
          chunkIndex: i, text: source.chunks[i]
        });
        totalLen += tokens.length;
      }
    }

    const avgDl = docs.length ? totalLen / docs.length : 1;
    const df = new Map();
    for (const doc of docs) {
      const seen = new Set();
      for (const t of doc.tokens) {
        if (!seen.has(t)) { df.set(t, (df.get(t) || 0) + 1); seen.add(t); }
      }
    }

    return { docs, avgDl, df, N: docs.length };
  }

  function searchSources(query, topK = 8) {
    const sources = _loadSources();
    if (!sources.length) return [];

    const index = buildIndex(sources);
    const queryTokens = tokenize(query);
    if (!queryTokens.length) return [];

    const k1 = 1.5, b = 0.75;
    const scores = [];

    for (const doc of index.docs) {
      let score = 0;
      for (const qt of queryTokens) {
        const docFreq = index.df.get(qt) || 0;
        if (docFreq === 0) continue;
        const idf = Math.log((index.N - docFreq + 0.5) / (docFreq + 0.5) + 1);
        const termFreq = doc.tf.get(qt) || 0;
        const tfNorm = (termFreq * (k1 + 1)) / (termFreq + k1 * (1 - b + b * doc.len / index.avgDl));
        score += idf * tfNorm;
      }

      // Exact phrase bonus
      if (doc.text.toLowerCase().includes(query.toLowerCase())) {
        score += 5;
      }

      if (score > 0) {
        scores.push({
          text: doc.text,
          sourceId: doc.sourceId,
          sourceTitle: doc.sourceTitle,
          score,
          chunkIndex: doc.chunkIndex
        });
      }
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK);
  }

  // ----- Extractive Q&A Engine -----
  function extractSentences(text) {
    return text
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 15);
  }

  function scoreSentence(sentence, queryTokens) {
    const sentTokens = tokenize(sentence);
    let matches = 0;
    for (const qt of queryTokens) {
      if (sentTokens.includes(qt)) matches++;
    }
    return queryTokens.length ? matches / queryTokens.length : 0;
  }

  function extractBestSentences(chunks, query, maxSentences = 8) {
    const queryTokens = tokenize(query);
    const scored = [];

    for (const chunk of chunks) {
      const sentences = extractSentences(chunk.text);
      for (const sent of sentences) {
        scored.push({
          sentence: sent,
          score: scoreSentence(sent, queryTokens),
          sourceTitle: chunk.sourceTitle,
          sourceId: chunk.sourceId
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    const seen = new Set();
    const result = [];
    for (const s of scored) {
      const key = s.sentence.toLowerCase().slice(0, 60);
      if (!seen.has(key) && s.score > 0) {
        seen.add(key);
        result.push(s);
      }
      if (result.length >= maxSentences) break;
    }

    return result;
  }

  function classifyQuery(query) {
    const q = query.toLowerCase();
    if (/drill|exercise|practice|warm.?up|cool.?down|set\b/.test(q)) return "drill";
    if (/workout|training plan|session|program|routine|yardage/.test(q)) return "workout";
    if (/technique|form|body position|hand entry|catch|pull|kick|rotation|streamline|stroke|breathing/.test(q)) return "technique";
    if (/time|pace|speed|fast|race|taper|competition|meet/.test(q)) return "racing";
    if (/why|explain|what is|what are|define|difference|science/.test(q)) return "explanation";
    if (/how (do|can|should)|improve|fix|correct|problem|trouble|mistake/.test(q)) return "howto";
    if (/summary|summarize|overview|key points|main ideas/.test(q)) return "summary";
    return "general";
  }

  function formatResponse(sentences, query, intent) {
    if (!sentences.length) {
      return "I couldn't find anything about that in your sources yet. Upload some swimming PDFs, coach notes, or articles and I'll be able to help!";
    }

    const bySource = new Map();
    for (const s of sentences) {
      if (!bySource.has(s.sourceTitle)) bySource.set(s.sourceTitle, []);
      bySource.get(s.sourceTitle).push(s.sentence);
    }

    let response = "";

    switch (intent) {
      case "drill":
        response = "Here are relevant drills from your sources:\n\n";
        for (const [title, sents] of bySource) {
          response += `**From: ${title}**\n`;
          response += sents.map(s => `- ${s}`).join("\n") + "\n\n";
        }
        break;

      case "workout":
        response = "Here's what your sources say about workouts and training:\n\n";
        for (const [title, sents] of bySource) {
          response += `**From: ${title}**\n`;
          response += sents.join(" ") + "\n\n";
        }
        break;

      case "technique":
        response = "Here's what your sources say about technique:\n\n";
        for (const [title, sents] of bySource) {
          response += `**${title}:** `;
          response += sents.join(" ") + "\n\n";
        }
        break;

      case "howto":
        response = "Here's what your sources suggest:\n\n";
        for (const [title, sents] of bySource) {
          response += `**From: ${title}**\n`;
          response += sents.map((s, i) => `${i + 1}. ${s}`).join("\n") + "\n\n";
        }
        break;

      case "explanation":
        response = "Based on your sources:\n\n";
        for (const [title, sents] of bySource) {
          response += sents.map(s => `${s} [Source: ${title}]`).join(" ") + "\n\n";
        }
        break;

      case "summary":
        response = "Here's a summary from your sources:\n\n";
        for (const [title, sents] of bySource) {
          response += `**${title}**\n`;
          response += sents.join(" ") + "\n\n";
        }
        break;

      default:
        response = "Here's what I found in your sources:\n\n";
        for (const [title, sents] of bySource) {
          response += `**From: ${title}**\n`;
          response += sents.join(" ") + "\n\n";
        }
    }

    return response.trim();
  }

  // ----- Main Ask Function -----
  function ask(query) {
    const context = searchSources(query, 8);

    const seen = new Set();
    const citations = [];
    for (const c of context) {
      if (!seen.has(c.sourceId)) {
        seen.add(c.sourceId);
        citations.push({ source_id: c.sourceId, source_title: c.sourceTitle });
      }
    }

    const intent = classifyQuery(query);
    const sentences = extractBestSentences(context, query);
    const response = formatResponse(sentences, query, intent);

    saveMessage("user", query);
    saveMessage("assistant", response, citations);

    return { response, citations, chunksUsed: context.length };
  }

  // ----- Source Analysis (NotebookLM-like) -----
  function extractTopics(source, maxTopics = 8) {
    const allText = source.chunks.join(" ");
    const tokens = tokenize(allText);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

    const sorted = [...tf.entries()]
      .filter(([term]) => term.length > 3)
      .sort((a, b) => b[1] - a[1]);

    return sorted.slice(0, maxTopics).map(([term, count]) => ({ term, count }));
  }

  function generateSourceSummary(source) {
    const allSentences = [];
    for (const chunk of source.chunks) {
      const sents = extractSentences(chunk);
      if (sents.length) allSentences.push(...sents);
    }

    if (!allSentences.length) return "No extractable content.";

    const topics = extractTopics(source, 10);
    const topicTerms = topics.map(t => t.term);

    const scored = allSentences.map(sent => {
      const tokens = tokenize(sent);
      const topicHits = topicTerms.filter(t => tokens.includes(t)).length;
      return { sent, score: topicHits };
    });

    scored.sort((a, b) => b.score - a.score);

    const used = new Set();
    const summary = [];
    for (const s of scored) {
      const key = s.sent.slice(0, 50);
      if (!used.has(key)) {
        used.add(key);
        summary.push(s.sent);
      }
      if (summary.length >= 4) break;
    }

    return summary.join(" ");
  }

  function getSourceOverview(sourceId) {
    const sources = _loadSources();
    const source = sources.find(s => s.id === sourceId);
    if (!source) return null;

    const allText = source.chunks.join(" ");
    const wordCount = allText.split(/\s+/).length;
    const topics = extractTopics(source);
    const summary = generateSourceSummary(source);

    return {
      id: source.id,
      title: source.title,
      type: source.type,
      chunkCount: source.chunkCount,
      wordCount,
      topics,
      summary,
      uploadedAt: source.uploadedAt
    };
  }

  function generateStudyGuide() {
    const sources = _loadSources();
    if (!sources.length) return null;

    const guide = {
      sourceCount: sources.length,
      sections: []
    };

    for (const source of sources) {
      const overview = getSourceOverview(source.id);
      const allSentences = [];
      for (const chunk of source.chunks) {
        allSentences.push(...extractSentences(chunk));
      }

      const keyFacts = allSentences.filter(s =>
        /\d/.test(s) || /focus|important|key|remember|always|never|tip|note/i.test(s)
      ).slice(0, 5);

      const faqSentences = allSentences.filter(s =>
        /should|can|will|helps?|improve|try|practice|make sure/i.test(s)
      ).slice(0, 3);

      guide.sections.push({
        title: source.title,
        topics: overview.topics,
        summary: overview.summary,
        keyFacts,
        faqEntries: faqSentences
      });
    }

    return guide;
  }

  return {
    getAllSources, deleteSource,
    processFile, processNote,
    getHistory, clearHistory,
    searchSources, ask,
    getSourceOverview, extractTopics,
    generateSourceSummary, generateStudyGuide,
  };
})();
