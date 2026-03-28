"""
Swimming Brain — RAG Engine
ChromaDB local embeddings for search + Gemini free tier for AI chat.
"""

import os
import json
import uuid
import time
import re
from pathlib import Path

import chromadb
from PyPDF2 import PdfReader
import google.generativeai as genai

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
CHUNK_SIZE = 2048          # characters per chunk
CHUNK_OVERLAP = 200        # character overlap between chunks
COLLECTION_NAME = "swimming_sources"
TOP_K = 5
DATA_DIR = "data"
SOURCES_DIR = os.path.join(DATA_DIR, "sources")
CHROMA_DIR = os.path.join(DATA_DIR, "chroma")
CHAT_HISTORY_FILE = os.path.join(DATA_DIR, "chat_history.json")
SOURCES_INDEX_FILE = os.path.join(DATA_DIR, "sources_index.json")

# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------
_chroma_client = None
_collection = None
_model = None


# ===================================================================
# INITIALIZATION
# ===================================================================

def init_brain(api_key: str = None) -> None:
    """Initialize ChromaDB (local embeddings) + Gemini (free tier AI chat)."""
    global _chroma_client, _collection, _model

    os.makedirs(SOURCES_DIR, exist_ok=True)
    os.makedirs(CHROMA_DIR, exist_ok=True)

    # ChromaDB uses built-in all-MiniLM-L6-v2 embeddings locally — no API
    _chroma_client = chromadb.PersistentClient(path=CHROMA_DIR)
    _collection = _chroma_client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"}
    )

    # Gemini free tier for AI chat generation
    if api_key:
        genai.configure(api_key=api_key)
        _model = genai.GenerativeModel("gemini-2.0-flash")
        print(f"  Brain initialized — {_collection.count()} chunks, Gemini AI enabled")
    else:
        print(f"  Brain initialized — {_collection.count()} chunks, no AI (search only)")


# ===================================================================
# SOURCE INDEX
# ===================================================================

def _load_sources_index() -> dict:
    if os.path.exists(SOURCES_INDEX_FILE):
        with open(SOURCES_INDEX_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def _save_sources_index(index: dict) -> None:
    with open(SOURCES_INDEX_FILE, "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)


def add_source_to_index(source_id: str, metadata: dict) -> None:
    index = _load_sources_index()
    index[source_id] = metadata
    _save_sources_index(index)


def remove_source_from_index(source_id: str) -> None:
    index = _load_sources_index()
    index.pop(source_id, None)
    _save_sources_index(index)


def get_all_sources() -> list:
    index = _load_sources_index()
    sources = list(index.values())
    sources.sort(key=lambda s: s.get("uploaded_at", 0), reverse=True)
    return sources


def get_source(source_id: str) -> dict | None:
    index = _load_sources_index()
    return index.get(source_id)


# ===================================================================
# TEXT EXTRACTION
# ===================================================================

def extract_text_from_pdf(file_path: str) -> str:
    try:
        reader = PdfReader(file_path)
        pages = []
        for page in reader.pages:
            text = page.extract_text()
            if text:
                pages.append(text)
        return "\n\n".join(pages)
    except Exception as e:
        print(f"  PDF extraction error: {e}")
        return ""


def extract_text_from_txt(file_path: str) -> str:
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return f.read()
    except UnicodeDecodeError:
        with open(file_path, "r", encoding="latin-1") as f:
            return f.read()


# ===================================================================
# CHUNKING
# ===================================================================

def chunk_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list:
    text = text.strip()
    if not text:
        return []

    if len(text) <= chunk_size:
        return [text]

    chunks = []
    start = 0

    while start < len(text):
        end = start + chunk_size

        if end >= len(text):
            chunks.append(text[start:].strip())
            break

        slice_text = text[start:end]
        para_break = slice_text.rfind("\n\n")
        if para_break > chunk_size * 0.3:
            end = start + para_break + 2
        else:
            for sep in [". ", "! ", "? ", ".\n", "\n"]:
                sent_break = slice_text.rfind(sep)
                if sent_break > chunk_size * 0.3:
                    end = start + sent_break + len(sep)
                    break

        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)

        start = end - overlap
        if start <= (end - chunk_size):
            start = end

    return chunks


# ===================================================================
# CHROMADB STORAGE & RETRIEVAL (embeddings handled automatically)
# ===================================================================

def store_chunks(source_id: str, chunks: list, metadata: dict) -> int:
    """Store chunks in ChromaDB. Embeddings generated automatically by ChromaDB."""
    ids = [f"{source_id}_chunk_{i}" for i in range(len(chunks))]
    metadatas = [
        {
            "source_id": source_id,
            "source_title": metadata.get("title", "Unknown"),
            "source_type": metadata.get("type", "unknown"),
            "chunk_index": i,
        }
        for i in range(len(chunks))
    ]

    _collection.add(
        ids=ids,
        documents=chunks,
        metadatas=metadatas,
    )

    return len(chunks)


def delete_source_chunks(source_id: str) -> int:
    try:
        results = _collection.get(where={"source_id": source_id})
        if results["ids"]:
            _collection.delete(ids=results["ids"])
            return len(results["ids"])
    except Exception as e:
        print(f"  ChromaDB delete error: {e}")
    return 0


def retrieve_context(query: str, top_k: int = TOP_K) -> list:
    """Retrieve relevant chunks using ChromaDB's built-in semantic search."""
    if _collection.count() == 0:
        return []

    results = _collection.query(
        query_texts=[query],
        n_results=min(top_k, _collection.count()),
        include=["documents", "metadatas", "distances"]
    )

    context = []
    for i in range(len(results["ids"][0])):
        context.append({
            "text": results["documents"][0][i],
            "source_id": results["metadatas"][0][i]["source_id"],
            "source_title": results["metadatas"][0][i]["source_title"],
            "distance": results["distances"][0][i],
            "chunk_index": results["metadatas"][0][i]["chunk_index"],
        })

    return context


# ===================================================================
# CHAT HISTORY
# ===================================================================

def load_chat_history() -> list:
    if os.path.exists(CHAT_HISTORY_FILE):
        with open(CHAT_HISTORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def save_chat_message(role: str, text: str, citations: list = None) -> None:
    history = load_chat_history()
    history.append({
        "role": role,
        "text": text,
        "time": time.time(),
        "citations": citations or [],
    })
    with open(CHAT_HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(history, f, indent=2)


def clear_chat_history() -> None:
    if os.path.exists(CHAT_HISTORY_FILE):
        os.remove(CHAT_HISTORY_FILE)


# ===================================================================
# RESPONSE GENERATION
# ===================================================================

SYSTEM_PROMPT = """You are Swimming Brain, an expert AI swimming coach.
You help swimmers improve technique, build training plans, and understand swimming science.

RULES:
- Answer using the PROVIDED SOURCE CONTEXT when available
- Cite sources with [Source: title] format after relevant statements
- If no sources are relevant, answer from general swimming knowledge and say so
- Be specific about body position, timing, catch mechanics, and common errors
- For workouts, include warm-up, main set, and cool-down with intervals
- Keep responses practical, actionable, and encouraging
- Use proper swimming terminology (catch, pull, recovery, streamline, EVF, DPS, etc.)
"""


def _build_citations(context_chunks: list) -> list:
    seen = set()
    citations = []
    for chunk in context_chunks:
        if chunk["source_id"] not in seen:
            seen.add(chunk["source_id"])
            citations.append({
                "source_id": chunk["source_id"],
                "source_title": chunk["source_title"],
            })
    return citations


def generate_response(query: str, context_chunks: list, chat_history: list = None) -> dict:
    """Generate response — uses Gemini if available, otherwise returns raw passages."""

    if not context_chunks:
        no_source_msg = "I don't have any sources about that yet. Upload some swimming PDFs, coach notes, or articles and I'll be able to help!"
        # If Gemini is available, let it answer from general knowledge
        if _model:
            try:
                prompt = f"User question: {query}\n\nNo uploaded sources are available. Answer from your general swimming knowledge."
                response = _model.generate_content(
                    contents=prompt,
                    generation_config=genai.GenerationConfig(temperature=0.7, max_output_tokens=2048),
                    system_instruction=SYSTEM_PROMPT,
                )
                return {"response": response.text, "citations": [], "chunks_used": 0}
            except Exception:
                pass
        return {"response": no_source_msg, "citations": [], "chunks_used": 0}

    # Filter low-relevance chunks
    relevant = [c for c in context_chunks if c["distance"] < 1.5]
    if not relevant:
        relevant = context_chunks[:2]  # fallback to top 2

    citations = _build_citations(relevant)

    # --- Gemini AI path (free tier) ---
    if _model:
        try:
            # Build context block
            context_text = "\n\n".join(
                f"[Source: {c['source_title']}]\n{c['text']}" for c in relevant
            )

            # Include recent chat history
            history_text = ""
            if chat_history:
                recent = chat_history[-6:]
                history_text = "\n".join(
                    f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['text'][:500]}"
                    for m in recent
                )

            prompt = f"SOURCES:\n{context_text}\n\n"
            if history_text:
                prompt += f"RECENT CONVERSATION:\n{history_text}\n\n"
            prompt += f"User question: {query}"

            response = _model.generate_content(
                contents=prompt,
                generation_config=genai.GenerationConfig(temperature=0.7, max_output_tokens=2048),
                system_instruction=SYSTEM_PROMPT,
            )
            return {"response": response.text, "citations": citations, "chunks_used": len(relevant)}
        except Exception as e:
            print(f"  Gemini error, falling back to raw passages: {e}")

    # --- Fallback: raw passages (no AI) ---
    parts = [f"Here's what I found in your sources about **\"{query}\"**:\n"]
    for chunk in relevant:
        text = chunk["text"].strip()
        if len(text) > 800:
            text = text[:800].rsplit(" ", 1)[0] + "..."
        parts.append(f"**From: {chunk['source_title']}**")
        parts.append(text)
        parts.append("")

    return {"response": "\n".join(parts), "citations": citations, "chunks_used": len(relevant)}


# ===================================================================
# TOP-LEVEL ORCHESTRATION
# ===================================================================

def process_upload(file_path: str, filename: str, file_type: str, title: str = None) -> dict:
    source_id = uuid.uuid4().hex[:12]
    display_title = title or Path(filename).stem.replace("_", " ").replace("-", " ").title()

    if file_type == "pdf":
        text = extract_text_from_pdf(file_path)
    elif file_type == "txt":
        text = extract_text_from_txt(file_path)
    elif file_type == "image":
        metadata = {
            "id": source_id,
            "title": display_title,
            "type": "image",
            "filename": os.path.basename(file_path),
            "uploaded_at": time.time(),
            "chunk_count": 0,
        }
        add_source_to_index(source_id, metadata)
        return {"ok": True, "source": metadata}
    else:
        return {"error": f"Unsupported file type: {file_type}"}

    if not text.strip():
        return {"error": "Could not extract text. The file may be image-based."}

    chunks = chunk_text(text)
    if not chunks:
        return {"error": "No content to process."}

    metadata = {
        "id": source_id,
        "title": display_title,
        "type": file_type,
        "filename": os.path.basename(file_path),
        "uploaded_at": time.time(),
        "chunk_count": len(chunks),
    }
    store_chunks(source_id, chunks, metadata)
    add_source_to_index(source_id, metadata)

    print(f"  Processed: {display_title} — {len(chunks)} chunks stored")
    return {"ok": True, "source": metadata}


def process_note(title: str, content: str) -> dict:
    source_id = uuid.uuid4().hex[:12]
    safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", title.lower())[:50]
    filename = f"{source_id}_{safe_name}.txt"
    file_path = os.path.join(SOURCES_DIR, filename)

    full_text = f"{title}\n\n{content}"
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(full_text)

    chunks = chunk_text(full_text)
    if not chunks:
        return {"error": "Note content is empty."}

    metadata = {
        "id": source_id,
        "title": title,
        "type": "note",
        "filename": filename,
        "uploaded_at": time.time(),
        "chunk_count": len(chunks),
    }
    store_chunks(source_id, chunks, metadata)
    add_source_to_index(source_id, metadata)

    print(f"  Note saved: {title} — {len(chunks)} chunks stored")
    return {"ok": True, "source": metadata}


def delete_source(source_id: str) -> dict:
    source = get_source(source_id)
    if not source:
        return {"error": "Source not found"}

    file_path = os.path.join(SOURCES_DIR, source.get("filename", ""))
    if os.path.exists(file_path):
        os.remove(file_path)

    deleted = delete_source_chunks(source_id)
    remove_source_from_index(source_id)

    print(f"  Deleted: {source.get('title')} — {deleted} chunks removed")
    return {"ok": True, "deleted": source_id, "chunks_removed": deleted}


def ask(query: str) -> dict:
    """Search sources, generate AI response (if Gemini available), save to history."""
    history = load_chat_history()
    context = retrieve_context(query)
    result = generate_response(query, context, history)

    save_chat_message("user", query)
    save_chat_message("assistant", result["response"], result["citations"])

    return result
