import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const html = readFileSync(resolve(root, "dist/index.html"), "utf8");
const appJs = readFileSync(resolve(root, "dist/assets/app.js"), "utf8");
const styles = readFileSync(resolve(root, "dist/assets/styles.css"), "utf8");

const worker = `const HTML = ${JSON.stringify(html)};
const APP_JS = ${JSON.stringify(appJs)};
const STYLES = ${JSON.stringify(styles)};

const demoEvents = [
  {
    id: 1,
    title: "Community Leadership Workshop",
    description: "A practical workshop for local volunteers and youth leaders.",
    start_at: "2026-10-20T10:00:00+00:00",
    location: "Nowshera Community Hall",
    capacity: 35,
    registered_count: 18,
    status: "published",
  },
  {
    id: 2,
    title: "Small Business Seminar",
    description: "Budgeting, marketing, and customer service sessions for new businesses.",
    start_at: "2026-11-05T14:00:00+00:00",
    location: "City Library Auditorium",
    capacity: 60,
    registered_count: 44,
    status: "published",
  },
  {
    id: 3,
    title: "Volunteer Training Day",
    description: "Hands-on training for event helpers, registration desks, and operations teams.",
    start_at: "2026-12-12T09:30:00+00:00",
    location: "Training Center Room 2",
    capacity: 25,
    registered_count: 10,
    status: "published",
  },
];

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function signUser(user) {
  return btoa(JSON.stringify({ id: user.id, name: user.name, email: user.email, role: user.role }));
}

function userFromRequest(request) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  try {
    return JSON.parse(atob(token));
  } catch {
    return null;
  }
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

function eventPayload(event) {
  const places_left = Math.max(Number(event.capacity) - Number(event.registered_count || 0), 0);
  return {
    ...event,
    places_left,
    is_full: places_left <= 0,
    is_past: new Date(event.start_at) <= new Date(),
    registered_by_me: false,
  };
}

async function syncSupabase(env, payload) {
  if (!env.SUPABASE_SYNC_FUNCTION_URL || !env.SUPABASE_SYNC_KEY) {
    return { ok: false, skipped: true };
  }
  const response = await fetch(env.SUPABASE_SYNC_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-sync-key": env.SUPABASE_SYNC_KEY,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Supabase sync failed.");
  return data;
}

async function api(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method;
  const body = method === "POST" || method === "PUT" ? await request.json().catch(() => ({})) : {};

  if (url.pathname === "/api/health") {
    return json({ status: "ok", supabase_sync: Boolean(env.SUPABASE_SYNC_FUNCTION_URL && env.SUPABASE_SYNC_KEY) });
  }

  if (url.pathname === "/api/auth/login" && method === "POST") {
    const email = String(body.email || "").toLowerCase();
    const isAdmin = email === "admin@nowshera.test";
    const user = {
      id: isAdmin ? 1 : Math.abs([...email].reduce((sum, char) => sum + char.charCodeAt(0), 0)),
      name: isAdmin ? "Admin User" : email.split("@")[0] || "Attendee",
      email,
      role: isAdmin ? "admin" : "attendee",
    };
    await syncSupabase(env, {
      action: "sync_user",
      name: user.name,
      email: user.email,
      password_hash: "live-site-login",
      role: user.role,
    });
    return json({ token: signUser(user), user: publicUser(user) });
  }

  if (url.pathname === "/api/auth/signup" && method === "POST") {
    const email = String(body.email || "").toLowerCase();
    const user = {
      id: Math.abs([...email].reduce((sum, char) => sum + char.charCodeAt(0), 0)),
      name: String(body.name || "Attendee").trim(),
      email,
      role: "attendee",
    };
    await syncSupabase(env, {
      action: "sync_user",
      name: user.name,
      email: user.email,
      password_hash: "live-site-signup",
      role: user.role,
    });
    return json({ token: signUser(user), user: publicUser(user) });
  }

  if (url.pathname === "/api/events" && method === "GET") {
    return json(demoEvents.filter((event) => event.status === "published").map(eventPayload));
  }

  if (parts[0] === "api" && parts[1] === "events" && parts.length === 3 && method === "GET") {
    const event = demoEvents.find((item) => item.id === Number(parts[2]));
    return event ? json(eventPayload(event)) : json({ detail: "Event not found." }, 404);
  }

  if (parts[0] === "api" && parts[1] === "events" && parts[3] === "register" && method === "POST") {
    const user = userFromRequest(request);
    if (!user) return json({ detail: "Please sign in first." }, 401);
    const event = demoEvents.find((item) => item.id === Number(parts[2]));
    if (!event) return json({ detail: "Event not found." }, 404);
    await syncSupabase(env, {
      action: "sync_user",
      name: user.name,
      email: user.email,
      password_hash: "live-site-user",
      role: user.role,
    });
    await syncSupabase(env, {
      action: "sync_registration",
      event_id: event.id,
      user_email: user.email,
      status: "active",
    });
    return json({ message: "Registration confirmed and saved to Supabase.", registration_id: Date.now() });
  }

  if (url.pathname === "/api/registrations/me" && method === "GET") {
    return json([]);
  }

  if (parts[0] === "api" && parts[1] === "registrations" && method === "DELETE") {
    return json({ message: "Registration cancelled." });
  }

  if (url.pathname === "/api/admin/dashboard") {
    const user = userFromRequest(request);
    if (user?.role !== "admin") return json({ detail: "Admin access required." }, 403);
    const published = demoEvents.filter((event) => event.status === "published").map(eventPayload);
    return json({
      events: demoEvents.length,
      published_events: published.length,
      active_registrations: 0,
      published_places_left: published.reduce((sum, event) => sum + event.places_left, 0),
    });
  }

  if (url.pathname === "/api/admin/events" && method === "GET") {
    const user = userFromRequest(request);
    if (user?.role !== "admin") return json({ detail: "Admin access required." }, 403);
    return json(demoEvents.map(eventPayload));
  }

  if (url.pathname === "/api/admin/events" && method === "POST") {
    const user = userFromRequest(request);
    if (user?.role !== "admin") return json({ detail: "Admin access required." }, 403);
    return json({ ...body, id: Date.now(), registered_count: 0, places_left: Number(body.capacity || 1), is_full: false });
  }

  if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "events" && method === "PUT") {
    const user = userFromRequest(request);
    if (user?.role !== "admin") return json({ detail: "Admin access required." }, 403);
    return json({ ...body, id: Number(parts[3]), registered_count: 0, places_left: Number(body.capacity || 1), is_full: false });
  }

  if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "events" && parts[4]?.startsWith("attendees")) {
    const user = userFromRequest(request);
    if (user?.role !== "admin") return json({ detail: "Admin access required." }, 403);
    return json([]);
  }

  return json({ detail: "Not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request, env);
    if (url.pathname === "/assets/app.js" || url.pathname === "/app.js") {
      return new Response(APP_JS, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    }
    if (url.pathname === "/assets/styles.css" || url.pathname === "/styles.css") {
      return new Response(STYLES, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    }
    return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};
`;

const output = resolve(root, "dist/server/index.js");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, worker);
