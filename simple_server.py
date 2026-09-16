from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import io
import json
import os
import secrets
import sqlite3
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import ProxyHandler, Request, build_opener


ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "app.db"
FRONTEND = ROOT / "frontend"
SECRET = b"nowshera-events-local-secret"


def load_env() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()
SUPABASE_SYNC_URL = os.getenv("SUPABASE_SYNC_FUNCTION_URL", "")
SUPABASE_SYNC_KEY = os.getenv("SUPABASE_SYNC_KEY", "")
NO_PROXY_OPENER = build_opener(ProxyHandler({}))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_dt(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 120_000)
    return f"{base64.b64encode(salt).decode()}:{base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str) -> bool:
    salt_text, digest_text = stored.split(":", 1)
    expected = password_hash(password, base64.b64decode(salt_text)).split(":", 1)[1]
    return hmac.compare_digest(expected, digest_text)


def sign_token(payload: dict) -> str:
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()
    sig = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def read_token(token: str) -> dict:
    body, sig = token.split(".", 1)
    expected = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise ValueError("Invalid token")
    return json.loads(base64.urlsafe_b64decode(body.encode()))


def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS app_users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              email TEXT NOT NULL UNIQUE,
              password_hash TEXT NOT NULL,
              role TEXT NOT NULL CHECK(role IN ('attendee', 'admin')),
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              title TEXT NOT NULL,
              description TEXT NOT NULL,
              start_at TEXT NOT NULL,
              location TEXT NOT NULL,
              capacity INTEGER NOT NULL CHECK(capacity > 0),
              status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'completed', 'cancelled')),
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS registrations (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
              user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
              status TEXT NOT NULL CHECK(status IN ('active', 'cancelled')),
              created_at TEXT NOT NULL,
              cancelled_at TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_active_registration
            ON registrations(event_id, user_id)
            WHERE status = 'active';
            """
        )
        seed_user(conn, "Admin User", "admin@nowshera.test", "Admin123!", "admin")
        seed_user(conn, "Amina Khan", "amina@example.com", "Attendee123!", "attendee")
        if conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 0:
            conn.executemany(
                "INSERT INTO events (title, description, start_at, location, capacity, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                    ("Community Leadership Workshop", "A practical workshop for local volunteers and youth leaders.", "2026-10-20T10:00:00+00:00", "Nowshera Community Hall", 35, "published", utc_now()),
                    ("Small Business Seminar", "Sessions on budgeting, marketing, and customer service for new businesses.", "2026-11-05T14:00:00+00:00", "City Library Auditorium", 60, "published", utc_now()),
                    ("Volunteer Training Day", "Draft event for the operations team to prepare before publishing.", "2026-12-12T09:30:00+00:00", "Training Center Room 2", 25, "draft", utc_now()),
                ],
            )


def seed_user(conn: sqlite3.Connection, name: str, email: str, password: str, role: str) -> None:
    if conn.execute("SELECT 1 FROM app_users WHERE email = ?", (email,)).fetchone():
        return
    conn.execute(
        "INSERT INTO app_users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
        (name, email, password_hash(password), role, utc_now()),
    )


def public_user(user: sqlite3.Row) -> dict:
    return {"id": user["id"], "name": user["name"], "email": user["email"], "role": user["role"]}


def parse_capacity(value) -> int:
    if isinstance(value, bool):
        raise ValueError("Capacity must be a whole number greater than 0.")
    if isinstance(value, int):
        capacity = value
    elif isinstance(value, str) and value.strip().isdigit():
        capacity = int(value.strip())
    else:
        raise ValueError("Capacity must be a whole number greater than 0.")
    if capacity < 1:
        raise ValueError("Capacity must be a whole number greater than 0.")
    return capacity


def supabase_sync(payload: dict) -> None:
    if not SUPABASE_SYNC_URL or not SUPABASE_SYNC_KEY:
        return
    try:
        raw = json.dumps(payload).encode("utf-8")
        request = Request(
            SUPABASE_SYNC_URL,
            data=raw,
            headers={
                "Content-Type": "application/json",
                "x-sync-key": SUPABASE_SYNC_KEY,
            },
            method="POST",
        )
        with NO_PROXY_OPENER.open(request, timeout=12) as response:
            if response.status >= 400:
                print(f"Supabase sync failed: HTTP {response.status}")
    except Exception as exc:
        print(f"Supabase sync failed: {exc}")


def sync_user(user: sqlite3.Row) -> None:
    supabase_sync(
        {
            "action": "sync_user",
            "name": user["name"],
            "email": user["email"],
            "password_hash": user["password_hash"],
            "role": user["role"],
        }
    )


def sync_registration(event_id: int, user: sqlite3.Row) -> None:
    supabase_sync(
        {
            "action": "sync_registration",
            "event_id": event_id,
            "user_email": user["email"],
            "status": "active",
        }
    )


def event_counts(conn: sqlite3.Connection, event_id: int) -> dict:
    active = conn.execute("SELECT COUNT(*) FROM registrations WHERE event_id = ? AND status = 'active'", (event_id,)).fetchone()[0]
    capacity = conn.execute("SELECT capacity FROM events WHERE id = ?", (event_id,)).fetchone()[0]
    return {"registered_count": active, "places_left": max(capacity - active, 0)}


def event_payload(conn: sqlite3.Connection, row: sqlite3.Row, user_id: int | None = None) -> dict:
    counts = event_counts(conn, row["id"])
    registered = False
    if user_id:
        registered = bool(conn.execute("SELECT 1 FROM registrations WHERE event_id = ? AND user_id = ? AND status = 'active'", (row["id"], user_id)).fetchone())
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "start_at": row["start_at"],
        "location": row["location"],
        "capacity": row["capacity"],
        "status": row["status"],
        "registered_count": counts["registered_count"],
        "places_left": counts["places_left"],
        "is_full": counts["places_left"] <= 0,
        "is_past": parse_dt(row["start_at"]) <= datetime.now(timezone.utc),
        "registered_by_me": registered,
    }


class Handler(BaseHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        self.route()

    def do_POST(self) -> None:
        self.route()

    def do_PUT(self) -> None:
        self.route()

    def do_DELETE(self) -> None:
        self.route()

    def route(self) -> None:
        try:
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            query = parse_qs(parsed.query)
            if path.startswith("/api/"):
                return self.api(path, query)
            return self.static_file(path)
        except Exception as exc:
            self.json({"detail": str(exc)}, 500)

    def body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode())

    def auth_user(self) -> sqlite3.Row:
        auth = self.headers.get("Authorization", "")
        if not auth.lower().startswith("bearer "):
            raise PermissionError("Please sign in first.")
        payload = read_token(auth.split(" ", 1)[1])
        with db() as conn:
            user = conn.execute("SELECT * FROM app_users WHERE id = ?", (payload["sub"],)).fetchone()
        if not user:
            raise PermissionError("User not found.")
        return user

    def admin(self) -> sqlite3.Row:
        user = self.auth_user()
        if user["role"] != "admin":
            raise PermissionError("Admin access required.")
        return user

    def json(self, payload, status: int = 200) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def api(self, path: str, query: dict) -> None:
        try:
            return self.handle_api(path, query)
        except PermissionError as exc:
            return self.json({"detail": str(exc)}, 403 if "Admin" in str(exc) else 401)
        except ValueError as exc:
            return self.json({"detail": str(exc)}, 400)
        except sqlite3.IntegrityError:
            return self.json({"detail": "This request conflicts with existing data."}, 409)

    def handle_api(self, path: str, query: dict) -> None:
        method = self.command
        parts = path.strip("/").split("/")
        if path == "/api/health":
            return self.json({"status": "ok", "database": "sqlite", "supabase_sync": bool(SUPABASE_SYNC_URL and SUPABASE_SYNC_KEY)})
        if path == "/api/auth/login" and method == "POST":
            data = self.body()
            with db() as conn:
                user = conn.execute("SELECT * FROM app_users WHERE email = ?", (data["email"].lower(),)).fetchone()
            if not user or not verify_password(data["password"], user["password_hash"]):
                return self.json({"detail": "Email or password is incorrect."}, 401)
            sync_user(user)
            return self.json({"token": sign_token({"sub": user["id"]}), "user": public_user(user)})
        if path == "/api/auth/signup" and method == "POST":
            data = self.body()
            with db() as conn:
                cur = conn.execute(
                    "INSERT INTO app_users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, 'attendee', ?)",
                    (data["name"].strip(), data["email"].lower(), password_hash(data["password"]), utc_now()),
                )
                user_id = cur.lastrowid
                user = conn.execute("SELECT * FROM app_users WHERE id = ?", (user_id,)).fetchone()
            sync_user(user)
            return self.json({"token": sign_token({"sub": user_id}), "user": {"id": user_id, "name": data["name"], "email": data["email"], "role": "attendee"}})
        if path == "/api/auth/me":
            return self.json({"user": public_user(self.auth_user())})
        if path == "/api/events" and method == "GET":
            user_id = None
            try:
                user_id = self.auth_user()["id"] if self.headers.get("Authorization") else None
            except Exception:
                user_id = None
            with db() as conn:
                rows = conn.execute("SELECT * FROM events WHERE status = 'published' AND start_at > ? ORDER BY start_at", (utc_now(),)).fetchall()
                return self.json([event_payload(conn, row, user_id) for row in rows])
        if len(parts) == 3 and parts[:2] == ["api", "events"] and method == "GET":
            event_id = int(parts[2])
            user = None
            try:
                user = self.auth_user() if self.headers.get("Authorization") else None
            except Exception:
                user = None
            with db() as conn:
                row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
                if not row:
                    return self.json({"detail": "Event not found."}, 404)
                if row["status"] != "published" and (not user or user["role"] != "admin"):
                    return self.json({"detail": "Event not found."}, 404)
                return self.json(event_payload(conn, row, user["id"] if user else None))
        if len(parts) == 4 and parts[:2] == ["api", "events"] and parts[3] == "register" and method == "POST":
            user = self.auth_user()
            event_id = int(parts[2])
            with db() as conn:
                row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
                if not row or row["status"] != "published" or parse_dt(row["start_at"]) <= datetime.now(timezone.utc):
                    return self.json({"detail": "Registration is closed for this event."}, 400)
                if event_counts(conn, event_id)["places_left"] <= 0:
                    return self.json({"detail": "This event is full."}, 400)
                cur = conn.execute("INSERT INTO registrations (event_id, user_id, status, created_at) VALUES (?, ?, 'active', ?)", (event_id, user["id"], utc_now()))
                sync_user(user)
                sync_registration(event_id, user)
                return self.json({"message": "Registration confirmed.", "registration_id": cur.lastrowid})
        if path == "/api/registrations/me" and method == "GET":
            user = self.auth_user()
            with db() as conn:
                rows = conn.execute(
                    "SELECT r.id registration_id, r.status registration_status, r.created_at registered_at, r.cancelled_at, e.* FROM registrations r JOIN events e ON e.id = r.event_id WHERE r.user_id = ? ORDER BY r.created_at DESC",
                    (user["id"],),
                ).fetchall()
                return self.json([{"registration_id": row["registration_id"], "registration_status": row["registration_status"], "registered_at": row["registered_at"], "cancelled_at": row["cancelled_at"], "event": event_payload(conn, row, user["id"])} for row in rows])
        if len(parts) == 3 and parts[:2] == ["api", "registrations"] and method == "DELETE":
            user = self.auth_user()
            registration_id = int(parts[2])
            with db() as conn:
                row = conn.execute("SELECT * FROM registrations WHERE id = ?", (registration_id,)).fetchone()
                if not row or row["user_id"] != user["id"]:
                    raise PermissionError("You can only cancel your own registrations.")
                conn.execute("UPDATE registrations SET status = 'cancelled', cancelled_at = ? WHERE id = ?", (utc_now(), registration_id))
            return self.json({"message": "Registration cancelled."})
        if path == "/api/admin/dashboard":
            self.admin()
            with db() as conn:
                events = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
                published = conn.execute("SELECT COUNT(*) FROM events WHERE status = 'published'").fetchone()[0]
                registrations = conn.execute("SELECT COUNT(*) FROM registrations WHERE status = 'active'").fetchone()[0]
                capacity = conn.execute("SELECT COALESCE(SUM(capacity), 0) FROM events WHERE status = 'published'").fetchone()[0]
            return self.json({"events": events, "published_events": published, "active_registrations": registrations, "published_places_left": max(capacity - registrations, 0)})
        if path == "/api/admin/events" and method == "GET":
            self.admin()
            with db() as conn:
                rows = conn.execute("SELECT * FROM events ORDER BY start_at DESC").fetchall()
                return self.json([event_payload(conn, row) for row in rows])
        if path == "/api/admin/events" and method == "POST":
            self.admin()
            data = self.body()
            capacity = parse_capacity(data["capacity"])
            with db() as conn:
                cur = conn.execute("INSERT INTO events (title, description, start_at, location, capacity, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", (data["title"], data["description"], parse_dt(data["start_at"]).isoformat(), data["location"], capacity, data["status"], utc_now()))
                return self.json(event_payload(conn, conn.execute("SELECT * FROM events WHERE id = ?", (cur.lastrowid,)).fetchone()))
        if len(parts) == 4 and parts[:3] == ["api", "admin", "events"] and method == "PUT":
            self.admin()
            event_id = int(parts[3])
            data = self.body()
            capacity = parse_capacity(data["capacity"])
            with db() as conn:
                active = event_counts(conn, event_id)["registered_count"]
                if capacity < active:
                    return self.json({"detail": f"Capacity cannot be less than current active registrations ({active})."}, 400)
                conn.execute("UPDATE events SET title=?, description=?, start_at=?, location=?, capacity=?, status=? WHERE id=?", (data["title"], data["description"], parse_dt(data["start_at"]).isoformat(), data["location"], capacity, data["status"], event_id))
                return self.json(event_payload(conn, conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()))
        if len(parts) >= 5 and parts[:3] == ["api", "admin", "events"] and parts[4].startswith("attendees"):
            self.admin()
            event_id = int(parts[3])
            q = f"%{query.get('q', [''])[0].lower()}%"
            with db() as conn:
                rows = conn.execute(
                    "SELECT r.id registration_id, r.created_at registered_at, u.name, u.email FROM registrations r JOIN app_users u ON u.id = r.user_id WHERE r.event_id = ? AND r.status = 'active' AND (LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ?) ORDER BY u.name",
                    (event_id, q, q),
                ).fetchall()
                data = [dict(row) for row in rows]
            if path.endswith(".csv"):
                output = io.StringIO()
                writer = csv.DictWriter(output, fieldnames=["registration_id", "name", "email", "registered_at"])
                writer.writeheader()
                writer.writerows(data)
                raw = output.getvalue().encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/csv")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                return self.wfile.write(raw)
            return self.json(data)
        return self.json({"detail": "Not found."}, 404)

    def static_file(self, path: str) -> None:
        if path == "/":
            path = "/index.html"
        if path.startswith("/assets/"):
            path = "/" + path.removeprefix("/assets/")
        target = (FRONTEND / path.lstrip("/")).resolve()
        if not str(target).startswith(str(FRONTEND.resolve())) or not target.exists():
            target = FRONTEND / "index.html"
        content_type = "text/html"
        if target.suffix == ".css":
            content_type = "text/css"
        elif target.suffix == ".js":
            content_type = "application/javascript"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    init_db()
    print("Nowshera Events running at http://127.0.0.1:8000")
    ThreadingHTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
