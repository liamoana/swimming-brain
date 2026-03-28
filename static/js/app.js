/* ===================================================================
   Swimming Brain — Frontend Logic
   =================================================================== */

// --- State ---
let sending = false;
let selectedFile = null;

// --- DOM refs ---
const $ = (s) => document.querySelector(s);
const inp = $("#inp");
const sendBtn = $("#sendBtn");
const chatArea = $("#chatArea");
const messagesEl = $("#messages");
const welcomeEl = $("#welcome");
const typingEl = $("#typing");
const sourceList = $("#sourceList");

// ===================================================================
// INIT
// ===================================================================

document.addEventListener("DOMContentLoaded", () => {
  loadSources();
  loadChatHistory();
  setupDragDrop();

  inp.addEventListener("input", () => {
    autoResize(inp);
    sendBtn.disabled = !inp.value.trim();
  });

  // Sidebar state from localStorage
  if (window.innerWidth > 860) {
    const hidden = localStorage.getItem("sb-sidebar-hidden") === "true";
    if (hidden) $("#sidebar").style.display = "none";
  }
});


// ===================================================================
// SOURCES
// ===================================================================

async function loadSources() {
  try {
    const res = await fetch("/api/sources");
    const data = await res.json();
    renderSourceList(data.sources || []);
  } catch (e) {
    console.error("Failed to load sources:", e);
  }
}

function renderSourceList(sources) {
  if (!sources.length) {
    sourceList.innerHTML = `
      <div class="no-sources">
        <p>No sources yet.</p>
        <p>Upload PDFs, notes, or images to build your swimming knowledge base.</p>
      </div>`;
    return;
  }

  sourceList.innerHTML = sources.map(s => {
    const icon = getSourceIcon(s.type);
    const chunks = s.chunk_count > 0 ? `${s.chunk_count} chunks` : "image";
    const date = new Date(s.uploaded_at * 1000).toLocaleDateString();
    return `
      <div class="source-item" data-id="${esc(s.id)}">
        <div class="source-icon ${esc(s.type)}">${icon}</div>
        <div class="source-info">
          <div class="source-name" title="${esc(s.title)}">${esc(s.title)}</div>
          <div class="source-meta">${chunks} &middot; ${date}</div>
        </div>
        <button class="source-delete" onclick="deleteSource('${esc(s.id)}')" title="Delete source">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>`;
  }).join("");
}

function getSourceIcon(type) {
  switch (type) {
    case "pdf": return "PDF";
    case "txt": return "TXT";
    case "note": return "NOTE";
    case "image": return "IMG";
    default: return "DOC";
  }
}

async function deleteSource(id) {
  if (!confirm("Delete this source? This removes it from your knowledge base.")) return;
  try {
    const res = await fetch(`/api/sources/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      showToast("Source deleted", "success");
      loadSources();
    } else {
      showToast(data.error || "Delete failed", "error");
    }
  } catch (e) {
    showToast("Delete failed", "error");
  }
}


// ===================================================================
// UPLOAD MODAL
// ===================================================================

function showUploadModal() {
  $("#uploadModal").style.display = "flex";
  switchTab("file");
  selectedFile = null;
  $("#filePreview").style.display = "none";
  $("#dropzone").style.display = "flex";
  $("#uploadBtn").disabled = true;
  $("#fileInput").value = "";
  $("#fileTitle").value = "";
  $("#noteTitle").value = "";
  $("#noteContent").value = "";
}

function hideUploadModal(e) {
  if (e && e.target !== $("#uploadModal")) return;
  $("#uploadModal").style.display = "none";
}

function switchTab(tab) {
  document.querySelectorAll(".modal-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  $("#tab-file").style.display = tab === "file" ? "block" : "none";
  $("#tab-note").style.display = tab === "note" ? "block" : "none";
}

function handleFileSelect(input) {
  if (input.files[0]) showFilePreview(input.files[0]);
}

function showFilePreview(file) {
  selectedFile = file;
  const ext = file.name.split(".").pop().toUpperCase();
  $("#fileIcon").textContent = ext;
  $("#fileName").textContent = file.name;
  $("#fileSize").textContent = formatFileSize(file.size);
  $("#dropzone").style.display = "none";
  $("#filePreview").style.display = "block";
  $("#uploadBtn").disabled = false;
}

function removeFile() {
  selectedFile = null;
  $("#fileInput").value = "";
  $("#filePreview").style.display = "none";
  $("#dropzone").style.display = "flex";
  $("#uploadBtn").disabled = true;
}

async function uploadFile() {
  if (!selectedFile) return;
  const btn = $("#uploadBtn");
  btn.disabled = true;
  btn.textContent = "Processing...";

  const form = new FormData();
  form.append("file", selectedFile);
  const title = $("#fileTitle").value.trim();
  if (title) form.append("title", title);

  try {
    const res = await fetch("/api/sources/upload", { method: "POST", body: form });
    const data = await res.json();
    if (data.ok) {
      showToast(`"${data.source.title}" added (${data.source.chunk_count} chunks)`, "success");
      hideUploadModal();
      loadSources();
    } else {
      showToast(data.error || "Upload failed", "error");
    }
  } catch (e) {
    showToast("Upload failed", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17,8 12,3 7,8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Upload & Process`;
  }
}

async function saveNote() {
  const title = $("#noteTitle").value.trim();
  const content = $("#noteContent").value.trim();
  if (!title) return showToast("Please add a title", "error");
  if (!content) return showToast("Please add some content", "error");

  const btn = $("#noteBtn");
  btn.disabled = true;
  btn.textContent = "Saving...";

  try {
    const res = await fetch("/api/sources/note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`Note "${data.source.title}" saved`, "success");
      hideUploadModal();
      loadSources();
    } else {
      showToast(data.error || "Save failed", "error");
    }
  } catch (e) {
    showToast("Save failed", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,8 15,8"/></svg> Save Note`;
  }
}

// Drag & drop
function setupDragDrop() {
  const dz = $("#dropzone");
  if (!dz) return;

  ["dragenter", "dragover"].forEach(ev =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag-over"); })
  );
  ["dragleave", "drop"].forEach(ev =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag-over"); })
  );
  dz.addEventListener("drop", (e) => {
    if (e.dataTransfer.files[0]) showFilePreview(e.dataTransfer.files[0]);
  });
}


// ===================================================================
// CHAT
// ===================================================================

async function send() {
  const text = inp.value.trim();
  if (!text || sending) return;

  sending = true;
  sendBtn.disabled = true;
  inp.value = "";
  autoResize(inp);

  hideWelcome();
  addMsg(text, "user");
  showTyping();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    const data = await res.json();
    hideTyping();

    if (data.ok) {
      addMsg(data.response, "bot", data.citations);
    } else {
      addMsg(data.error || "Something went wrong.", "bot");
    }
  } catch (e) {
    hideTyping();
    addMsg("Network error. Please check your connection.", "bot");
  } finally {
    sending = false;
    sendBtn.disabled = !inp.value.trim();
  }
}

function handleKey(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

function useSuggestion(btn) {
  inp.value = btn.textContent;
  sendBtn.disabled = false;
  send();
}

async function loadChatHistory() {
  try {
    const res = await fetch("/api/chat/history");
    const data = await res.json();
    if (data.messages && data.messages.length > 0) {
      hideWelcome();
      data.messages.forEach(m => addMsg(m.text, m.role === "user" ? "user" : "bot", m.citations, false));
      scrollToBottom();
    }
  } catch (e) {
    console.error("Failed to load history:", e);
  }
}

async function clearChat() {
  try {
    await fetch("/api/chat/clear", { method: "POST" });
    messagesEl.innerHTML = "";
    showWelcome();
  } catch (e) {
    showToast("Failed to clear chat", "error");
  }
}


// ===================================================================
// MESSAGE RENDERING
// ===================================================================

function addMsg(text, role, citations, animate = true) {
  const row = document.createElement("div");
  row.className = `msg-row ${role}`;
  if (!animate) row.style.animation = "none";

  if (role === "bot") {
    const citHtml = (citations && citations.length)
      ? `<div class="citations">${citations.map(c =>
          `<span class="citation-chip">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
            ${esc(c.source_title)}
          </span>`
        ).join("")}</div>`
      : "";

    row.innerHTML = `
      <div class="msg-avatar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 0 1 7 7c0 3-2 5.5-4 7.5L12 22l-3-5.5C7 14.5 5 12 5 9a7 7 0 0 1 7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
      </div>
      <div class="msg-body">
        <div class="msg-text">${formatMarkdown(text)}</div>
        ${citHtml}
      </div>`;
  } else {
    row.innerHTML = `
      <div class="msg-body">
        <div class="msg-text">${esc(text)}</div>
      </div>`;
  }

  messagesEl.appendChild(row);
  scrollToBottom();
}

function formatMarkdown(text) {
  if (!text) return "";
  // Basic markdown: bold, italic, lists, paragraphs, code, citations
  let html = esc(text);

  // Code blocks
  html = html.replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>");
  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // Citation highlights
  html = html.replace(/\[Source:\s*([^\]]+)\]/g, '<span class="citation-chip" style="display:inline-flex;margin:0 2px;font-size:11px;padding:2px 8px;">$1</span>');
  // Line breaks to paragraphs
  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  html = `<p>${html}</p>`;
  // Lists (basic)
  html = html.replace(/<p>(\d+)\.\s/g, "<p>$1. ");

  return html;
}


// ===================================================================
// UI HELPERS
// ===================================================================

function showTyping() { typingEl.style.display = "flex"; scrollToBottom(); }
function hideTyping() { typingEl.style.display = "none"; }

function showWelcome() { welcomeEl.style.display = "flex"; messagesEl.style.display = "none"; }
function hideWelcome() { welcomeEl.style.display = "none"; messagesEl.style.display = "flex"; }

function scrollToBottom() {
  requestAnimationFrame(() => {
    chatArea.scrollTop = chatArea.scrollHeight;
  });
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

function toggleSidebar() {
  const sidebar = $("#sidebar");
  const overlay = $("#overlay");
  if (window.innerWidth <= 860) {
    sidebar.classList.toggle("open");
  } else {
    const hidden = sidebar.style.display === "none";
    sidebar.style.display = hidden ? "" : "none";
    localStorage.setItem("sb-sidebar-hidden", hidden ? "false" : "true");
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("sb-theme", next);
}

function showToast(message, type = "success") {
  const container = $("#toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("removing");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function esc(str) {
  if (!str) return "";
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
