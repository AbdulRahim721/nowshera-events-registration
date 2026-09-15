from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, RowMapping


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
DATA_DIR = ROOT / "data"
load_dotenv(ROOT / ".env")

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/app.db")
if DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)
APP_SECRET = os.getenv("APP_SECRET")
IS_POSTGRES = DATABASE_URL.startswith(("postgresql://", "postgresql+"))

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, future=True, connect_args=connect_args)

app = FastAPI(title="Nowshera Events API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class SignupIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    email: EmailStr
    password: str = Field(min_length=8, max_length=120)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class EventIn(BaseModel):
    title: str = Field(min_length=3, max_length=120)
    description: str = Field(min_length=5, max_length=2000)
    start_at: str
    location: str = Field(min_length=2, max_length=160)
    capacity: int = Field(ge=1, le=100000)
    status: str = Field(pattern="^(draft|published|completed|cancelled)$")

    @field_validator("start_at")
    @classmethod
    def valid_datetime(cls, value: str) -> str:
        parse_dt(value)
        return value


def get_secret() -> bytes:
    if APP_SECRET:
        return APP_SECRET.encode("utf-8")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    secret_path = DATA_DIR / ".secret"
    if not secret_path.exists():
        secret_path.write_text(secrets.token_urlsafe(48), encoding="utf-8")
    return secret_path.read_text(encoding="utf-8").encode("utf-8")


def parse_dt(value: str) -> datetime:
    cleaned = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(cleaned)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Date and time is invalid.") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def db_value_dt(value: Any) -> datetime:
    parsed = value if isinstance(value, datetime) else parse_dt(str(value))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def iso(value: Any) -> str:
    return db_value_dt(value).isoformat()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120_000)
    return f"{base64.b64encode(salt).decode()}:{base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str) -> bool:
    salt_text, digest_text = stored.split(":", 1)
    expected = password_hash(password, base64.b64decode(salt_text)).split(":", 1)[1]
    return hmac.compare_digest(expected, digest_text)


def sign_token(payload: dict[str, Any]) -> str:
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()
    sig = hmac.new(get_secret(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def read_token(token: str) -> dict[str, Any]:
    try:
        body, sig = token.split(".", 1)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid token.") from exc
    expected = hmac.new(get_secret(), body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise HTTPException(status_code=401, detail="Invalid token.")
    return json.loads(base64.urlsafe_b64decode(body.encode()))


def one(conn: Connection, sql: str, params: dict[str, Any] | None = None) -> RowMapping | None:
    return conn.execute(text(sql), params or {}).mappings().fetchone()


def all_rows(conn: Connection, sql: str, params: dict[str, Any] | None = None) -> list[RowMapping]:
    return list(conn.execute(text(sql), params or {}).mappings().fetchall())


def scalar(conn: Connection, sql: str, params: dict[str, Any] | None = None) -> Any:
    return conn.execute(text(sql), params or {}).scalar()


def current_user(authorization: str | None = Header(default=None)) -> RowMapping:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Please sign in first.")
    payload = read_token(authorization.split(" ", 1)[1])
    with engine.begin() as conn:
        user = one(conn, "SELECT * FROM app_users WHERE id = :id", {"id": payload.get("sub")})
    if not user:
        raise HTTPException(status_code=401, detail="User not found.")
    return user


def optional_user(authorization: str | None = Header(default=None)) -> RowMapping | None:
    if not authorization:
        return None
    return current_user(authorization)


def admin_user(user: RowMapping = Depends(current_user)) -> RowMapping:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin access required.")
    return user


def public_user(user: RowMapping) -> dict[str, Any]:
    return {"id": user["id"], "name": user["name"], "email": user["email"], "role": user["role"]}


def event_counts(conn: Connection, event_id: int) -> dict[str, int]:
    registered = scalar(
        conn,
        "SELECT COUNT(*) FROM registrations WHERE event_id = :event_id AND status = 'active'",
        {"event_id": event_id},
    )
    capacity = scalar(conn, "SELECT capacity FROM events WHERE id = :event_id", {"event_id": event_id})
    return {"registered_count": int(registered or 0), "places_left": max(int(capacity or 0) - int(registered or 0), 0)}


def event_payload(conn: Connection, row: RowMapping, user_id: int | None = None) -> dict[str, Any]:
    counts = event_counts(conn, row["id"])
    registered = False
    if user_id:
        registered = bool(
            one(
                conn,
                "SELECT 1 FROM registrations WHERE event_id = :event_id AND user_id = :user_id AND status = 'active'",
                {"event_id": row["id"], "user_id": user_id},
            )
        )
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "start_at": iso(row["start_at"]),
        "location": row["location"],
        "capacity": row["capacity"],
        "status": row["status"],
        "registered_count": counts["registered_count"],
        "places_left": counts["places_left"],
        "is_full": counts["places_left"] <= 0,
        "is_past": db_value_dt(row["start_at"]) <= datetime.now(timezone.utc),
        "registered_by_me": registered,
    }


def create_schema(conn: Connection) -> None:
    if IS_POSTGRES:
        for statement in (ROOT / "backend" / "supabase_schema.sql").read_text(encoding="utf-8").split(";"):
            if statement.strip():
                conn.execute(text(statement))
        return
    conn.execute(text("PRAGMA foreign_keys = ON"))
    conn.execute(text("""CREATE TABLE IF NOT EXISTS app_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('attendee', 'admin')), created_at TEXT NOT NULL)"""))
    conn.execute(text("""CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL,
        start_at TEXT NOT NULL, location TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity > 0),
        status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'completed', 'cancelled')), created_at TEXT NOT NULL)"""))
    conn.execute(text("""CREATE TABLE IF NOT EXISTS registrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('active', 'cancelled')), created_at TEXT NOT NULL, cancelled_at TEXT)"""))
    conn.execute(text("""CREATE UNIQUE INDEX IF NOT EXISTS one_active_registration
        ON registrations(event_id, user_id) WHERE status = 'active'"""))


def insert_and_get_id(conn: Connection, sql_without_returning: str, params: dict[str, Any]) -> int:
    if IS_POSTGRES:
        return int(scalar(conn, f"{sql_without_returning} RETURNING id", params))
    result = conn.execute(text(sql_without_returning), params)
    return int(result.lastrowid)


def seed_user(conn: Connection, name: str, email: str, password: str, role: str) -> None:
    if one(conn, "SELECT 1 FROM app_users WHERE email = :email", {"email": email}):
        return
    conn.execute(
        text("""INSERT INTO app_users (name, email, password_hash, role, created_at)
            VALUES (:name, :email, :password_hash, :role, :created_at)"""),
        {"name": name, "email": email, "password_hash": password_hash(password), "role": role, "created_at": utc_now()},
    )


def seed_data(conn: Connection) -> None:
    seed_user(conn, "Admin User", "admin@nowshera.test", "Admin123!", "admin")
    seed_user(conn, "Amina Khan", "amina@example.com", "Attendee123!", "attendee")
    if int(scalar(conn, "SELECT COUNT(*) FROM events") or 0) > 0:
        return
    events = [
        ("Community Leadership Workshop", "A practical workshop for local volunteers and youth leaders.", "2026-10-20T10:00:00+00:00", "Nowshera Community Hall", 35, "published"),
        ("Small Business Seminar", "Sessions on budgeting, marketing, and customer service for new businesses.", "2026-11-05T14:00:00+00:00", "City Library Auditorium", 60, "published"),
        ("Volunteer Training Day", "Draft event for the operations team to prepare before publishing.", "2026-12-12T09:30:00+00:00", "Training Center Room 2", 25, "draft"),
    ]
    for title, description, start_at, location, capacity, status in events:
        conn.execute(
            text("""INSERT INTO events (title, description, start_at, location, capacity, status, created_at)
                VALUES (:title, :description, :start_at, :location, :capacity, :status, :created_at)"""),
            {"title": title, "description": description, "start_at": start_at, "location": location, "capacity": capacity, "status": status, "created_at": utc_now()},
        )


@app.on_event("startup")
def startup() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with engine.begin() as conn:
        create_schema(conn)
        seed_data(conn)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "database": "supabase/postgres" if IS_POSTGRES else "sqlite"}


@app.post("/api/auth/signup")
def signup(data: SignupIn) -> dict[str, Any]:
    with engine.begin() as conn:
        if one(conn, "SELECT 1 FROM app_users WHERE email = :email", {"email": data.email.lower()}):
            raise HTTPException(status_code=409, detail="An account with this email already exists.")
        user_id = insert_and_get_id(
            conn,
            """INSERT INTO app_users (name, email, password_hash, role, created_at)
               VALUES (:name, :email, :password_hash, 'attendee', :created_at)""",
            {"name": data.name.strip(), "email": data.email.lower(), "password_hash": password_hash(data.password), "created_at": utc_now()},
        )
    return {"token": sign_token({"sub": user_id}), "user": {"id": user_id, "name": data.name, "email": data.email, "role": "attendee"}}


@app.post("/api/auth/login")
def login(data: LoginIn) -> dict[str, Any]:
    with engine.begin() as conn:
        user = one(conn, "SELECT * FROM app_users WHERE email = :email", {"email": data.email.lower()})
    if not user or not verify_password(data.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")
    return {"token": sign_token({"sub": user["id"]}), "user": public_user(user)}


@app.get("/api/auth/me")
def me(user: RowMapping = Depends(current_user)) -> dict[str, Any]:
    return {"user": public_user(user)}


@app.get("/api/events")
def public_events(user: RowMapping | None = Depends(optional_user)) -> list[dict[str, Any]]:
    with engine.begin() as conn:
        rows = all_rows(conn, "SELECT * FROM events WHERE status = 'published' AND start_at > :now ORDER BY start_at ASC", {"now": utc_now()})
        return [event_payload(conn, row, user["id"] if user else None) for row in rows]


@app.get("/api/events/{event_id}")
def public_event(event_id: int, user: RowMapping | None = Depends(optional_user)) -> dict[str, Any]:
    with engine.begin() as conn:
        row = one(conn, "SELECT * FROM events WHERE id = :id", {"id": event_id})
        if not row:
            raise HTTPException(status_code=404, detail="Event not found.")
        if row["status"] != "published" and (not user or user["role"] != "admin"):
            raise HTTPException(status_code=404, detail="Event not found.")
        return event_payload(conn, row, user["id"] if user else None)


@app.post("/api/events/{event_id}/register")
def register(event_id: int, user: RowMapping = Depends(current_user)) -> dict[str, Any]:
    with engine.begin() as conn:
        row = one(conn, "SELECT * FROM events WHERE id = :id", {"id": event_id})
        if not row:
            raise HTTPException(status_code=404, detail="Event not found.")
        if row["status"] != "published":
            raise HTTPException(status_code=400, detail="Registration is closed for this event.")
        if db_value_dt(row["start_at"]) <= datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="Registration is closed for past events.")
        if one(conn, "SELECT 1 FROM registrations WHERE event_id = :event_id AND user_id = :user_id AND status = 'active'", {"event_id": event_id, "user_id": user["id"]}):
            raise HTTPException(status_code=409, detail="You are already registered for this event.")
        if event_counts(conn, event_id)["places_left"] <= 0:
            raise HTTPException(status_code=400, detail="This event is full.")
        registration_id = insert_and_get_id(
            conn,
            """INSERT INTO registrations (event_id, user_id, status, created_at)
               VALUES (:event_id, :user_id, 'active', :created_at)""",
            {"event_id": event_id, "user_id": user["id"], "created_at": utc_now()},
        )
        return {"message": "Registration confirmed.", "registration_id": registration_id}


@app.get("/api/registrations/me")
def my_registrations(user: RowMapping = Depends(current_user)) -> list[dict[str, Any]]:
    with engine.begin() as conn:
        rows = all_rows(
            conn,
            """SELECT r.id AS registration_id, r.status AS registration_status, r.created_at AS registered_at,
                      r.cancelled_at, e.*
               FROM registrations r JOIN events e ON e.id = r.event_id
               WHERE r.user_id = :user_id ORDER BY r.created_at DESC""",
            {"user_id": user["id"]},
        )
        return [{"registration_id": row["registration_id"], "registration_status": row["registration_status"], "registered_at": iso(row["registered_at"]), "cancelled_at": iso(row["cancelled_at"]) if row["cancelled_at"] else None, "event": event_payload(conn, row, user["id"])} for row in rows]


@app.delete("/api/registrations/{registration_id}")
def cancel_registration(registration_id: int, user: RowMapping = Depends(current_user)) -> dict[str, str]:
    with engine.begin() as conn:
        row = one(conn, "SELECT * FROM registrations WHERE id = :id", {"id": registration_id})
        if not row:
            raise HTTPException(status_code=404, detail="Registration not found.")
        if row["user_id"] != user["id"]:
            raise HTTPException(status_code=403, detail="You can only cancel your own registrations.")
        if row["status"] != "active":
            raise HTTPException(status_code=400, detail="This registration is already cancelled.")
        conn.execute(text("UPDATE registrations SET status = 'cancelled', cancelled_at = :cancelled_at WHERE id = :id"), {"cancelled_at": utc_now(), "id": registration_id})
    return {"message": "Registration cancelled."}


@app.get("/api/admin/dashboard")
def dashboard(_: RowMapping = Depends(admin_user)) -> dict[str, int]:
    with engine.begin() as conn:
        events = int(scalar(conn, "SELECT COUNT(*) FROM events") or 0)
        published = int(scalar(conn, "SELECT COUNT(*) FROM events WHERE status = 'published'") or 0)
        registrations = int(scalar(conn, "SELECT COUNT(*) FROM registrations WHERE status = 'active'") or 0)
        capacity = int(scalar(conn, "SELECT COALESCE(SUM(capacity), 0) FROM events WHERE status = 'published'") or 0)
    return {"events": events, "published_events": published, "active_registrations": registrations, "published_places_left": max(capacity - registrations, 0)}


@app.get("/api/admin/events")
def admin_events(_: RowMapping = Depends(admin_user)) -> list[dict[str, Any]]:
    with engine.begin() as conn:
        return [event_payload(conn, row) for row in all_rows(conn, "SELECT * FROM events ORDER BY start_at DESC")]


@app.post("/api/admin/events")
def create_event(data: EventIn, _: RowMapping = Depends(admin_user)) -> dict[str, Any]:
    with engine.begin() as conn:
        event_id = insert_and_get_id(
            conn,
            """INSERT INTO events (title, description, start_at, location, capacity, status, created_at)
               VALUES (:title, :description, :start_at, :location, :capacity, :status, :created_at)""",
            {"title": data.title.strip(), "description": data.description.strip(), "start_at": parse_dt(data.start_at).isoformat(), "location": data.location.strip(), "capacity": data.capacity, "status": data.status, "created_at": utc_now()},
        )
        return event_payload(conn, one(conn, "SELECT * FROM events WHERE id = :id", {"id": event_id}))


@app.put("/api/admin/events/{event_id}")
def update_event(event_id: int, data: EventIn, _: RowMapping = Depends(admin_user)) -> dict[str, Any]:
    with engine.begin() as conn:
        row = one(conn, "SELECT * FROM events WHERE id = :id", {"id": event_id})
        if not row:
            raise HTTPException(status_code=404, detail="Event not found.")
        active = event_counts(conn, event_id)["registered_count"]
        if data.capacity < active:
            raise HTTPException(status_code=400, detail=f"Capacity cannot be less than current active registrations ({active}).")
        conn.execute(
            text("""UPDATE events SET title = :title, description = :description, start_at = :start_at,
                    location = :location, capacity = :capacity, status = :status WHERE id = :id"""),
            {"title": data.title.strip(), "description": data.description.strip(), "start_at": parse_dt(data.start_at).isoformat(), "location": data.location.strip(), "capacity": data.capacity, "status": data.status, "id": event_id},
        )
        return event_payload(conn, one(conn, "SELECT * FROM events WHERE id = :id", {"id": event_id}))


@app.get("/api/admin/events/{event_id}/attendees")
def attendees(event_id: int, q: str = "", _: RowMapping = Depends(admin_user)) -> list[dict[str, Any]]:
    with engine.begin() as conn:
        if not one(conn, "SELECT 1 FROM events WHERE id = :id", {"id": event_id}):
            raise HTTPException(status_code=404, detail="Event not found.")
        rows = all_rows(
            conn,
            """SELECT r.id AS registration_id, r.created_at AS registered_at, u.name, u.email
               FROM registrations r JOIN app_users u ON u.id = r.user_id
               WHERE r.event_id = :event_id AND r.status = 'active'
               AND (LOWER(u.name) LIKE :query OR LOWER(u.email) LIKE :query)
               ORDER BY u.name ASC""",
            {"event_id": event_id, "query": f"%{q.lower()}%"},
        )
        return [{"registration_id": row["registration_id"], "registered_at": iso(row["registered_at"]), "name": row["name"], "email": row["email"]} for row in rows]


@app.get("/api/admin/events/{event_id}/attendees.csv")
def attendees_csv(event_id: int, _: RowMapping = Depends(admin_user)) -> StreamingResponse:
    rows = attendees(event_id, "", _)
    output = StringIO()
    writer = csv.DictWriter(output, fieldnames=["registration_id", "name", "email", "registered_at"])
    writer.writeheader()
    writer.writerows(rows)
    output.seek(0)
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="event-{event_id}-attendees.csv"'})


app.mount("/assets", StaticFiles(directory=FRONTEND), name="assets")


@app.get("/{path:path}", include_in_schema=False)
def frontend(path: str) -> Response:
    target = FRONTEND / path
    if path and target.exists() and target.is_file():
        return FileResponse(target)
    return FileResponse(FRONTEND / "index.html")
