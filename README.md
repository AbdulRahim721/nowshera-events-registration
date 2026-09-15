# Nowshera Events Registration System

Full-stack event registration website for attendees and the events team.

## What is included

- FastAPI backend with SQLite database
- Supabase PostgreSQL support through `DATABASE_URL`
- Attendee sign up, sign in, event browsing, registration, and cancellation
- Admin dashboard with totals
- Admin event create/edit/status controls
- Capacity checks, duplicate registration blocking, and past/closed event blocking
- Attendee list search and CSV export
- Responsive frontend served by FastAPI

## Run in VS Code

Open this folder in VS Code:

```powershell
code "D:\Project one"
```

If `code` is not available in PowerShell, open VS Code manually and choose:

```text
File > Open Folder > D:\Project one
```

Then run this command inside the VS Code terminal:

```powershell
.\run_server.bat
```

Or run manually:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn backend.main:app --reload
```

Open:

```text
http://127.0.0.1:8000
```

Health check:

```text
http://127.0.0.1:8000/api/health
```

## Supabase Setup

This project is ready for Supabase. To connect it:

1. Create a Supabase project.
2. Open Supabase SQL Editor.
3. Run the SQL file:

```text
backend/supabase_schema.sql
```

4. Copy `.env.example` to `.env`.
5. Put your Supabase database connection string in `.env`:

```env
DATABASE_URL=postgresql+psycopg://postgres:YOUR_PASSWORD@db.tvwmokxxznetdlnixkeh.supabase.co:5432/postgres
APP_SECRET=make-this-a-long-random-secret
SUPABASE_URL=https://tvwmokxxznetdlnixkeh.supabase.co
SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
```

The app also creates the required tables automatically on startup if they do not exist. The included SQL file enables RLS and revokes browser Data API access from `anon` and `authenticated`; this project uses FastAPI as the secure server layer.

Important: use the Supabase database password from Project Settings > Database. Do not use the anon key as the database password.

## Demo Accounts

Admin:

```text
admin@nowshera.test
Admin123!
```

Attendee:

```text
amina@example.com
Attendee123!
```

You can also create new attendee accounts from the website.

## Project Structure

```text
backend/
  main.py
frontend/
  index.html
  app.js
  styles.css
data/
  app.db  created automatically
```

## Notes

The server enforces role permissions, event capacity, duplicate registration rules, and owner-only access to attendee registrations.

## Test Checklist

- Attendee can sign up and sign in.
- Attendee can register for a published future event.
- Duplicate registration is blocked.
- Full events block extra registrations.
- Cancelled, completed, draft, and past events cannot be registered for.
- Cancellation frees one place.
- Admin can create, edit, publish, complete, and cancel events.
- Admin capacity cannot be lower than active registrations.
- Attendee cannot access admin API routes.
- Admin can search attendees and export CSV.
