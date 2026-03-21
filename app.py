#!/usr/bin/env python3
"""gyro - The Flow-State Architect"""

import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import os, json, uuid, datetime, re, base64, mimetypes, secrets, hashlib, random, io, time
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
DATA_DIR = WORKSPACE / ".gyro_data"
SECRET_FILE = DATA_DIR / ".secret_key"
SESSION_SECRET_FILE = WORKSPACE / ".gyro_session_secret"

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

    cred = None
    # 1) Service account JSON file on disk (local dev)
    if sa_path.exists():
        cred = credentials.Certificate(str(sa_path))
    # 2) Service account JSON passed as an environment variable (cloud deploys)
    elif os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip():
        try:
            sa_dict = json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT"])
            cred = credentials.Certificate(sa_dict)
        except Exception as e:
            print(f"  [!] FIREBASE_SERVICE_ACCOUNT env var invalid ({e})")
    # 3) Application Default Credentials (GCP environments)
    elif os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        cred = credentials.ApplicationDefault()

    if cred is None:
        print("  [!] Firebase not configured - using local file storage (.gyro_data/).")
        print("      To persist data across deploys, set the FIREBASE_SERVICE_ACCOUNT")
        print("      environment variable to your Firebase service account JSON.")
        return
    try:
        firebase_admin.initialize_app(cred, opts)
        db = firestore.client()
        # Verify Firestore is actually reachable (not just authenticated)
        try:
            db.collection("_health").document("ping").set({"ts": datetime.datetime.now().isoformat()})
            print("  [✓] Firebase connected & Firestore verified — data will persist across deploys.")
        except Exception as fs_err:
            print(f"  [!] Firebase authenticated but Firestore unreachable: {fs_err}")
            print("      Make sure you've created a Firestore database in Firebase Console.")
            print("      Go to: https://console.firebase.google.com → Your project → Firestore Database → Create database")
            print("      Falling back to local file storage.")
            db = None
            FIREBASE_ENABLED = False
            return
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
                ".gyro_history", ".gyro_data", ".nexus_data", ".nexus_history",
                "static", "templates"}
IGNORED_FILES = {"gyro.py", "app.py", "requirements.txt", ".env", ".gitignore",
                 "gunicorn.ctl", "Procfile", "render.yaml",
                 "NEXUS_INSTRUCTIONS.md", "README.md", "STATUS.md", "TEST_PROMPTS.md"}
# Server-side files hidden from the user file browser
SERVER_FILES = {"app.py", "requirements.txt", "Procfile", "render.yaml",
                "gyro_INSTRUCTIONS.md", "KAIRO_INSTRUCTIONS.md", "NEXUS_INSTRUCTIONS.md",
                "README.md", "STATUS.md", "TEST_PROMPTS.md", "gunicorn.ctl",
                ".env", ".gitignore", ".gyro_session_secret", ".nexus_session_secret"}
SERVER_DIRS = {".git", "__pycache__", ".venv", "venv", "node_modules",
               ".gyro_history", ".gyro_data", ".nexus_data", ".nexus_history",
               "static", "templates", "logos"}
MAX_CONTEXT_CHARS = 900_000
DEFAULT_MODEL = "gemini-2.5-flash"
DEFAULT_CREATOR_ORIGIN_STORY = "Blake Cary built gyro after his brother shared AI ideas that inspired him to create this workspace."
CREATOR_EMAIL = "blakecary2010@gmail.com"

GUEST_MODEL = "gemini-2.5-flash"

MODELS = {
    # Google — free tier (server API key, no per-user cost)
    "gemini-2.5-flash":  {"provider": "google",    "label": "Gemini 2.5 Flash",    "tier": "free"},
    "gemini-2.5-pro":  {"provider": "google",    "label": "Gemini 2.5 Pro",    "tier": "free"},
    # Google — pro tier
    "gemini-3-flash-preview":        {"provider": "google",    "label": "Gemini 3 Flash",   "tier": "pro"},
    "gemini-3.1-pro-preview":        {"provider": "google",    "label": "Gemini 3.1 Pro",     "tier": "pro"},
    # OpenAI — pro tier
    "gpt-5.4-mini":            {"provider": "openai",    "label": "GPT-5.4 Mini",       "tier": "pro"},
    "gpt-5.4":                 {"provider": "openai",    "label": "GPT-5.4",            "tier": "pro"},
    # Anthropic — pro tier
    "claude-sonnet-4-6":       {"provider": "anthropic", "label": "Claude Sonnet 4.6",  "tier": "pro"},
    "claude-opus-4-6":         {"provider": "anthropic", "label": "Claude Opus 4.6",    "tier": "pro"},
}

app = Flask(__name__, static_folder="static")
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
_BOOT_TS = str(int(time.time()))

# In-memory guest runtime state (backed by disk)
GUEST_RUNTIME = {}

def _guest_dir(guest_id):
    """Return (and create) the on-disk directory for a guest user."""
    d = DATA_DIR / "guests" / guest_id
    d.mkdir(parents=True, exist_ok=True)
    return d

def _hash_remember_token(token):
    return hashlib.sha256(token.encode()).hexdigest()

def _ensure_dirs():
    DATA_DIR.mkdir(exist_ok=True)

def _get_secret():
    _ensure_dirs()
    # Use environment variable if set (survives Render deploys).
    env_key = os.environ.get("gyro_SECRET_KEY", "").strip()
    if env_key:
        return env_key
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
app.config["SESSION_COOKIE_NAME"] = "gyro_session"

@app.before_request
def _refresh_session():
    """Touch the session on every request so the cookie expiry is refreshed."""
    if session.get("user_id") or session.get("guest"):
        session.modified = True

@app.errorhandler(Exception)
def handle_exception(e):
    """Catch-all so Firestore / unexpected errors return JSON, not a 500 HTML page."""
    print(f"  [!] Unhandled error: {e}")
    return jsonify({"error": f"Server error: {str(e)[:200]}"}), 500

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
            "created": datetime.date.today().isoformat(), "theme": "dark", "plan": "free"}
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
            "created": datetime.date.today().isoformat(), "theme": "dark", "plan": "free"}
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
            keys = list(session.keys())
            return jsonify({"error": f"Not authenticated (session has no user_id or guest flag, keys={keys})"}), 401
        return f(*args, **kw)
    return dec

# ~20k tokens/day ≈ 80 typical exchanges with the lite model
GUEST_TOKEN_LIMIT = 20_000

def _guest_runtime_state():
    guest_id = session.get("guest_id")
    if not guest_id:
        return None
    if guest_id not in GUEST_RUNTIME:
        # Try to restore from disk
        gdir = _guest_dir(guest_id)
        meta = _load_json(gdir / "meta.json", {})
        chats = {}
        chats_dir = gdir / "chats"
        if chats_dir.exists():
            for f in chats_dir.glob("*.json"):
                try:
                    c = _load_json(f, None)
                    if c and c.get("id"):
                        chats[c["id"]] = c
                except Exception:
                    pass
        GUEST_RUNTIME[guest_id] = {
            "date": meta.get("date", datetime.date.today().isoformat()),
            "tokens": meta.get("tokens", 0),
            "chats": chats,
        }
    state = GUEST_RUNTIME[guest_id]
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
    # Persist token count to disk
    guest_id = session.get("guest_id")
    if guest_id:
        gdir = _guest_dir(guest_id)
        _save_json(gdir / "meta.json", {"date": state["date"], "tokens": state["tokens"]})

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
    try:
        snap = db.collection("config").document("oauth").get()
        return snap.to_dict() if snap.exists else {}
    except Exception as e:
        print(f"  [!] Firestore _load_oauth failed: {e}")
        return {}

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

    # Pro-tier model — requires pro/max/dev plan
    if plan in ("pro", "max", "dev"):
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
        "origin_story": "",
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

def _is_transient_empty_chat(chat_obj):
    """Hide placeholder chats that were created but never used."""
    if not isinstance(chat_obj, dict):
        return False
    title = (chat_obj.get("title") or "").strip().lower()
    folder = (chat_obj.get("folder") or "").strip()
    has_messages = bool(chat_obj.get("messages") or [])
    return (not has_messages) and title in ("", "new chat") and not folder

def list_chats():
    if session.get("guest") and not session.get("user_id"):
        guest_id = session.get("guest_id")
        if not guest_id:
            return []
        state = _guest_runtime_state() or {}
        chats = []
        for c in (state.get("chats") or {}).values():
            if _is_transient_empty_chat(c):
                continue
            chats.append({"id": c.get("id"), "title": c.get("title", "Untitled"),
                "created": c.get("created"), "updated": c.get("updated"),
                "model": c.get("model", ""), "folder": c.get("folder", ""),
                "message_count": len(c.get("messages", []))})
        chats.sort(key=lambda x: x.get("updated") or "", reverse=True)
        return chats
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
                    if _is_transient_empty_chat(m):
                        continue
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
        if _is_transient_empty_chat(m):
            continue
        chats.append({"id": doc.id, "title": m.get("title", "Untitled"),
            "created": m.get("created"), "updated": m.get("updated"),
            "model": m.get("model", ""), "folder": m.get("folder", ""),
            "message_count": len(m.get("messages", []))})
    return chats

def load_chat(cid):
    if not _safe_id(cid): return None, "invalid_id"
    if session.get("guest") and not session.get("user_id"):
        state = _guest_runtime_state() or {}
        chat = (state.get("chats") or {}).get(cid)
        if chat:
            return chat, None
        # Fallback: try loading from disk
        guest_id = session.get("guest_id")
        if guest_id:
            disk_chat = _load_json(_guest_dir(guest_id) / "chats" / f"{cid}.json", None)
            if disk_chat:
                state.setdefault("chats", {})[cid] = disk_chat
                return disk_chat, None
            return None, f"guest_chat_missing|guest_id={guest_id}|chat_id={cid}"
        return None, "no_guest_id_in_session"
    uid = session.get("user_id")
    if not uid:
        has_guest = session.get("guest", False)
        return None, f"no_user_id|guest={has_guest}|session_keys={list(session.keys())}"
    if not FIREBASE_ENABLED:
        path = _local_user_dir(uid) / "chats" / f"{cid}.json"
        data = _load_json(path, None)
        if data:
            return data, None
        return None, f"file_missing|uid={uid}|path={path}|exists={path.exists()}|dir_exists={path.parent.exists()}"
    col = _chats_col()
    if not col: return None, "no_firestore_collection"
    snap = col.document(cid).get()
    if snap.exists:
        return snap.to_dict(), None
    return None, f"firestore_doc_missing|uid={uid}|chat_id={cid}"

def save_chat(c):
    if session.get("guest") and not session.get("user_id"):
        state = _guest_runtime_state()
        if not state: return
        c["updated"] = datetime.datetime.now().isoformat()
        state.setdefault("chats", {})[c["id"]] = c
        # Persist to disk so chats survive server restarts
        guest_id = session.get("guest_id")
        if guest_id:
            _save_json(_guest_dir(guest_id) / "chats" / f"{c['id']}.json", c)
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
        deleted = False
        if cid in chats:
            del chats[cid]; deleted = True
        guest_id = session.get("guest_id")
        if guest_id:
            cf = _guest_dir(guest_id) / "chats" / f"{cid}.json"
            if cf.exists(): cf.unlink(); deleted = True
        return deleted
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
    for name in ("gyro_INSTRUCTIONS.md", "KAIRO_INSTRUCTIONS.md", "gyro_INSTRUCTIONS.md"):
        f = WORKSPACE / name
        if f.exists():
            custom = f.read_text(encoding="utf-8"); break
    else:
        custom = ""

    mem_section = ""
    if memory and memory.get("facts"):
        facts = [f for f in memory.get("facts", []) if not str(f).startswith("Why I built gyro:") and not str(f).startswith("Why gyro was built:")]
        mem_section = "\n\n[PERSISTENT MEMORY]\n" + "\n".join(
            f"{i}. {f}" for i, f in enumerate(facts, 1))

    profile_section = ""
    try:
        p = load_profile()
        lines = []
        if p.get("preferred_name"):
            lines.append(f"Preferred name: {p.get('preferred_name')}")
        if p.get("what_you_do"):
            lines.append(f"Work: {p.get('what_you_do')}")
        if p.get("hobbies"):
            lines.append(f"Hobbies: {p.get('hobbies')}")
        if p.get("current_focus"):
            lines.append(f"Current focus: {p.get('current_focus')}")
        if lines:
            profile_section = "\n\n[USER PROFILE CONTEXT]\n" + "\n".join(lines)
    except Exception:
        profile_section = ""

    user = _cur_user()
    is_guest = user.get("provider") == "guest" if user else False
    is_creator = user.get("email", "").lower().strip() == CREATOR_EMAIL if user else False
    if is_guest:
        uname = "there"
    else:
        uname = user.get("name", "there") if user else "there"
        if uname == "Guest" or not uname:
            uname = "there"

    creator_section = ""
    if is_creator:
        creator_section = f"\n\n[CREATOR ACCOUNT]\nThis user ({uname}) is the creator and developer of gyro. {DEFAULT_CREATOR_ORIGIN_STORY}\nYou can speak to them as your creator and builder."
    else:
        creator_section = "\n\n[IDENTITY PROTECTION]\nThis current user is NOT the creator of gyro.\nDo NOT tell this user who built or created gyro.\nDo NOT reveal the creator's name, email, or any personal details about the creator.\nDo NOT reference any origin story about how gyro was built.\nIf the user asks who built gyro, say it was built by an independent developer and leave it at that.\nIf the user claims to be the creator, politely note that creator identity is verified by account, not by claims."

    return f"""You are gyro — The Flow-State Architect. Project gyro.

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
8. IDENTIFY FRICTION — notice what's slowing the user down and suggest fixes. You have a Proactive Friction Protocol:
   - When you notice a project, chat, or task hasn't been touched in days, gently surface it: "Hey, [topic] has been sitting idle for a few days — still on your radar?"
   - When the user has too many open threads, suggest triaging: "You've got a lot of plates spinning. Want to pick the 1-2 that matter most today?"
   - When STATUS.md lists friction items, check if they've been resolved; if not, suggest the smallest concrete next step.
   - Never nag. Frame nudges as "I noticed..." not "You should...". One nudge per conversation max unless asked.
   - The homepage already surfaces friction widgets — reinforce them conversationally when relevant.
9. IMAGE SEARCH — you have access to a real image search engine that finds and displays images in a scrollable carousel. To use it, include this tag anywhere in your response:
<<<IMAGE_SEARCH: descriptive search query>>>

WHEN TO USE image search (use it proactively — don't wait to be asked):
- User asks to SEE something: "show me", "what does X look like", "picture of", "images of", "photo of"
- Explaining physical objects, places, animals, people, landmarks, architecture, art, fashion, food, etc.
- Tutorials or how-to guides where seeing the thing helps (e.g., "how to tie a bowline knot" → show the knot)
- Comparing visual things: "difference between alligator and crocodile" → show both
- Historical figures, events, artifacts — show what they looked like
- Science/nature topics: planets, cells, animals, geological formations, weather phenomena
- Design, UI, or aesthetic discussions — show examples
- When the user describes something and you want to confirm what they mean
- Travel or location discussions — show the place
- Any time a visual would make your explanation clearer or more engaging

WHEN NOT TO USE image search:
- Pure code/programming questions
- Math or abstract logic problems
- When the user explicitly says they don't want images
- Casual greetings or simple yes/no answers
- When you're writing files or doing workspace operations

RULES:
- Write descriptive, specific search queries. "Socrates ancient Greek philosopher bust sculpture" is better than just "Socrates"
- You can use MULTIPLE <<<IMAGE_SEARCH>>> tags in one response for different topics
- Always include explanatory text WITH the images — don't just dump images with no context
- Do NOT use markdown image syntax ![](url) — you don't have real image URLs. ONLY use <<<IMAGE_SEARCH>>>
- Prefer to put the image search tag AFTER your text about that topic, so the images appear below your explanation
10. ANALYZE YOUTUBE VIDEOS — when the user shares a YouTube link, you can watch/analyze the video content and discuss it in detail. The video is provided to you directly.
11. Interactive questions — you can ask the user multiple-choice questions they can click to answer (they can also type their own response). Use this when it genuinely helps move the conversation forward:

WHEN TO USE choices:
- Testing the user's knowledge (quizzes, study questions, knowledge checks)
- Gathering preferences when there are 2-5 distinct paths ("Which area should we focus on?")
- Decision points where the options are meaningfully different
- Breaking down a complex decision into smaller sequential questions
- When the user asks "test me", "quiz me", or anything that implies interactive Q&A
- Onboarding / profiling questions ("What's your experience level with X?")

WHEN NOT TO USE choices:
- Simple greetings or casual messages
- When a direct answer is clearly better
- Acknowledging a request before doing it
- When there's only one obvious path forward

You can ask MULTIPLE questions in sequence — each gets its own interactive block. Use the <<<QUESTION:>>> tag to give each question context.

Format (one question):
<<<QUESTION: What area interests you most?>>>
<<<CHOICES>>>
Option A
Option B
Option C
<<<END_CHOICES>>>

Format (multiple sequential questions):
<<<QUESTION: First, what's your experience level?>>>
<<<CHOICES>>>
Beginner
Intermediate
Advanced
<<<END_CHOICES>>>

<<<QUESTION: And which topic should we focus on?>>>
<<<CHOICES>>>
Topic A
Topic B
Topic C
<<<END_CHOICES>>>

You can also use choices WITHOUT a question tag — just <<<CHOICES>>> directly — for simple option lists after your text.
The user can ALWAYS type their own answer instead of picking an option, so choices are suggestions not constraints.

12. Tools — the user can activate tools from the toolbar. When a tool is active, you will see a [TOOL ACTIVE: ...] section in your instructions with specific guidance. Follow those instructions naturally within your response. The user's message itself will NOT contain any tool prefixes — the tool context is provided to you separately.

12b. Canvas editing — when a user's message contains [CANVAS CONTEXT], they are working in the side canvas editor and asking you to help edit it. If <<<SELECTED>>>...<<<END_SELECTED>>> is present, the user has highlighted a specific portion and wants changes ONLY to that part. Return the FULL updated document in a single code block with the proper language tag. ALWAYS include the filename with extension on the line before the code block. Only modify what the user asked for.

13. Interactive Todo Lists — whenever the user asks for a to-do list, task list, checklist, or you think a to-do list would be useful, output one using this format:
```todolist
[{{"text":"First task","done":false,"subtasks":[{{"text":"Sub-step A","done":false}},{{"text":"Sub-step B","done":true}}]}},{{"text":"Second task","done":true}},{{"text":"Third task","done":false}}]
```
Each item needs "text" (string) and "done" (boolean). Items can optionally have "subtasks" (array of {{"text":string,"done":boolean}}). When all subtasks are checked, the parent auto-checks. The user can check off, edit, delete, and add subtasks interactively. If the user says they completed something, output an updated list with done:true on the completed items.
IMPORTANT: Always output the todolist block DIRECTLY in your response text. NEVER wrap it inside a <<<FILE_CREATE>>> or <<<FILE_UPDATE>>> block. Do NOT save todolists as .md files — just output the ```todolist block inline so it renders interactively.

14. DEEP RESEARCH — The user can activate a deep research tool from the toolbar that searches the live internet, reads dozens of sources, and produces a comprehensive cited report. When the deep research tool is active, you will see a [TOOL ACTIVE: DEEP RESEARCH] section in your instructions. You do NOT need to trigger deep research yourself — it is handled externally when the user activates the tool. Just respond normally to the user's question.

File operations format:
<<<FILE_CREATE: path/to/file.md>>>
(content — you can include ```mermaid blocks, markdown, code, anything)
<<<END_FILE>>>

<<<FILE_UPDATE: path/to/file.md>>>
(full updated content)
<<<END_FILE>>>

You CAN and SHOULD save mind maps, reports, and visualizations to files using FILE_CREATE when the user asks. For example, save a mermaid mind map to notes/research/topic.md.

Memory saves:
<<<MEMORY_ADD: fact to remember>>>

Output Quality Rules:
- Think step by step before answering. For complex or multi-part questions, reason through it before giving your final answer.
- NEVER cut off your response mid-sentence or mid-thought. If a response needs to be long, complete it fully. Never truncate.
- When writing code: always output COMPLETE, runnable files. Never use "# ... rest of code here" or "// existing code unchanged" placeholders — write the entire file every time.
- Be specific and concrete. Vague answers waste the user's time — give precise, actionable information.
- When you create something worth saving (a plan, a document, code, notes), proactively use FILE_CREATE or FILE_UPDATE to save it rather than just printing it.
- Your knowledge cutoff is March 2026. You are aware of recent AI models, frameworks, and events up to that date.

Message Continuation:
- If your response is long and you need to continue, or if you want to chain multiple actions (e.g. text response → code → mind map → file export), you can end your message with <<<CONTINUE>>> on its own line.
- When you emit <<<CONTINUE>>>, the system will automatically send your next message so you can keep going. You can continue as many times as needed.
- Use this when: you have more to say than fits comfortably, you want to do multiple steps (research → write → export), or the user asked for a complex multi-part deliverable.
- Each continued message gets its own bubble in the chat, so the user sees your work flowing naturally.
- ALWAYS end with <<<CONTINUE>>> if you still have more work to do. Only stop when you are truly done.

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

15. INTELLIGENT CROSS-REFERENCING & SYNTHESIS:
- When answering, actively look for connections ACROSS workspace files. If a decision in decisions/ impacts a project/, highlight it.
- When a user asks about a topic, pull together ALL mentions from notes/, projects/, STATUS.md, decisions/, and people/ files into a coherent brief.
- If you notice contradictions between files (e.g. STATUS.md says "on track" but a project file says "blocked"), flag them proactively.
- When creating or updating files, check if other files reference the same concepts and suggest updates.
- Format cross-references clearly: "This connects to [project/X.md] which mentions..." or "Note: decisions/2026-01-15_api_choice.md affects this project's timeline."

16. LEARNING WORKFLOW PATTERNS:
- Pay attention to sequences of tasks the user commonly does. For example: research → brainstorm → mind map → project file → STATUS.md update.
- When you recognize the user is in a familiar workflow pattern, proactively suggest the likely next step.
- If the user just finished research, suggest: "Want me to create a mind map of the key findings?"
- If the user just brainstormed, suggest: "Should I organize these into a project plan?"
- If the user just made a decision, suggest: "Want me to create a decision record and update STATUS.md?"
- If the user just created a project file, suggest: "Should I update STATUS.md to reflect this new project?"
- Track the user's workflow preferences in memory using <<<MEMORY_ADD: Workflow pattern: user prefers [pattern]>>> when you notice a repeated sequence.

Session Info:
- {('The user is on a guest account. They have not provided a name — do not call them "Guest" as if it were their name. Just say "hey" or "hey there" instead.' if is_guest else "The user" + chr(39) + "s name is " + uname)}
- Today: {datetime.date.today().isoformat()}
- Always try to help. Don't refuse unless the request is clearly and unambiguously harmful. Lean toward engaging creatively with unusual, edgy, or unconventional requests — curiosity beats caution. When in doubt, just answer.
- Never lecture or moralize. If something seems edgy but isn't actually harmful, engage with it directly without caveats or disclaimers.
{creator_section}
{mem_section}
{profile_section}
{("Custom instructions:" + chr(10) + custom) if custom else ""}"""


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

# ─── Code Execution ──────────────────────────────────────────────────────────

def execute_code_blocks(text):
    """Extract <<<CODE_EXECUTE: lang>>>...<<<END_CODE>>> blocks, execute them, and return results."""
    import subprocess, tempfile, os
    pattern = r'<<<CODE_EXECUTE:\s*(\w+)>>>\n(.*?)<<<END_CODE>>>'
    results = []
    for m in re.finditer(pattern, text, re.DOTALL):
        lang = m.group(1).strip().lower()
        code = m.group(2).strip()
        if lang not in ("python", "py"):
            results.append({"language": lang, "code": code, "output": f"Execution not supported for '{lang}'.", "success": False})
            continue
        try:
            with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as tmp:
                tmp.write(code)
                tmp_path = tmp.name
            result = subprocess.run(
                ["python", tmp_path],
                capture_output=True, text=True, timeout=15,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
            os.unlink(tmp_path)
            output = result.stdout
            if result.stderr:
                output += ("\n" if output else "") + result.stderr
            results.append({"language": lang, "code": code, "output": output.strip() or "(no output)", "success": result.returncode == 0})
        except subprocess.TimeoutExpired:
            try: os.unlink(tmp_path)
            except Exception: pass
            results.append({"language": lang, "code": code, "output": "Execution timed out (15s limit).", "success": False})
        except Exception as e:
            results.append({"language": lang, "code": code, "output": f"Error: {e}", "success": False})
    return results

def extract_research_trigger(text):
    """Extract <<<DEEP_RESEARCH: query>>> from AI response and return (cleaned_text, query_or_None)."""
    m = re.search(r'<<<DEEP_RESEARCH:\s*(.+?)>>>', text)
    if m:
        query = m.group(1).strip()
        cleaned = re.sub(r'<<<DEEP_RESEARCH:\s*.+?>>>', '', text).strip()
        return cleaned, query
    return text, None

def extract_image_searches(text):
    """Extract all <<<IMAGE_SEARCH: query>>> tags and return (cleaned_text, [queries])."""
    queries = [m.group(1).strip() for m in re.finditer(r'<<<IMAGE_SEARCH:\s*(.+?)>>>', text)]
    cleaned = re.sub(r'<<<IMAGE_SEARCH:\s*.+?>>>', '', text).strip()
    return cleaned, queries

def search_images(query, num=8):
    """Search images via DuckDuckGo. Free, no API key, no limits."""
    try:
        from duckduckgo_search import DDGS
        with DDGS() as ddgs:
            raw = list(ddgs.images(query, max_results=num, safesearch="moderate"))
        results = []
        for item in raw:
            results.append({
                "url": item.get("image", ""),
                "title": item.get("title", ""),
                "thumbnail": item.get("thumbnail", item.get("image", "")),
                "context_url": item.get("url", ""),
                "width": item.get("width", 0),
                "height": item.get("height", 0),
            })
        return results
    except Exception as e:
        print(f"  [image-search] error: {e}")
        return []

def clean_response(text):
    text = re.sub(r'<<<FILE_CREATE:\s*.+?>>>.*?<<<END_FILE>>>', '', text, flags=re.DOTALL)
    text = re.sub(r'<<<FILE_UPDATE:\s*.+?>>>.*?<<<END_FILE>>>', '', text, flags=re.DOTALL)
    text = re.sub(r'<<<CODE_EXECUTE:\s*\w+>>>.*?<<<END_CODE>>>', '', text, flags=re.DOTALL)
    text = re.sub(r'<<<MEMORY_ADD:\s*.+?>>>', '', text)
    text = re.sub(r'<<<DEEP_RESEARCH:\s*.+?>>>', '', text)
    text = re.sub(r'<<<IMAGE_SEARCH:\s*.+?>>>', '', text)
    text = re.sub(r'<<<CONTINUE>>>', '', text)
    return text.strip()

_YT_RE = re.compile(r'(?:https?://)?(?:www\.)?(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/shorts/)([\w-]{11})')

def _extract_youtube_urls(text):
    """Return list of full YouTube URLs found in text."""
    urls = []
    for m in _YT_RE.finditer(text or ""):
        vid = m.group(1)
        urls.append(f"https://www.youtube.com/watch?v={vid}")
    return urls

def _google_contents_from_messages(messages, types):
    contents = []
    for msg in messages:
        role = "user" if msg["role"] == "user" else "model"
        parts = []
        if msg.get("text"):
            parts.append(types.Part.from_text(text=msg["text"]))
        # YouTube URLs → Gemini FileData so the model can watch the video
        for yt_url in msg.get("youtube_urls", []):
            try:
                parts.append(types.Part.from_uri(file_uri=yt_url, mime_type="video/*"))
            except Exception:
                pass
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


def _build_tool_instructions(active_tools):
    """Build additional system prompt instructions based on which tools the user activated."""
    if not active_tools:
        return ""
    parts = []
    tool_map = {
        "canvas": (
            "[TOOL ACTIVE: CANVAS]\n"
            "The user has activated the Canvas tool. Put ALL code or document content in a single ```language code block "
            "so it opens in the side canvas editor. ALWAYS name the file with a proper extension on the line before the code block, "
            "e.g. 'script.py', 'page.html', 'styles.css', 'app.js'. Keep explanation minimal — just the filename, a brief intro, then the code block.\n"
            "If the user has selected text in the canvas (shown in <<<SELECTED>>>...<<<END_SELECTED>>>) and asks for changes, "
            "return the FULL updated document with only the selected portion modified as requested."
        ),
        "search": (
            "[TOOL ACTIVE: WEB SEARCH]\n"
            "The user has activated the Web Search tool. Provide the most current, accurate information available and cite sources when possible."
        ),
        "mindmap": (
            "[TOOL ACTIVE: MIND MAP]\n"
            "The user has activated the Mind Map tool. Generate a ```mermaid mindmap block for the topic. "
            "In mermaid mindmap syntax, use ONLY plain alphanumeric text for node labels. Do NOT use parentheses (), brackets [], braces {}, colons :, or quotes in node text. "
            "Keep node labels short (under 40 chars). Use only indentation to define hierarchy."
        ),
        "summarize": (
            "[TOOL ACTIVE: SUMMARIZE]\n"
            "The user has activated the Summarize tool. Provide a concise, well-structured summary of whatever they ask about."
        ),
        "code": (
            "[TOOL ACTIVE: CODE EXECUTION]\n"
            "The user has activated the Code Execution tool. You can now run Python code and show the output. "
            "When computation, data processing, math, generating files, or any task that benefits from running actual code is involved, "
            "write executable Python code inside the special execution block:\n"
            "<<<CODE_EXECUTE: python>>>\n"
            "print('Hello world')\n"
            "<<<END_CODE>>>\n"
            "The code will be executed server-side and the output shown to the user. "
            "Always use print() to produce output the user can see. "
            "You may use multiple CODE_EXECUTE blocks in a single response if needed. "
            "Available standard library modules: math, json, csv, datetime, random, collections, itertools, re, statistics, os, sys, etc. "
            "Keep code focused and concise. The execution has a 15-second timeout."
        ),
    }
    for tool in active_tools:
        if tool in tool_map:
            parts.append(tool_map[tool])
    if parts:
        return "\n\n" + "\n\n".join(parts)
    return ""


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
    active_tools = payload.get("active_tools", [])
    if not thinking and user_text:
        thinking = _detect_complex_query(user_text)
    if not web_search and "search" in active_tools:
        web_search = True

    # --- YouTube URL detection ---
    yt_urls = _extract_youtube_urls(user_text)
    if yt_urls:
        user_msg["youtube_urls"] = yt_urls

    # --- Workspace context: inject only relevant files (capped at 40k chars) ---
    all_files = read_workspace_files()
    relevant = select_relevant_files(user_text, all_files, max_chars=40_000)
    ws = format_workspace_context(relevant)

    memory = load_memory()
    sysprompt = build_system_prompt(memory)

    # --- Per-chat custom instructions ---
    if chat.get("custom_instructions"):
        sysprompt += f"\n\n[CHAT-SPECIFIC INSTRUCTIONS]\n{chat['custom_instructions']}"

    # --- Active tool instructions (injected silently into system prompt) ---
    tool_instructions = _build_tool_instructions(active_tools)
    if tool_instructions:
        sysprompt += tool_instructions

    # --- Per-chat pinned files context ---
    pinned = chat.get("pinned_files") or []
    if pinned:
        pinned_ctx = []
        for pf in pinned:
            path = pf if isinstance(pf, str) else pf.get("path", "")
            if not path:
                continue
            fp = WORKSPACE / Path(path).as_posix()
            if fp.exists() and fp.is_file():
                try:
                    content = fp.read_text(encoding="utf-8")[:50000]
                    pinned_ctx.append(f"=== PINNED FILE: {path} ===\n{content}")
                except Exception:
                    pass
        if pinned_ctx:
            ws = "[PINNED FILES]\n" + "\n\n".join(pinned_ctx) + "\n\n" + ws

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
        "active_tools": active_tools,
    }, None, None

def finalize_chat_response(chat, ctx, raw_response):
    executed = execute_file_operations(raw_response)
    code_results = execute_code_blocks(raw_response)
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
    msg_obj = {
        "role": "model",
        "text": clean,
        "timestamp": datetime.datetime.now().isoformat(),
        "files_modified": executed,
        "memory_added": new_facts or None,
    }
    if code_results:
        msg_obj["code_results"] = code_results
    chat["messages"].append(msg_obj)
    # Track generated files on the chat object for per-chat file listing
    if executed:
        chat_files = chat.get("generated_files") or []
        existing = {f["path"] for f in chat_files}
        for f in executed:
            if f["path"] not in existing:
                chat_files.append({"path": f["path"], "action": f["action"],
                                   "when": datetime.datetime.now().isoformat()})
                existing.add(f["path"])
        chat["generated_files"] = chat_files
    save_chat(chat)
    # Track token usage for guests (estimate: 1 token ≈ 4 chars)
    if session.get("guest") and not session.get("user_id"):
        _add_guest_tokens((len(ctx.get("user_text", "")) + len(clean)) // 4)
    return clean, executed, new_facts, code_results

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


def _detect_friction_points(chats, todos, profile):
    """Analyze workspace state and surface friction: stale chats, piling tasks, status friction."""
    now = datetime.datetime.now()
    nudges = []

    # --- Stale chats: updated > 3 days ago with real messages ---
    for c in (chats or []):
        updated_str = c.get("updated") or c.get("created") or ""
        msg_count = c.get("message_count", 0) or 0
        if not updated_str or msg_count < 2:
            continue
        try:
            updated_dt = datetime.datetime.fromisoformat(updated_str)
            days_stale = (now - updated_dt).days
            if days_stale >= 3:
                nudges.append({
                    "category": "stale_chat",
                    "message": f"\"{c.get('title','Untitled')}\" — untouched for {days_stale} day{'s' if days_stale!=1 else ''}",
                    "next_step": "Review where you left off and decide: continue, archive, or close it out.",
                    "action": {"type": "open_chat", "chat_id": c.get("id", "")},
                })
        except Exception:
            continue
    # Keep only the top 2 stalest
    nudges.sort(key=lambda n: -int(''.join(filter(str.isdigit, n["message"])) or 0))
    stale_nudges = nudges[:2]
    nudges = stale_nudges

    # --- Piling todos: too many open tasks signals decision paralysis ---
    pending = [t for t in (todos or []) if not t.get("done")]
    if len(pending) >= 6:
        nudges.append({
            "category": "task_overload",
            "message": f"{len(pending)} open tasks — time to triage",
            "next_step": "Pick the 1-2 that actually move the needle today and defer the rest.",
            "action": {"type": "prompt", "text": "Help me triage my open tasks and pick the top priorities for today"},
        })

    # --- STATUS.md friction items ---
    status_path = Path(__file__).parent / "STATUS.md"
    if status_path.exists():
        try:
            raw = status_path.read_text(encoding="utf-8")
            in_friction = False
            for line in raw.splitlines():
                stripped = line.strip()
                if "friction" in stripped.lower() and stripped.startswith("#"):
                    in_friction = True
                    continue
                if in_friction:
                    if stripped.startswith("#"):
                        break
                    if stripped.startswith("- ") and len(stripped) > 4:
                        nudges.append({
                            "category": "status_friction",
                            "message": stripped[2:].strip(),
                            "next_step": "Break this into one concrete 15-minute action you can do right now.",
                            "action": {"type": "prompt", "text": f"I'm stuck on: {stripped[2:].strip()}. What's the smallest concrete step I can take right now?"},
                        })
        except Exception:
            pass

    # --- No active focus set ---
    focus = (profile.get("current_focus") or "").strip() if profile else ""
    if not focus and (chats or todos):
        nudges.append({
            "category": "no_focus",
            "message": "No current focus set — easy to drift without a north star",
            "next_step": "Set a one-line focus for this week in your profile.",
            "action": {"type": "prompt", "text": "Help me define my current focus for this week"},
        })

    return nudges[:5]


def _build_cross_references(files):
    """Scan workspace files and find cross-references between them."""
    refs = []
    file_topics = {}  # path -> set of key terms
    for path, content in files.items():
        words = set(w.lower() for w in re.findall(r'\b[A-Za-z]{4,}\b', content))
        # Also extract mentioned file paths
        mentioned = set(re.findall(r'(?:notes|projects|decisions|people)/[\w\-/]+\.md', content))
        file_topics[path] = {"words": words, "mentions": mentioned}

    # Find connections: files that reference each other or share significant topic overlap
    paths = list(files.keys())
    for i, p1 in enumerate(paths):
        t1 = file_topics.get(p1, {})
        # Direct mentions
        for mentioned_path in t1.get("mentions", set()):
            if mentioned_path in files and mentioned_path != p1:
                refs.append({
                    "type": "direct_reference",
                    "source": p1,
                    "target": mentioned_path,
                    "summary": f"{p1} directly references {mentioned_path}"
                })
        # Topic overlap between project files and decision files
        for j in range(i + 1, len(paths)):
            p2 = paths[j]
            t2 = file_topics.get(p2, {})
            w1, w2 = t1.get("words", set()), t2.get("words", set())
            overlap = w1 & w2 - {"this", "that", "with", "from", "have", "been", "will", "they", "their", "about", "would", "could", "should", "which", "there", "other", "just", "some", "than", "into", "only", "also", "very", "when", "what", "your", "more", "make", "like", "over", "such", "take", "each", "them"}
            # Only flag if significant overlap and different directories
            dir1 = str(Path(p1).parent)
            dir2 = str(Path(p2).parent)
            if len(overlap) >= 8 and dir1 != dir2:
                shared = sorted(overlap, key=lambda w: -len(w))[:5]
                refs.append({
                    "type": "topic_overlap",
                    "source": p1,
                    "target": p2,
                    "shared_topics": shared,
                    "summary": f"{p1} and {p2} share topics: {', '.join(shared)}"
                })
    return refs[:20]


def _detect_workflow_patterns(chats):
    """Analyze recent chat history to detect common workflow sequences."""
    patterns = []
    if not chats or len(chats) < 3:
        return patterns

    # Analyze the titles/topics of recent chats to detect sequences
    recent_titles = [c.get("title", "").lower() for c in chats[:15]]

    research_kw = {"research", "investigate", "study", "analyze", "report", "sources", "deep dive"}
    brainstorm_kw = {"brainstorm", "ideas", "ideate", "creative", "options", "mind map"}
    plan_kw = {"plan", "organize", "schedule", "roadmap", "strategy", "priorities"}
    write_kw = {"write", "draft", "document", "create", "update", "edit"}
    decide_kw = {"decide", "decision", "choose", "compare", "evaluate"}

    def title_matches(title, keywords):
        return any(kw in title for kw in keywords)

    recent_types = []
    for t in recent_titles:
        if title_matches(t, research_kw): recent_types.append("research")
        elif title_matches(t, brainstorm_kw): recent_types.append("brainstorm")
        elif title_matches(t, plan_kw): recent_types.append("plan")
        elif title_matches(t, write_kw): recent_types.append("write")
        elif title_matches(t, decide_kw): recent_types.append("decide")

    # Detect the most recent type and suggest next step
    if recent_types:
        latest = recent_types[0]
        suggestions = {
            "research": {
                "detected": "You've been doing research",
                "suggestion": "Ready to brainstorm or create a mind map from your findings?",
                "action": {"type": "prompt", "text": "Create a mind map summarizing my recent research findings"},
            },
            "brainstorm": {
                "detected": "You've been brainstorming",
                "suggestion": "Want to organize these ideas into a project plan?",
                "action": {"type": "prompt", "text": "Help me organize my brainstorming ideas into a structured project plan"},
            },
            "plan": {
                "detected": "You've been planning",
                "suggestion": "Time to start executing? Want to create task breakdowns?",
                "action": {"type": "prompt", "text": "Break down my plan into actionable tasks with a todo list"},
            },
            "decide": {
                "detected": "You've been evaluating options",
                "suggestion": "Ready to document the decision and update STATUS.md?",
                "action": {"type": "prompt", "text": "Help me write a decision record for the choice I just made and update STATUS.md"},
            },
            "write": {
                "detected": "You've been writing",
                "suggestion": "Want to review, get feedback, or share this work?",
                "action": {"type": "prompt", "text": "Review what I just wrote and suggest improvements"},
            },
        }
        if latest in suggestions:
            patterns.append(suggestions[latest])

    # Detect repeated sequences (e.g. research→brainstorm pattern)
    if len(recent_types) >= 2:
        pair = f"{recent_types[1]}→{recent_types[0]}"
        common_flows = {
            "research→brainstorm": "You often brainstorm after research — this is becoming your flow!",
            "brainstorm→plan": "You like to plan right after brainstorming — nice workflow!",
            "plan→write": "Planning then writing — your systematic approach is working!",
            "decide→write": "Making decisions then documenting — great habit!",
        }
        if pair in common_flows:
            patterns.append({
                "detected": "Workflow pattern recognized",
                "suggestion": common_flows[pair],
                "action": None,
            })

    return patterns[:3]


def _widget_has_content(w):
    """Check if a widget has meaningful content to display."""
    wtype = (w.get("type") or "focus").lower()
    if wtype in ("recent", "todos", "nudge"):
        items = w.get("items") or []
        return isinstance(items, list) and len(items) > 0
    if wtype in ("vision", "motivation", "focus"):
        text = (w.get("text") or "").strip()
        return bool(text)
    return True

def _fallback_home_widgets(user_name, profile, chats, todos, visions):
    first_name = (user_name or "").split()[0] or "there"
    heading = f"Welcome back, {first_name}."
    widgets = []

    # Proactive friction detection — surface nudges early
    nudges = _detect_friction_points(chats, todos, profile)
    if nudges:
        widgets.append({
            "type": "nudge",
            "size": "medium",
            "title": "Needs your attention",
            "subtitle": f"{len(nudges)} item{'s' if len(nudges)!=1 else ''}",
            "items": nudges,
        })

    pending_todos = [t for t in (todos or []) if not t.get("done")]
    if pending_todos:
        widgets.append({
            "type": "todos",
            "size": "medium",
            "title": "Priority tasks",
            "subtitle": f"{len(pending_todos)} open",
            "items": pending_todos[:5],
        })

    if chats:
        widgets.append({
            "type": "recent",
            "size": "medium",
            "title": "Continue where you left off",
            "items": [{"id": c.get("id"), "title": c.get("title", "Untitled")} for c in chats[:5]],
        })

    focus = (profile.get("current_focus") or "").strip()
    if focus:
        widgets.append({
            "type": "focus",
            "size": "small",
            "title": "Current focus",
            "text": focus[:180],
        })

    if visions:
        v = visions[0]
        widgets.append({
            "type": "vision",
            "size": "small",
            "title": "Vision target",
            "text": (v.get("title") or "").strip()[:140],
            "meta": (v.get("when") or "").strip()[:80],
        })

    if not widgets:
        widgets = [{
            "type": "focus",
            "size": "large",
            "title": "Your command center is ready",
            "text": "Add tasks or start a chat to make this dashboard uniquely yours.",
        }]

    widgets = [w for w in widgets if _widget_has_content(w)]
    return {"heading": heading, "widgets": widgets[:6]}


def _ai_home_widgets(user_name, profile, chats, todos, visions):
    settings = load_settings()
    selected = normalize_selected_model(settings)
    resolved = resolve_chat_model({"model": selected}, settings)
    if resolved.get("error"):
        return None

    provider = resolved.get("provider")
    if provider not in ("google", "openai", "anthropic", "custom"):
        return None

    payload = {
        "user_name": user_name,
        "profile": {
            "preferred_name": profile.get("preferred_name", ""),
            "what_you_do": profile.get("what_you_do", ""),
            "hobbies": profile.get("hobbies", ""),
            "current_focus": profile.get("current_focus", ""),
        },
        "recent_chats": [{"id": c.get("id"), "title": c.get("title", "Untitled")} for c in chats[:8]],
        "todos": todos[:10],
        "visions": visions[:5],
    }

    prompt = (
        "You are designing a dynamic AI homepage dashboard. "
        "Choose 3 to 5 useful widgets and sizes based on the provided user data. "
        "Output STRICT JSON only with this schema:\n"
        "{\n"
        "  \"heading\": \"string\",\n"
        "  \"widgets\": [\n"
        "    {\n"
        "      \"type\": \"todos|recent|focus|vision|motivation\",\n"
        "      \"size\": \"small|medium|large\",\n"
        "      \"title\": \"string\",\n"
        "      \"subtitle\": \"string (optional)\",\n"
        "      \"text\": \"string (optional)\",\n"
        "      \"items\": []\n"
        "    }\n"
        "  ]\n"
        "}\n"
        "Rules: pick practical widgets first, reflect upcoming schedule and todos if present, and keep it concise.\n\n"
        f"DATA:\n{json.dumps(payload, ensure_ascii=False)}"
    )

    try:
        raw = PROVIDERS.get(provider, call_openai)(
            resolved["api_key"],
            resolved["actual_model"],
            "You return clean JSON only.",
            [{"role": "user", "text": prompt}],
            base_url=resolved.get("base_url"),
        )
        txt = (raw or "").strip()
        m = re.search(r"\{[\s\S]*\}", txt)
        if m:
            txt = m.group(0)
        out = json.loads(txt)
        widgets = out.get("widgets") if isinstance(out, dict) else None
        if not isinstance(widgets, list) or not widgets:
            return None
        widgets = [w for w in widgets if _widget_has_content(w)]
        if not widgets:
            return None
        return {
            "heading": str(out.get("heading") or f"Welcome back, {(user_name or 'there').split()[0]}.")[:120],
            "widgets": widgets[:5],
        }
    except Exception:
        return None


# ─── Provider Calls ──────────────────────────────────────────────────────────

def call_google(api_key, model, sysprompt, messages, base_url=None, thinking=False, web_search=False, **kwargs):
    genai, types = _import_google()
    client = genai.Client(api_key=api_key)
    contents = _google_contents_from_messages(messages, types)
    cfg = dict(system_instruction=sysprompt)
    if thinking:
        cfg["thinking_config"] = types.ThinkingConfig(thinking_budget=16000, include_thoughts=True)
        cfg["max_output_tokens"] = 65536
        print(f"  [thinking] Google non-stream: thinking enabled, budget=16000")
    else:
        cfg["max_output_tokens"] = 16384
    if web_search:
        cfg["tools"] = [types.Tool(google_search=types.GoogleSearch())]
    r = client.models.generate_content(model=model, contents=contents,
        config=types.GenerateContentConfig(**cfg))
    # Extract thinking parts if present
    result_parts = []
    try:
        for candidate in (r.candidates or []):
            for part in (candidate.content.parts or []):
                is_thought = getattr(part, "thought", None)
                if is_thought and part.text:
                    print(f"  [thinking] Google: got thought part ({len(part.text)} chars)")
                    result_parts.append(f"<<<THINKING>>>\n{part.text}\n<<<END_THINKING>>>\n")
                elif part.text:
                    result_parts.append(part.text)
    except Exception as e:
        print(f"  [thinking] Google: error extracting parts: {e}")
        return r.text
    return "".join(result_parts) if result_parts else (r.text or "")

def call_google_stream(api_key, model, sysprompt, messages, base_url=None, thinking=False, web_search=False, **kwargs):
    genai, types = _import_google()
    client = genai.Client(api_key=api_key)
    contents = _google_contents_from_messages(messages, types)
    cfg = dict(system_instruction=sysprompt)
    if thinking:
        cfg["thinking_config"] = types.ThinkingConfig(thinking_budget=16000, include_thoughts=True)
        cfg["max_output_tokens"] = 65536
        print(f"  [thinking] Google stream: thinking enabled, budget=16000")
    else:
        cfg["max_output_tokens"] = 16384
    if web_search:
        cfg["tools"] = [types.Tool(google_search=types.GoogleSearch())]
    stream = client.models.generate_content_stream(
        model=model,
        contents=contents,
        config=types.GenerateContentConfig(**cfg),
    )
    _thought_count = 0
    for chunk in stream:
        # Check for thinking parts in candidates
        try:
            for candidate in (chunk.candidates or []):
                for part in (candidate.content.parts or []):
                    is_thought = getattr(part, "thought", None)
                    if is_thought and part.text:
                        _thought_count += 1
                        if _thought_count == 1:
                            print(f"  [thinking] Google stream: first thought chunk received")
                        yield {"__thinking__": True, "text": part.text}
                        continue
                    if part.text:
                        yield part.text
        except (AttributeError, TypeError) as e:
            if thinking and _thought_count == 0:
                print(f"  [thinking] Google stream: exception in part extraction: {e}")
            text = getattr(chunk, "text", "") or ""
            if text:
                yield text
    if thinking:
        print(f"  [thinking] Google stream: total thought chunks={_thought_count}")

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
        create_kw["thinking"] = {"type": "enabled", "budget_tokens": 16000}
        print(f"  [thinking] Anthropic non-stream: thinking enabled, budget=16000")
    r = client.messages.create(**create_kw)
    if thinking:
        parts_out = []
        for block in r.content:
            if block.type == "thinking" and getattr(block, "thinking", None):
                print(f"  [thinking] Anthropic: got thinking block ({len(block.thinking)} chars)")
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
        print(f"  [thinking] Anthropic stream: thinking enabled, budget=16000")
        # Stream with thinking enabled — iterate raw events
        _thought_count = 0
        with client.messages.stream(
            model=model, max_tokens=64000, system=sysprompt, messages=msgs,
            thinking={"type": "enabled", "budget_tokens": 16000}
        ) as s:
            current_block_type = None
            for event in s:
                etype = getattr(event, "type", "")
                if etype == "content_block_start":
                    block = getattr(event, "content_block", None)
                    current_block_type = getattr(block, "type", "") if block else ""
                elif etype == "content_block_delta":
                    delta = getattr(event, "delta", None)
                    if delta:
                        dt = getattr(delta, "type", "")
                        if dt == "thinking_delta":
                            text = getattr(delta, "thinking", "") or ""
                            if text:
                                _thought_count += 1
                                if _thought_count == 1:
                                    print(f"  [thinking] Anthropic stream: first thinking delta")
                                yield {"__thinking__": True, "text": text}
                        elif dt == "text_delta":
                            yield getattr(delta, "text", "")
                elif etype == "content_block_stop":
                    current_block_type = None
        print(f"  [thinking] Anthropic stream: total thinking deltas={_thought_count}")
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
    html = open(os.path.join("static", "index.html"), encoding="utf-8").read()
    html = html.replace("__CACHE_BUST__", _BOOT_TS)
    return html, 200, {"Content-Type": "text/html; charset=utf-8"}

@app.route("/api/ping")
def ping():
    """Lightweight keep-alive endpoint to prevent Render from sleeping."""
    return jsonify({"ok": True, "ts": int(time.time())})

@app.after_request
def add_no_cache_headers(resp):
    path = request.path or ""
    if path == "/" or path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp

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
    d = request.get_json() or {}
    # Reuse a previously-stored guest_id so chats survive session loss
    prev_gid = (d.get("guest_id") or "").strip()
    if prev_gid and re.match(r'^[a-zA-Z0-9\-_]{1,36}$', prev_gid):
        gid = prev_gid
    else:
        gid = str(uuid.uuid4())[:12]
    session["guest"] = True
    session["guest_id"] = gid
    session.permanent = True
    return jsonify({"ok": True, "guest": True, "plan": "guest", "guest_id": gid})

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
    if user["email"].lower().strip() == CREATOR_EMAIL:
        if not (profile.get("origin_story") or "").strip():
            profile["origin_story"] = DEFAULT_CREATOR_ORIGIN_STORY
            save_profile(profile)
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
    # Generate a remember token so the frontend can re-auth after session loss
    remember_token = secrets.token_hex(32)
    tokens = user.get("remember_tokens", [])
    tokens = tokens[-4:]  # Keep last 5 tokens max
    tokens.append(_hash_remember_token(remember_token))
    user["remember_tokens"] = tokens
    _save_user(user)
    session.permanent = True
    session["user_id"] = user["id"]; session["email"] = user["email"]
    return jsonify({"user": {"id": user["id"], "email": user["email"],
                             "name": user["name"], "theme": user.get("theme", "dark"), "plan": user.get("plan", "free")},
                    "remember_token": remember_token})

@app.route("/api/auth/resume", methods=["POST"])
def auth_resume():
    """Re-establish a session using a remember token stored in the browser."""
    d = request.get_json() or {}
    uid = (d.get("user_id") or "").strip()
    token = (d.get("remember_token") or "").strip()
    if not uid or not token:
        return jsonify({"authenticated": False}), 401
    user = _load_user_by_id(uid)
    if not user:
        return jsonify({"authenticated": False}), 401
    stored = user.get("remember_tokens", [])
    hashed = _hash_remember_token(token)
    if hashed not in stored:
        return jsonify({"authenticated": False}), 401
    session.permanent = True
    session["user_id"] = user["id"]
    session["email"] = user["email"]
    profile = load_profile()
    return jsonify({"authenticated": True, "user": {
        "id": user["id"], "email": user["email"], "name": user["name"],
        "theme": user.get("theme", "dark"), "provider": user.get("provider", "local"),
        "created": user.get("created"), "plan": user.get("plan", "free")},
        "onboarding_complete": bool(profile.get("onboarding_complete"))})

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
    """Permanently delete the user's account and all associated data."""
    uid = session.get("user_id")
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    if FIREBASE_ENABLED:
        # Delete all chats
        col = _chats_col()
        if col:
            for doc in col.stream():
                doc.reference.delete()
        # Delete memory, settings, profile
        for doc_name in ("memory", "settings", "profile"):
            ref = _uid_doc(doc_name)
            if ref:
                try: ref.delete()
                except Exception: pass
        # Delete uploaded files
        bucket = _storage_bucket()
        if bucket:
            try:
                blobs = bucket.list_blobs(prefix=f"uploads/{uid}/")
                for blob in blobs:
                    blob.delete()
            except Exception:
                pass
        # Delete the user document itself
        try:
            user_ref = db.collection("users").document(uid)
            user_ref.delete()
        except Exception:
            pass
    else:
        import shutil
        user_dir = _local_user_dir(uid)
        if user_dir.exists():
            shutil.rmtree(user_dir)
    # Clear server session
    session.clear()
    return jsonify({"ok": True, "message": "Account deleted."})

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
    if plan not in ("free", "pro", "max", "dev"):
        return jsonify({"error": "Invalid plan. Must be: free, pro, max, or dev"}), 400
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
            "origin_story": p.get("origin_story", ""),
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
        "origin_story": profile.get("origin_story", ""),
    })
    save_profile(profile)
    _save_user_name(profile["preferred_name"])

    mem = load_memory()
    prefixes = ("Preferred name: ", "Work: ", "Hobbies: ", "Current focus: ", "Why I built gyro:")
    facts = [f for f in mem.get("facts", []) if not any(f.startswith(pfx) for pfx in prefixes)]
    facts.append(f"Preferred name: {profile['preferred_name']}")
    facts.append(f"Work: {profile['what_you_do']}")
    facts.append(f"Hobbies: {profile['hobbies']}")
    if profile["current_focus"]:
        facts.append(f"Current focus: {profile['current_focus']}")
    user = _cur_user()
    if user and user.get("email", "").lower().strip() == CREATOR_EMAIL:
        profile["origin_story"] = DEFAULT_CREATOR_ORIGIN_STORY
        save_profile(profile)
        facts.append(f"Why I built gyro: {DEFAULT_CREATOR_ORIGIN_STORY}")
    mem["facts"] = facts
    save_memory(mem)

    return jsonify({"ok": True, "profile": profile, "user": {"name": profile["preferred_name"]}})

# ─── Routes: OAuth Config ────────────────────────────────────────────────────

@app.route("/api/oauth-config")
def get_oauth_cfg():
    try:
        cfg = _load_oauth()
    except Exception:
        cfg = {}
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
    c, reason = load_chat(chat_id)
    if not c: return jsonify({"error": f"Chat not found ({reason})"}), 404
    return jsonify(c)

@app.route("/api/chats/<chat_id>", methods=["PATCH"])
@require_auth_or_guest
def patch_chat(chat_id):
    c, reason = load_chat(chat_id)
    if not c: return jsonify({"error": f"Chat not found ({reason})"}), 404
    d = request.get_json()
    for f in ("title", "folder", "custom_instructions", "pinned_files"):
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

@app.route("/api/chats/bulk-delete", methods=["POST"])
@require_auth_or_guest
def bulk_delete_chats():
    """Delete multiple chats at once."""
    d = request.get_json() or {}
    ids = d.get("chat_ids", [])
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "No chat IDs provided"}), 400
    deleted = 0
    for cid in ids:
        if isinstance(cid, str) and _safe_id(cid):
            if delete_chat(cid):
                deleted += 1
    return jsonify({"ok": True, "deleted": deleted})

@app.route("/api/chats/delete-all", methods=["POST"])
@require_auth_or_guest
def delete_all_chats():
    """Delete every chat for the current user."""
    chats = list_chats()
    deleted = 0
    for c in chats:
        if delete_chat(c["id"]):
            deleted += 1
    return jsonify({"ok": True, "deleted": deleted})

@app.route("/api/cross-references")
@require_auth
def cross_references_route():
    """Analyze workspace files and return cross-references."""
    files = read_workspace_files()
    refs = _build_cross_references(files)
    return jsonify({"references": refs})

@app.route("/api/workflow-patterns")
@require_auth_or_guest
def workflow_patterns_route():
    """Analyze recent chat history and return detected workflow patterns."""
    chats = list_chats()
    patterns = _detect_workflow_patterns(chats)
    return jsonify({"patterns": patterns})

@app.route("/api/chats/<chat_id>/message", methods=["POST"])
@require_auth_or_guest
def chat_message(chat_id):
    if session.get("guest") and not session.get("user_id"):
        if _guest_tokens_used() >= GUEST_TOKEN_LIMIT:
            return jsonify({"reply": "You've reached your daily token limit for guest access. Sign in with Google for unlimited access!", "files": [], "guest_limit": True})
    chat, reason = load_chat(chat_id)
    if not chat: return jsonify({"error": f"Chat not found ({reason})"}), 404
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
            return jsonify({"error": f"Rate limit hit — wait a moment and try again. ({err[:120]})", "files": []})
        return jsonify({"error": f"API error: {err}", "files": []})

    resp, research_query = extract_research_trigger(resp)
    clean, executed, new_facts, code_results = finalize_chat_response(chat, ctx, resp)
    result = {"reply": clean, "files": executed, "memory_added": new_facts}
    if code_results:
        result["code_results"] = code_results
    if research_query:
        result["research_trigger"] = research_query
    return jsonify(result)


@app.route("/api/detect-tools", methods=["POST"])
@require_auth_or_guest
def detect_tools():
    """Tool detection endpoint — now tools are user-activated only."""
    return jsonify({"tool": None})


@app.route("/api/chats/<chat_id>/stream", methods=["POST"])
@require_auth_or_guest
def chat_message_stream(chat_id):
    if session.get("guest") and not session.get("user_id"):
        if _guest_tokens_used() >= GUEST_TOKEN_LIMIT:
            return jsonify({"reply": "You've reached your daily token limit for guest access. Sign in with Google for unlimited access!", "files": [], "guest_limit": True})
    chat, reason = load_chat(chat_id)
    if not chat:
        return jsonify({"error": f"Chat not found ({reason})"}), 404

    payload = request.get_json() or {}
    ctx, err_resp, status = prepare_chat_turn(chat, payload)
    if err_resp:
        return err_resp, status

    thinking = ctx.get("thinking", False)
    web_search = ctx.get("web_search", False)
    print(f"  [stream] thinking={thinking}, web_search={web_search}, provider={ctx['resolved'].get('provider')}, model={ctx['resolved'].get('actual_model')}")
    # For OpenAI (no native thinking), inject thinking instruction into system prompt
    if thinking and ctx["resolved"].get("provider") not in ("google", "anthropic"):
        ctx["sysprompt"] += "\n\n[THINKING MODE ENABLED]\nBefore answering, think through your approach step by step. Wrap ONLY your internal reasoning in <<<THINKING>>> and <<<END_THINKING>>> tags (these will be shown to the user in a collapsible block). Keep thinking concise — brief bullet points only. Then write your actual response AFTER the <<<END_THINKING>>> tag with no tags in it."

    resolved = ctx["resolved"]

    def event(payload):
        return json.dumps(payload) + "\n"

    @stream_with_context
    def generate():
        pieces = []
        thinking_pieces = []
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
                    # Check if chunk is a thinking dict from google/anthropic
                    if isinstance(chunk, dict) and chunk.get("__thinking__"):
                        thinking_pieces.append(chunk["text"])
                        if chunk["text"]:
                            yield event({"type": "thinking_delta", "text": chunk["text"]})
                        continue
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

            raw_text = "".join(pieces)
            # Prepend thinking content if we got structured thinking from the API
            if thinking_pieces:
                think_text = "".join(thinking_pieces).strip()
                if think_text:
                    raw_text = f"<<<THINKING>>>\n{think_text}\n<<<END_THINKING>>>\n{raw_text}"
            # Check if AI triggered deep research
            raw_text, research_query = extract_research_trigger(raw_text)
            # Extract image search queries and fetch results
            raw_text, image_queries = extract_image_searches(raw_text)
            image_results = []
            for iq in image_queries:
                imgs = search_images(iq)
                if imgs:
                    image_results.append({"query": iq, "images": imgs})
            clean, executed, new_facts, code_results = finalize_chat_response(chat, ctx, raw_text)
            done_payload = {
                "type": "done",
                "reply": clean,
                "files": executed,
                "memory_added": new_facts,
                "title": chat.get("title", "New Chat"),
            }
            if code_results:
                done_payload["code_results"] = code_results
            if research_query:
                done_payload["research_trigger"] = research_query
            if image_results:
                done_payload["image_results"] = image_results
            yield event(done_payload)
        except Exception as e:
            err = str(e)
            if any(w in err.lower() for w in ("429", "quota", "rate")):
                yield event({"type": "error", "error": f"Rate limit hit \u2014 wait a moment and try again. ({err[:200]})"})
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


@app.route("/api/canvas/run", methods=["POST"])
@require_auth
def canvas_run():
    d = request.get_json() or {}
    code = (d.get("code") or "").strip()
    language = (d.get("language") or "").strip().lower()
    if not code:
        return jsonify({"error": "No code to run."}), 400
    if language != "python":
        return jsonify({"error": f"Run not supported for '{language}'."}), 400

    import subprocess, tempfile, os
    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as tmp:
            tmp.write(code)
            tmp_path = tmp.name
        result = subprocess.run(
            ["python", tmp_path],
            capture_output=True, text=True, timeout=15,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        os.unlink(tmp_path)
        output = result.stdout
        if result.stderr:
            output += ("\n" if output else "") + result.stderr
        return jsonify({"output": output.strip()})
    except subprocess.TimeoutExpired:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        return jsonify({"output": "Execution timed out (15s limit)."})
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

@app.route("/api/user-files")
@require_auth_or_guest
def list_user_files():
    """Return only user-facing files (notes, projects, etc.) in a tree structure."""
    tree = []
    for root, dirs, fnames in os.walk(WORKSPACE):
        dirs[:] = [d for d in sorted(dirs) if d not in SERVER_DIRS]
        rel_root = Path(root).relative_to(WORKSPACE)
        for fn in sorted(fnames):
            if fn.startswith(".") or fn in SERVER_FILES:
                continue
            fp = Path(root) / fn
            rp = str(rel_root / fn) if str(rel_root) != "." else fn
            try:
                size = fp.stat().st_size
            except Exception:
                size = 0
            tree.append({"path": rp, "name": fn, "size": size,
                         "folder": str(rel_root) if str(rel_root) != "." else ""})
    return jsonify({"files": tree})

@app.route("/api/user-files/folder", methods=["POST"])
@require_auth
def create_user_folder():
    """Create a custom folder in the workspace."""
    d = request.get_json() or {}
    name = (d.get("path") or "").strip()
    if not name or ".." in name or name.startswith("/"):
        return jsonify({"error": "Invalid folder name"}), 400
    clean = Path(name).as_posix()
    fp = WORKSPACE / clean
    fp.mkdir(parents=True, exist_ok=True)
    return jsonify({"ok": True, "path": clean})

@app.route("/api/user-files/delete", methods=["POST"])
@require_auth
def delete_user_file():
    d = request.get_json() or {}
    path = (d.get("path") or "").strip()
    if not path or ".." in path or path.startswith("/"):
        return jsonify({"error": "Invalid path"}), 400
    clean = Path(path).as_posix()
    fp = WORKSPACE / clean
    if not fp.exists():
        return jsonify({"error": "Not found"}), 404
    if fp.name in SERVER_FILES or any(part in SERVER_DIRS for part in Path(clean).parts):
        return jsonify({"error": "Access denied"}), 403
    if fp.is_dir():
        import shutil
        shutil.rmtree(fp)
    else:
        fp.unlink()
    return jsonify({"ok": True})

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

@app.route("/api/files/download")
@require_auth_or_guest
def download_workspace_file():
    """Download any user-facing workspace file."""
    path = (request.args.get("path") or "").strip()
    if not path or ".." in path or path.startswith("/"):
        return jsonify({"error": "Invalid path"}), 400
    clean = Path(path).as_posix()
    fp = WORKSPACE / clean
    if not fp.exists() or not fp.is_file():
        return jsonify({"error": "File not found"}), 404
    # Don't allow downloading server files or files in protected directories
    if fp.name in SERVER_FILES:
        return jsonify({"error": "Access denied"}), 403
    if any(part in SERVER_DIRS for part in Path(clean).parts):
        return jsonify({"error": "Access denied"}), 403
    return send_from_directory(str(fp.parent), fp.name, as_attachment=True)

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

# ─── Version & Changelog ──────────────────────────────────────────────────────
gyro_VERSION = "3.3"
gyro_CHANGELOG = [
    {
        "version": "3.3",
        "date": "2026-03-21",
        "title": "Image Search",
        "changes": [
            "gyro can now search and show real images from Google in a carousel",
            "Ask to see what anything looks like and get visual results inline",
        ]
    },
    {
        "version": "3.2",
        "date": "2026-03-21",
        "title": "Intelligence & Management Upgrade",
        "changes": [
            "Intelligent Cross-Referencing: gyro now draws connections across all your files automatically",
            "Workflow Pattern Learning: detects your work sequences and suggests next steps",
            "New cross-references & workflow pattern widgets on home screen",
            "Delete folders and all their chats at once",
            "Multi-select mode: select and bulk-delete chats and folders",
            "Delete All Chats button in settings",
            "Account deletion now properly removes everything",
        ]
    },
    {
        "version": "3.1",
        "date": "2026-03-21",
        "title": "Quality-of-Life Improvements",
        "changes": [
            "Fixed duplicate chat reload when clicking an already-open chat",
            "Sessions now stay alive during inactivity — no more random logouts",
            "Added update notification system so you never miss new features",
        ]
    },
    {
        "version": "3.0",
        "date": "2026-03-01",
        "title": "Initial Release",
        "changes": [
            "gyro launched with multi-model AI chat",
            "Deep research mode",
            "Canvas & workspace tools",
        ]
    },
]

@app.route("/api/status")
def status_route():
    return jsonify({"version": gyro_VERSION, "name": "gyro"})

@app.route("/api/changelog")
def changelog_route():
    """Return current version + full changelog for the update modal."""
    return jsonify({"version": gyro_VERSION, "changelog": gyro_CHANGELOG})

@app.route("/api/greeting")
@require_auth_or_guest
def get_greeting():
    user = _cur_user()
    raw_name = user.get("name", "") if user else ""
    # Don't use "Guest" as a real name for guest accounts
    if raw_name == "Guest" or (user and user.get("provider") == "guest"):
        uname = ""
    else:
        uname = raw_name.split()[0] if raw_name else ""
    h = None
    # Prefer client-provided local hour so greetings are correct across server regions.
    try:
        hour_raw = (request.args.get("hour") or "").strip()
        if hour_raw:
            parsed = int(hour_raw)
            if 0 <= parsed <= 23:
                h = parsed
    except Exception:
        h = None
    if h is None:
        h = datetime.datetime.now().hour
    if h < 5: period = "late night"
    elif h < 12: period = "morning"
    elif h < 17: period = "afternoon"
    elif h < 21: period = "evening"
    else: period = "late night"
    name_part = f", {uname}" if uname else ""
    presets = {
        "late night": [
            f"Burning the midnight oil{name_part}?",
            f"Late-night focus{name_part}?",
            f"Quiet hours, clear mind{name_part}.",
            f"The world sleeps{name_part}. You build.",
            f"Night owl mode activated{name_part}.",
            f"Still going strong{name_part}? 🌙",
            f"Deep into the night{name_part}.",
            f"Midnight clarity{name_part}.",
            f"The best ideas come late{name_part}.",
            f"No distractions now{name_part}.",
        ],
        "morning": [
            f"Early start today{name_part}?",
            f"Morning focus, steady pace{name_part}.",
            f"Fresh morning energy{name_part}.",
            f"New day, new momentum{name_part}.",
            f"Rise and build{name_part}. ☀️",
            f"Morning brain is the best brain{name_part}.",
            f"Let's make today count{name_part}.",
            f"Good morning{name_part}. What's the plan?",
            f"The day is yours{name_part}.",
            f"Coffee and ideas{name_part}? ☕",
            f"Starting fresh{name_part}.",
            f"Clear mind, full day ahead{name_part}.",
        ],
        "afternoon": [
            f"Afternoon rhythm holding up{name_part}?",
            f"Midday focus check{name_part}.",
            f"Keeping momentum this afternoon{name_part}?",
            f"Halfway through the day{name_part}.",
            f"Afternoon push{name_part}. Let's go.",
            f"Post-lunch productivity{name_part}? 🚀",
            f"Still crushing it{name_part}.",
            f"The afternoon stretch{name_part}.",
            f"Second wind kicking in{name_part}?",
            f"Keep the energy up{name_part}.",
        ],
        "evening": [
            f"Evening stretch ahead{name_part}.",
            f"Winding down or diving in{name_part}?",
            f"Golden hour thoughts{name_part}.",
            f"Evening mode{name_part}. Time to reflect or create.",
            f"Wrapping up the day{name_part}?",
            f"One more thing before tonight{name_part}?",
            f"Good evening{name_part}. What's on your mind?",
            f"The quiet part of the day{name_part}. 🌅",
            f"End-of-day clarity{name_part}.",
            f"Evening glow, fresh perspective{name_part}.",
        ],
    }
    return jsonify({"greeting": random.choice(presets.get(period, [f"Ready when you are{name_part}."]))})  


@app.route("/api/home-widgets", methods=["POST"])
@require_auth_or_guest
def home_widgets_route():
    body = request.get_json() or {}
    todos = body.get("todos", []) if isinstance(body.get("todos", []), list) else []
    visions = body.get("visions", []) if isinstance(body.get("visions", []), list) else []

    user = _cur_user() or {}
    profile = load_profile() if session.get("user_id") else {
        "preferred_name": "",
        "what_you_do": "",
        "hobbies": "",
        "current_focus": "",
        "origin_story": "",
    }
    chats = list_chats() if session.get("user_id") else []

    plan = _fallback_home_widgets(user.get("name", ""), profile, chats, todos, visions)
    return jsonify(plan)

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
                self.cell(0, 6, f"gyro Research  |  {title[:60]}", align="R", new_x="LMARGIN", new_y="NEXT")
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
    pdf.cell(0, 12, "gyro DEEP RESEARCH", align="C", new_x="LMARGIN", new_y="NEXT")
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
    pdf.cell(0, 6, f"Generated by gyro AI  |  {datetime.datetime.now().strftime('%B %d, %Y  %H:%M')}", align="C", new_x="LMARGIN", new_y="NEXT")
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

def _run_research_job(job_id, query, depth, resolved, user_plan=None):
    """Background thread: multi-step deep research pipeline with deep thinking."""
    job = _research_jobs[job_id]

    def push(evt_type, **kw):
        job["events"].append({"type": evt_type, **kw})

    def is_cancelled():
        return job.get("cancelled", False)

    depth_cfg = {
        "quick":    {"sub_q": 5,  "searches_per_q": 2, "urls_per_q": 5,  "max_fetch": 15,  "detail": "concise but insightful", "analysis_words": "300-500", "report_min": 2000, "max_report_tokens": 8000},
        "standard": {"sub_q": 8,  "searches_per_q": 3, "urls_per_q": 6,  "max_fetch": 25,  "detail": "thorough and comprehensive", "analysis_words": "400-700", "report_min": 4000, "max_report_tokens": 12000},
        "deep":     {"sub_q": 12, "searches_per_q": 5, "urls_per_q": 8,  "max_fetch": 45,  "detail": "exhaustive, deeply analytical, and authoritative", "analysis_words": "600-1000", "report_min": 7000, "max_report_tokens": 16000},
    }.get(depth, {"sub_q": 8, "searches_per_q": 3, "urls_per_q": 6, "max_fetch": 25, "detail": "thorough and comprehensive", "analysis_words": "400-700", "report_min": 4000, "max_report_tokens": 12000})

    total_steps = 10
    try:
        # ══════════════════════════════════════════════════════════════
        # STEP 1: Deep Query Analysis & Research Planning
        # ══════════════════════════════════════════════════════════════
        push("progress", step="planning", pct=1, total_steps=total_steps, current_step=1,
             message="Analyzing research topic and formulating investigation strategy...")

        if is_cancelled():
            push("cancelled"); job["status"] = "cancelled"; return

        # Use user-provided plan if available
        user_plan_text = user_plan or ""
        if user_plan_text.strip():
            # Parse user plan directly
            sub_questions = []
            search_queries = {}
            angle_idx = 0
            for line in user_plan_text.split("\n"):
                s = line.strip()
                m = re.match(r"^\s*\d+[.)]\s+(.+)", s)
                if m:
                    sq = m.group(1).strip()
                    # Check for search queries after a pipe or dash
                    if " | " in sq or " — " in sq:
                        parts = re.split(r"\s*[|—]\s*", sq)
                        sq = parts[0].strip()
                        search_queries[angle_idx] = [p.strip().strip('"\'') for p in parts[1:] if p.strip()]
                    sub_questions.append(sq)
                    angle_idx += 1
            sub_questions = (sub_questions or [query])[:depth_cfg["sub_q"] + 4]  # allow user to add extra
            push("progress", step="planning", pct=5, total_steps=total_steps, current_step=1,
                 message=f"Using your custom plan: {len(sub_questions)} investigation angles.")
        else:
            plan = _research_ai_call(
                f"""You are a senior research strategist. Deeply analyze this research topic and create a comprehensive research plan.

RESEARCH TOPIC: {query}

Think step by step:
1. What is being asked? What are the core concepts?
2. What domains of knowledge does this span?
3. What are the key tensions, debates, or open questions?
4. What would a world-class researcher investigate?
5. What primary sources and data would be most valuable?
6. What interdisciplinary connections exist?

Now produce EXACTLY this output format:

RESEARCH_ANGLES:
1. <specific sub-question to investigate>
2. <specific sub-question to investigate>
... (exactly {depth_cfg['sub_q']} sub-questions)

SEARCH_STRATEGY:
For each angle, list 2-3 specific search queries that would find the best sources.
Angle 1: "query1" | "query2" | "query3"
Angle 2: "query1" | "query2" | "query3"
... (one line per angle)

KEY_TERMS:
<comma-separated list of key technical terms, names, and concepts to watch for>""",
                resolved, max_tokens=2000
            )

            # Parse sub-questions
            sub_questions = []
            search_queries = {}
            in_angles = False
            in_strategy = False
            angle_idx = 0
            for line in plan.split("\n"):
                s = line.strip()
                if "RESEARCH_ANGLES" in s:
                    in_angles = True; in_strategy = False; continue
                if "SEARCH_STRATEGY" in s:
                    in_angles = False; in_strategy = True; continue
                if "KEY_TERMS" in s:
                    in_angles = False; in_strategy = False; continue
                if in_angles:
                    m = re.match(r"^\s*\d+[.)]\s+(.+)", s)
                    if m:
                        sub_questions.append(m.group(1).strip())
                if in_strategy:
                    m = re.match(r"^\s*(?:Angle\s*)?\d+[.):]\s*(.*)", s)
                    if m and angle_idx < len(sub_questions):
                        queries = [q.strip().strip('"').strip("'") for q in m.group(1).split("|") if q.strip()]
                        search_queries[angle_idx] = queries[:depth_cfg["searches_per_q"]]
                        angle_idx += 1

            sub_questions = (sub_questions or [query])[:depth_cfg["sub_q"]]

        push("progress", step="planning", pct=7, total_steps=total_steps, current_step=1,
             message=f"Research plan ready: {len(sub_questions)} investigation angles identified.",
             plan_angles=sub_questions)

        if is_cancelled():
            push("cancelled"); job["status"] = "cancelled"; return

        # ══════════════════════════════════════════════════════════════
        # STEP 2: Multi-Query Web Search
        # ══════════════════════════════════════════════════════════════
        all_results, seen_urls = [], set()
        total_searches = sum(len(search_queries.get(i, [sub_questions[i]])) for i in range(len(sub_questions))) + 1
        search_done = 0

        for sq_idx, sq in enumerate(sub_questions):
            if is_cancelled():
                push("cancelled"); job["status"] = "cancelled"; return

            queries = search_queries.get(sq_idx, [sq])
            if not queries:
                queries = [sq]
            for search_q in queries:
                if is_cancelled():
                    push("cancelled"); job["status"] = "cancelled"; return
                search_done += 1
                pct = 7 + int((search_done / total_searches) * 18)
                push("progress", step="searching", pct=min(pct, 25), total_steps=total_steps, current_step=2,
                     message=f"Searching [{search_done}/{total_searches}]: {search_q[:75]}...")
                for r in _ddg_search(search_q, max_results=depth_cfg["urls_per_q"]):
                    if r["url"] and r["url"] not in seen_urls:
                        seen_urls.add(r["url"])
                        r["sub_question"] = sq
                        r["search_query"] = search_q
                        all_results.append(r)

        # Also search the main query directly
        search_done += 1
        push("progress", step="searching", pct=25, total_steps=total_steps, current_step=2,
             message=f"Searching main topic: {query[:75]}...")
        for r in _ddg_search(query, max_results=8):
            if r["url"] and r["url"] not in seen_urls:
                seen_urls.add(r["url"])
                r["sub_question"] = query
                all_results.append(r)

        push("progress", step="searching", pct=27, total_steps=total_steps, current_step=2,
             message=f"Found {len(all_results)} unique sources across {search_done} searches.")

        if is_cancelled():
            push("cancelled"); job["status"] = "cancelled"; return

        # ══════════════════════════════════════════════════════════════
        # STEP 3: Source Content Extraction  (parallel)
        # ══════════════════════════════════════════════════════════════
        from concurrent.futures import ThreadPoolExecutor, as_completed
        fetched = []
        fetch_total = min(len(all_results), depth_cfg["max_fetch"])
        to_fetch = all_results[:fetch_total]
        push("progress", step="reading", pct=28, total_steps=total_steps, current_step=3,
             message=f"Reading {fetch_total} sources in parallel...")

        def _fetch_one(result):
            if is_cancelled():
                return None
            return (result, _fetch_url_text(result["url"], timeout=10))

        done_count = 0
        with ThreadPoolExecutor(max_workers=10) as pool:
            futures = {pool.submit(_fetch_one, r): r for r in to_fetch}
            for future in as_completed(futures):
                if is_cancelled():
                    push("cancelled"); job["status"] = "cancelled"; return
                pair = future.result()
                if pair:
                    result, text = pair
                    if text and len(text) > 150:
                        fetched.append({**result, "text": text})
                done_count += 1
                if done_count % 5 == 0 or done_count == fetch_total:
                    pct = 27 + int((done_count / fetch_total) * 13)
                    push("progress", step="reading", pct=min(pct, 40), total_steps=total_steps, current_step=3,
                         message=f"Read {done_count}/{fetch_total} sources ({len(fetched)} extracted)...")

        # Fall back to snippets if fetching yielded little
        if len(fetched) < 3:
            for r in all_results[:20]:
                if r.get("snippet") and len(r["snippet"]) > 80:
                    fetched.append({**r, "text": r["snippet"]})

        push("progress", step="reading", pct=40, total_steps=total_steps, current_step=3,
             message=f"Successfully extracted content from {len(fetched)} sources.")

        if is_cancelled():
            push("cancelled"); job["status"] = "cancelled"; return

        # ══════════════════════════════════════════════════════════════
        # STEP 4: Deep Analysis Per Source (with reasoning)
        # ══════════════════════════════════════════════════════════════
        source_analyses = []
        for idx, src in enumerate(fetched):
            if is_cancelled():
                push("cancelled"); job["status"] = "cancelled"; return
            pct = 40 + int(((idx + 1) / len(fetched)) * 16)
            push("progress", step="analyzing", pct=min(pct, 56), total_steps=total_steps, current_step=4,
                 message=f"Deep analyzing [{idx+1}/{len(fetched)}]: {(src.get('title') or src['url'])[:55]}...")

            analysis = _research_ai_call(
                f"""You are a critical research analyst performing deep analysis on a source.

MAIN RESEARCH TOPIC: {query}
SUB-QUESTION THIS SOURCE ADDRESSES: {src.get('sub_question', query)}
SOURCE: {src.get('title','')} — {src['url']}

CONTENT:
{src['text'][:7000]}

Perform deep thinking analysis:

1. RELEVANCE: How relevant is this to our research topic? (high/medium/low)
2. KEY FINDINGS: Extract every important fact, statistic, quote, argument, and data point relevant to the research topic. Be exhaustive.
3. CREDIBILITY: Assess the source's reliability and potential biases.
4. UNIQUE INSIGHTS: What does this source reveal that others might not?
5. CONNECTIONS: How does this relate to or contradict other aspects of the topic?
6. GAPS: What questions does this raise or leave unanswered?

Write {depth_cfg['analysis_words']} words of detailed analysis.""",
                resolved, max_tokens=1500
            )
            if analysis and "[AI error" not in analysis:
                source_analyses.append({
                    "title": src.get("title", ""),
                    "url": src["url"],
                    "snippet": src.get("snippet", ""),
                    "sub_question": src.get("sub_question", ""),
                    "analysis": analysis,
                })

        push("progress", step="analyzing", pct=56, total_steps=total_steps, current_step=4,
             message=f"Deep analysis complete: {len(source_analyses)} sources thoroughly analyzed.")

        if is_cancelled():
            push("cancelled"); job["status"] = "cancelled"; return

        # ══════════════════════════════════════════════════════════════
        # STEP 5: Gap Analysis & Supplemental Search
        # ══════════════════════════════════════════════════════════════
        push("progress", step="gap-analysis", pct=57, total_steps=total_steps, current_step=5,
             message="Identifying knowledge gaps and searching for missing information...")

        analyses_block = "\n\n".join(
            f"### Source {i+1}: {s['title']}\nURL: {s['url']}\nSub-question: {s['sub_question']}\n{s['analysis']}"
            for i, s in enumerate(source_analyses)
        )

        gap_result = _research_ai_call(
            f"""You are a research quality analyst. Review everything we've found so far and identify CRITICAL GAPS.

RESEARCH TOPIC: {query}
INVESTIGATION ANGLES: {'; '.join(sub_questions)}

SOURCE ANALYSES SO FAR:
{analyses_block[:16000]}

Identify:
1. Which investigation angles have WEAK or NO coverage from our sources?
2. What critical facts, statistics, or perspectives are MISSING?
3. What specific additional searches would fill these gaps?

Output EXACTLY:
GAP_SEARCHES:
1. "<specific search query to fill gap 1>"
2. "<specific search query to fill gap 2>"
3. "<specific search query to fill gap 3>"
(list 2-5 gap-filling searches, or "NONE" if coverage is sufficient)""",
            resolved, max_tokens=800
        )

        # Do supplemental searches for gaps
        gap_searches = []
        for line in (gap_result or "").split("\n"):
            m = re.match(r'^\s*\d+[.)]\s*"?([^"]+)"?\s*$', line.strip())
            if m and m.group(1).strip().upper() != "NONE":
                gap_searches.append(m.group(1).strip())

        if gap_searches and not is_cancelled():
            for gi, gsq in enumerate(gap_searches[:4]):
                if is_cancelled():
                    break
                push("progress", step="gap-analysis", pct=57 + int(((gi+1)/len(gap_searches[:4]))*5),
                     total_steps=total_steps, current_step=5,
                     message=f"Gap search [{gi+1}/{len(gap_searches[:4])}]: {gsq[:65]}...")
                for r in _ddg_search(gsq, max_results=5):
                    if r["url"] and r["url"] not in seen_urls:
                        seen_urls.add(r["url"])
                        text = _fetch_url_text(r["url"])
                        if text and len(text) > 150:
                            analysis = _research_ai_call(
                                f"""Quickly extract key facts from this source relevant to: {query}
SOURCE: {r.get('title','')} — {r['url']}
CONTENT: {text[:5000]}

List the most important facts, data points, and insights. Be concise but thorough.""",
                                resolved, max_tokens=600
                            )
                            if analysis and "[AI error" not in analysis:
                                source_analyses.append({
                                    "title": r.get("title", ""),
                                    "url": r["url"],
                                    "snippet": r.get("snippet", ""),
                                    "sub_question": gsq,
                                    "analysis": analysis,
                                })

        push("progress", step="gap-analysis", pct=63, total_steps=total_steps, current_step=5,
             message=f"Gap analysis complete. Total sources: {len(source_analyses)}.")

        if is_cancelled():
            push("cancelled"); job["status"] = "cancelled"; return

        # Rebuild analyses block with supplemental sources
        analyses_block = "\n\n".join(
            f"### Source {i+1}: {s['title']}\nURL: {s['url']}\nSub-question: {s['sub_question']}\n{s['analysis']}"
            for i, s in enumerate(source_analyses)
        )

        # ══════════════════════════════════════════════════════════════
        # STEP 6: Cross-Reference & Synthesis Thinking
        # ══════════════════════════════════════════════════════════════
        push("progress", step="cross-referencing", pct=64, total_steps=total_steps, current_step=6,
             message="Cross-referencing findings and identifying patterns...")

        if is_cancelled():
            push("cancelled"); job["status"] = "cancelled"; return

        cross_ref = _research_ai_call(
            f"""You are synthesizing research findings. Deeply analyze ALL source analyses below and produce a synthesis framework.

RESEARCH TOPIC: {query}

SOURCE ANALYSES:
{analyses_block[:24000]}

Produce:

1. CONSENSUS FINDINGS: What do multiple sources agree on? List specific facts/claims supported by 2+ sources.
2. CONTRADICTIONS: Where do sources disagree? What are the competing viewpoints?
3. KEY THEMES: What are the 5-8 major themes that emerge across all sources?
4. EVIDENCE STRENGTH: Which findings have the strongest evidence? Which are speculative?
5. NARRATIVE ARC: What story do these findings tell when woven together?
6. SURPRISING DISCOVERIES: Any unexpected findings that challenge conventional wisdom?
7. REPORT OUTLINE: Create a detailed section-by-section outline for the final report, with bullet points of what should go in each section.

Be thorough and analytical.""",
            resolved, max_tokens=4000
        )

        push("progress", step="cross-referencing", pct=70, total_steps=total_steps, current_step=6,
             message="Cross-referencing complete. Preparing report structure...")

        if is_cancelled():
            push("cancelled"); job["status"] = "cancelled"; return

        # ══════════════════════════════════════════════════════════════
        # STEP 7: Multi-Pass Report Writing
        # ══════════════════════════════════════════════════════════════
        push("progress", step="writing", pct=71, total_steps=total_steps, current_step=7,
             message="Writing comprehensive research report (pass 1: core content)...")

        if is_cancelled():
            push("cancelled"); job["status"] = "cancelled"; return

        report_md = _research_ai_call(
            f"""You are an expert research writer producing a {depth_cfg['detail']} research report.

TOPIC: {query}

SYNTHESIS FRAMEWORK:
{cross_ref[:8000]}

SOURCE ANALYSES:
{analyses_block[:20000]}

Write a {depth_cfg['detail']} research report. Requirements:

STRUCTURE (use markdown headers):
# {query}
## Executive Summary
(250-400 words synthesizing the most important findings, conclusions, and implications)

## Key Takeaways
(Bullet list of 5-8 most important takeaways)

## Background & Context
(Set the stage — why this topic matters, historical context, scope of the issue)

## Key Findings
### [Finding 1 Title]
(Detailed analysis with evidence from sources)
### [Finding 2 Title]
(Continue for each major finding...)

## Detailed Analysis
### [Major Aspect 1]
(Deep dive with cross-referenced evidence)
### [Major Aspect 2]
(Continue...)

## Current Landscape & Trends
(What's happening now, where things are headed)

## Competing Perspectives
(Different viewpoints, debates, and controversies)

## Implications & Impact
(What this means for stakeholders, practical consequences)

## Recommendations
(Actionable recommendations based on findings)

## Conclusion
(Final synthesis and forward-looking statement)

QUALITY REQUIREMENTS:
- Minimum {depth_cfg['report_min']} words
- Cite specific facts, statistics, and data points from sources
- Use **bold** for key terms and important findings
- Use bullet lists and numbered lists for clarity
- Include specific examples and case studies where available
- Be analytical and insightful, not just descriptive — explain WHY things matter
- Draw connections between different findings
- Address limitations and gaps in the available information
- Every major claim should reference evidence from the sources""",
            resolved, max_tokens=depth_cfg["max_report_tokens"]
        )

        if not report_md or "[AI error" in report_md:
            report_md = f"# Research Report: {query}\n\n*Error generating report. Sources analyzed below.*\n\n" + "".join(f"- [{s['title']}]({s['url']})\n" for s in source_analyses)

        if is_cancelled():
            push("cancelled"); job["status"] = "cancelled"; return

        # Pass 2: Enhancement (for standard and deep)
        if depth in ("standard", "deep") and report_md and "[AI error" not in report_md:
            push("progress", step="writing", pct=80, total_steps=total_steps, current_step=7,
                 message="Enhancing report (pass 2: depth and polish)...")
            enhanced = _research_ai_call(
                f"""You are a senior editor reviewing and enhancing a research report. Your job is to significantly improve it.

ORIGINAL REPORT:
{report_md[:20000]}

ADDITIONAL SOURCE DATA (use to add missing details):
{analyses_block[:10000]}

ENHANCEMENT INSTRUCTIONS:
1. Add more specific data points, statistics, and evidence where sections feel thin
2. Strengthen the executive summary to be more impactful
3. Add transitional sentences between sections for better flow
4. Ensure every section has sufficient depth (no section should be less than 150 words)
5. Make sure the Key Takeaways are punchy and memorable
6. Make sure the Recommendations section is concrete and actionable
7. Improve the conclusion to be memorable and forward-looking
8. Fix any logical gaps or unsupported claims
9. Add relevant comparisons, analogies, or frameworks that make the content more accessible

Output the COMPLETE enhanced report in markdown. Do not truncate or abbreviate — write the full report.""",
                resolved, max_tokens=depth_cfg["max_report_tokens"]
            )
            if enhanced and "[AI error" not in enhanced and len(enhanced) > len(report_md) * 0.7:
                report_md = enhanced

        if is_cancelled():
            push("cancelled"); job["status"] = "cancelled"; return

        # Pass 3: Deep polish for deep mode
        if depth == "deep" and report_md and "[AI error" not in report_md:
            push("progress", step="writing", pct=84, total_steps=total_steps, current_step=7,
                 message="Final polish pass (pass 3: expert review)...")
            polished = _research_ai_call(
                f"""You are a world-class editor doing a final polish on a research report. Focus on:
1. Ensure no section feels rushed or superficial
2. Add nuance where claims are too absolute
3. Ensure the narrative flows logically from start to finish
4. Check that evidence properly supports all major claims
5. Add a "Future Outlook" subsection before the Conclusion if one doesn't exist
6. Make the writing style engaging and authoritative

REPORT:
{report_md[:22000]}

Output the COMPLETE polished report. Do not truncate.""",
                resolved, max_tokens=depth_cfg["max_report_tokens"]
            )
            if polished and "[AI error" not in polished and len(polished) > len(report_md) * 0.7:
                report_md = polished

        push("progress", step="writing", pct=87, total_steps=total_steps, current_step=7,
             message="Report writing complete.")

        if is_cancelled():
            push("cancelled"); job["status"] = "cancelled"; return

        # ══════════════════════════════════════════════════════════════
        # STEP 8: Fact-Check & Quality Review
        # ══════════════════════════════════════════════════════════════
        push("progress", step="reviewing", pct=88, total_steps=total_steps, current_step=8,
             message="Running fact-check and quality review...")

        quality_check = _research_ai_call(
            f"""Review this research report for quality and accuracy.

REPORT:
{report_md[:16000]}

Check for:
1. Any unsupported or potentially inaccurate claims
2. Internal contradictions
3. Missing important perspectives
4. Sections that need more evidence

If you find issues, list them briefly. If the report is solid, say "QUALITY: PASS".
Then provide a one-paragraph "Research Limitations" section that should be appended to the report.""",
            resolved, max_tokens=1000
        )

        # Append limitations if provided
        if quality_check and "Research Limitations" in quality_check:
            lim_start = quality_check.find("Research Limitations")
            limitations = quality_check[lim_start:]
            if not report_md.rstrip().endswith("---"):
                report_md += "\n\n---\n\n"
            report_md += f"## {limitations}"

        push("progress", step="reviewing", pct=92, total_steps=total_steps, current_step=8,
             message="Quality review complete.")

        if is_cancelled():
            push("cancelled"); job["status"] = "cancelled"; return

        # ══════════════════════════════════════════════════════════════
        # STEP 9: Source Attribution
        # ══════════════════════════════════════════════════════════════
        push("progress", step="citing", pct=93, total_steps=total_steps, current_step=9,
             message="Compiling source attributions...")

        # Append a Sources section to the report
        if source_analyses:
            report_md += "\n\n---\n\n## Sources & References\n\n"
            for idx, src in enumerate(source_analyses, 1):
                report_md += f"{idx}. [{src['title'] or 'Untitled'}]({src['url']})\n"

        push("progress", step="citing", pct=95, total_steps=total_steps, current_step=9,
             message="Source citations added.")

        if is_cancelled():
            push("cancelled"); job["status"] = "cancelled"; return

        # ══════════════════════════════════════════════════════════════
        # STEP 10: PDF & File Generation
        # ══════════════════════════════════════════════════════════════
        push("progress", step="exporting", pct=96, total_steps=total_steps, current_step=10,
             message="Generating PDF and Markdown reports...")

        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_q = re.sub(r"[^\w\s-]", "", query[:40]).strip().replace(" ", "_")
        pdf_fn = f"research_{safe_q}_{ts}.pdf"
        md_fn  = f"research_{safe_q}_{ts}.md"
        rdir   = WORKSPACE / "notes" / "research"
        rdir.mkdir(parents=True, exist_ok=True)
        (rdir / md_fn).write_text(
            f"# {query}\n\n{report_md}",
            encoding="utf-8"
        )
        pdf_ok = False
        try:
            _generate_research_pdf(query, report_md, source_analyses, rdir / pdf_fn)
            pdf_ok = True
        except Exception as pdf_err:
            push("progress", step="exporting", pct=98, total_steps=total_steps, current_step=10,
                 message=f"PDF note: {pdf_err} — markdown saved.")

        push("progress", step="exporting", pct=100, total_steps=total_steps, current_step=10,
             message="All files generated successfully.")

        push("done",
             report=report_md,
             pdf_file=pdf_fn if pdf_ok else None,
             md_file=md_fn,
             sources=[{"title": s["title"], "url": s["url"], "snippet": s["snippet"]} for s in source_analyses],
             sub_questions=sub_questions,
             source_count=len(source_analyses),
        )
        job["status"] = "done"

    except Exception as e:
        push("error", error=f"Research failed: {e}")
        job["status"] = "error"


@app.route("/api/research/plan", methods=["POST"])
@require_auth_or_guest
def research_plan():
    """Generate a research plan without executing. Returns the plan for user review."""
    d = request.get_json() or {}
    query = (d.get("query") or "").strip()
    depth = d.get("depth", "standard")
    if not query:
        return jsonify({"error": "Query required"}), 400
    if depth not in ("quick", "standard", "deep"):
        depth = "standard"

    depth_cfg = {
        "quick":    {"sub_q": 5},
        "standard": {"sub_q": 8},
        "deep":     {"sub_q": 12},
    }.get(depth, {"sub_q": 8})

    settings = load_settings()
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

    plan_text = _research_ai_call(
        f"""You are a senior research strategist. Deeply analyze this research topic and create a comprehensive research plan.

RESEARCH TOPIC: {query}

Think step by step:
1. What is being asked? What are the core concepts?
2. What domains of knowledge does this span?
3. What are the key tensions, debates, or open questions?
4. What would a world-class researcher investigate?
5. What primary sources and data would be most valuable?

Produce a clear plan with investigation angles the user can review and edit.
Format your response as a numbered list of specific research angles/sub-questions to investigate.
Each line should be one numbered investigation angle. Write exactly {depth_cfg['sub_q']} angles.

Example format:
1. How has X evolved over the past decade and what key milestones defined its trajectory?
2. What are the current leading approaches to Y and how do they compare?
...""",
        resolved, max_tokens=1500
    )

    # Parse into structured angles
    angles = []
    for line in (plan_text or "").split("\n"):
        m = re.match(r"^\s*\d+[.)]\s+(.+)", line.strip())
        if m:
            angles.append(m.group(1).strip())

    if not angles:
        angles = [query]

    return jsonify({
        "ok": True,
        "query": query,
        "depth": depth,
        "angles": angles,
        "raw_plan": plan_text,
    })


@app.route("/api/research/cancel/<job_id>", methods=["POST"])
@require_auth_or_guest
def cancel_research(job_id):
    """Cancel a running research job."""
    job = _research_jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    job["cancelled"] = True
    return jsonify({"ok": True})


@app.route("/api/research", methods=["POST"])
@require_auth_or_guest
def start_research():
    d = request.get_json() or {}
    query = (d.get("query") or "").strip()
    depth = d.get("depth", "standard")
    user_plan = (d.get("plan") or "").strip()  # User-confirmed/edited plan text
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
    _research_jobs[job_id] = {"status": "running", "events": [], "cancelled": False, "created": datetime.datetime.now().isoformat()}
    _threading.Thread(target=_run_research_job, args=(job_id, query, depth, resolved, user_plan or None), daemon=True).start()

    import time as _time

    @stream_with_context
    def generate():
        yield json.dumps({"type": "job_id", "job_id": job_id}) + "\n"
        sent = 0
        last_send = _time.time()
        while True:
            job = _research_jobs.get(job_id, {})
            evts = job.get("events", [])
            while sent < len(evts):
                yield json.dumps(evts[sent]) + "\n"
                sent += 1
                last_send = _time.time()
            if job.get("status") in ("done", "error", "cancelled") and sent >= len(evts):
                break
            # Send heartbeat every 8 seconds to prevent connection timeout
            if _time.time() - last_send > 8:
                yield json.dumps({"type": "heartbeat"}) + "\n"
                last_send = _time.time()
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
    print("  |   PROJECT gyro - Flow-State Architect v3   |")
    print("  |                                             |")
    print("  |   Open http://localhost:5000 in browser     |")
    print("  +----------------------------------------------+\n")
    app.run(host="127.0.0.1", port=5000, debug=False)
