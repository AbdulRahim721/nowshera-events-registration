const state = {
  token: localStorage.getItem("token"),
  user: JSON.parse(localStorage.getItem("user") || "null"),
  view: "events",
  events: [],
  usingDemoEvents: false,
  demoMode: false,
};

const DEMO_DB_KEY = "nowshera_demo_db_v2";

const demoEvents = [
  {
    id: 101,
    title: "Community Leadership Workshop",
    description: "A practical workshop for local volunteers and youth leaders.",
    start_at: "2026-10-20T10:00:00+00:00",
    location: "Nowshera Community Hall",
    capacity: 35,
    registered_count: 18,
    places_left: 17,
    is_full: false,
    registered_by_me: false,
    status: "published",
  },
  {
    id: 102,
    title: "Small Business Seminar",
    description: "Budgeting, marketing, and customer service sessions for new businesses.",
    start_at: "2026-11-05T14:00:00+00:00",
    location: "City Library Auditorium",
    capacity: 60,
    registered_count: 44,
    places_left: 16,
    is_full: false,
    registered_by_me: false,
    status: "published",
  },
  {
    id: 103,
    title: "Volunteer Training Day",
    description: "Hands-on training for event helpers, registration desks, and operations teams.",
    start_at: "2026-12-12T09:30:00+00:00",
    location: "Training Center Room 2",
    capacity: 25,
    registered_count: 10,
    places_left: 15,
    is_full: false,
    registered_by_me: false,
    status: "published",
  },
];

if (window.location.search) {
  window.history.replaceState({}, document.title, window.location.pathname);
}

function setPointerDepth(event) {
  const x = (event.clientX / window.innerWidth - 0.5).toFixed(3);
  const y = (event.clientY / window.innerHeight - 0.5).toFixed(3);
  document.body.style.setProperty("--mx", x);
  document.body.style.setProperty("--my", y);
}

window.addEventListener("pointermove", setPointerDepth, { passive: true });
window.addEventListener("pointerleave", () => {
  document.body.style.setProperty("--mx", "0");
  document.body.style.setProperty("--my", "0");
});

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function authHeaders() {
  return state.token ? { Authorization: `Bearer ${state.token}` } : {};
}

async function api(path, options = {}) {
  try {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...(options.headers || {}),
      },
    });
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json() : await response.text();
    if (path.startsWith("/api/") && !contentType.includes("application/json")) {
      return demoApi(path, options);
    }
    if (!response.ok) {
      throw new Error(data.detail || "Something went wrong.");
    }
    state.demoMode = false;
    return data;
  } catch (error) {
    if (path.startsWith("/api/") && (error instanceof TypeError || error.message.includes("static preview"))) {
      return demoApi(path, options);
    }
    throw error;
  }
}

function demoDb() {
  const saved = JSON.parse(localStorage.getItem(DEMO_DB_KEY) || "null");
  if (saved?.users && saved?.events && saved?.registrations) return saved;
  const now = new Date().toISOString();
  const db = {
    users: [
      { id: 1, name: "Admin User", email: "admin@nowshera.test", password: "Admin123!", role: "admin" },
      { id: 2, name: "Amina Khan", email: "amina@example.com", password: "Attendee123!", role: "attendee" },
    ],
    events: demoEvents.map((event) => ({ ...event })),
    registrations: [{ id: 1, event_id: 101, user_id: 2, status: "active", created_at: now, cancelled_at: null }],
    nextUserId: 3,
    nextRegistrationId: 2,
    nextEventId: 104,
  };
  saveDemoDb(db);
  return db;
}

function saveDemoDb(db) {
  localStorage.setItem(DEMO_DB_KEY, JSON.stringify(db));
}

function publicDemoUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

function demoUserFromToken(db) {
  if (!state.token?.startsWith("demo:")) return null;
  const id = Number(state.token.split(":")[1]);
  return db.users.find((user) => user.id === id) || null;
}

function demoRequireUser(db) {
  const user = demoUserFromToken(db);
  if (!user) throw new Error("Please sign in first.");
  return user;
}

function demoRequireAdmin(db) {
  const user = demoRequireUser(db);
  if (user.role !== "admin") throw new Error("Admin access required.");
  return user;
}

function demoEventPayload(db, event, userId = null) {
  const active = db.registrations.filter((item) => item.event_id === event.id && item.status === "active");
  const registered_count = active.length + Number(event.registered_count || 0);
  const places_left = Math.max(Number(event.capacity) - registered_count, 0);
  return {
    ...event,
    registered_count,
    places_left,
    is_full: places_left <= 0,
    is_past: new Date(event.start_at) <= new Date(),
    registered_by_me: userId ? active.some((item) => item.user_id === userId) : false,
  };
}

function validateDemoCapacity(value, active = 0) {
  if (!Number.isInteger(Number(value)) || Number(value) < 1) {
    throw new Error("Capacity must be a whole number greater than 0.");
  }
  if (Number(value) < active) {
    throw new Error(`Capacity cannot be less than current active registrations (${active}).`);
  }
  return Number(value);
}

async function demoApi(path, options = {}) {
  state.demoMode = true;
  const db = demoDb();
  const method = options.method || "GET";
  const url = new URL(path, window.location.origin);
  const parts = url.pathname.split("/").filter(Boolean);
  const body = options.body ? JSON.parse(options.body) : {};

  if (url.pathname === "/api/auth/login" && method === "POST") {
    const user = db.users.find((item) => item.email.toLowerCase() === String(body.email || "").toLowerCase() && item.password === body.password);
    if (!user) throw new Error("Email or password is incorrect.");
    return { token: `demo:${user.id}`, user: publicDemoUser(user) };
  }
  if (url.pathname === "/api/auth/signup" && method === "POST") {
    const email = String(body.email || "").toLowerCase();
    if (db.users.some((item) => item.email === email)) throw new Error("This email is already registered.");
    const user = { id: db.nextUserId++, name: body.name.trim(), email, password: body.password, role: "attendee" };
    db.users.push(user);
    saveDemoDb(db);
    return { token: `demo:${user.id}`, user: publicDemoUser(user) };
  }
  if (url.pathname === "/api/events" && method === "GET") {
    const user = demoUserFromToken(db);
    return db.events
      .filter((event) => event.status === "published" && new Date(event.start_at) > new Date())
      .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))
      .map((event) => demoEventPayload(db, event, user?.id));
  }
  if (parts[0] === "api" && parts[1] === "events" && parts[3] === "register" && method === "POST") {
    const user = demoRequireUser(db);
    const event = db.events.find((item) => item.id === Number(parts[2]));
    const payload = event && demoEventPayload(db, event, user.id);
    if (!event || event.status !== "published" || payload.is_past) throw new Error("Registration is closed for this event.");
    if (payload.is_full) throw new Error("This event is full.");
    if (db.registrations.some((item) => item.event_id === event.id && item.user_id === user.id && item.status === "active")) {
      throw new Error("This request conflicts with existing data.");
    }
    const registration = { id: db.nextRegistrationId++, event_id: event.id, user_id: user.id, status: "active", created_at: new Date().toISOString(), cancelled_at: null };
    db.registrations.push(registration);
    saveDemoDb(db);
    return { message: "Registration confirmed.", registration_id: registration.id };
  }
  if (parts[0] === "api" && parts[1] === "events" && parts.length === 3 && method === "GET") {
    const user = demoUserFromToken(db);
    const event = db.events.find((item) => item.id === Number(parts[2]));
    if (!event) throw new Error("Event not found.");
    if (event.status !== "published" && user?.role !== "admin") throw new Error("Event not found.");
    return demoEventPayload(db, event, user?.id);
  }
  if (url.pathname === "/api/registrations/me" && method === "GET") {
    const user = demoRequireUser(db);
    return db.registrations
      .filter((item) => item.user_id === user.id)
      .map((item) => ({
        registration_id: item.id,
        registration_status: item.status,
        registered_at: item.created_at,
        cancelled_at: item.cancelled_at,
        event: demoEventPayload(db, db.events.find((event) => event.id === item.event_id), user.id),
      }));
  }
  if (parts[0] === "api" && parts[1] === "registrations" && method === "DELETE") {
    const user = demoRequireUser(db);
    const registration = db.registrations.find((item) => item.id === Number(parts[2]));
    if (!registration || registration.user_id !== user.id) throw new Error("You can only cancel your own registrations.");
    registration.status = "cancelled";
    registration.cancelled_at = new Date().toISOString();
    saveDemoDb(db);
    return { message: "Registration cancelled." };
  }
  if (url.pathname === "/api/admin/dashboard") {
    demoRequireAdmin(db);
    const published = db.events.filter((event) => event.status === "published").map((event) => demoEventPayload(db, event));
    return {
      events: db.events.length,
      published_events: published.length,
      active_registrations: db.registrations.filter((item) => item.status === "active").length,
      published_places_left: published.reduce((total, event) => total + event.places_left, 0),
    };
  }
  if (url.pathname === "/api/admin/events" && method === "GET") {
    demoRequireAdmin(db);
    return [...db.events].sort((a, b) => new Date(b.start_at) - new Date(a.start_at)).map((event) => demoEventPayload(db, event));
  }
  if (url.pathname === "/api/admin/events" && method === "POST") {
    demoRequireAdmin(db);
    const event = {
      id: db.nextEventId++,
      title: body.title,
      description: body.description,
      start_at: body.start_at,
      location: body.location,
      capacity: validateDemoCapacity(body.capacity),
      status: body.status,
      registered_count: 0,
    };
    db.events.push(event);
    saveDemoDb(db);
    return demoEventPayload(db, event);
  }
  if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "events" && method === "PUT") {
    demoRequireAdmin(db);
    const event = db.events.find((item) => item.id === Number(parts[3]));
    if (!event) throw new Error("Event not found.");
    const active = db.registrations.filter((item) => item.event_id === event.id && item.status === "active").length;
    Object.assign(event, {
      title: body.title,
      description: body.description,
      start_at: body.start_at,
      location: body.location,
      capacity: validateDemoCapacity(body.capacity, active),
      status: body.status,
    });
    saveDemoDb(db);
    return demoEventPayload(db, event);
  }
  if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "events" && parts[4]?.startsWith("attendees")) {
    demoRequireAdmin(db);
    const eventId = Number(parts[3]);
    const query = (url.searchParams.get("q") || "").toLowerCase();
    return db.registrations
      .filter((item) => item.event_id === eventId && item.status === "active")
      .map((item) => ({ ...item, user: db.users.find((user) => user.id === item.user_id) }))
      .filter((item) => [item.user?.name, item.user?.email].join(" ").toLowerCase().includes(query))
      .map((item) => ({ registration_id: item.id, name: item.user.name, email: item.user.email, registered_at: item.created_at }));
  }
  throw new Error("This action is not available.");
}

function showToast(message, type = "ok") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast ${type === "error" ? "error" : ""}`;
  setTimeout(() => toast.classList.add("hidden"), 4200);
}

function setSession(payload) {
  state.token = payload.token;
  state.user = payload.user;
  localStorage.setItem("token", payload.token);
  localStorage.setItem("user", JSON.stringify(payload.user));
  updateShell();
}

function clearSession() {
  state.token = null;
  state.user = null;
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  state.view = "events";
  updateShell();
  loadEvents();
}

function updateShell() {
  const signedIn = Boolean(state.user);
  $("#authPanel").classList.toggle("hidden", signedIn);
  $("#logoutBtn").classList.toggle("hidden", !signedIn);
  $("#userBadge").textContent = signedIn ? `${state.user.name} (${state.user.role})` : "";
  $$(".auth-only").forEach((el) => el.classList.toggle("hidden", !signedIn));
  $$(".admin-only").forEach((el) => el.classList.toggle("hidden", !signedIn || state.user.role !== "admin"));
  if (!signedIn && (state.view === "my" || state.view === "admin")) state.view = "events";
  if (signedIn && state.user.role !== "admin" && state.view === "admin") state.view = "events";
  showView(state.view);
}

function showView(view) {
  state.view = view;
  $$(".view").forEach((el) => el.classList.add("hidden"));
  $(`#${view}View`).classList.remove("hidden");
  $$(".nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.view === view));
  if (view === "events") loadEvents();
  if (view === "my") loadMine();
  if (view === "admin") loadAdmin();
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function eventCard(event) {
  const disabled = !state.user || event.is_full || event.registered_by_me;
  const status = event.is_full ? "Full" : `${event.places_left} places left`;
  const ratio = event.capacity ? event.registered_count / event.capacity : 0;
  const heat = ratio >= 0.7 ? "Filling fast" : "Open";
  return `
    <article class="card">
      <span class="pill ${event.is_full ? "closed" : ""}">${status}</span>
      <span class="pill accent">${heat}</span>
      <h3>${escapeHtml(event.title)}</h3>
      <p>${escapeHtml(event.description)}</p>
      <p class="meta">${formatDate(event.start_at)}<br>${escapeHtml(event.location)}</p>
      <button data-register="${event.id}" ${disabled ? "disabled" : ""}>
        ${event.registered_by_me ? "Already registered" : state.user ? "Register" : "Sign in to register"}
      </button>
    </article>
  `;
}

async function loadEvents() {
  try {
    state.events = await api("/api/events");
    state.usingDemoEvents = state.demoMode;
  } catch (error) {
    state.events = demoEvents;
    state.usingDemoEvents = true;
  }
  renderEvents();
}

function renderEvents() {
  const search = ($("#eventSearch")?.value || "").trim().toLowerCase();
  const filter = $("#eventFilter")?.value || "all";
  let events = state.events;

  if (search) {
    events = events.filter((event) => [event.title, event.description, event.location].join(" ").toLowerCase().includes(search));
  }
  if (filter === "open") {
    events = events.filter((event) => !event.is_full && event.places_left > 0);
  }
  if (filter === "popular") {
    events = events.filter((event) => event.capacity && event.registered_count / event.capacity >= 0.7);
  }

  $("#eventsList").innerHTML = events.length
    ? events.map(eventCard).join("")
    : `<p class="meta">No matching events found.</p>`;
  updateImpact(state.events);
  updateSpotlight(state.events);
  if (state.usingDemoEvents) {
    showToast("Live site demo mode is active. Sign in, sign up, and registration work in this browser.");
  }
}

function updateImpact(events) {
  const seats = events.reduce((total, event) => total + Math.max(Number(event.places_left || 0), 0), 0);
  $("#impactEvents").textContent = events.length;
  $("#impactSeats").textContent = seats;
}

function updateSpotlight(events) {
  const upcoming = [...events].sort((a, b) => new Date(a.start_at) - new Date(b.start_at))[0];
  const target = $("#spotlight");
  if (!upcoming) {
    target.classList.add("hidden");
    return;
  }
  const diff = Math.max(new Date(upcoming.start_at) - new Date(), 0);
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  target.classList.remove("hidden");
  target.innerHTML = `
    <div>
      <p class="eyebrow">Next featured event</p>
      <h2>${escapeHtml(upcoming.title)}</h2>
      <p class="meta">${formatDate(upcoming.start_at)} · ${escapeHtml(upcoming.location)}</p>
    </div>
    <div class="countdown" aria-label="Countdown">
      <span>${days}<br>days</span>
      <span>${hours}<br>hrs</span>
      <span>${minutes}<br>min</span>
    </div>
  `;
}

async function register(eventId) {
  if (!state.user) return showToast("Please sign in first.", "error");
  try {
    const result = await api(`/api/events/${eventId}/register`, { method: "POST" });
    showToast(result.message);
    loadEvents();
    if (state.view === "my") loadMine();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function registrationCard(item) {
  const event = item.event;
  return `
    <article class="card">
      <span class="pill ${item.registration_status === "cancelled" ? "closed" : ""}">${item.registration_status}</span>
      <h3>${escapeHtml(event.title)}</h3>
      <p class="meta">${formatDate(event.start_at)}<br>${escapeHtml(event.location)}</p>
      <button data-cancel="${item.registration_id}" ${item.registration_status !== "active" ? "disabled" : ""}>Cancel registration</button>
    </article>
  `;
}

async function loadMine() {
  try {
    const registrations = await api("/api/registrations/me");
    $("#myList").innerHTML = registrations.length
      ? registrations.map(registrationCard).join("")
      : `<p class="meta">You do not have any registrations yet.</p>`;
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function cancelRegistration(id) {
  try {
    const result = await api(`/api/registrations/${id}`, { method: "DELETE" });
    showToast(result.message);
    loadMine();
    loadEvents();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function loadAdmin() {
  try {
    const [stats, events] = await Promise.all([api("/api/admin/dashboard"), api("/api/admin/events")]);
    $("#stats").innerHTML = [
      ["Events", stats.events],
      ["Published", stats.published_events],
      ["Registrations", stats.active_registrations],
      ["Places left", stats.published_places_left],
    ].map(([label, value]) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`).join("");
    $("#adminEvents").innerHTML = events.map(adminEventCard).join("");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function adminEventCard(event) {
  return `
    <article class="admin-card">
      <div class="row">
        <span class="pill ${event.status === "published" ? "" : "warn"}">${event.status}</span>
        <span class="meta">${event.registered_count}/${event.capacity} registered</span>
      </div>
      <h3>${escapeHtml(event.title)}</h3>
      <p class="meta">${formatDate(event.start_at)} · ${escapeHtml(event.location)}</p>
      <div class="row">
        <button data-edit="${event.id}">Edit</button>
        <button data-attendees="${event.id}" class="ghost">Attendees</button>
        <a class="ghost button-link" href="/api/admin/events/${event.id}/attendees.csv" data-export="${event.id}">Export CSV</a>
      </div>
      <div id="attendees-${event.id}" class="attendees hidden"></div>
    </article>
  `;
}

async function editEvent(id) {
  const event = await api(`/api/events/${id}`);
  const form = $("#eventForm");
  form.id.value = event.id;
  form.title.value = event.title;
  form.description.value = event.description;
  form.start_at.value = toLocalInput(event.start_at);
  form.location.value = event.location;
  form.capacity.value = event.capacity;
  form.status.value = event.status;
  $("#formTitle").textContent = "Edit Event";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function showAttendees(id) {
  const panel = $(`#attendees-${id}`);
  panel.classList.toggle("hidden");
  if (panel.classList.contains("hidden")) return;
  panel.innerHTML = `
    <input data-search-attendees="${id}" placeholder="Search attendee name or email" />
    <div data-attendee-list="${id}" class="meta">Loading...</div>
  `;
  await loadAttendees(id, "");
}

async function loadAttendees(id, query) {
  const rows = await api(`/api/admin/events/${id}/attendees?q=${encodeURIComponent(query)}`);
  const target = document.querySelector(`[data-attendee-list="${id}"]`);
  target.innerHTML = rows.length
    ? rows.map((row) => `
      <div class="attendee-row">
        <strong>${escapeHtml(row.name)}</strong>
        <span>${escapeHtml(row.email)}</span>
      </div>
    `).join("")
    : "No active attendees found.";
}

async function saveEvent(form) {
  const payload = {
    title: form.title.value,
    description: form.description.value,
    start_at: new Date(form.start_at.value).toISOString(),
    location: form.location.value,
    capacity: Number(form.capacity.value),
    status: form.status.value,
  };
  const id = form.id.value;
  const path = id ? `/api/admin/events/${id}` : "/api/admin/events";
  const method = id ? "PUT" : "POST";
  const result = await api(path, { method, body: JSON.stringify(payload) });
  showToast(`Saved: ${result.title}`);
  resetEventForm();
  loadAdmin();
  loadEvents();
}

function resetEventForm() {
  $("#eventForm").reset();
  $("#eventForm").id.value = "";
  $("#eventForm").status.value = "draft";
  $("#formTitle").textContent = "Create Event";
}

function toLocalInput(value) {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));
}

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (target.matches("[data-view]")) showView(target.dataset.view);
  if (target.matches("[data-register]")) register(target.dataset.register);
  if (target.matches("[data-cancel]")) cancelRegistration(target.dataset.cancel);
  if (target.matches("[data-edit]")) editEvent(target.dataset.edit);
  if (target.matches("[data-attendees]")) showAttendees(target.dataset.attendees);
  if (target.matches("[data-export]")) {
    event.preventDefault();
    try {
      let blob;
      if (state.demoMode) {
        const rows = await demoApi(new URL(target.href).pathname.replace(".csv", "") + ".csv");
        const csv = ["registration_id,name,email,registered_at", ...rows.map((row) => `${row.registration_id},${row.name},${row.email},${row.registered_at}`)].join("\n");
        blob = new Blob([csv], { type: "text/csv" });
      } else {
        const response = await fetch(target.href, { headers: authHeaders() });
        if (!response.ok) throw new Error("Export failed.");
        blob = await response.blob();
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = target.href.split("/").at(-1);
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      showToast(error.message, "error");
    }
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (target.matches("[data-search-attendees]")) {
    loadAttendees(target.dataset.searchAttendees, target.value).catch((error) => showToast(error.message, "error"));
  }
});

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    setSession(await api("/api/auth/login", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }));
    showToast("Signed in successfully.");
    loadEvents();
  } catch (error) {
    showToast(error.message, "error");
  }
});

$("#signupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    setSession(await api("/api/auth/signup", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }));
    showToast("Account created.");
    event.target.reset();
    loadEvents();
  } catch (error) {
    showToast(error.message, "error");
  }
});

$("#eventForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await saveEvent(event.target);
  } catch (error) {
    showToast(error.message, "error");
  }
});

$("#logoutBtn").addEventListener("click", clearSession);
$("#refreshEvents").addEventListener("click", loadEvents);
$("#eventSearch").addEventListener("input", renderEvents);
$("#eventFilter").addEventListener("change", renderEvents);
$("#refreshMine").addEventListener("click", loadMine);
$("#refreshAdmin").addEventListener("click", loadAdmin);
$("#resetForm").addEventListener("click", resetEventForm);

updateShell();
loadEvents();
