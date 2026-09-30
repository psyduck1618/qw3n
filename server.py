#!/usr/bin/env python3
"""QW3N local chat server.

Serves the static UI and proxies requests to a local Ollama instance.
Standard library only - no dependencies to install.

    python3 server.py                    # http://127.0.0.1:8080
    python3 server.py --port 9000
    python3 server.py --open             # also open in your browser
    python3 server.py --host 127.0.0.1   # localhost only, nothing on the LAN
    python3 server.py --tunnel           # expose via tailscale or cloudflare
    python3 server.py --no-auth          # skip the token gate (trusted LAN only)
    python3 server.py --setup            # force the installer to show again

First run opens the installer instead of the chat: it checks for Python,
Ollama and a model, and runs the missing pieces one at a time.

Reachability:
    local        127.0.0.1:PORT          always, while the process runs
    home wifi    192.168.x.x:PORT        anything on the same router
    anywhere     --tunnel tailscale      private VPN url, no public port
                  --tunnel cloudflare    public HTTPS url, no open port

Every path except a successful login requires QWEN_TOKEN (generated once into
data/.token and printed in the banner), so exposing the port never means
exposing the conversations.

The installer's command runner is a fixed list of steps compiled into this
file. The browser can only pick a step by id - it can never send a command
string - and the whole endpoint disappears once setup is marked complete.
"""

import argparse
import hmac
import json
import os
import platform
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
CHATS_DIR = DATA_DIR / "chats"
TRASH_DIR = DATA_DIR / ".trash"
TOKEN_FILE = DATA_DIR / ".token"
SETUP_FILE = DATA_DIR / "setup.json"
SETUP_LOG = DATA_DIR / "setup.log"

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
DEFAULT_MODEL = os.environ.get("QWEN_MODEL", "qwen3:8b")

COOKIE = "qwen_token"
COOKIE_MAX_AGE = 60 * 60 * 24 * 30
MAX_BODY = 8 * 1024 * 1024
MAX_SETUP_SECONDS = 30 * 60

TOKEN = None
AUTH_ENABLED = True
SETUP_ENABLED = True

# ip -> [window start, attempt count]  — crude but enough to slow a guessing loop
FAILURES = {}
FAIL_LOCK = int(os.environ.get("QWEN_MAX_TRIES", "8"))
FAIL_WINDOW = 60

CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob: https: http:; "
    "font-src 'self' data:; "
    "connect-src 'self'; "
    "base-uri 'none'; "
    "form-action 'self'; "
    "frame-ancestors 'none'"
)

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}

CHAT_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def log(msg):
    print(f"  \033[2m{time.strftime('%H:%M:%S')}\033[0m {msg}", flush=True)


def c(text, code):
    return f"\033[{code}m{text}\033[0m"


def safe_id(value):
    return value if value and CHAT_ID_RE.match(value) else None


# --------------------------------------------------------------------------
# Access token
# --------------------------------------------------------------------------

def resolve_token(explicit=None):
    """Find or mint the password that guards the API."""
    if explicit:
        return explicit
    if env := os.environ.get("QWEN_TOKEN"):
        return env
    try:
        if TOKEN_FILE.exists():
            saved = TOKEN_FILE.read_text("utf-8").strip()
            if saved:
                return saved
    except OSError:
        pass
    minted = secrets.token_urlsafe(18)
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        TOKEN_FILE.write_text(minted + "\n", "utf-8")
        TOKEN_FILE.chmod(0o600)
    except OSError as exc:
        log(f"could not persist the token ({exc}); it will change on restart")
    return minted


# --------------------------------------------------------------------------
# Tunnels — reach the port from outside the home network
# --------------------------------------------------------------------------

def start_tunnel(kind, port, funnel=False):
    """Bring up tailscale or cloudflared in front of this port.

    Returns (process, url) where url is best-effort and may be None.
    """
    local = f"http://127.0.0.1:{port}"

    if kind in ("auto", "tailscale") and shutil.which("tailscale"):
        sub = "funnel" if funnel else "serve"
        cmd = ["tailscale", sub, "--bg", local]
        if not run_quiet(cmd):
            return None, None
        url = tailscale_url()
        watch_tunnel("tailscale", [sub, "--bg", local], local)
        return "tailscale", url

    if kind in ("auto", "cloudflare") and shutil.which("cloudflared"):
        cmd = ["cloudflared", "tunnel", "--no-autoupdate", "--url", local]
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        url = read_tunnel_url(proc)
        watch_process("cloudflared", proc, local)
        return "cloudflared", url

    if kind == "auto":
        log("no tunnel tool found — install tailscale or cloudflared")
    else:
        log(f"{kind} is not installed — install it and retry")
    return None, None


def run_quiet(cmd):
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except Exception as exc:
        log(f"{' '.join(cmd[:2])} failed: {exc}")
        return False
    if done.returncode != 0:
        log(f"{' '.join(cmd[:2])}: {(done.stderr or done.stdout or '').strip()[:160]}")
        return False
    return True


def tailscale_url():
    try:
        done = subprocess.run(
            ["tailscale", "status", "--json"], capture_output=True, text=True, timeout=15
        )
        data = json.loads(done.stdout)
        dns = (data.get("Self") or {}).get("DNSName", "").rstrip(".")
        return f"https://{dns}/" if dns else None
    except Exception:
        return None


URL_RE = re.compile(r"https://[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:trycloudflare\.com|ngrok\.[a-z]+)/")


def read_tunnel_url(proc):
    """cloudflared prints its URL on stderr once the tunnel is up."""
    deadline = time.time() + 25
    while time.time() < deadline:
        line = proc.stderr.readline() if proc.stderr else ""
        if not line:
            if proc.poll() is not None:
                return None
            continue
        match = URL_RE.search(line)
        if match:
            return match.group(0)
    return None


def watch_process(name, proc, local):
    def run():
        code = proc.wait()
        log(f"{name} tunnel exited (code {code}) — LAN access is unaffected")

    threading.Thread(target=run, daemon=True).start()


def watch_tunnel(name, cmd, local):
    def run():
        time.sleep(3)
        try:
            subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        except Exception:
            pass
        log(f"{name} tunnel stopped — re-run with --tunnel to bring it back")

    threading.Thread(target=run, daemon=True).start()


# --------------------------------------------------------------------------
# Ollama
# --------------------------------------------------------------------------

def ollama_request(path, payload=None, method="GET", timeout=30):
    url = f"{OLLAMA_URL}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", "replace")
    return json.loads(body) if body.strip() else {}


def fetch_models():
    try:
        data = ollama_request("/api/tags", timeout=5)
    except Exception:
        return {"models": [], "online": False}
    models = []
    for m in data.get("models", []):
        details = m.get("details") or {}
        models.append(
            {
                "name": m.get("name"),
                "size": m.get("size", 0),
                "params": details.get("parameter_size", ""),
                "quant": details.get("quantization_level", ""),
                "context": details.get("context_length", 0),
                "family": details.get("family", ""),
            }
        )
    models.sort(key=lambda m: m["name"] or "")
    return {"models": models, "online": True, "default": chosen_model()}


# --------------------------------------------------------------------------
# Guided setup
#
# The browser may only name a step. Every command below is a literal argv
# list built here in Python - nothing a client sends is ever handed to a
# shell - and the parameter the only step accepts (a model name) is matched
# against MODEL_RE before it is used.
# --------------------------------------------------------------------------

MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$")

MODELS = [
    {"name": "qwen3:8b", "size": "5.2 GB", "note": "default · good all-rounder"},
    {"name": "qwen3:4b", "size": "2.6 GB", "note": "lighter, still capable"},
    {"name": "qwen3:1.7b", "size": "1.4 GB", "note": "smallest, works on 8 GB"},
    {"name": "qwen3:14b", "size": "9.0 GB", "note": "needs 16 GB+ of memory"},
    {"name": "llama3:latest", "size": "4.7 GB", "note": "not qwen, but solid"},
]

IS_MAC = platform.system() == "Darwin"
MIN_PYTHON = (3, 9)


def setup_state():
    try:
        return json.loads(SETUP_FILE.read_text("utf-8"))
    except Exception:
        return {}


def setup_done():
    return bool(setup_state().get("completed"))


def setup_save(**fields):
    data = setup_state()
    data.update(fields)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SETUP_FILE.write_text(json.dumps(data, indent=2), "utf-8")
    return data


def setup_log(line):
    stamp = time.strftime("%H:%M:%S")
    try:
        with SETUP_LOG.open("a", encoding="utf-8") as fh:
            fh.write(f"[{stamp}] {line.rstrip()}\n")
    except OSError:
        pass


def ollama_reachable(timeout=2):
    try:
        urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=timeout).read()
        return True
    except Exception:
        return False


def installed_models():
    try:
        data = ollama_request("/api/tags", timeout=5)
    except Exception:
        return []
    return [m.get("name") for m in data.get("models", []) if m.get("name")]


def chosen_model():
    return setup_state().get("model") or DEFAULT_MODEL


def chosen_model_ok():
    wanted = chosen_model()
    return any(m == wanted or m.split(":")[0] == wanted.split(":")[0] for m in installed_models())


# -- probes ---------------------------------------------------------------

def probe_system():
    version = ".".join(str(n) for n in sys.version_info[:3])
    ok = sys.version_info[:2] >= MIN_PYTHON
    return {
        "state": "ok" if ok else "bad",
        "note": f"{platform.system()} {platform.machine()} · Python {version}"
                + ("" if ok else f" · needs {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+"),
    }


def probe_brew():
    if not IS_MAC:
        return {"state": "skip", "note": "not needed on this platform"}
    if shutil.which("brew"):
        return {"state": "ok", "note": shutil.which("brew")}
    if ollama_reachable(1):
        return {"state": "ok", "note": "Ollama already answers, Homebrew not required"}
    return {
        "state": "missing",
        "note": "Homebrew is the easy way to install Ollama on macOS",
        "manual": "/bin/bash -c 'curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh'",
    }


def probe_ollama():
    if shutil.which("ollama"):
        return {"state": "ok", "note": shutil.which("ollama")}
    if ollama_reachable(1):
        return {"state": "ok", "note": "reachable but not on PATH"}
    if IS_MAC and shutil.which("brew"):
        return {
            "state": "missing",
            "note": "installs the official Ollama.app",
            "argv": ["brew", "install", "--cask", "ollama"],
            "display": "brew install --cask ollama",
        }
    return {
        "state": "missing",
        "note": "download Ollama and drag it to Applications",
        "manual": "https://ollama.com/download",
    }


def probe_serve():
    if ollama_reachable(2):
        return {"state": "ok", "note": f"answering on {OLLAMA_URL}"}
    if not shutil.which("ollama"):
        return {"state": "skip", "note": "install Ollama first"}
    return {
        "state": "missing",
        "note": "starts the model server in the background",
        "argv": ["ollama", "serve"],
        "display": "ollama serve",
        "detached": True,
    }


def probe_model():
    wanted = chosen_model()
    if chosen_model_ok():
        return {"state": "ok", "note": f"{wanted} is ready"}
    if not ollama_reachable(2):
        return {"state": "skip", "note": "start the server first"}
    return {
        "state": "missing",
        "note": f"downloads {wanted} — the largest step, be patient",
        "argv": ["ollama", "pull", wanted],
        "display": f"ollama pull {wanted}",
    }


def probe_verify():
    if not ollama_reachable(2):
        return {"state": "skip", "note": "nothing to test yet"}
    if not chosen_model_ok():
        return {"state": "skip", "note": "model not downloaded yet"}
    if setup_state().get("verified") == chosen_model():
        return {"state": "ok", "note": f"{chosen_model()} answered a test message"}
    return {
        "state": "missing",
        "note": "sends a 2-token test message to prove the whole chain works",
        "http": "/api/chat",
    }


STEPS = [
    {
        "id": "system",
        "title": "Check Python",
        "body": "QW3N is a single stdlib Python file — no pip, no virtualenv. "
                "This just confirms the Python running the server is new enough.",
        "probe": probe_system,
        "runnable": False,
    },
    {
        "id": "brew",
        "title": "Homebrew",
        "body": "Only used to install Ollama on macOS. If you already have Ollama, "
                "or you would rather install it by hand, skip this.",
        "probe": probe_brew,
        "runnable": False,
    },
    {
        "id": "ollama",
        "title": "Install Ollama",
        "body": "Ollama is the part that actually runs the model. Everything else "
                "in this app is a front end for it.",
        "probe": probe_ollama,
    },
    {
        "id": "serve",
        "title": "Start the Ollama server",
        "body": "Ollama needs one process listening on 127.0.0.1:11434 to serve "
                "models. It is started in the background and left running.",
        "probe": probe_serve,
    },
    {
        "id": "model",
        "title": "Download the model",
        "body": "The first run of a model reads several gigabytes off your disk. "
                "Later runs are instant because the weights stay in memory.",
        "probe": probe_model,
        "param": "model",
    },
    {
        "id": "verify",
        "title": "Verify end to end",
        "body": "Browser to server to Ollama and back. If this passes, the chat is "
                "guaranteed to work.",
        "probe": probe_verify,
    },
]

STEP_INDEX = {s["id"]: s for s in STEPS}


def step_snapshot():
    out = []
    for step in STEPS:
        try:
            found = step["probe"]()
        except Exception as exc:
            found = {"state": "unknown", "note": str(exc)}
        out.append(
            {
                "id": step["id"],
                "title": step["title"],
                "body": step["body"],
                "runnable": step.get("runnable", True),
                "param": step.get("param"),
                "manual": step.get("manual"),
                **found,
            }
        )
    return out


def setup_overview():
    steps = step_snapshot()
    pending = [s for s in steps if s["state"] == "missing"]
    return {
        "completed": setup_done(),
        "enabled": SETUP_ENABLED,
        "steps": steps,
        "pending": [s["id"] for s in pending],
        "models": MODELS,
        "model": chosen_model(),
        "ready": not pending,
    }


def pick_model(name):
    name = str(name or "").strip()
    if not MODEL_RE.match(name):
        return None
    state = setup_state()
    fields = {"model": name}
    if state.get("model") != name and state.get("verified"):
        # a different model has not been proven yet
        fields["verified"] = ""
    setup_save(**fields)
    return name


# -- running a step -------------------------------------------------------

class StepRun:
    """Streams one step's output to the browser as server-sent events."""

    def __init__(self, step, params):
        self.step = step
        self.params = params or {}
        self.finished = None

    def events(self):
        step = self.step
        yield {"type": "start", "id": step["id"]}

        probe = step["probe"]()
        if probe["state"] in ("ok", "skip"):
            yield {"type": "done", "id": step["id"], "code": 0,
                   "note": probe.get("note", "already satisfied")}
            return

        if probe.get("manual"):
            yield {"type": "manual", "id": step["id"], "note": probe["note"],
                   "command": probe["manual"]}
            return

        if probe.get("http"):
            yield from self._http(probe)
            return

        argv = probe.get("argv")
        if not argv:
            yield {"type": "done", "id": step["id"], "code": 0, "note": "nothing to do"}
            return

        yield {"type": "cmd", "id": step["id"], "command": probe.get("display") or " ".join(argv)}
        yield from self._spawn(argv, detached=probe.get("detached", False))

    def _spawn(self, argv, detached=False):
        started = time.time()
        if detached:
            try:
                subprocess.Popen(
                    argv,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            except Exception as exc:
                yield {"type": "done", "id": self.step["id"], "code": 1, "note": str(exc)}
                return
            # the daemon needs a moment before its port answers
            for _ in range(30):
                if time.time() - started > MAX_SETUP_SECONDS:
                    break
                if ollama_reachable(1):
                    yield {"type": "line", "id": self.step["id"], "text": "ollama is up"}
                    yield {"type": "done", "id": self.step["id"], "code": 0, "note": "started"}
                    return
                yield {"type": "tick", "id": self.step["id"]}
                time.sleep(1)
            yield {"type": "done", "id": self.step["id"], "code": 1,
                   "note": "gave up waiting for ollama to listen"}
            return

        try:
            proc = subprocess.Popen(
                argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1, errors="replace",
            )
        except Exception as exc:
            yield {"type": "done", "id": self.step["id"], "code": 127, "note": str(exc)}
            return

        deadline = time.time() + MAX_SETUP_SECONDS
        while True:
            if time.time() > deadline:
                proc.kill()
                yield {"type": "done", "id": self.step["id"], "code": 124,
                       "note": "timed out after 30 minutes"}
                return
            line = proc.stdout.readline()
            if line:
                text = line.rstrip()
                setup_log(text)
                yield {"type": "line", "id": self.step["id"], "text": text}
                continue
            if proc.poll() is not None:
                break
            yield {"type": "tick", "id": self.step["id"]}
            time.sleep(0.4)

        code = proc.returncode
        yield {"type": "done", "id": self.step["id"], "code": code,
               "note": "ok" if code == 0 else f"exited with code {code}"}

    def _http(self, probe):
        path = probe["http"]
        payload = None
        if path == "/api/chat":
            payload = {
                "model": chosen_model(),
                "messages": [{"role": "user", "content": "Reply with the single word: ready"}],
                "stream": False,
                "options": {"num_predict": 2, "temperature": 0},
            }
        try:
            data = ollama_request(path, payload, method="POST", timeout=120)
        except Exception as exc:
            yield {"type": "done", "id": self.step["id"], "code": 1, "note": str(exc)}
            return
        if data.get("error"):
            yield {"type": "done", "id": self.step["id"], "code": 1, "note": str(data["error"])}
            return
        reply = ((data.get("message") or {}).get("content") or "").strip()
        if not reply:
            yield {"type": "done", "id": self.step["id"], "code": 1, "note": "model returned nothing"}
            return
        yield {"type": "line", "id": self.step["id"], "text": f"model replied: {reply}"}
        # remember which model passed, so the step can report itself done
        setup_save(verified=chosen_model())
        yield {"type": "done", "id": self.step["id"], "code": 0, "note": "everything works"}


# --------------------------------------------------------------------------
# Thread storage - one JSON file per conversation
# --------------------------------------------------------------------------

def chat_path(chat_id):
    return CHATS_DIR / f"{chat_id}.json"


def list_chats():
    out = []
    for path in CHATS_DIR.glob("*.json"):
        try:
            data = json.loads(path.read_text("utf-8"))
        except Exception:
            continue
        messages = data.get("messages", [])
        title = data.get("title") or "Untitled"
        if title == "Untitled":
            first = next((m for m in messages if m.get("role") == "user"), None)
            if first:
                title = first.get("content", "").strip().replace("\n", " ")[:48]
        out.append(
            {
                "id": data.get("id", path.stem),
                "title": title,
                "updated": data.get("updated", 0),
                "created": data.get("created", 0),
                "count": len(messages),
                "model": data.get("model", ""),
            }
        )
    out.sort(key=lambda c: c["updated"], reverse=True)
    return out


def load_chat(chat_id):
    path = chat_path(chat_id)
    if not path.exists():
        return None
    return json.loads(path.read_text("utf-8"))


def save_chat(payload):
    chat_id = safe_id(payload.get("id")) or uuid.uuid4().hex[:12]
    path = chat_path(chat_id)
    existing = load_chat(chat_id) or {}
    now = time.time()
    data = {
        "id": chat_id,
        "title": payload.get("title") or existing.get("title") or "Untitled",
        "model": payload.get("model") or existing.get("model") or chosen_model(),
        "system": payload.get("system", existing.get("system", "")),
        "created": existing.get("created", now),
        "updated": now,
        "messages": payload.get("messages", existing.get("messages", [])),
    }
    path.write_text(json.dumps(data, indent=2), "utf-8")
    return data


def delete_chat(chat_id):
    """Move the file to data/.trash instead of unlinking it.

    Conversations are the only thing here worth protecting, and an
    unlink is unrecoverable — a mis-click on the wrong row is permanent.
    Restore by moving the file back into data/chats/.
    """
    path = chat_path(chat_id)
    if not path.exists():
        return False
    try:
        TRASH_DIR.mkdir(parents=True, exist_ok=True)
        target = TRASH_DIR / f"{chat_id}.{int(time.time())}.json"
        path.replace(target)
        path = target
    except OSError as exc:
        log(f"could not move {chat_id} to the trash ({exc}); deleting outright")
        path.unlink(missing_ok=True)
        return True

    # keep the trash from growing without bound
    try:
        cutoff = time.time() - 30 * 86400
        for old in TRASH_DIR.glob("*.json"):
            if old.stat().st_mtime < cutoff:
                old.unlink()
    except OSError:
        pass
    return True


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "QW3N/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("QWEN_ACCESS_LOG"):
            print(f"  \033[2m{time.strftime('%H:%M:%S')} {fmt % args}\033[0m", flush=True)

    # -- helpers ---------------------------------------------------------

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", CSP)
        super().end_headers()

    def client_ip(self):
        forwarded = self.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return self.client_address[0] if self.client_address else "-"

    def given_token(self):
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            name, _, value = part.strip().partition("=")
            if name == COOKIE:
                return urllib.parse.unquote(value)
        header = self.headers.get("X-Auth-Token")
        return header.strip() if header else None

    def is_authed(self):
        if not AUTH_ENABLED:
            return True
        given = self.given_token()
        return bool(given) and TOKEN is not None and hmac.compare_digest(given, TOKEN)

    def is_https(self):
        return self.headers.get("X-Forwarded-Proto", "").split(",")[0].strip() == "https"

    def lockout_left(self):
        now = time.time()
        rec = FAILURES.get(self.client_ip())
        if rec and rec[1] >= FAIL_LOCK and now - rec[0] < FAIL_WINDOW:
            return int(FAIL_WINDOW - (now - rec[0]))
        if rec and now - rec[0] >= FAIL_WINDOW:
            FAILURES.pop(self.client_ip(), None)
        return 0

    def note_failure(self):
        now = time.time()
        rec = FAILURES.get(self.client_ip())
        if not rec or now - rec[0] >= FAIL_WINDOW:
            rec = [now, 0]
        rec[0] = now
        rec[1] += 1
        FAILURES[self.client_ip()] = rec
        return rec[1]

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("request body too large")
        return json.loads(self.rfile.read(length).decode("utf-8", "replace"))

    def send_static(self, rel):
        path = (STATIC_DIR / rel).resolve()
        if not str(path).startswith(str(STATIC_DIR)) or not path.is_file():
            self.send_error_json(404, "not found")
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # -- session ---------------------------------------------------------

    def session_state(self):
        return {
            "authRequired": AUTH_ENABLED,
            "authed": self.is_authed(),
            "setupCompleted": setup_done(),
            "setupEnabled": SETUP_ENABLED,
        }

    def do_login(self):
        wait = self.lockout_left()
        if wait:
            self.send_error_json(429, f"too many attempts — wait {wait}s")
            return
        try:
            payload = self.read_json()
        except Exception:
            self.send_error_json(400, "bad request")
            return

        if not AUTH_ENABLED:
            self.send_json({"ok": True})
            return

        given = str(payload.get("token") or "")
        if TOKEN and hmac.compare_digest(given, TOKEN):
            FAILURES.pop(self.client_ip(), None)
            cookie = (
                f"{COOKIE}={urllib.parse.quote(TOKEN)}; Path=/; HttpOnly; "
                f"SameSite=Lax; Max-Age={COOKIE_MAX_AGE}"
            )
            if self.is_https():
                cookie += "; Secure"
            self.send_response(200)
            body = json.dumps({"ok": True}).encode()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Set-Cookie", cookie)
            self.end_headers()
            self.wfile.write(body)
            log(f"unlocked from {self.client_ip()}")
            return

        left = FAIL_LOCK - self.note_failure()
        self.send_error_json(401, f"wrong token — {left} attempt(s) left")

    def do_logout(self):
        self.send_response(200)
        body = json.dumps({"ok": True}).encode()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header(
            "Set-Cookie", f"{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        )
        self.end_headers()
        self.wfile.write(body)

    # -- setup runner ----------------------------------------------------

    def setup_run(self):
        """Run one installer step, streaming its output back as events.

        The body may only name a step that exists in STEPS. It can never
        carry a command, and the one parameter (a model name) is validated
        against MODEL_RE before it reaches an argv list.
        """
        if not SETUP_ENABLED:
            self.send_error_json(
                403, "setup is finished — restart with --setup to run it again"
            )
            return
        try:
            payload = self.read_json()
        except Exception:
            self.send_error_json(400, "bad request")
            return

        step = STEP_INDEX.get(str(payload.get("id") or ""))
        if not step:
            self.send_error_json(404, "no such step")
            return
        if not step.get("runnable", True):
            self.send_error_json(400, "that step is informational")
            return

        params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
        if step.get("param") == "model" and params.get("model"):
            if not pick_model(params["model"]):
                self.send_error_json(400, "that is not a usable model name")
                return

        setup_log(f"run {step['id']}")
        run = StepRun(step, params)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        try:
            for event in run.events():
                self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            log(f"client left the {step['id']} step early")
        except Exception as exc:
            log(f"setup step {step['id']} failed: {exc}")
        finally:
            self.close_connection = True

    def setup_finish(self):
        """Mark setup done, which removes the command runner from this process."""
        global SETUP_ENABLED
        if not SETUP_ENABLED:
            self.send_error_json(403, "setup is already finished")
            return
        setup_save(completed=True, completedAt=time.time(), model=chosen_model())
        SETUP_ENABLED = False
        log("setup marked complete — the command runner is now closed")
        self.send_json({"ok": True, "model": chosen_model()})

    def setup_reset(self):
        """Reopen the installer without a restart. Re-enables the runner."""
        global SETUP_ENABLED
        if not setup_state().get("forceOpen") and setup_done():
            self.send_error_json(403, "restart with --setup to reopen the installer")
            return
        setup_save(forceOpen=True)
        SETUP_ENABLED = True
        self.send_json({"ok": True})

    # -- routes ----------------------------------------------------------

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            self.send_static("index.html")
        elif path.startswith("/static/"):
            self.send_static(path[len("/static/"):])
        elif path == "/api/session":
            self.send_json(self.session_state())
        elif path == "/api/health":
            self.send_json({"ok": True, "ollama": OLLAMA_URL, "auth": AUTH_ENABLED})
        elif not self.is_authed():
            self.send_error_json(401, "locked")
        elif path == "/api/setup":
            self.send_json(setup_overview())
        elif path == "/api/models":
            self.send_json(fetch_models())
        elif path == "/api/chats":
            self.send_json({"chats": list_chats()})
        elif path.startswith("/api/chats/"):
            chat_id = safe_id(path[len("/api/chats/"):])
            data = load_chat(chat_id) if chat_id else None
            self.send_json(data) if data else self.send_error_json(404, "no such chat")
        else:
            self.send_error_json(404, "not found")

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/login":
            self.do_login()
            return
        if path == "/api/logout":
            self.do_logout()
            return
        if not self.is_authed():
            self.send_error_json(401, "locked")
            return
        if path == "/api/chat":
            self.stream_chat()
        elif path == "/api/setup/run":
            self.setup_run()
        elif path == "/api/setup/finish":
            self.setup_finish()
        elif path == "/api/setup/reset":
            self.setup_reset()
        elif path == "/api/chats":
            try:
                self.send_json(save_chat(self.read_json()))
            except Exception as exc:
                self.send_error_json(400, str(exc))
        else:
            self.send_error_json(404, "not found")

    def do_PUT(self):
        path = self.path.split("?", 1)[0]
        if path != "/api/chats":
            self.send_error_json(404, "not found")
        elif not self.is_authed():
            self.send_error_json(401, "locked")
        else:
            try:
                self.send_json(save_chat(self.read_json()))
            except Exception as exc:
                self.send_error_json(400, str(exc))

    def do_DELETE(self):
        path = self.path.split("?", 1)[0]
        if not path.startswith("/api/chats/"):
            self.send_error_json(404, "not found")
        elif not self.is_authed():
            self.send_error_json(401, "locked")
        else:
            chat_id = safe_id(path[len("/api/chats/"):])
            if chat_id and delete_chat(chat_id):
                self.send_json({"deleted": chat_id})
            else:
                self.send_error_json(404, "no such chat")

    # -- streaming proxy -------------------------------------------------

    def stream_chat(self):
        try:
            payload = self.read_json()
        except Exception as exc:
            self.send_error_json(400, f"bad request: {exc}")
            return

        messages = payload.get("messages") or []
        if not messages:
            self.send_error_json(400, "messages required")
            return

        model = payload.get("model") or DEFAULT_MODEL
        options = payload.get("options") or {}

        body = {
            "model": model,
            "messages": messages,
            "stream": True,
            "options": {k: v for k, v in options.items() if v not in (None, "", -1)},
        }

        req = urllib.request.Request(
            f"{OLLAMA_URL}/api/chat",
            data=json.dumps(body).encode(),
            method="POST",
            headers={"Content-Type": "application/json", "Accept": "application/x-ndjson"},
        )

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        try:
            pending = b""
            with urllib.request.urlopen(req, timeout=600) as resp:
                while True:
                    chunk = resp.read(1024)
                    if not chunk:
                        break
                    pending += chunk
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        line = line.strip()
                        if line:
                            self.wfile.write(b"data: " + line + b"\n\n")
                            self.wfile.flush()
            if pending.strip():
                self.wfile.write(b"data: " + pending.strip() + b"\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            log(f"client stopped generation ({model})")
        except urllib.error.URLError as exc:
            try:
                err = f'{{"error":"ollama unreachable: {exc.reason}"}}'
                self.wfile.write(f"data: {err}\n\n".encode())
                self.wfile.flush()
            except Exception:
                pass
        except Exception as exc:
            log(f"stream error: {exc}")
        finally:
            try:
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except Exception:
                pass
            self.close_connection = True


# --------------------------------------------------------------------------
# startup helpers
# --------------------------------------------------------------------------

def local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def ollama_online():
    try:
        urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=2).read()
        return True
    except Exception:
        return False


def open_browser(url):
    for cmd in (["open", url], ["xdg-open", url], ["start", "", url]):
        try:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except Exception:
            continue


def main():
    parser = argparse.ArgumentParser(
        description="QW3N local chat server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--host", default="0.0.0.0", help="default 0.0.0.0 (LAN + localhost)")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--open", action="store_true", help="open in default browser")
    parser.add_argument(
        "--token",
        help="access token (default: $QWEN_TOKEN, else data/.token, else generated)",
    )
    parser.add_argument(
        "--no-auth", action="store_true",
        help="skip the token gate — only safe on a network you fully trust",
    )
    parser.add_argument(
        "--tunnel", choices=["auto", "tailscale", "cloudflare"],
        help="expose the port outside the home network",
    )
    parser.add_argument(
        "--funnel", action="store_true",
        help="with --tunnel tailscale: publish to the public internet, not just the tailnet",
    )
    parser.add_argument(
        "--setup", action="store_true",
        help="reopen the guided installer even if it was already completed",
    )
    args = parser.parse_args()

    global TOKEN, AUTH_ENABLED, SETUP_ENABLED
    AUTH_ENABLED = not args.no_auth
    TOKEN = resolve_token(args.token) if AUTH_ENABLED else None
    SETUP_ENABLED = args.setup or not setup_done()

    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    CHATS_DIR.mkdir(parents=True, exist_ok=True)
    TRASH_DIR.mkdir(parents=True, exist_ok=True)

    print()
    print(f"  {c('QW3N', '1;94')}  {c('liquid glass · local chat', '2')}")
    print(f"  {c('─' * 46, '2')}")

    if ollama_online():
        models = fetch_models()["models"]
        names = ", ".join(m["name"] for m in models[:3])
        print(f"  {c('●', '92')} ollama online  {c(OLLAMA_URL, '2')}")
        print(f"  {c(f'{len(models)} model(s): {names}', '2')}")
    else:
        print(f"  {c('●', '91')} ollama NOT reachable at {OLLAMA_URL}")
        print(f"  {c('start it with:  ollama serve', '2')}")

    ip = local_ip()

    # bind before tunnelling so the tunnel never points at a closed door
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True

    print(f"  {c('─' * 46, '2')}")
    print(f"  local     {c(f'http://127.0.0.1:{args.port}', '96')}")
    if args.host == "0.0.0.0":
        print(f"  home wifi {c(f'http://{ip}:{args.port}', '96')}  {c('phone / laptop', '2')}")
    else:
        print(f"  {c(f'bound to {args.host} only — not reachable from the LAN', '2')}")

    if AUTH_ENABLED:
        print(f"  token     {c(TOKEN, '95')}  {c('needed once per browser', '2')}")
    else:
        print(f"  {c('●', '91')} auth DISABLED — anyone who can reach this port can read your chats")

    tunnel_url = None
    if args.tunnel:
        tool, tunnel_url = start_tunnel(args.tunnel, args.port, args.funnel)
        if tool:
            where = "public internet" if (tool == "tailscale" and args.funnel) else (
                "public url" if tool == "cloudflared" else "your tailnet"
            )
            print(f"  {tool:<9} {c(tunnel_url or 'starting…', '96')}  {c(f'from anywhere · {where}', '2')}")

    if not setup_done():
        pending = [s["id"] for s in step_snapshot() if s["state"] == "missing"]
        if pending:
            print(f"  {c('setup', '93')} not finished — the browser will walk you through it")
            print(f"  {c('missing: ' + ', '.join(pending), '2')}")
        else:
            print(f"  {c('setup', '92')} everything is installed — you can skip to the chat")
    elif SETUP_ENABLED:
        print(f"  {c('setup', '93')} forced open with --setup")
    else:
        print(f"  {c('setup', '92')} complete ({chosen_model()}) — installer closed")

    print(f"  chats     {c(str(CHATS_DIR), '2')}")
    trashed = len(list(TRASH_DIR.glob("*.json"))) if TRASH_DIR.exists() else 0
    if trashed:
        print(f"  {c(f'{trashed} deleted chat(s) in {TRASH_DIR} — move one back to restore it', '2')}")
    print(f"  {c('Ctrl+C to stop', '2')}")
    print()

    if args.open:
        open_browser(f"http://127.0.0.1:{args.port}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print(f"\n  {c('stopped', '2')}\n")
        server.shutdown()


if __name__ == "__main__":
    main()