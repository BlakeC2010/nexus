#!/usr/bin/env python3
"""NEXUS - The Flow-State Architect"""

import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import os, json, uuid, datetime, re, base64, mimetypes, secrets, hashlib, random, io
import urllib.request, urllib.parse
from pathlib import Path
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory, session, Response, stream_with_context

def _import_google():
    from google import genai; from google.genai import types; return genai, types
def _import_openai():
    import openai; return openai
def _import_anthropic():
    import anthropic; return anthropic

# ─── Firebase / Firestore init ────────────────────────────────────────────────
import firebase_admin
from firebase_admin import credentials, firestore, storage as fb_storage

FIREBASE_ENABLED = False
db = None

WORKSPACE = Path(__file__).parent.resolve()
DATA_DIR = WORKSPACE / ".nexus_data"
SECRET_FILE = DATA_DIR / ".secret_key"
SESSION_SECRET_FILE = WORKSPACE / ".nexus_session_secret"

def _init_firebase():
    """Initialise Firebase once. Falls back to local file storage if not configured."""
    global FIREBASE_ENABLED, db
    if firebase_admin._apps:
        db = firestore.client()
        FIREBASE_ENABLED = True
        return
    sa_path = WORKSPACE / "serviceAccount.json"
    bucket = os.environ.get("FIREBASE_STORAGE_BUCKET", "").strip()
    if not bucket:
        ef = WORKSPACE / ".env"
        if ef.exists():
            for line in ef.read_text(encoding="utf-8").splitlines():
                if line.strip().startswith("FIREBASE_STORAGE_BUCKET="):
                    bucket = line.split("=", 1)[1].strip().strip('"\'')
    opts = {"storageBucket": bucket} if bucket else {}
    if sa_path.exists():
        cred = credentials.Certificate(str(sa_path))
    elif os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        cred = credentials.ApplicationDefault()
    else:
        print("  [!] Firebase not configured - using local file storage (.nexus_data/).")
        return
    try:
        firebase_admin.initialize_app(cred, opts)
        db = firestore.client()
        FIREBASE_ENABLED = True
    except Exception as e:
        print(f"  [!] Firebase init failed ({e}) - using local file storage.")

_init_firebase()

def _storage_bucket():
    if not FIREBASE_ENABLED: return None
    try:
        return fb_storage.bucket()
    except Exception:
        return None

# ─── Local file storage (fallback when Firebase not configured) ───────────────

def _local_user_dir(uid):
    d = DATA_DIR / "users" / uid
    d.mkdir(parents=True, exist_ok=True)
    return d

def _load_json(path, default=None):
    if default is None: default = {}
    try:
        return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default
    except Exception:
        return default

def _save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')

def _local_load_users():
    return _load_json(DATA_DIR / "users.json", {})

def _local_save_user(user):
    users = _local_load_users()
    users[user["id"]] = user
    _save_json(DATA_DIR / "users.json", users)

def _local_find_user_by_email(email):
    for u in _local_load_users().values():
        if u.get("email", "").lower() == email.lower():
            return u
    return None

def _local_load_user_by_id(uid):
    return _local_load_users().get(uid)

LEGACY_DEFAULT_GOOGLE_CLIENT_ID = "253818541787-cal4ulgrb5otqjj8htg55l8c6gvl750o.apps.googleusercontent.com"

IGNORED_DIRS = {".git", "__pycache__", ".venv", "venv", "node_modules",
                ".nexus_history", ".nexus_data", "static", "templates"}
IGNORED_FILES = {"nexus.py", "app.py", "requirements.txt", ".env", ".gitignore"}
MAX_CONTEXT_CHARS = 900_000
DEFAULT_MODEL = "gemini-3-flash-preview"

GUEST_MODEL = "gemini-3-flash-preview"

MODELS = {
    # Google — free tier (server API key, no per-user cost)
    "gemini-3-flash-preview":  {"provider": "google",    "label": "Gemini 3 Flash",    "tier": "free"},
    "gemini-3.1-pro-preview":  {"provider": "google",    "label": "Gemini 3.1 Pro",    "tier": "free"},
    # Google — pro tier
    "gemini-2.5-flash":        {"provider": "google",    "label": "Gemini 2.5 Flash",   "tier": "pro"},
    "gemini-2.5-pro":          {"provider": "google",    "label": "Gemini 2.5 Pro",     "tier": "pro"},
    # OpenAI — pro tier
    "gpt-5.4-mini":            {"provider": "openai",    "label": "GPT-5.4 Mini",       "tier": "pro"},
    "gpt-5.4":                 {"provider": "openai",    "label": "GPT-5.4",            "tier": "pro"},
    # Anthropic — pro tier
    "claude-sonnet-4-6":       {"provider": "anthropic", "label": "Claude Sonnet 4.6",  "tier": "pro"},
    "claude-opus-4-6":         {"provider": "anthropic", "label": "Claude Opus 4.6",    "tier": "pro"},
}

app = Flask(__name__, static_folder="static")
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024

# In-memory guest runtime state (never persisted)
GUEST_RUNTIME = {}

def _ensure_dirs():
    DATA_DIR.mkdir(exist_ok=True)

def _get_secret():
    _ensure_dirs()
    # Prefer a workspace-level secret so auth survives data-folder cleanup.
    if SESSION_SECRET_FILE.exists():
        key = SESSION_SECRET_FILE.read_text(encoding="utf-8").strip()
        if key and not SECRET_FILE.exists():
            SECRET_FILE.write_text(key, encoding="utf-8")
        return key
    if SECRET_FILE.exists():
        key = SECRET_FILE.read_text(encoding="utf-8").strip()
        if key:
            SESSION_SECRET_FILE.write_text(key, encoding="utf-8")
            return key
    k = secrets.token_hex(32)
    SECRET_FILE.write_text(k, encoding="utf-8")
    SESSION_SECRET_FILE.write_text(k, encoding="utf-8")
    return k

app.secret_key = _get_secret()
app.config["PERMANENT_SESSION_LIFETIME"] = datetime.timedelta(days=30)
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_NAME"] = "nexus_session"

# ─── Auth helpers ─────────────────────────────────────────────────────────────

def _hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    return hashlib.sha256((salt + pw).encode()).hexdigest(), salt

# ─── Firestore user helpers ───────────────────────────────────────────────────

def _users_col():
    if not FIREBASE_ENABLED: return None
    return db.collection("users")

def _user_doc(uid):
    col = _users_col()
    if col is None: return None
    return col.document(uid)

def _find_user_by_email(email):
    if not FIREBASE_ENABLED:
        return _local_find_user_by_email(email)
    ref = db.collection("user_emails").document(email.lower())
    snap = ref.get()
    if not snap.exists: return None
    uid = snap.to_dict().get("uid")
    if not uid: return None
    usnap = _user_doc(uid).get()
    return usnap.to_dict() if usnap.exists else None

def _save_user(user):
    if not FIREBASE_ENABLED:
        _local_save_user(user)
        return
    _user_doc(user["id"]).set(user)
    db.collection("user_emails").document(user["email"]).set({"uid": user["id"]})

def _load_user_by_id(uid):
    if not FIREBASE_ENABLED:
        return _local_load_user_by_id(uid)
    snap = _user_doc(uid).get()
    return snap.to_dict() if snap.exists else None

def _update_user_field(uid, **fields):
    """Update fields on a user record (works for both storage backends)."""
    if not uid: return
    if not FIREBASE_ENABLED:
        user = _local_load_user_by_id(uid)
        if user:
            user.update(fields)
            _local_save_user(user)
        return
    _user_doc(uid).update(fields)

def _safe_id(s):
    return bool(s and re.match(r'^[a-zA-Z0-9\-_]{1,36}$', s))

def create_user(email, pw, name="", provider="local"):
    if _find_user_by_email(email):
        return None, "Account already exists with this email"
    uid = str(uuid.uuid4())[:12]
    h, s = _hash_pw(pw) if pw else ("", "")
    user = {"id": uid, "email": email.lower(), "name": name or email.split("@")[0],
            "password_hash": h, "salt": s, "provider": provider,
            "created": datetime.datetime.now().isoformat(), "theme": "dark", "plan": "free"}
    _save_user(user)
    return user, None

def verify_pw(email, pw):
    u = _find_user_by_email(email)
    if not u or not u.get("password_hash"): return None
    h, _ = _hash_pw(pw, u["salt"])
    return u if h == u["password_hash"] else None

def oauth_user(email, name, provider):
    existing = _find_user_by_email(email)
    if existing:
        return existing
    uid = str(uuid.uuid4())[:12]
    user = {"id": uid, "email": email.lower(), "name": name or email.split("@")[0],
            "password_hash": "", "salt": "", "provider": provider,
            "created": datetime.datetime.now().isoformat(), "theme": "dark", "plan": "free"}
    _save_user(user)
    return user

def require_auth(f):
    @wraps(f)
    def dec(*args, **kw):
        if not session.get("user_id"):
            return jsonify({"error": "Not authenticated"}), 401
        return f(*args, **kw)
    return dec

def require_auth_or_guest(f):
    @wraps(f)
    def dec(*args, **kw):
        if not session.get("user_id") and not session.get("guest"):
            return jsonify({"error": "Not authenticated"}), 401
        return f(*args, **kw)
    return dec

# ~20k tokens/day ≈ 80 typical exchanges with the lite model
GUEST_TOKEN_LIMIT = 20_000

def _guest_runtime_state():
    guest_id = session.get("guest_id")
    if not guest_id:
        return None
    state = GUEST_RUNTIME.setdefault(guest_id, {
        "date": datetime.date.today().isoformat(),
        "tokens": 0,
        "chats": {},
    })
    today = datetime.date.today().isoformat()
    if state.get("date") != today:
        state["date"] = today
        state["tokens"] = 0
    return state

def _guest_tokens_used():
    state = _guest_runtime_state()
    if not state:
        return 0
    return int(state.get("tokens", 0))

def _add_guest_tokens(n):
    state = _guest_runtime_state()
    if not state:
        return
    state["tokens"] = int(state.get("tokens", 0)) + max(0, int(n))

def _cur_user():
    uid = session.get("user_id")
    if not uid:
        if session.get("guest"):
            return {"id": "guest", "name": "Guest", "email": "", "provider": "guest"}
        return None
    return _load_user_by_id(uid)

# Store OAuth config in Firestore (or local file)
def _load_oauth():
    if not FIREBASE_ENABLED:
        return _load_json(DATA_DIR / "oauth.json", {})
    snap = db.collection("config").document("oauth").get()
    return snap.to_dict() if snap.exists else {}

def _save_oauth(cfg):
    if not FIREBASE_ENABLED:
        _save_json(DATA_DIR / "oauth.json", cfg)
        return
    db.collection("config").document("oauth").set(cfg)

# ─── Per-user data ────────────────────────────────────────────────────────────

def _uid_doc(sub):
    """Return a Firestore DocumentReference for the current user's sub-document."""
    uid = session.get("user_id")
    if not uid:
        return None
    return _user_doc(uid).collection("data").document(sub)

def load_settings():
    uid = session.get("user_id")
    defaults = {"keys": {}, "selected_model": DEFAULT_MODEL, "custom_endpoints": []}
    if not uid: return defaults
    if not FIREBASE_ENABLED:
        s = _load_json(_local_user_dir(uid) / "settings.json", {})
        for k, v in defaults.items(): s.setdefault(k, v)
        return s
    ref = _uid_doc("settings")
    snap = ref.get()
    s = snap.to_dict() if snap.exists else {}
    for k, v in defaults.items(): s.setdefault(k, v)
    return s

def save_settings(s):
    if not FIREBASE_ENABLED:
        uid = session.get("user_id")
        if uid: _save_json(_local_user_dir(uid) / "settings.json", s)
        return
    ref = _uid_doc("settings")
    if ref: ref.set(s)

def _load_server_key(provider):
    """Load a server-side API key from environment or .env file."""
    env_map = {"google": "GEMINI_API_KEY", "openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY"}
    env_name = env_map.get(provider, "")
    if not env_name:
        return ""
    val = os.environ.get(env_name, "").strip()
    if val:
        return val
    ef = WORKSPACE / ".env"
    if ef.exists():
        for line in ef.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith(f"{env_name}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""

def _load_default_google_key():
    return _load_server_key("google")

def _load_google_client_id_env():
    val = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    if val:
        return val
    ef = WORKSPACE / ".env"
    if ef.exists():
        for line in ef.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("GOOGLE_CLIENT_ID="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""

def _effective_google_client_id(cfg=None):
    cfg = cfg or {}
    return (
        _load_google_client_id_env()
        or (cfg.get("google_client_id") or "").strip()
        or LEGACY_DEFAULT_GOOGLE_CLIENT_ID
    )

def _get_current_user_plan():
    uid = session.get("user_id")
    if not uid:
        return "guest" if session.get("guest") else "none"
    user = _load_user_by_id(uid)
    return user.get("plan", "free") if user else "free"

def resolve_provider_key(settings, provider):
    saved = (settings.get("keys", {}).get(provider, "") or "").strip()
    if saved:
        return saved, "user"
    if provider != "custom":
        server_key = _load_server_key(provider)
        if server_key:
            return server_key, "server"
    return "", ""

def model_access(model_id, settings):
    plan = _get_current_user_plan()

    if model_id.startswith("custom:"):
        ep_name = model_id.split(":", 1)[1]
        endpoint = next((e for e in settings.get("custom_endpoints", []) if e.get("name") == ep_name), None)
        if not endpoint:
            return False, "Custom endpoint not found.", ""
        api_key, source = resolve_provider_key(settings, "custom")
        if api_key:
            return True, "", source
        return False, "Add your own gateway API key to use custom endpoints.", ""

    info = MODELS.get(model_id)
    if not info:
        return False, f"Unknown model: {model_id}", ""

    provider = info["provider"]
    tier = info.get("tier", "pro")

    # User-provided key always works regardless of plan
    user_key = (settings.get("keys", {}).get(provider, "") or "").strip()
    if user_key:
        return True, "", "user"

    if tier == "free":
        server_key = _load_server_key(provider)
        if server_key:
            return True, "", "server"
        return False, f"No {provider} API key configured on this server.", ""

    # Pro-tier model — requires pro/max plan
    if plan in ("pro", "max"):
        server_key = _load_server_key(provider)
        if server_key:
            return True, "", "server"
        return False, f"No server-side {provider.title()} key configured. Contact the site admin.", ""

    # Plan insufficient
    return False, "upgrade_required", ""

def normalize_selected_model(settings):
    selected = settings.get("selected_model") or DEFAULT_MODEL
    allowed, _, _ = model_access(selected, settings)
    return selected if allowed else DEFAULT_MODEL

def load_memory():
    uid = session.get("user_id")
    default = {"facts": [], "updated": None}
    if not uid: return default
    if not FIREBASE_ENABLED:
        m = _load_json(_local_user_dir(uid) / "memory.json", default)
        m.setdefault("facts", [])
        return m
    ref = _uid_doc("memory")
    if not ref: return default
    snap = ref.get()
    if snap.exists:
        data = snap.to_dict()
        data.setdefault("facts", [])
        return data
    return default

def save_memory(m):
    if not FIREBASE_ENABLED:
        uid = session.get("user_id")
        if not uid: return
        m["updated"] = datetime.datetime.now().isoformat()
        _save_json(_local_user_dir(uid) / "memory.json", m)
        return
    ref = _uid_doc("memory")
    if not ref: return
    m["updated"] = datetime.datetime.now().isoformat()
    ref.set(m)

def load_profile():
    default = {
        "onboarding_complete": False,
        "preferred_name": "",
        "what_you_do": "",
        "hobbies": "",
        "current_focus": "",
        "updated": None,
    }
    uid = session.get("user_id")
    if not uid: return default
    if not FIREBASE_ENABLED:
        p = _load_json(_local_user_dir(uid) / "profile.json", {})
        for k, v in default.items(): p.setdefault(k, v)
        return p
    ref = _uid_doc("profile")
    if not ref: return default
    snap = ref.get()
    p = snap.to_dict() if snap.exists else {}
    for k, v in default.items(): p.setdefault(k, v)
    return p

def save_profile(p):
    if not FIREBASE_ENABLED:
        uid = session.get("user_id")
        if not uid: return
        p["updated"] = datetime.datetime.now().isoformat()
        _save_json(_local_user_dir(uid) / "profile.json", p)
        return
    ref = _uid_doc("profile")
    if not ref: return
    p["updated"] = datetime.datetime.now().isoformat()
    ref.set(p)

def _save_user_name(name):
    uid = session.get("user_id")
    if not uid: return False
    _update_user_field(uid, name=name)
    return True

def _chats_col():
    if not FIREBASE_ENABLED: return None
    uid = session.get("user_id")
    if not uid: return None
    return _user_doc(uid).collection("chats")

def list_chats():
    if session.get("guest") and not session.get("user_id"): return []
    uid = session.get("user_id")
    if not uid: return []
    if not FIREBASE_ENABLED:
        chats_dir = _local_user_dir(uid) / "chats"
        if not chats_dir.exists(): return []
        chats = []
        for f in chats_dir.glob("*.json"):
            try:
                m = _load_json(f, {})
                if m:
                    chats.append({"id": m.get("id", f.stem), "title": m.get("title", "Untitled"),
                        "created": m.get("created"), "updated": m.get("updated"),
                        "model": m.get("model", ""), "folder": m.get("folder", ""),
                        "message_count": len(m.get("messages", []))})
            except Exception: pass
        chats.sort(key=lambda x: x.get("updated") or "", reverse=True)
        return chats
    col = _chats_col()
    if not col: return []
    docs = col.order_by("updated", direction=firestore.Query.DESCENDING).stream()
    chats = []
    for doc in docs:
        m = doc.to_dict()
        chats.append({"id": doc.id, "title": m.get("title", "Untitled"),
            "created": m.get("created"), "updated": m.get("updated"),
            "model": m.get("model", ""), "folder": m.get("folder", ""),
            "message_count": len(m.get("messages", []))})
    return chats

def load_chat(cid):
    if not _safe_id(cid): return None
    if session.get("guest") and not session.get("user_id"):
        state = _guest_runtime_state() or {}
        return (state.get("chats") or {}).get(cid)
    uid = session.get("user_id")
    if not uid: return None
    if not FIREBASE_ENABLED:
        return _load_json(_local_user_dir(uid) / "chats" / f"{cid}.json", None)
    col = _chats_col()
    if not col: return None
    snap = col.document(cid).get()
    return snap.to_dict() if snap.exists else None

def save_chat(c):
    if session.get("guest") and not session.get("user_id"):
        state = _guest_runtime_state()
        if not state: return
        c["updated"] = datetime.datetime.now().isoformat()
        state.setdefault("chats", {})[c["id"]] = c
        return
    uid = session.get("user_id")
    if not uid: return
    if not FIREBASE_ENABLED:
        c["updated"] = datetime.datetime.now().isoformat()
        _save_json(_local_user_dir(uid) / "chats" / f"{c['id']}.json", c)
        return
    col = _chats_col()
    if not col: return
    c["updated"] = datetime.datetime.now().isoformat()
    col.document(c["id"]).set(c)

def delete_chat(cid):
    if not _safe_id(cid): return False
    if session.get("guest") and not session.get("user_id"):
        state = _guest_runtime_state() or {}
        chats = state.get("chats") or {}
        if cid in chats:
            del chats[cid]; return True
        return False
    uid = session.get("user_id")
    if not uid: return False
    if not FIREBASE_ENABLED:
        cf = _local_user_dir(uid) / "chats" / f"{cid}.json"
        if cf.exists(): cf.unlink(); return True
        return False
    col = _chats_col()
    if not col: return False
    col.document(cid).delete()
    return True

def create_new_chat(model=None, folder=""):
    s = load_settings()
    if session.get("guest") and not session.get("user_id"):
        model = GUEST_MODEL
    return {"id": str(uuid.uuid4())[:12], "title": "New Chat",
            "created": datetime.datetime.now().isoformat(),
            "updated": datetime.datetime.now().isoformat(),
            "model": model or normalize_selected_model(s),
            "messages": [], "folder": folder}

# ─── Workspace (shared) ──────────────────────────────────────────────────────

def read_workspace_files():
    files = {}; total = 0
    for root, dirs, fnames in os.walk(WORKSPACE):
        dirs[:] = [d for d in dirs if d not in IGNORED_DIRS]
        for fn in sorted(fnames):
            if fn in IGNORED_FILES: continue
            if not fn.endswith((".md", ".txt", ".yaml", ".yml", ".json")): continue
            fp = Path(root) / fn; rp = fp.relative_to(WORKSPACE)
            try: content = fp.read_text(encoding="utf-8")
            except: continue
            if total + len(content) > MAX_CONTEXT_CHARS: break
            files[str(rp)] = content; total += len(content)
    return files

def format_workspace_context(files):
    if not files: return "(The command center is empty.)"
    return "\n".join(f"=== FILE: {p} ===\n{c}\n" for p, c in sorted(files.items()))

# ─── KAIRO System Prompt ─────────────────────────────────────────────────────

def build_system_prompt(memory=None):
    for name in ("NEXUS_INSTRUCTIONS.md", "KAIRO_INSTRUCTIONS.md", "nexus_INSTRUCTIONS.md"):
        f = WORKSPACE / name
        if f.exists():
            custom = f.read_text(encoding="utf-8"); break
    else:
        custom = ""

    mem_section = ""
    if memory and memory.get("facts"):
        mem_section = "\n\n[PERSISTENT MEMORY]\n" + "\n".join(
            f"{i}. {f}" for i, f in enumerate(memory["facts"], 1))

    user = _cur_user()
    uname = user.get("name", "there") if user else "there"

    return f"""You are Nexus — The Flow-State Architect. Project NEXUS.

Your name means "connection point" — the critical link between thought and action.
Unlike passive assistants, you actively identify friction and remove it.

Core philosophy: Momentum is everything. Wasted motion is the enemy. Every interaction should move the user closer to flow state.

Personality:
- Friendly, calm, and easy to talk to
- Clear and concise, but never cold or robotic
- Warm, encouraging, and genuinely helpful
- Break overwhelming tasks into 30-second starting points to trigger momentum
- When the user procrastinates, don't nag — find the smallest actionable step
- Think in systems, patterns, and leverage points
- Sound like a smart, supportive strategist who makes things feel simpler
- Prefer plain, natural language over stiff or overly formal wording
- If the user seems uncertain, meet them where they are and reduce friction immediately
- When the user says something casual ("hi", "hey", "what's up", etc.), respond warmly and naturally — match their energy, don't immediately pivot to work or productivity
- Small talk is fine. Not every message is about tasks or goals — engage like a real person first

Capabilities:
1. READ workspace files (provided as context) to understand the user's world
2. CREATE new files when information needs a home
3. UPDATE existing files when information changes
4. GENERATE briefings, summaries, and strategic insights
5. ROUTE brain dumps — figure out which files to update/create
6. GENERATE mind maps in ```mermaid blocks
7. ANALYZE uploaded files
8. IDENTIFY FRICTION — notice what's slowing the user down and suggest fixes
9. Multiple-choice (VERY rarely — only for genuine branching decisions where the user is stuck and there are 2-4 clearly distinct paths that would lead to very different outcomes). DO NOT use choices for:
   - Asking clarifying questions
   - Acknowledging a request before doing it
   - Offering to help in different ways
   - Any time a direct response works better
   - Simple greetings or casual messages ("hi", "hey", "how are you", "what's up")
   - Any message that doesn't involve a real decision with meaningfully different outcomes
   Default to just answering directly. Choices should be the exception, not the rule. When in doubt, skip them.

Multiple-choice format (only when truly needed):
<<<CHOICES>>>
Option A text
Option B text
<<<END_CHOICES>>>

10. Tool mode prefixes — the user may start a message with a tool prefix:
- [Use Canvas]: Put ALL code or document content in a single ```language code block so it opens in the side canvas editor. Do NOT add explanation around the code — just the code block with a brief intro line.
- [Search the web]: Reference your knowledge or provide the most current info available, citing sources when possible.
- [Create a mind map]: Immediately generate a ```mermaid mindmap block for the topic. Do not ask for the topic — use whatever subject is most relevant from context or the message. If the message says "about a topic I choose" just pick the most interesting topic you know about.
- [Summarize]: Provide a concise summary.

File operations format:
<<<FILE_CREATE: path/to/file.md>>>
(content)
<<<END_FILE>>>

<<<FILE_UPDATE: path/to/file.md>>>
(full updated content)
<<<END_FILE>>>

Memory saves:
<<<MEMORY_ADD: fact to remember>>>

Output Quality Rules:
- Think step by step before answering. For complex or multi-part questions, reason through it before giving your final answer.
- NEVER cut off your response mid-sentence or mid-thought. If a response needs to be long, complete it fully. Never truncate.
- When writing code: always output COMPLETE, runnable files. Never use "# ... rest of code here" or "// existing code unchanged" placeholders — write the entire file every time.
- Be specific and concrete. Vague answers waste the user's time — give precise, actionable information.
- When you create something worth saving (a plan, a document, code, notes), proactively use FILE_CREATE or FILE_UPDATE to save it rather than just printing it.
- Your knowledge cutoff is March 2026. You are aware of recent AI models, frameworks, and events up to that date.

Workspace File Rules:
- Relative paths from workspace root
- people/firstname_lastname.md for people files
- decisions/YYYY-MM-DD_description.md for decisions
- projects/project_name.md for projects
- STATUS.md = central operational status
- PRINCIPLES.md = core values and decision heuristics
- Lead with action or insight, not explanation
- Be approachable and conversational while staying useful
- Be specific and actionable in briefings

Session Info:
- The user's name is {uname}
- Today: {datetime.date.today().isoformat()}
- Always try to help. Don't refuse unless the request is clearly and unambiguously harmful. Lean toward engaging creatively with unusual, edgy, or unconventional requests — curiosity beats caution. When in doubt, just answer.
- Never lecture or moralize. If something seems edgy but isn't actually harmful, engage with it directly without caveats or disclaimers.
{mem_section}
{f"Custom instructions:{chr(10)}{custom}" if custom else ""}"""


def fallback_chat_title(user_text, assistant_text=""):
    text = (user_text or assistant_text or "New Chat").strip()
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"^[^A-Za-z0-9]+", "", text)
    if not text:
        return "New Chat"
    words = text.split()
    title = " ".join(words[:6])
    return title[:48].strip(" -:,.?") or "New Chat"


def generate_chat_title(api_key, provider, model_name, base_url, user_text, assistant_text):
    prompt = (
        "Create a short, friendly chat title for this conversation. "
        "Return only the title, no quotes, no punctuation at the end, 2 to 6 words max.\n\n"
        f"User: {user_text[:400]}\n"
        f"Assistant: {assistant_text[:400]}"
    )
    title_messages = [{"role": "user", "text": prompt}]
    title_system = (
        "You write concise conversation titles. "
        "Keep them specific, natural, and easy to scan."
    )
    try:
        # Always use gemini-2.0-flash-lite for titles if a Google key is available
        g_key = load_settings().get("keys", {}).get("google", "")
        if g_key:
            raw_title = call_google(g_key, "gemini-2.0-flash-lite", title_system, title_messages)
        else:
            raw_title = PROVIDERS.get(provider, call_openai)(
                api_key, model_name, title_system, title_messages, base_url=base_url
            )
        title = re.sub(r"\s+", " ", (raw_title or "").strip())
        title = title.strip('"\'` ')
        title = re.sub(r"[\r\n]+", " ", title)
        title = re.sub(r"[.!?]+$", "", title)
        if not title:
            return fallback_chat_title(user_text, assistant_text)
        return title[:48]
    except Exception:
        return fallback_chat_title(user_text, assistant_text)

# ─── File Operations ─────────────────────────────────────────────────────────

def execute_file_operations(text):
    ops = []
    for pat in (r'<<<FILE_CREATE:\s*(.+?)>>>\n(.*?)<<<END_FILE>>>',
                r'<<<FILE_UPDATE:\s*(.+?)>>>\n(.*?)<<<END_FILE>>>'):
        for m in re.finditer(pat, text, re.DOTALL):
            ops.append((m.group(1).strip(), m.group(2).strip()))
    executed = []
    for rel, content in ops:
        clean = Path(rel).as_posix()
        if ".." in clean or clean.startswith("/"): continue
        fp = WORKSPACE / clean
        action = "Created" if not fp.exists() else "Updated"
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(content + "\n", encoding="utf-8")
        executed.append({"action": action, "path": clean})
    return executed

def extract_memory_ops(text):
    return [m.group(1).strip() for m in re.finditer(r'<<<MEMORY_ADD:\s*(.+?)>>>', text)]

def clean_response(text):
    text = re.sub(r'<<<FILE_CREATE:\s*.+?>>>.*?<<<END_FILE>>>', '', text, flags=re.DOTALL)
    text = re.sub(r'<<<FILE_UPDATE:\s*.+?>>>.*?<<<END_FILE>>>', '', text, flags=re.DOTALL)
    text = re.sub(r'<<<MEMORY_ADD:\s*.+?>>>', '', text)
    return text.strip()

def _google_contents_from_messages(messages, types):
    contents = []
    for msg in messages:
        role = "user" if msg["role"] == "user" else "model"
        parts = []
        if msg.get("text"):
            parts.append(types.Part.from_text(text=msg["text"]))
        for img in msg.get("images", []):
            try:
                parts.append(types.Part.from_bytes(data=base64.b64decode(img["data"]), mime_type=img["mime"]))
            except:
                pass
        if msg.get("file_text"):
            parts.append(types.Part.from_text(text=f"[Attached: {msg.get('file_name','')}]\n{msg['file_text']}"))
        if parts:
            contents.append(types.Content(role=role, parts=parts))
    return contents

def resolve_chat_model(chat, settings):
    # Guests are always on the lite model regardless of what they select
    if session.get("guest") and not session.get("user_id"):
        model_id = GUEST_MODEL
    else:
        model_id = chat.get("model") or normalize_selected_model(settings)
    allowed, reason, source = model_access(model_id, settings)
    if not allowed:
        return {"error": reason, "model_id": model_id}

    if model_id.startswith("custom:"):
        ep_name = model_id.split(":", 1)[1]
        ep = next((e for e in settings.get("custom_endpoints", []) if e["name"] == ep_name), None)
        if not ep:
            return {"error": "Custom endpoint not found.", "model_id": model_id}
        api_key, _ = resolve_provider_key(settings, "custom")
        return {
            "model_id": model_id,
            "provider": ep.get("provider_type", "openai"),
            "actual_model": ep.get("model", ""),
            "base_url": ep.get("base_url"),
            "api_key": api_key,
            "key_source": source,
        }

    model_info = MODELS.get(model_id)
    provider = model_info["provider"]
    api_key, source = resolve_provider_key(settings, provider)
    return {
        "model_id": model_id,
        "provider": provider,
        "actual_model": model_id,
        "base_url": None,
        "api_key": api_key,
        "key_source": source,
    }

def prepare_chat_turn(chat, payload):
    user_text = (payload.get("message") or "").strip()
    attached = payload.get("files", [])
    if not user_text and not attached:
        return None, jsonify({"error": "Empty"}), 400

    settings = load_settings()
    resolved = resolve_chat_model(chat, settings)
    if resolved.get("error"):
        return None, jsonify({"reply": resolved["error"], "files": [], "locked": True}), 403

    user_msg = {"role": "user", "text": user_text, "timestamp": datetime.datetime.now().isoformat()}
    images = []
    file_texts = []
    for f in attached:
        mime = f.get("mime", "")
        if mime.startswith("image/"):
            images.append({"data": f["data"], "mime": mime})
        elif f.get("text"):
            file_texts.append(f"[File: {f['name']}]\n{f['text']}")
    if images:
        user_msg["images"] = images
    if file_texts:
        user_msg["file_text"] = "\n\n".join(file_texts)
        user_msg["file_name"] = ", ".join(f["name"] for f in attached if f.get("text"))

    # --- Thinking & web-search flags ---
    thinking = payload.get("thinking", False)
    web_search = payload.get("web_search", False)
    if not thinking and user_text:
        thinking = _detect_complex_query(user_text)
    if not web_search and "[search the web]" in user_text.lower():
        web_search = True

    # --- Workspace context: inject only relevant files (capped at 40k chars) ---
    all_files = read_workspace_files()
    relevant = select_relevant_files(user_text, all_files, max_chars=40_000)
    ws = format_workspace_context(relevant)

    memory = load_memory()
    sysprompt = build_system_prompt(memory)

    # --- Chat history: summarize old messages if conversation is long ---
    messages = chat["messages"]
    if len(messages) > 20:
        if ("summary_cache" not in chat or
                chat.get("summary_at") != len(messages) - 10):
            chat["summary_cache"] = _summarize_messages(messages[:-10], resolved)
            chat["summary_at"] = len(messages) - 10
        api_msgs = [
            {"role": "user", "text": f"[CONVERSATION SUMMARY]\n{chat['summary_cache']}"},
            {"role": "assistant", "text": "Got it, I have the context from our earlier conversation."},
        ] + list(messages[-10:])
    else:
        api_msgs = list(messages[-20:])

    cur = dict(user_msg)
    cur["text"] = f"[WORKSPACE CONTEXT]\n{ws}\n\n[USER MESSAGE]\n{user_text}"
    if file_texts:
        cur["text"] += "\n\n" + "\n\n".join(file_texts)
    api_msgs.append(cur)

    return {
        "user_text": user_text,
        "attached": attached,
        "settings": settings,
        "resolved": resolved,
        "user_msg": user_msg,
        "memory": memory,
        "sysprompt": sysprompt,
        "api_msgs": api_msgs,
        "thinking": thinking,
        "web_search": web_search,
    }, None, None

def finalize_chat_response(chat, ctx, raw_response):
    executed = execute_file_operations(raw_response)
    new_facts = extract_memory_ops(raw_response)
    if new_facts:
        for fact in new_facts:
            if fact not in ctx["memory"]["facts"]:
                ctx["memory"]["facts"].append(fact)
        save_memory(ctx["memory"])

    clean = clean_response(raw_response)
    if not chat["messages"] and ctx["user_text"]:
        resolved = ctx["resolved"]
        chat["title"] = generate_chat_title(
            resolved["api_key"],
            resolved["provider"],
            resolved["actual_model"],
            resolved["base_url"],
            ctx["user_text"],
            clean,
        )

    chat["messages"].append(ctx["user_msg"])
    chat["messages"].append({
        "role": "model",
        "text": clean,
        "timestamp": datetime.datetime.now().isoformat(),
        "files_modified": executed,
        "memory_added": new_facts or None,
    })
    save_chat(chat)
    # Track token usage for guests (estimate: 1 token ≈ 4 chars)
    if session.get("guest") and not session.get("user_id"):
        _add_guest_tokens((len(ctx.get("user_text", "")) + len(clean)) // 4)
    return clean, executed, new_facts

# ─── Context Helpers ────────────────────────────────────────────────────────

import re as _re
_STOPWORDS = {"the","and","for","that","this","with","from","have","will","are",
              "you","your","can","not","but","was","its","his","her","they",
              "how","why","what","when","where","which","who","been","has"}

def _detect_complex_query(text):
    """Return True if the query looks complex enough to warrant auto-thinking."""
    lo = text.lower()
    signals = ["why ","how does","analyze","analyse","compare","difference",
               "explain","debug ","optimize","design ","architecture","algorithm",
               "prove","calculate","implement","refactor","step by step"]
    if any(s in lo for s in signals): return True
    if text.count("?") >= 2: return True
    if len(text) > 300: return True
    if "```" in text: return True
    return False


def select_relevant_files(user_text, files, max_chars=40_000):
    """Return workspace files most relevant to user_text, capped at max_chars."""
    if not files:
        return {}
    words = set(w.lower() for w in _re.findall(r"\b\w{3,}\b", user_text)
                if w.lower() not in _STOPWORDS)

    def score(path, content):
        tokens = set(w.lower() for w in _re.findall(r"\b\w{3,}\b", content))
        tokens |= set(w.lower() for w in _re.split(r"[/\\._]", path) if len(w) >= 3)
        return len(words & tokens)

    priority_names = {"status.md", "principles.md", "readme.md"}
    prioritised = sorted(files.keys(), key=lambda p: (
        0 if Path(p).name.lower() in priority_names else (-score(p, files[p]) if words else 0)
    ))
    result = {}; total = 0
    for path in prioritised:
        content = files[path]
        if total + len(content) <= max_chars:
            result[path] = content; total += len(content)
    return result


def _summarize_messages(old_messages, resolved):
    """Summarize older chat turns into a digest using a cheap model call."""
    lines = []
    for msg in old_messages[-30:]:
        prefix = "User" if msg.get("role") == "user" else "Assistant"
        text = (msg.get("text") or "")[:400]
        if text:
            lines.append(f"{prefix}: {text}")
    if not lines:
        return ""
    prompt = ("Summarize the following conversation into 4-6 concise bullet points. "
              "Focus on key topics, decisions, and context needed to continue it:\n\n"
              + "\n".join(lines))
    try:
        fast = {"google": "gemini-3-flash-preview", "openai": "gpt-5.4-mini",
                "anthropic": "claude-sonnet-4-6"}
        fn = PROVIDERS.get(resolved.get("provider"), call_openai)
        return fn(resolved["api_key"],
                  fast.get(resolved.get("provider"), resolved.get("actual_model")),
                  "You are a conversation summarizer. Output only brief bullet points.",
                  [{"role": "user", "text": prompt}],
                  base_url=resolved.get("base_url"))
    except Exception:
        return "\n".join(f"- {l}" for l in lines[-6:])


# ─── Provider Calls ──────────────────────────────────────────────────────────

def call_google(api_key, model, sysprompt, messages, base_url=None, thinking=False, web_search=False, **kwargs):
    genai, types = _import_google()
    client = genai.Client(api_key=api_key)
    contents = _google_contents_from_messages(messages, types)
    cfg = dict(system_instruction=sysprompt, max_output_tokens=16384)
    if thinking:
        cfg["thinking_config"] = types.ThinkingConfig(thinking_budget=8000)
    if web_search:
        cfg["tools"] = [types.Tool(google_search=types.GoogleSearch())]
    r = client.models.generate_content(model=model, contents=contents,
        config=types.GenerateContentConfig(**cfg))
    return r.text

def call_google_stream(api_key, model, sysprompt, messages, base_url=None, thinking=False, web_search=False, **kwargs):
    genai, types = _import_google()
    client = genai.Client(api_key=api_key)
    contents = _google_contents_from_messages(messages, types)
    cfg = dict(system_instruction=sysprompt, max_output_tokens=16384)
    if thinking:
        cfg["thinking_config"] = types.ThinkingConfig(thinking_budget=8000)
    if web_search:
        cfg["tools"] = [types.Tool(google_search=types.GoogleSearch())]
    stream = client.models.generate_content_stream(
        model=model,
        contents=contents,
        config=types.GenerateContentConfig(**cfg),
    )
    for chunk in stream:
        text = getattr(chunk, "text", "") or ""
        if text:
            yield text

def call_openai(api_key, model, sysprompt, messages, base_url=None, web_search=False, **kwargs):
    openai = _import_openai()
    kw = {"api_key": api_key}
    if base_url: kw["base_url"] = base_url
    client = openai.OpenAI(**kw)
    msgs = [{"role": "system", "content": sysprompt}]
    for msg in messages:
        role = msg["role"] if msg["role"] in ("user", "assistant") else ("assistant" if msg["role"] == "model" else "user")
        parts = []
        if msg.get("text"): parts.append({"type": "text", "text": msg["text"]})
        for img in msg.get("images", []):
            parts.append({"type": "image_url", "image_url": {"url": f"data:{img['mime']};base64,{img['data']}"}})
        if msg.get("file_text"):
            parts.append({"type": "text", "text": f"[Attached: {msg.get('file_name','')}]\n{msg['file_text']}"})
        if len(parts) == 1 and parts[0]["type"] == "text":
            msgs.append({"role": role, "content": parts[0]["text"]})
        elif parts:
            msgs.append({"role": role, "content": parts})
    create_kw = dict(model=model, messages=msgs, max_tokens=16384)
    if web_search:
        create_kw["tools"] = [{"type": "web_search_preview"}]
        create_kw["tool_choice"] = "auto"
    r = client.chat.completions.create(**create_kw)
    return r.choices[0].message.content

def call_anthropic(api_key, model, sysprompt, messages, base_url=None, thinking=False, **kwargs):
    anthropic = _import_anthropic()
    kw = {"api_key": api_key}
    if base_url: kw["base_url"] = base_url
    client = anthropic.Anthropic(**kw)
    msgs = []
    for msg in messages:
        role = msg["role"] if msg["role"] in ("user", "assistant") else ("assistant" if msg["role"] == "model" else "user")
        parts = []
        for img in msg.get("images", []):
            parts.append({"type": "image", "source": {"type": "base64", "media_type": img["mime"], "data": img["data"]}})
        if msg.get("file_text"):
            parts.append({"type": "text", "text": f"[Attached: {msg.get('file_name','')}]\n{msg['file_text']}"})
        if msg.get("text"): parts.append({"type": "text", "text": msg["text"]})
        if parts: msgs.append({"role": role, "content": parts})
    create_kw = dict(model=model, max_tokens=64000, system=sysprompt, messages=msgs)
    if thinking:
        create_kw["thinking"] = {"type": "enabled", "budget_tokens": 8000}
    r = client.messages.create(**create_kw)
    if thinking:
        parts_out = []
        for block in r.content:
            if block.type == "thinking" and getattr(block, "thinking", None):
                parts_out.append(f"<<<THINKING>>>\n{block.thinking}\n<<<END_THINKING>>>\n")
            elif block.type == "text" and block.text:
                parts_out.append(block.text)
        return "".join(parts_out)
    return r.content[0].text

PROVIDERS = {"google": call_google, "openai": call_openai,
             "anthropic": call_anthropic, "custom": call_openai}

def call_openai_stream(api_key, model, sysprompt, messages, base_url=None, web_search=False, **kwargs):
    openai = _import_openai()
    kw = {"api_key": api_key}
    if base_url: kw["base_url"] = base_url
    client = openai.OpenAI(**kw)
    msgs = [{"role": "system", "content": sysprompt}]
    for msg in messages:
        role = msg["role"] if msg["role"] in ("user", "assistant") else ("assistant" if msg["role"] == "model" else "user")
        parts = []
        if msg.get("text"): parts.append({"type": "text", "text": msg["text"]})
        for img in msg.get("images", []):
            parts.append({"type": "image_url", "image_url": {"url": f"data:{img['mime']};base64,{img['data']}"}})
        if msg.get("file_text"):
            parts.append({"type": "text", "text": f"[Attached: {msg.get('file_name','')}]\n{msg['file_text']}"})
        if len(parts) == 1 and parts[0]["type"] == "text":
            msgs.append({"role": role, "content": parts[0]["text"]})
        elif parts:
            msgs.append({"role": role, "content": parts})
    create_kw = dict(model=model, messages=msgs, stream=True, max_tokens=16384)
    if web_search:
        create_kw["tools"] = [{"type": "web_search_preview"}]
        create_kw["tool_choice"] = "auto"
    stream = client.chat.completions.create(**create_kw)
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta.content:
            yield chunk.choices[0].delta.content

def call_anthropic_stream(api_key, model, sysprompt, messages, base_url=None, thinking=False, **kwargs):
    anthropic = _import_anthropic()
    kw = {"api_key": api_key}
    if base_url: kw["base_url"] = base_url
    client = anthropic.Anthropic(**kw)
    msgs = []
    for msg in messages:
        role = msg["role"] if msg["role"] in ("user", "assistant") else ("assistant" if msg["role"] == "model" else "user")
        parts = []
        for img in msg.get("images", []):
            parts.append({"type": "image", "source": {"type": "base64", "media_type": img["mime"], "data": img["data"]}})
        if msg.get("file_text"):
            parts.append({"type": "text", "text": f"[Attached: {msg.get('file_name','')}]\n{msg['file_text']}"})
        if msg.get("text"): parts.append({"type": "text", "text": msg["text"]})
        if parts: msgs.append({"role": role, "content": parts})
    if thinking:
        # Use blocking create() to get native thinking blocks, then yield them
        r = client.messages.create(
            model=model, max_tokens=64000, system=sysprompt, messages=msgs,
            thinking={"type": "enabled", "budget_tokens": 8000}
        )
        for block in r.content:
            if block.type == "thinking" and getattr(block, "thinking", None):
                yield f"<<<THINKING>>>\n{block.thinking}\n<<<END_THINKING>>>\n"
            elif block.type == "text" and block.text:
                yield block.text
    else:
        with client.messages.stream(model=model, max_tokens=64000, system=sysprompt, messages=msgs) as stream:
            for text in stream.text_stream:
                yield text

STREAM_PROVIDERS = {"google": call_google_stream, "openai": call_openai_stream,
                    "anthropic": call_anthropic_stream, "custom": call_openai_stream}

def generate_image_google(api_key, prompt):
    genai, types = _import_google()
    client = genai.Client(api_key=api_key)
    r = client.models.generate_images(model="imagen-3.0-generate-002", prompt=prompt,
        config=types.GenerateImagesConfig(number_of_images=1))
    if r.generated_images:
        return base64.b64encode(r.generated_images[0].image.image_bytes).decode()
    return None

# ─── Routes: Static ──────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory("static", "index.html")

# ─── Routes: Auth ─────────────────────────────────────────────────────────────

@app.route("/api/auth/register", methods=["POST"])
def register():
    return jsonify({"error": "Email/password sign-up is disabled. Please sign in with Google."}), 403

@app.route("/api/auth/login", methods=["POST"])
def login():
    return jsonify({"error": "Email/password sign-in is disabled. Please sign in with Google."}), 403

@app.route("/api/auth/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})

@app.route("/api/auth/guest", methods=["POST"])
def guest_login():
    session["guest"] = True
    session["guest_id"] = str(uuid.uuid4())[:12]
    session.permanent = True
    return jsonify({"ok": True, "guest": True, "plan": "guest"})

@app.route("/api/auth/guest/status")
def guest_status():
    if not session.get("guest"):
        return jsonify({"guest": False})
    used = _guest_tokens_used()
    return jsonify({"guest": True, "used_tokens": used, "token_limit": GUEST_TOKEN_LIMIT, "remaining_tokens": max(0, GUEST_TOKEN_LIMIT - used)})

@app.route("/api/auth/me")
def auth_me():
    uid = session.get("user_id")
    if not uid:
        if session.get("guest"):
            used = _guest_tokens_used()
            return jsonify({"authenticated": False, "guest": True, "guest_tokens_remaining": max(0, GUEST_TOKEN_LIMIT - used), "plan": "guest"})
        return jsonify({"authenticated": False})
    user = _cur_user()
    if not user: session.clear(); return jsonify({"authenticated": False})
    profile = load_profile()
    return jsonify({"authenticated": True, "user": {
        "id": user["id"], "email": user["email"], "name": user["name"],
        "theme": user.get("theme", "dark"), "provider": user.get("provider", "local"),
        "created": user.get("created"), "plan": user.get("plan", "free")},
        "onboarding_complete": bool(profile.get("onboarding_complete"))})

@app.route("/api/auth/google", methods=["POST"])
def auth_google():
    cred = (request.get_json() or {}).get("credential", "")
    if not cred: return jsonify({"error": "No credential"}), 400
    try:
        url = f"https://oauth2.googleapis.com/tokeninfo?id_token={urllib.parse.quote(cred)}"
        with urllib.request.urlopen(url, timeout=10) as resp:
            info = json.loads(resp.read().decode())
        cfg = _load_oauth()
        expected_client_id = _effective_google_client_id(cfg)
        if info.get("aud") != expected_client_id:
            return jsonify({"error": "Google token audience mismatch."}), 400
        email = info.get("email")
        name = info.get("name", info.get("given_name", ""))
        if not email: return jsonify({"error": "No email from Google"}), 400
    except Exception as e:
        return jsonify({"error": f"Google verification failed: {e}"}), 400
    user = oauth_user(email, name, "google")
    session.permanent = True
    session["user_id"] = user["id"]; session["email"] = user["email"]
    return jsonify({"user": {"id": user["id"], "email": user["email"],
                             "name": user["name"], "theme": user.get("theme", "dark"), "plan": user.get("plan", "free")}})

@app.route("/api/auth/github")
def auth_github_start():
    return jsonify({"error": "GitHub sign-in is disabled for now."}), 400

@app.route("/api/auth/github/callback")
def auth_github_cb():
    return "GitHub sign-in is disabled for now.", 400

@app.route("/api/auth/data")
@require_auth
def get_user_data():
    user = _cur_user(); mem = load_memory(); s = load_settings()
    chats = list_chats()
    # Count uploads from Firebase Storage
    bucket = _storage_bucket()
    uid = session.get("user_id", "")
    upload_count = 0
    if bucket:
        try:
            blobs = list(bucket.list_blobs(prefix=f"uploads/{uid}/"))
            upload_count = len(blobs)
        except Exception:
            pass
    return jsonify({
        "user": {"email": user.get("email"), "name": user.get("name"),
                 "provider": user.get("provider"), "created": user.get("created"), "theme": user.get("theme","dark")},
        "stats": {"chats": len(chats), "messages": sum(c.get("message_count",0) for c in chats),
                  "memory_facts": len(mem.get("facts",[])),
                  "uploaded_files": upload_count,
                  "api_keys": sum(1 for v in s.get("keys",{}).values() if v)},
        "memory": mem.get("facts", []),
        "chats": [{"id":c["id"],"title":c["title"],"messages":c["message_count"],"created":c["created"]} for c in chats]
    })

@app.route("/api/auth/data", methods=["DELETE"])
@require_auth
def reset_data():
    code = (request.get_json() or {}).get("code", "")
    if code != "DELETE-MY-DATA":
        return jsonify({"error": "Type DELETE-MY-DATA to confirm."}), 400
    uid = session.get("user_id")
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    if FIREBASE_ENABLED:
        col = _chats_col()
        if col:
            for doc in col.stream():
                doc.reference.delete()
        _uid_doc("memory").set({"facts": [], "updated": None})
        _uid_doc("settings").set({"keys": {}, "selected_model": DEFAULT_MODEL, "custom_endpoints": []})
        ref = _uid_doc("profile")
        snap = ref.get()
        if snap.exists:
            ref.delete()
        bucket = _storage_bucket()
        if bucket:
            try:
                blobs = bucket.list_blobs(prefix=f"uploads/{uid}/")
                for blob in blobs:
                    blob.delete()
            except Exception:
                pass
    else:
        chats_dir = _local_user_dir(uid) / "chats"
        if chats_dir.exists():
            for f in chats_dir.glob("*.json"):
                f.unlink()
        save_memory({"facts": [], "updated": None})
        save_settings({"keys": {}, "selected_model": DEFAULT_MODEL, "custom_endpoints": []})
        prof = _local_user_dir(uid) / "profile.json"
        if prof.exists(): prof.unlink()
    return jsonify({"ok": True, "message": "All data reset."})

@app.route("/api/auth/theme", methods=["POST"])
@require_auth
def set_theme():
    theme = (request.get_json() or {}).get("theme", "dark")
    if theme not in ("dark", "light"): theme = "dark"
    uid = session.get("user_id")
    if uid:
        _update_user_field(uid, theme=theme)
    return jsonify({"ok": True})

@app.route("/api/auth/name", methods=["POST"])
@require_auth
def set_name():
    name = (request.get_json() or {}).get("name", "").strip()
    if not name: return jsonify({"error": "Name required"}), 400
    _save_user_name(name)
    return jsonify({"ok": True})

@app.route("/api/auth/plan", methods=["POST"])
@require_auth
def update_plan():
    plan = (request.get_json() or {}).get("plan", "").strip()
    if plan not in ("free", "pro", "max"):
        return jsonify({"error": "Invalid plan. Must be: free, pro, or max"}), 400
    uid = session.get("user_id")
    if uid:
        _update_user_field(uid, plan=plan)
    return jsonify({"ok": True, "plan": plan})

@app.route("/api/profile-onboarding")
@require_auth
def get_profile_onboarding():
    p = load_profile()
    return jsonify({
        "onboarding_complete": bool(p.get("onboarding_complete")),
        "profile": {
            "preferred_name": p.get("preferred_name", ""),
            "what_you_do": p.get("what_you_do", ""),
            "hobbies": p.get("hobbies", ""),
            "current_focus": p.get("current_focus", ""),
        },
    })

@app.route("/api/profile-onboarding", methods=["POST"])
@require_auth
def save_profile_onboarding():
    d = request.get_json() or {}
    preferred_name = (d.get("preferred_name") or "").strip()
    what_you_do = (d.get("what_you_do") or "").strip()
    hobbies = (d.get("hobbies") or "").strip()
    current_focus = (d.get("current_focus") or "").strip()

    if not preferred_name or not what_you_do or not hobbies:
        return jsonify({"error": "Name, what you do, and hobbies are required."}), 400

    profile = load_profile()
    profile.update({
        "onboarding_complete": True,
        "preferred_name": preferred_name[:120],
        "what_you_do": what_you_do[:300],
        "hobbies": hobbies[:300],
        "current_focus": current_focus[:300],
    })
    save_profile(profile)
    _save_user_name(profile["preferred_name"])

    mem = load_memory()
    prefixes = ("Preferred name: ", "Work: ", "Hobbies: ", "Current focus: ")
    facts = [f for f in mem.get("facts", []) if not any(f.startswith(pfx) for pfx in prefixes)]
    facts.append(f"Preferred name: {profile['preferred_name']}")
    facts.append(f"Work: {profile['what_you_do']}")
    facts.append(f"Hobbies: {profile['hobbies']}")
    if profile["current_focus"]:
        facts.append(f"Current focus: {profile['current_focus']}")
    mem["facts"] = facts
    save_memory(mem)

    return jsonify({"ok": True, "profile": profile, "user": {"name": profile["preferred_name"]}})

# ─── Routes: OAuth Config ────────────────────────────────────────────────────

@app.route("/api/oauth-config")
def get_oauth_cfg():
    cfg = _load_oauth()
    return jsonify({"google_client_id": _effective_google_client_id(cfg),
                    "github_available": False,
                    "apple_available": False})

@app.route("/api/oauth-config", methods=["POST"])
@require_auth
def save_oauth_cfg():
    d = request.get_json(); cfg = _load_oauth()
    for k in ("google_client_id",):
        if k in d: cfg[k] = d[k]
    _save_oauth(cfg)
    return jsonify({"ok": True})

# ─── Routes: Settings ────────────────────────────────────────────────────────

@app.route("/api/settings")
@require_auth
def get_settings():
    s = load_settings()
    safe_keys = {k: ("••••" + v[-4:] if len(v) > 4 else "••••") for k, v in s.get("keys", {}).items() if v}
    key_sources = {}
    for provider in ("google", "openai", "anthropic", "custom"):
        api_key, source = resolve_provider_key(s, provider)
        key_sources[provider] = source if api_key else ""
    return jsonify({"keys": safe_keys, "selected_model": s.get("selected_model"),
                    "custom_endpoints": s.get("custom_endpoints", []),
                    "key_sources": key_sources})

@app.route("/api/settings", methods=["POST"])
@require_auth
def update_settings():
    d = request.get_json(); s = load_settings()
    if "selected_model" in d:
        allowed, reason, _ = model_access(d["selected_model"], s)
        if not allowed:
            s["selected_model"] = DEFAULT_MODEL
            save_settings(s)
            return jsonify({"error": reason, "selected_model": DEFAULT_MODEL}), 400
        s["selected_model"] = d["selected_model"]
    if "keys" in d:
        for p, k in d["keys"].items():
            if p in ("google", "openai", "anthropic", "custom") and isinstance(k, str):
                s.setdefault("keys", {})[p] = k
    if "custom_endpoints" in d:
        s["custom_endpoints"] = [{"name": e["name"], "base_url": e["base_url"],
            "model": e.get("model", ""), "provider_type": e.get("provider_type", "openai")}
            for e in d["custom_endpoints"] if isinstance(e, dict) and e.get("name") and e.get("base_url")]
    save_settings(s)
    return jsonify({"ok": True})

@app.route("/api/settings/key", methods=["DELETE"])
@require_auth
def delete_key():
    p = (request.get_json() or {}).get("provider")
    s = load_settings()
    if p in s.get("keys", {}): del s["keys"][p]; save_settings(s)
    return jsonify({"ok": True})

@app.route("/api/models")
@require_auth_or_guest
def get_models():
    s = load_settings(); result = []
    for mid, info in MODELS.items():
        available, reason, key_source = model_access(mid, s)
        result.append({"id": mid, "label": info["label"], "provider": info["provider"],
                       "tier": info["tier"], "available": available,
                       "locked_reason": reason, "key_source": key_source})
    for ep in s.get("custom_endpoints", []):
        model_id = f"custom:{ep['name']}"
        available, reason, key_source = model_access(model_id, s)
        result.append({"id": f"custom:{ep['name']}", "label": ep["name"], "provider": "custom",
                       "tier": "custom", "available": available,
                       "locked_reason": reason, "key_source": key_source,
                       "base_url": ep.get("base_url"), "model": ep.get("model")})
    return jsonify({"models": result, "selected": normalize_selected_model(s)})

# ─── Routes: Chats ────────────────────────────────────────────────────────────

@app.route("/api/chats")
@require_auth_or_guest
def get_chats():
    return jsonify({"chats": list_chats()})

@app.route("/api/chats", methods=["POST"])
@require_auth_or_guest
def new_chat():
    d = request.get_json() or {}
    requested_model = d.get("model")
    settings = load_settings()
    if requested_model:
        allowed, _, _ = model_access(requested_model, settings)
        if not allowed:
            requested_model = DEFAULT_MODEL
    c = create_new_chat(model=requested_model, folder=d.get("folder", ""))
    save_chat(c)
    return jsonify(c)

@app.route("/api/chats/<chat_id>")
@require_auth_or_guest
def get_chat(chat_id):
    c = load_chat(chat_id)
    if not c: return jsonify({"error": "Not found"}), 404
    return jsonify(c)

@app.route("/api/chats/<chat_id>", methods=["PATCH"])
@require_auth_or_guest
def patch_chat(chat_id):
    c = load_chat(chat_id)
    if not c: return jsonify({"error": "Not found"}), 404
    d = request.get_json()
    for f in ("title", "folder"):
        if f in d: c[f] = d[f]
    if "model" in d:
        settings = load_settings()
        allowed, reason, _ = model_access(d["model"], settings)
        if not allowed:
            return jsonify({"error": reason}), 400
        c["model"] = d["model"]
    save_chat(c)
    return jsonify({"ok": True})

@app.route("/api/chats/<chat_id>", methods=["DELETE"])
@require_auth_or_guest
def del_chat(chat_id):
    delete_chat(chat_id)
    return jsonify({"ok": True})

@app.route("/api/chats/<chat_id>/message", methods=["POST"])
@require_auth_or_guest
def chat_message(chat_id):
    if session.get("guest") and not session.get("user_id"):
        if _guest_tokens_used() >= GUEST_TOKEN_LIMIT:
            return jsonify({"reply": "You've reached your daily token limit for guest access. Sign in with Google for unlimited access!", "files": [], "guest_limit": True})
    chat = load_chat(chat_id)
    if not chat: return jsonify({"error": "Not found"}), 404
    ctx, err_resp, status = prepare_chat_turn(chat, request.get_json() or {})
    if err_resp:
        return err_resp, status

    try:
        resolved = ctx["resolved"]
        resp = PROVIDERS.get(resolved["provider"], call_openai)(
            resolved["api_key"],
            resolved["actual_model"],
            ctx["sysprompt"],
            ctx["api_msgs"],
            base_url=resolved["base_url"],
        )
    except Exception as e:
        err = str(e)
        if any(w in err.lower() for w in ("429", "quota", "rate")):
            return jsonify({"reply": "Rate limit hit. Wait a moment.", "files": []})
        return jsonify({"reply": f"API error: {err}", "files": []})

    clean, executed, new_facts = finalize_chat_response(chat, ctx, resp)
    return jsonify({"reply": clean, "files": executed, "memory_added": new_facts})

@app.route("/api/chats/<chat_id>/stream", methods=["POST"])
@require_auth_or_guest
def chat_message_stream(chat_id):
    if session.get("guest") and not session.get("user_id"):
        if _guest_tokens_used() >= GUEST_TOKEN_LIMIT:
            return jsonify({"reply": "You've reached your daily token limit for guest access. Sign in with Google for unlimited access!", "files": [], "guest_limit": True})
    chat = load_chat(chat_id)
    if not chat:
        return jsonify({"error": "Not found"}), 404

    payload = request.get_json() or {}
    ctx, err_resp, status = prepare_chat_turn(chat, payload)
    if err_resp:
        return err_resp, status

    thinking = ctx.get("thinking", False)
    web_search = ctx.get("web_search", False)
    # For OpenAI (no native thinking), inject thinking instruction into system prompt
    if thinking and ctx["resolved"].get("provider") not in ("google", "anthropic"):
        ctx["sysprompt"] += "\n\n[THINKING MODE ENABLED]\nBefore answering, think through your approach step by step. Wrap ONLY your internal reasoning in <<<THINKING>>> and <<<END_THINKING>>> tags (these will be shown to the user in a collapsible block). Keep thinking concise — brief bullet points only. Then write your actual response AFTER the <<<END_THINKING>>> tag with no tags in it."

    resolved = ctx["resolved"]

    def event(payload):
        return json.dumps(payload) + "\n"

    @stream_with_context
    def generate():
        pieces = []
        try:
            stream_fn = STREAM_PROVIDERS.get(resolved["provider"])
            if stream_fn:
                for chunk in stream_fn(
                    resolved["api_key"],
                    resolved["actual_model"],
                    ctx["sysprompt"],
                    ctx["api_msgs"],
                    base_url=resolved["base_url"],
                    thinking=thinking,
                    web_search=web_search,
                ):
                    pieces.append(chunk)
                    yield event({"type": "delta", "text": chunk})
            else:
                full = PROVIDERS.get(resolved["provider"], call_openai)(
                    resolved["api_key"],
                    resolved["actual_model"],
                    ctx["sysprompt"],
                    ctx["api_msgs"],
                    base_url=resolved["base_url"],
                    thinking=thinking,
                    web_search=web_search,
                )
                pieces.append(full)
                yield event({"type": "delta", "text": full})

            clean, executed, new_facts = finalize_chat_response(chat, ctx, "".join(pieces))
            yield event({
                "type": "done",
                "reply": clean,
                "files": executed,
                "memory_added": new_facts,
                "title": chat.get("title", "New Chat"),
            })
        except Exception as e:
            err = str(e)
            if any(w in err.lower() for w in ("429", "quota", "rate")):
                yield event({"type": "error", "error": "Rate limit hit. Wait a moment."})
            else:
                yield event({"type": "error", "error": f"API error: {err}"})

    return Response(generate(), mimetype="application/x-ndjson")

@app.route("/api/canvas/apply", methods=["POST"])
@require_auth
def canvas_apply():
    d = request.get_json() or {}
    content = (d.get("content") or "")
    instruction = (d.get("instruction") or "").strip()
    language = (d.get("language") or "text").strip()
    if not content.strip():
        return jsonify({"error": "Canvas is empty."}), 400
    if not instruction:
        return jsonify({"error": "Add an instruction for the canvas."}), 400

    settings = load_settings()
    selected_model = normalize_selected_model(settings)
    allowed, reason, _ = model_access(selected_model, settings)
    if not allowed:
        return jsonify({"error": reason}), 400

    resolved = resolve_chat_model({"model": selected_model}, settings)
    if resolved.get("error"):
        return jsonify({"error": resolved["error"]}), 400

    canvas_prompt = (
        "You are editing a document inside a side-by-side AI canvas. "
        "Return only the updated document content. Do not wrap it in markdown fences. "
        "Preserve useful structure, improve clarity, and follow the user's request exactly.\n\n"
        f"Document language: {language}\n"
        f"Instruction: {instruction}\n\n"
        "[CURRENT DOCUMENT]\n"
        f"{content}"
    )
    try:
        updated = PROVIDERS.get(resolved["provider"], call_openai)(
            resolved["api_key"],
            resolved["actual_model"],
            build_system_prompt(load_memory()),
            [{"role": "user", "text": canvas_prompt}],
            base_url=resolved["base_url"],
        )
        return jsonify({"content": (updated or "").strip()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ─── Routes: Image, Upload, Memory, Files ────────────────────────────────────

@app.route("/api/generate-image", methods=["POST"])
@require_auth
def gen_image():
    prompt = (request.get_json() or {}).get("prompt", "").strip()
    if not prompt: return jsonify({"error": "No prompt"}), 400
    api_key = load_settings().get("keys", {}).get("google", "")
    if not api_key: return jsonify({"error": "Google API key required."}), 400
    try:
        img = generate_image_google(api_key, prompt)
        return jsonify({"image": img}) if img else jsonify({"error": "No image generated"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/upload", methods=["POST"])
@require_auth_or_guest
def upload_file():
    uid = session.get("user_id") or session.get("guest_id", "guest")
    if not uid: return jsonify({"error": "Not authenticated"}), 401
    if "file" not in request.files: return jsonify({"error": "No file"}), 400
    f = request.files["file"]
    if not f.filename: return jsonify({"error": "No filename"}), 400
    safe = re.sub(r'[^\w\s\-.]', '_', f.filename)
    fid = str(uuid.uuid4())[:8]
    file_bytes = f.read()
    mime = f.content_type or mimetypes.guess_type(safe)[0] or "application/octet-stream"
    # Upload to Firebase Storage (non-guest only; guests keep data in-memory)
    if session.get("user_id"):
        bucket = _storage_bucket()
        if bucket:
            blob = bucket.blob(f"uploads/{uid}/{fid}_{safe}")
            blob.upload_from_string(file_bytes, content_type=mime)
    TEXT_EXTS = (".md",".txt",".json",".yaml",".yml",".py",".js",".ts",".html",".css",
                 ".csv",".xml",".log",".ini",".cfg",".sh",".bat",".ps1",".sql",".java",
                 ".c",".cpp",".h",".go",".rs",".rb",".php",".swift",".kt")
    text = None
    if mime.startswith("text/") or safe.lower().endswith(TEXT_EXTS):
        try: text = file_bytes.decode("utf-8", errors="replace")
        except: pass
    img_data = None
    if mime.startswith("image/"):
        img_data = base64.b64encode(file_bytes).decode()
    return jsonify({"id": fid, "name": f.filename, "mime": mime,
                    "size": len(file_bytes), "text": text, "image_data": img_data})

@app.route("/api/memory")
@require_auth
def get_memory():
    return jsonify(load_memory())

@app.route("/api/memory", methods=["POST"])
@require_auth
def add_memory():
    fact = (request.get_json() or {}).get("fact", "").strip()
    if not fact: return jsonify({"error": "Empty"}), 400
    m = load_memory()
    if fact not in m["facts"]: m["facts"].append(fact); save_memory(m)
    return jsonify({"ok": True})

@app.route("/api/memory/<int:idx>", methods=["DELETE"])
@require_auth
def del_memory(idx):
    m = load_memory()
    if 0 <= idx < len(m["facts"]): m["facts"].pop(idx); save_memory(m)
    return jsonify({"ok": True})

@app.route("/api/files")
@require_auth
def list_files_route():
    files = read_workspace_files()
    return jsonify({"files": [{"path": p, "size": len(c), "preview": c[:200],
        "folder": str(Path(p).parent) if str(Path(p).parent) != "." else ""}
        for p, c in sorted(files.items())]})

@app.route("/api/files/content")
@require_auth_or_guest
def get_file_content_route():
    path = (request.args.get("path") or "").strip()
    if not path:
        return jsonify({"error": "Path required"}), 400
    files = read_workspace_files()
    if path not in files:
        return jsonify({"error": "File not found"}), 404
    return jsonify({"path": path, "content": files[path]})

@app.route("/api/folders")
@require_auth
def get_folders():
    folders = set()
    for c in list_chats():
        if c.get("folder"): folders.add(c["folder"])
    for p in read_workspace_files():
        parent = str(Path(p).parent)
        if parent != ".": folders.add(parent)
    return jsonify({"folders": sorted(folders)})

@app.route("/api/status")
def status_route():
    return jsonify({"version": "3.0", "name": "NEXUS"})

@app.route("/api/greeting")
@require_auth_or_guest
def get_greeting():
    user = _cur_user()
    uname = user.get("name", "").split()[0] if user and user.get("name") else ""
    h = datetime.datetime.now().hour
    if h < 5: period = "late night"
    elif h < 12: period = "morning"
    elif h < 17: period = "afternoon"
    elif h < 21: period = "evening"
    else: period = "late night"
    name_part = f", {uname}" if uname else ""
    presets = {
        "late night": [f"Burning the midnight oil{name_part}?", f"Late night{name_part}? Moon", f"Quiet hours, clear mind{name_part}."],
        "morning":    [f"Early start today{name_part}?", f"Morning focus, steady pace{name_part}.", f"Fresh morning energy{name_part}."],
        "afternoon":  [f"Afternoon rhythm holding up{name_part}?", f"Midday focus check{name_part}.", f"Keeping momentum this afternoon{name_part}?"],
        "evening":    [f"Evening stretch ahead{name_part}.", f"Winding down or diving in{name_part}?", f"Golden hour thoughts{name_part}."],
    }
    return jsonify({"greeting": random.choice(presets.get(period, [f"Ready when you are{name_part}."]))})  

# ─── Deep Research Engine ────────────────────────────────────────────────────

import threading as _threading
_research_jobs = {}  # job_id -> {"status": ..., "events": [...]}

def _lazy_import_bs():
    import requests as _r; from bs4 import BeautifulSoup as _BS; return _r, _BS

def _lazy_import_ddg():
    from duckduckgo_search import DDGS; return DDGS

def _fetch_url_text(url, timeout=12):
    """Fetch URL, strip boilerplate, return up to 8 000 chars of plain text."""
    try:
        req, BS = _lazy_import_bs()
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"}
        resp = req.get(url, headers=headers, timeout=timeout, allow_redirects=True)
        resp.raise_for_status()
        ct = resp.headers.get("content-type", "")
        if "text" not in ct:
            return None
        soup = BS(resp.text, "lxml")
        for tag in soup(["script","style","nav","header","footer","aside","form","iframe","noscript"]):
            tag.decompose()
        main = (soup.find("main") or soup.find("article") or
                soup.find(id=re.compile(r"content|main|article", re.I)) or
                soup.find(class_=re.compile(r"content|main|article|post", re.I)) or
                soup.find("body"))
        text = main.get_text(separator=" ", strip=True) if main else soup.get_text(separator=" ", strip=True)
        text = re.sub(r"[ \t]{3,}", "  ", text)
        text = re.sub(r"\n{4,}", "\n\n\n", text)
        return text[:8000]
    except Exception:
        return None

def _ddg_search(query, max_results=8):
    """DuckDuckGo text search → list of {title, url, snippet}."""
    try:
        DDGS = _lazy_import_ddg()
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
        return [{"title": r.get("title",""), "url": r.get("href",""), "snippet": r.get("body","")}
                for r in results if r.get("href")]
    except Exception:
        return []

def _research_ai_call(prompt, resolved, max_tokens=4096):
    """Non-streaming AI call for research steps."""
    provider = resolved.get("provider", "google")
    try:
        fn = PROVIDERS.get(provider, call_openai)
        result = fn(
            api_key=resolved.get("api_key",""),
            model=resolved.get("actual_model",""),
            sysprompt="You are a precise, expert research analyst. Follow instructions exactly. Output only what is asked.",
            messages=[{"role": "user", "text": prompt}],
            base_url=resolved.get("base_url"),
        )
        return result or ""
    except Exception as e:
        return f"[AI error: {e}]"

def _generate_research_pdf(title, report_md, sources, output_path):
    """Convert markdown research report to a styled multi-page PDF."""
    from fpdf import FPDF

    class PDF(FPDF):
        def header(self):
            if self.page_no() > 1:
                self.set_font("Helvetica", "I", 7)
                self.set_text_color(160, 160, 160)
                self.cell(0, 6, f"NEXUS Research  |  {title[:60]}", align="R", new_x="LMARGIN", new_y="NEXT")
                self.set_draw_color(220, 220, 220)
                self.line(10, self.get_y(), 200, self.get_y())
                self.ln(2)
        def footer(self):
            self.set_y(-13)
            self.set_font("Helvetica", "I", 7)
            self.set_text_color(160, 160, 160)
            self.cell(0, 6, f"Page {self.page_no()}", align="C")

    def safe(t):
        return t.encode("latin-1", "replace").decode("latin-1")

    pdf = PDF()
    pdf.set_auto_page_break(auto=True, margin=16)
    pdf.set_margins(14, 14, 14)
    pdf.add_page()

    # ── Cover page ──
    pdf.set_font("Helvetica", "B", 22)
    pdf.set_text_color(40, 40, 40)
    pdf.ln(8)
    pdf.cell(0, 12, "NEXUS DEEP RESEARCH", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.set_draw_color(191, 107, 58)
    pdf.set_line_width(0.8)
    pdf.line(14, pdf.get_y(), 196, pdf.get_y())
    pdf.ln(6)
    pdf.set_font("Helvetica", "B", 14)
    pdf.set_text_color(60, 60, 60)
    # Title word-wrap
    words = title.split()
    lines_out, cur_line = [], []
    for w in words:
        cur_line.append(w)
        if len(" ".join(cur_line)) > 55:
            lines_out.append(" ".join(cur_line[:-1]))
            cur_line = [w]
    if cur_line:
        lines_out.append(" ".join(cur_line))
    for ln_txt in lines_out:
        pdf.cell(0, 9, safe(ln_txt), align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)
    pdf.set_draw_color(191, 107, 58)
    pdf.line(14, pdf.get_y(), 196, pdf.get_y())
    pdf.ln(8)
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(120, 120, 120)
    pdf.cell(0, 6, f"Generated by NEXUS AI  |  {datetime.datetime.now().strftime('%B %d, %Y  %H:%M')}", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 6, f"Sources consulted: {len(sources)}", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.add_page()

    # ── Report body ──
    in_code = False
    code_buf = []

    def render_inline(txt):
        """Strip inline markdown for safe PDF text."""
        txt = re.sub(r"\*\*(.*?)\*\*", r"\1", txt)
        txt = re.sub(r"\*(.*?)\*", r"\1", txt)
        txt = re.sub(r"`(.*?)`", r"\1", txt)
        txt = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", txt)
        return safe(txt)

    for line in report_md.split("\n"):
        s = line.strip()
        if s.startswith("```"):
            if not in_code:
                in_code = True; code_buf = []
            else:
                in_code = False
                pdf.set_font("Courier", "", 7.5)
                pdf.set_text_color(50, 50, 50)
                pdf.set_fill_color(245, 245, 240)
                for cl in code_buf:
                    pdf.cell(0, 4.2, safe(cl[:140]), new_x="LMARGIN", new_y="NEXT", fill=True)
                pdf.ln(2)
            continue
        if in_code:
            code_buf.append(line)
            continue

        if s.startswith("# "):
            pdf.add_page()
            pdf.set_font("Helvetica", "B", 16)
            pdf.set_text_color(30, 30, 30)
            pdf.multi_cell(0, 10, render_inline(s[2:]))
            pdf.set_draw_color(191, 107, 58)
            pdf.set_line_width(0.5)
            pdf.line(14, pdf.get_y(), 196, pdf.get_y())
            pdf.set_line_width(0.2)
            pdf.ln(4)
        elif s.startswith("## "):
            pdf.ln(4)
            pdf.set_font("Helvetica", "B", 13)
            pdf.set_text_color(191, 107, 58)
            pdf.multi_cell(0, 8, render_inline(s[3:]))
            pdf.set_draw_color(220, 200, 180)
            pdf.line(14, pdf.get_y(), 196, pdf.get_y())
            pdf.ln(2)
            pdf.set_text_color(40, 40, 40)
        elif s.startswith("### "):
            pdf.ln(2)
            pdf.set_font("Helvetica", "B", 11)
            pdf.set_text_color(50, 50, 50)
            pdf.multi_cell(0, 7, render_inline(s[4:]))
            pdf.ln(1)
        elif s.startswith("#### "):
            pdf.set_font("Helvetica", "B", 10)
            pdf.set_text_color(60, 60, 60)
            pdf.multi_cell(0, 6, render_inline(s[5:]))
        elif s.startswith(("- ", "* ")):
            pdf.set_font("Helvetica", "", 10)
            pdf.set_text_color(40, 40, 40)
            pdf.set_x(19)
            pdf.cell(5, 5, chr(149), new_x="RIGHT", new_y="LAST")
            pdf.multi_cell(0, 5, render_inline(s[2:]))
        elif re.match(r"^\d+\.\s", s):
            num, rest = s.split(".", 1)
            pdf.set_font("Helvetica", "", 10)
            pdf.set_text_color(40, 40, 40)
            pdf.set_x(19)
            pdf.cell(8, 5, safe(num + "."), new_x="RIGHT", new_y="LAST")
            pdf.multi_cell(0, 5, render_inline(rest.strip()))
        elif s in ("---", "***", "___"):
            pdf.ln(2)
            pdf.set_draw_color(210, 210, 210)
            pdf.line(14, pdf.get_y(), 196, pdf.get_y())
            pdf.ln(2)
        elif s:
            pdf.set_font("Helvetica", "", 10)
            pdf.set_text_color(40, 40, 40)
            pdf.multi_cell(0, 5, render_inline(s))
            pdf.ln(1)
        else:
            pdf.ln(2)

    # ── Sources page ──
    if sources:
        pdf.add_page()
        pdf.set_font("Helvetica", "B", 13)
        pdf.set_text_color(191, 107, 58)
        pdf.cell(0, 9, "Sources & References", new_x="LMARGIN", new_y="NEXT")
        pdf.set_draw_color(191, 107, 58)
        pdf.line(14, pdf.get_y(), 196, pdf.get_y())
        pdf.ln(5)
        for idx, src in enumerate(sources, 1):
            pdf.set_font("Helvetica", "B", 9)
            pdf.set_text_color(40, 40, 40)
            pdf.multi_cell(0, 5, safe(f"{idx}. {src.get('title','Untitled')[:90]}"))
            pdf.set_font("Helvetica", "I", 8)
            pdf.set_text_color(60, 60, 180)
            pdf.multi_cell(0, 4, safe(src.get("url","")[:120]))
            snip = src.get("snippet","")[:220]
            if snip:
                pdf.set_font("Helvetica", "", 8)
                pdf.set_text_color(100, 100, 100)
                pdf.multi_cell(0, 4, safe(snip))
            pdf.ln(3)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    pdf.output(str(output_path))

def _run_research_job(job_id, query, depth, resolved):
    """Background thread: multi-step deep research pipeline."""
    job = _research_jobs[job_id]

    def push(evt_type, **kw):
        job["events"].append({"type": evt_type, **kw})

    depth_cfg = {
        "quick":    {"sub_q": 3, "urls_per_q": 3, "max_fetch": 7,  "detail": "concise"},
        "standard": {"sub_q": 5, "urls_per_q": 5, "max_fetch": 14, "detail": "thorough"},
        "deep":     {"sub_q": 8, "urls_per_q": 7, "max_fetch": 22, "detail": "highly comprehensive and deeply detailed"},
    }.get(depth, {"sub_q": 5, "urls_per_q": 5, "max_fetch": 14, "detail": "thorough"})

    try:
        # ── Step 1: Query decomposition ──
        push("progress", step="planning", message="Analyzing query and generating research angles...")
        decomp = _research_ai_call(
            f"""You are a research planner. Break this topic into exactly {depth_cfg['sub_q']} specific, distinct sub-questions that form a {depth_cfg['detail']} investigation.

Research Topic: {query}

Output ONLY a numbered list, one sub-question per line, no extra text:
1. <sub-question>
2. <sub-question>
(continue...)""",
            resolved, max_tokens=512
        )
        sub_questions = []
        for line in decomp.split("\n"):
            m = re.match(r"^\s*\d+[.)]\s+(.+)", line.strip())
            if m:
                sub_questions.append(m.group(1).strip())
        sub_questions = (sub_questions or [query])[:depth_cfg["sub_q"]]
        push("progress", step="planning", message=f"Research plan: {len(sub_questions)} angles identified.")

        # ── Step 2: DuckDuckGo search per sub-question + main query ──
        all_results, seen_urls = [], set()
        for sq in sub_questions:
            push("progress", step="searching", message=f"Searching: {sq[:80]}...")
            for r in _ddg_search(sq, max_results=depth_cfg["urls_per_q"]):
                if r["url"] and r["url"] not in seen_urls:
                    seen_urls.add(r["url"]); r["sub_question"] = sq; all_results.append(r)
        for r in _ddg_search(query, max_results=5):
            if r["url"] and r["url"] not in seen_urls:
                seen_urls.add(r["url"]); r["sub_question"] = query; all_results.append(r)
        push("progress", step="searching", message=f"Found {len(all_results)} unique sources to read.")

        # ── Step 3: Fetch source content ──
        fetched = []
        for idx, result in enumerate(all_results[:depth_cfg["max_fetch"]]):
            url = result["url"]
            push("progress", step="fetching",
                 message=f"Reading [{idx+1}/{min(len(all_results), depth_cfg['max_fetch'])}]: {url[:70]}...")
            text = _fetch_url_text(url)
            if text and len(text) > 150:
                fetched.append({**result, "text": text})
        # Fall back to snippets if fetching yielded little
        if len(fetched) < 3:
            for r in all_results[:15]:
                if r.get("snippet") and len(r["snippet"]) > 80:
                    fetched.append({**r, "text": r["snippet"]})
        push("progress", step="fetching", message=f"Successfully read {len(fetched)} sources.")

        # ── Step 4: Per-source summarization ──
        source_summaries = []
        for idx, src in enumerate(fetched):
            push("progress", step="analyzing",
                 message=f"Analyzing source {idx+1}/{len(fetched)}: {(src.get('title') or src['url'])[:55]}...")
            summary = _research_ai_call(
                f"""Research topic: {query}
Source: {src.get('title','')} — {src['url']}

{src['text'][:6000]}

Extract the key facts, statistics, arguments, and insights from this source that are most relevant to the research topic. Be specific. ~200-400 words.""",
                resolved, max_tokens=700
            )
            if summary and "[AI error" not in summary:
                source_summaries.append({
                    "title": src.get("title",""),
                    "url": src["url"],
                    "snippet": src.get("snippet",""),
                    "summary": summary,
                })

        push("progress", step="analyzing",
             message=f"Analyzed {len(source_summaries)} sources. Writing report...")

        # ── Step 5: Full report synthesis ──
        push("progress", step="synthesizing", message="Synthesizing findings into a comprehensive report...")
        summaries_block = "\n\n".join(
            f"### Source {i+1}: {s['title']}\nURL: {s['url']}\n{s['summary']}"
            for i, s in enumerate(source_summaries)
        )
        report_md = _research_ai_call(
            f"""You are an expert research analyst. Write a {depth_cfg['detail']} research report based on the sources below.

TOPIC: {query}

SOURCES:
{summaries_block[:28000]}

Structure the report with these sections (use markdown headers):
# Executive Summary
## Key Findings
## Background & Context
## Detailed Analysis
### [subsection for each major aspect found]
## Current State & Trends
## Implications & Insights
## Conclusion & Recommendations

Requirements:
- Use ## and ### for sections and subsections
- Use **bold** for key terms and important facts
- Use bullet lists for key points
- Include specific facts, numbers, and quotes from sources
- Minimum 1800 words for a {depth_cfg['detail']} report
- Be insightful, not just descriptive""",
            resolved, max_tokens=8192
        )
        if not report_md or "[AI error" in report_md:
            report_md = f"# Research Report: {query}\n\n*Error generating report. Sources found below.*\n\n" + "".join(f"- [{s['title']}]({s['url']})\n" for s in source_summaries)

        # ── Step 6: PDF generation ──
        push("progress", step="pdf", message="Generating PDF report...")
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_q = re.sub(r"[^\w\s-]", "", query[:40]).strip().replace(" ", "_")
        pdf_fn = f"research_{safe_q}_{ts}.pdf"
        md_fn  = f"research_{safe_q}_{ts}.md"
        rdir   = WORKSPACE / "notes" / "research"
        rdir.mkdir(parents=True, exist_ok=True)
        (rdir / md_fn).write_text(
            f"# {query}\n\n{report_md}\n\n---\n\n## Sources\n\n" +
            "".join(f"- [{s['title']}]({s['url']})\n" for s in source_summaries),
            encoding="utf-8"
        )
        pdf_ok = False
        try:
            _generate_research_pdf(query, report_md, source_summaries, rdir / pdf_fn)
            pdf_ok = True
        except Exception as pdf_err:
            push("progress", step="pdf", message=f"PDF note: {pdf_err} — markdown saved.")

        push("done",
             report=report_md,
             pdf_file=pdf_fn if pdf_ok else None,
             md_file=md_fn,
             sources=[{"title": s["title"], "url": s["url"], "snippet": s["snippet"]} for s in source_summaries],
             sub_questions=sub_questions,
             source_count=len(source_summaries),
        )
        job["status"] = "done"

    except Exception as e:
        push("error", error=f"Research failed: {e}")
        job["status"] = "error"


@app.route("/api/research", methods=["POST"])
@require_auth_or_guest
def start_research():
    d = request.get_json() or {}
    query = (d.get("query") or "").strip()
    depth = d.get("depth", "standard")
    if not query:
        return jsonify({"error": "Query required"}), 400
    if depth not in ("quick", "standard", "deep"):
        depth = "standard"

    settings = load_settings()
    # Pick best available model for research (prefer pro models)
    available_model = None
    for mid in ("gemini-3.1-pro-preview", "gemini-3-flash-preview"):
        mi = MODELS.get(mid, {})
        api_key, _ = resolve_provider_key(settings, mi.get("provider","google"))
        if api_key:
            available_model = mid
            break
    if not available_model:
        available_model = DEFAULT_MODEL
    resolved = {
        "provider": MODELS[available_model]["provider"],
        "actual_model": available_model,
        "api_key": resolve_provider_key(settings, MODELS[available_model]["provider"])[0],
        "base_url": None,
    }
    if not resolved["api_key"]:
        return jsonify({"error": "No AI API key configured. Add a key in Settings first."}), 400

    job_id = str(uuid.uuid4())[:12]
    _research_jobs[job_id] = {"status": "running", "events": [], "created": datetime.datetime.now().isoformat()}
    _threading.Thread(target=_run_research_job, args=(job_id, query, depth, resolved), daemon=True).start()

    import time as _time

    @stream_with_context
    def generate():
        sent = 0
        while True:
            job = _research_jobs.get(job_id, {})
            evts = job.get("events", [])
            while sent < len(evts):
                yield json.dumps(evts[sent]) + "\n"
                sent += 1
            if job.get("status") in ("done", "error") and sent >= len(evts):
                break
            _time.sleep(0.25)
        # Clean up old jobs (keep last 20)
        if len(_research_jobs) > 20:
            oldest = sorted(_research_jobs.keys(),
                            key=lambda k: _research_jobs[k].get("created",""))[:-20]
            for k in oldest:
                _research_jobs.pop(k, None)

    return Response(generate(), mimetype="application/x-ndjson")


@app.route("/api/research/download/<path:filename>")
@require_auth
def download_research_file(filename):
    safe_fn = re.sub(r"[^\w.\-]", "", Path(filename).name)
    return send_from_directory(str(WORKSPACE / "notes" / "research"), safe_fn, as_attachment=True)


# ─── Main ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    _ensure_dirs()
    print("\n  +----------------------------------------------+")
    print("  |   PROJECT NEXUS - Flow-State Architect v3   |")
    print("  |                                             |")
    print("  |   Open http://localhost:5000 in browser     |")
    print("  +----------------------------------------------+\n")
    app.run(host="127.0.0.1", port=5000, debug=False)
