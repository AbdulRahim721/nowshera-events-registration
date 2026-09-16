# Live Deployment

Public website:
https://nowshera-events-registration.sahibqazi285.chatgpt.site/

This Sites deployment is server-backed. The live worker handles `/api/*` requests and calls the Supabase Edge Function from server-side environment variables, so the private sync key is not exposed in frontend JavaScript.

Runtime variables configured in Sites:
- `SUPABASE_SYNC_FUNCTION_URL`
- `SUPABASE_SYNC_KEY` (secret)

Build the worker locally with:

```bash
node scripts/build_worker.mjs
```

The generated worker is written to `dist/server/index.js` for Sites packaging.
