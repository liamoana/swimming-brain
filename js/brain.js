/* ===================================================================
   Swimming Brain — Brain Engine (client-side)
   Stores sources in localStorage, searches with keyword scoring,
   generates answers with Gemini free tier API.
   =================================================================== */

const Brain = (() => {
  const STORAGE_KEY = "sb-sources";
  const HISTORY_KEY = "sb-history";
  const APIKEY_KEY = "sb-gemini-key";
  const CHUNK_SIZE = 1500;
  const CHUNK_OVERLAP = 150;

  const SYSTEM_PROMPT = `You are Swimming Brain, an expert AI swimming coach.
You help swimmers improve technique, build training plans, and understand swimming science.

RULES:
- Answer using the PROVIDED SOURCE CONTEXT when available
- Cite sources with [Source: title] format after relevant statements
- If no sources are relevant, answer from general swimming knowledge and say so
- Be specific about body position, timing, catch mechanics, and common errors
- For workouts, include warm-up, main set, and cool-down with intervals
- Keep responses practical, actionable, and encouraging
- Use proper swimming terminology (catch, pull, recovery, streamline, EVF, DPS, etc.)`;

  // ----- API Key -----
  function getApiKey() {
    return localStorage.getItem(APIKEY_KEY) || "";
  }

  function setApiKey(key) {
    localStorage.setItem(APIKEY_KEY, key.trim());
  }

  function hasApiKey() {
    return !!getApiKey();
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

  // ----- Search (keyword scoring) -----
  function searchSources(query, topK = 5) {
    const sources = _loadSources();
    if (!sources.length) return [];

    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const results = [];

    for (const source of sources) {
      for (let i = 0; i < source.chunks.length; i++) {
        const chunk = source.chunks[i];
        const chunkLower = chunk.toLowerCase();
        let score = 0;

        for (const word of queryWords) {
          const matches = (chunkLower.match(new RegExp(word, "g")) || []).length;
          score += matches;
        }

        // Bonus for exact phrase match
        if (chunkLower.includes(query.toLowerCase())) {
          score += 10;
        }

        if (score > 0) {
          results.push({
            text: chunk,
            sourceId: source.id,
            sourceTitle: source.title,
            score,
            chunkIndex: i,
          });
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  // ----- Gemini API Call -----
  async function callGemini(prompt) {
    const key = getApiKey();
    if (!key) throw new Error("No API key");

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
        }),
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Gemini API error ${res.status}`);
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";
  }

  // ----- Main Ask Function -----
  async function ask(query) {
    const context = searchSources(query);
    const history = getHistory();

    // Build citations list
    const seen = new Set();
    const citations = [];
    for (const c of context) {
      if (!seen.has(c.sourceId)) {
        seen.add(c.sourceId);
        citations.push({ source_id: c.sourceId, source_title: c.sourceTitle });
      }
    }

    // Try Gemini AI
    if (hasApiKey()) {
      try {
        let prompt = "";

        if (context.length) {
          const contextText = context.map(c =>
            `[Source: ${c.sourceTitle}]\n${c.text}`
          ).join("\n\n");
          prompt += `SOURCES:\n${contextText}\n\n`;
        } else {
          prompt += "No uploaded sources match this question. Answer from general swimming knowledge.\n\n";
        }

        // Recent history
        const recent = history.slice(-6);
        if (recent.length) {
          prompt += "RECENT CONVERSATION:\n";
          prompt += recent.map(m =>
            `${m.role === "user" ? "User" : "Assistant"}: ${m.text.slice(0, 500)}`
          ).join("\n") + "\n\n";
        }

        prompt += `User question: ${query}`;

        const response = await callGemini(prompt);

        saveMessage("user", query);
        saveMessage("assistant", response, citations);

        return { response, citations, chunksUsed: context.length };
      } catch (e) {
        console.error("Gemini error:", e);
        // Fall through to offline mode
      }
    }

    // Offline fallback — return raw passages
    saveMessage("user", query);

    if (!context.length) {
      const msg = hasApiKey()
        ? "Gemini API error. Check your API key in settings."
        : "Add a Gemini API key (click the key icon) for AI answers, or upload sources to search.";
      saveMessage("assistant", msg, []);
      return { response: msg, citations: [], chunksUsed: 0 };
    }

    const parts = [`Here's what I found in your sources:\n`];
    for (const c of context) {
      let text = c.text.trim();
      if (text.length > 600) text = text.slice(0, 600).replace(/\s\S*$/, "") + "...";
      parts.push(`**From: ${c.sourceTitle}**\n${text}\n`);
    }

    const response = parts.join("\n");
    saveMessage("assistant", response, citations);
    return { response, citations, chunksUsed: context.length };
  }

  return {
    getApiKey, setApiKey, hasApiKey,
    getAllSources, deleteSource,
    processFile, processNote,
    getHistory, clearHistory,
    ask,
  };
})();
