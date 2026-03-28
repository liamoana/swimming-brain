/* ===================================================================
   Swimming Brain — UI Logic (static, no server, no API)
   =================================================================== */

let sending = false;
let selectedFile = null;

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

  if (window.innerWidth > 860) {
    const hidden = localStorage.getItem("sb-sidebar-hidden") === "true";
    if (hidden) $("#sidebar").style.display = "none";
  }
});

// ===================================================================
// SOURCES
// ===================================================================

function loadSources() {
  renderSourceList(Brain.getAllSources());
}

function renderSourceList(sources) {
  if (!sources.length) {
    sourceList.innerHTML = `
      <div class="no-sources">
        <p>No sources yet.</p>
        <p>Upload PDFs or type notes to build your swimming knowledge base.</p>
      </div>`;
    return;
  }

  sourceList.innerHTML = sources.map(s => {
    const icon = s.type === "pdf" ? "PDF" : s.type === "note" ? "NOTE" : "TXT";
    const date = new Date(s.uploadedAt).toLocaleDateString();
    return `
      <div class="source-item" data-id="${esc(s.id)}" onclick="showSourceOverview('${esc(s.id)}')">
        <div class="source-icon ${esc(s.type)}">${icon}</div>
        <div class="source-info">
          <div class="source-name" title="${esc(s.title)}">${esc(s.title)}</div>
          <div class="source-meta">${s.chunkCount} chunks &middot; ${date}</div>
        </div>
        <button class="source-delete" onclick="event.stopPropagation(); deleteSource('${esc(s.id)}')" title="Delete">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>`;
  }).join("");
}

function deleteSource(id) {
  if (!confirm("Delete this source?")) return;
  Brain.deleteSource(id);
  loadSources();
  showToast("Source deleted", "success");
}

// ===================================================================
// SOURCE OVERVIEW
// ===================================================================

function showSourceOverview(sourceId) {
  const overview = Brain.getSourceOverview(sourceId);
  if (!overview) return;

  const topicsHtml = overview.topics
    .map(t => `<span class="topic-tag">${esc(t.term)}</span>`)
    .join("");

  $("#overviewBody").innerHTML = `
    <h4 class="overview-title">${esc(overview.title)}</h4>
    <div class="overview-stats">
      <span>${overview.wordCount.toLocaleString()} words</span>
      <span>${overview.chunkCount} chunks</span>
      <span>${overview.type.toUpperCase()}</span>
    </div>
    <div class="overview-section">
      <h5>Key Topics</h5>
      <div class="topics-list">${topicsHtml || '<span class="no-data">No topics extracted</span>'}</div>
    </div>
    <div class="overview-section">
      <h5>Summary</h5>
      <p>${esc(overview.summary)}</p>
    </div>
  `;

  $("#sourceList").style.display = "none";
  $(".add-source-btn").style.display = "none";
  $("#sourceOverview").style.display = "block";
}

function hideSourceOverview() {
  $("#sourceOverview").style.display = "none";
  $("#sourceList").style.display = "";
  $(".add-source-btn").style.display = "";
}

// ===================================================================
// STUDY GUIDE
// ===================================================================

function showStudyGuide() {
  const guide = Brain.generateStudyGuide();
  if (!guide || !guide.sections.length) {
    showToast("Upload some sources first to generate a study guide", "error");
    return;
  }

  let html = `<div class="study-guide-body">`;
  html += `<p class="study-guide-intro">${guide.sourceCount} source${guide.sourceCount > 1 ? "s" : ""} analyzed</p>`;

  for (const section of guide.sections) {
    html += `<div class="study-section">`;
    html += `<h4>${esc(section.title)}</h4>`;
    html += `<p class="study-summary">${esc(section.summary)}</p>`;

    if (section.topics.length) {
      html += `<div class="study-topics">`;
      html += section.topics.map(t => `<span class="topic-tag">${esc(t.term)}</span>`).join("");
      html += `</div>`;
    }

    if (section.keyFacts.length) {
      html += `<h5>Key Facts</h5><ul>`;
      html += section.keyFacts.map(f => `<li>${esc(f)}</li>`).join("");
      html += `</ul>`;
    }

    if (section.faqEntries.length) {
      html += `<h5>Things to Practice</h5><ul>`;
      html += section.faqEntries.map(f => `<li>${esc(f)}</li>`).join("");
      html += `</ul>`;
    }

    html += `</div>`;
  }

  html += `</div>`;

  $("#studyGuideContent").innerHTML = html;
  $("#studyGuideModal").style.display = "flex";
}

function hideStudyGuide(e) {
  if (e && e.target !== $("#studyGuideModal")) return;
  $("#studyGuideModal").style.display = "none";
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

async function processFile() {
  if (!selectedFile) return;
  const btn = $("#uploadBtn");
  btn.disabled = true;
  btn.textContent = "Processing...";

  try {
    const title = $("#fileTitle").value.trim() || undefined;
    const source = await Brain.processFile(selectedFile, title);
    showToast(`"${source.title}" added (${source.chunkCount} chunks)`, "success");
    hideUploadModal();
    loadSources();
  } catch (e) {
    showToast(e.message || "Upload failed", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17,8 12,3 7,8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Upload & Process`;
  }
}

function saveNote() {
  const title = $("#noteTitle").value.trim();
  const content = $("#noteContent").value.trim();
  if (!title) return showToast("Add a title", "error");
  if (!content) return showToast("Add some content", "error");

  try {
    const source = Brain.processNote(title, content);
    showToast(`Note "${source.title}" saved`, "success");
    hideUploadModal();
    loadSources();
  } catch (e) {
    showToast(e.message || "Save failed", "error");
  }
}

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

function send() {
  const text = inp.value.trim();
  if (!text || sending) return;

  sending = true;
  sendBtn.disabled = true;
  inp.value = "";
  autoResize(inp);

  hideWelcome();
  addMsg(text, "user");
  showTyping();

  // Small delay so typing indicator is visible (extraction is instant)
  setTimeout(() => {
    try {
      const data = Brain.ask(text);
      hideTyping();
      addMsg(data.response, "bot", data.citations);
    } catch (e) {
      hideTyping();
      addMsg("Something went wrong. " + (e.message || ""), "bot");
    } finally {
      sending = false;
      sendBtn.disabled = !inp.value.trim();
    }
  }, 300);
}

function handleKey(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
}

function useSuggestion(btn) {
  inp.value = btn.textContent;
  sendBtn.disabled = false;
  send();
}

function loadChatHistory() {
  const messages = Brain.getHistory();
  if (messages.length > 0) {
    hideWelcome();
    messages.forEach(m => addMsg(m.text, m.role === "user" ? "user" : "bot", m.citations, false));
    scrollToBottom();
  }
}

function clearChat() {
  Brain.clearHistory();
  messagesEl.innerHTML = "";
  showWelcome();
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
          </span>`).join("")}</div>` : "";

    row.innerHTML = `
      <div class="msg-avatar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 0 1 7 7c0 3-2 5.5-4 7.5L12 22l-3-5.5C7 14.5 5 12 5 9a7 7 0 0 1 7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
      </div>
      <div class="msg-body">
        <div class="msg-text">${formatMd(text)}</div>
        ${citHtml}
      </div>`;
  } else {
    row.innerHTML = `<div class="msg-body"><div class="msg-text">${esc(text)}</div></div>`;
  }

  messagesEl.appendChild(row);
  scrollToBottom();
}

function formatMd(text) {
  if (!text) return "";
  let html = esc(text);
  html = html.replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\[Source:\s*([^\]]+)\]/g, '<span class="citation-chip" style="display:inline-flex;margin:0 2px;font-size:11px;padding:2px 8px;">$1</span>');
  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  return `<p>${html}</p>`;
}

// ===================================================================
// UI HELPERS
// ===================================================================

function showTyping() { typingEl.style.display = "flex"; scrollToBottom(); }
function hideTyping() { typingEl.style.display = "none"; }
function showWelcome() { welcomeEl.style.display = "flex"; messagesEl.style.display = "none"; }
function hideWelcome() { welcomeEl.style.display = "none"; messagesEl.style.display = "flex"; }

function scrollToBottom() {
  requestAnimationFrame(() => { chatArea.scrollTop = chatArea.scrollHeight; });
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

function toggleSidebar() {
  const sidebar = $("#sidebar");
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
  setTimeout(() => { toast.classList.add("removing"); setTimeout(() => toast.remove(), 300); }, 3000);
}

function esc(str) {
  if (!str) return "";
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}
