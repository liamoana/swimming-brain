"""
Swimming Brain — Flask Application
Personal swimming knowledge base. Gemini free tier for AI chat (optional).
"""

import os
import uuid
from flask import Flask, request, jsonify, render_template
from werkzeug.utils import secure_filename
from dotenv import load_dotenv
import brain

load_dotenv()

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "swimming-brain-dev-key")

ALLOWED_EXTENSIONS = {"pdf", "txt"}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def get_file_type(filename):
    ext = filename.rsplit(".", 1)[1].lower()
    if ext == "pdf":
        return "pdf"
    return "txt"


# ===================================================================
# PAGES
# ===================================================================

@app.route("/")
def index():
    return render_template("index.html")


# ===================================================================
# SOURCE MANAGEMENT
# ===================================================================

@app.route("/api/sources", methods=["GET"])
def list_sources():
    sources = brain.get_all_sources()
    return jsonify({"ok": True, "sources": sources, "count": len(sources)})


@app.route("/api/sources/upload", methods=["POST"])
def upload_source():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    if not allowed_file(file.filename):
        return jsonify({"error": f"File type not allowed. Accepted: {', '.join(ALLOWED_EXTENSIONS)}"}), 400

    file.seek(0, 2)
    size = file.tell()
    file.seek(0)
    if size > MAX_FILE_SIZE:
        return jsonify({"error": "File too large. Maximum size: 10 MB"}), 400

    safe_name = f"{uuid.uuid4().hex[:8]}_{secure_filename(file.filename)}"
    file_path = os.path.join(brain.SOURCES_DIR, safe_name)
    file.save(file_path)

    title = request.form.get("title", "").strip() or None
    file_type = get_file_type(file.filename)

    try:
        result = brain.process_upload(file_path, safe_name, file_type, title)
        if "error" in result:
            if os.path.exists(file_path):
                os.remove(file_path)
            return jsonify(result), 400
        return jsonify(result)
    except Exception as e:
        if os.path.exists(file_path):
            os.remove(file_path)
        return jsonify({"error": f"Failed to process: {str(e)}"}), 500


@app.route("/api/sources/note", methods=["POST"])
def save_note():
    data = request.get_json()
    if not data:
        return jsonify({"error": "JSON body required"}), 400

    title = (data.get("title") or "").strip()
    content = (data.get("content") or "").strip()

    if not title:
        return jsonify({"error": "Title is required"}), 400
    if not content:
        return jsonify({"error": "Content is required"}), 400
    if len(title) > 200:
        return jsonify({"error": "Title must be under 200 characters"}), 400
    if len(content) > 50000:
        return jsonify({"error": "Content must be under 50,000 characters"}), 400

    try:
        result = brain.process_note(title, content)
        if "error" in result:
            return jsonify(result), 400
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": f"Failed to save note: {str(e)}"}), 500


@app.route("/api/sources/<source_id>", methods=["DELETE"])
def delete_source(source_id):
    try:
        result = brain.delete_source(source_id)
        if "error" in result:
            return jsonify(result), 404
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": f"Failed to delete: {str(e)}"}), 500


# ===================================================================
# CHAT
# ===================================================================

@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json()
    if not data:
        return jsonify({"error": "JSON body required"}), 400

    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"error": "Message is required"}), 400

    try:
        result = brain.ask(message)
        return jsonify({"ok": True, **result})
    except Exception as e:
        return jsonify({"error": f"Search error: {str(e)}"}), 500


@app.route("/api/chat/history", methods=["GET"])
def chat_history():
    messages = brain.load_chat_history()
    return jsonify({"ok": True, "messages": messages})


@app.route("/api/chat/clear", methods=["POST"])
def chat_clear():
    brain.clear_chat_history()
    return jsonify({"ok": True})


# ===================================================================
# SERVER
# ===================================================================

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))

    api_key = os.environ.get("GEMINI_API_KEY")

    print()
    print("=" * 55)
    print("  Swimming Brain")
    print("  Your Swimming Knowledge Base")
    if api_key:
        print("  Gemini AI: enabled (free tier)")
    else:
        print("  Gemini AI: off (search-only mode)")
        print("  Add GEMINI_API_KEY to .env for AI answers")
    print("=" * 55)

    brain.init_brain(api_key)

    print(f"  Sources: {len(brain.get_all_sources())} loaded")
    print(f"  Port: {port}")
    print("=" * 55)
    print()

    try:
        from waitress import serve
        print("  Server: Waitress (production)")
        serve(app, host="0.0.0.0", port=port, threads=4)
    except ImportError:
        print("  Server: Flask (development)")
        app.run(host="0.0.0.0", port=port, debug=True)
