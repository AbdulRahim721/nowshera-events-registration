import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function supabaseFetch(path: string, options: RequestInit = {}) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase service environment is missing.");

  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(typeof data?.message === "string" ? data.message : text || "Supabase request failed.");
  }
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const syncKey = Deno.env.get("NOWSHERA_SYNC_KEY");
    if (!syncKey || req.headers.get("x-sync-key") !== syncKey) return json({ error: "Unauthorized" }, 401);

    const body = await req.json();
    if (body.action === "sync_user") {
      const rows = await supabaseFetch("app_users?on_conflict=email", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify([
          {
            name: body.name,
            email: String(body.email).toLowerCase(),
            password_hash: body.password_hash,
            role: body.role || "attendee",
          },
        ]),
      });
      return json({ ok: true, user_id: rows?.[0]?.id ?? null });
    }

    if (body.action === "sync_registration") {
      const email = encodeURIComponent(String(body.user_email).toLowerCase());
      const users = await supabaseFetch(`app_users?select=id&email=eq.${email}&limit=1`);
      const userId = users?.[0]?.id;
      if (!userId) return json({ error: "User not found" }, 404);

      const eventId = Number(body.event_id);
      const existing = await supabaseFetch(
        `registrations?select=id&event_id=eq.${eventId}&user_id=eq.${userId}&status=eq.active&limit=1`,
      );
      if (existing?.[0]?.id) return json({ ok: true, registration_id: existing[0].id, existing: true });

      const rows = await supabaseFetch("registrations", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify([{ event_id: eventId, user_id: userId, status: body.status || "active" }]),
      });
      return json({ ok: true, registration_id: rows?.[0]?.id ?? null });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
