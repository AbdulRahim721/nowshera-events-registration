const state = {
  token: localStorage.getItem("token"),
  user: JSON.parse(localStorage.getItem("user") || "null"),
  view: "events",
  events: [],
  usingDemoEvents: false,
};

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
  if (!response.ok) {
    throw new Error(data.detail || "Something went wrong.");
  }
  return data;
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
    state.usingDemoEvents = false;
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
    showToast("Live preview is showing demo events. Local FastAPI mode uses real backend data.");
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
      const response = await fetch(target.href, { headers: authHeaders() });
      if (!response.ok) throw new Error("Export failed.");
      const blob = await response.blob();
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
