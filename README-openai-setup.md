# Hydra — OpenAI brain + SaaS-ready architecture

This adds a real orchestration backend behind the existing Mission Builder UI, without changing the UI itself, and without adding accounts or billing. It's structured so those can be added later without touching the core mission-generation logic.

## Current state (read this first)

**No authentication exists anywhere in this project today.** There is no login flow, no session/JWT handling, and no account concept — the only backend-adjacent thing in the original `index.html` was an anonymous Supabase insert of raw mission text. Nothing here changes that; it only adds the seams so real accounts can be layered in later without a rewrite. If that's wrong — if there's an auth system elsewhere I didn't see — tell me before I build anything auth-shaped on top of this.

## Pipeline

Each request to `/api/generate-mission` (and `/api/refine`) flows through this exact order, matching the target architecture:

```
FRONTEND
  ↓
api/lib/request-context.js   — AUTH / USER CONTEXT        (today: always anonymous)
  ↓
api/lib/entitlements.js      — ENTITLEMENT / USAGE CHECK  (today: always allowed)
  ↓
api/lib/orchestrator.js      — OPENAI ORCHESTRATION
  ↓
api/tool-registry.json       — TOOL REGISTRY
  ↓
(workflow JSON)
  ↓
api/lib/mission-store.js     — SHAPE + SAVE MISSION       (today: shaped, not persisted)
  ↓
RENDER NODES (index.html, unchanged)
```

`api/generate-mission.js` and `api/refine.js` are thin — they just call these in order and turn the result into an HTTP response. Each stage is its own file so one can be upgraded without touching the others:

- **`api/lib/request-context.js`** — `getRequestContext(req)` → `{ userId, isAuthenticated, plan }`. This is the *only* file that should change when real auth is added: verify a session/JWT here, set `userId` from the verified identity, and every downstream file (rate limiting, entitlements, mission records) already keys off it. It deliberately never trusts a client-supplied user id — a request can't claim to be someone else's account today, and won't be able to once accounts exist either, unless this file itself verifies it.
- **`api/lib/entitlements.js`** — `checkEntitlement(context, action)` → `{ allowed, plan, reason, limit }`. Separate from orchestration on purpose: plans, credits, and Stripe all plug in here later, and `orchestrator.js` never needs to know a plan system exists. `FREE_LIMITS` already names the two metered actions (`generate_mission`, `refine_step`) — refinement was in your list of candidate paid-only features, so gating it later is a one-line change in this file.
- **`api/lib/orchestrator.js`** — `generateMissionPlan(...)` / `refineStepPrompt(...)`. The actual OpenAI calls, schema, and registry-validation. Pure functions: no `req`/`res`, no auth, no persistence. This is "the brain" in isolation — callable from a future authenticated route, a batch job, or a CLI without change.
- **`api/lib/mission-store.js`** — `buildMissionRecord(...)` defines the exact row shape a `missions` table should have (`user_id, idea, type, level, budget, title, tags, steps, output, model, created_at`). `saveMission(record)` is a no-op today (returns `{id, saved:false}`) and `getMissionHistory(context)` returns `[]` — both are marked `TODO(persistence)` for whenever a database is wired up (Supabase is already in this project's stack, so it's the natural fit).
- **`api/tool-registry.json`** — unchanged from the first pass; still the only source of truth the model is constrained to.

The JSON response from `/api/generate-mission` already includes `mission_id`, `saved: false`, and `plan: 'anonymous'` — fields the frontend doesn't use yet, but that a future "sign in to save this mission" UI can read without any backend change on that day.

## What was deliberately NOT built in this pass

Per your instructions: no login/signup UI, no Stripe, no database writes, no usage-limit enforcement beyond the existing soft rate limiter, no account dashboard. Everything above is an empty, clearly-marked seam — implementing any one of them touches exactly one file and doesn't require reworking the OpenAI integration.

## Adding each future piece later (pointers, not built yet)

- **Auth**: implement real verification in `request-context.js` (e.g. Supabase Auth — verify the session cookie or `Authorization` header server-side).
- **Usage limits / free vs paid**: implement real plan + usage lookups in `entitlements.js`.
- **Saved missions / history**: implement `saveMission`/`getMissionHistory` in `mission-store.js` against a real table, then add new endpoints (e.g. `GET /api/missions`, `GET /api/missions/:id`) that call them — `generate-mission.js` doesn't need to change.
- **Stripe / billing**: new `api/billing/*` endpoints + webhook, feeding a plan value into `entitlements.js` only.
- **Account dashboard**: a new frontend view reading from the missions endpoints above once they exist.

## Bug found & fixed while verifying the production flow

Automated end-to-end testing (below) surfaced one real, pre-existing bug: `runHydra()` (the "Ask Hydra" box) called `await saveHydraMission(rawValue)` with no error handling. If that Supabase call fails for *any* reason — a blocked CDN, a bad key, a network blip, an ad-blocker — the `await` throws, and every line after it in `runHydra()`, including the mission-generation call, never runs. Ask Hydra would look completely dead with no visible error. Fixed by wrapping that call in try/catch (mission logging is now best-effort and never blocks mission generation) and downgrading its failure log from `console.error` to `console.warn` since it's non-fatal. This is the only behavior change beyond the OpenAI wiring itself.

## Files to deploy

Everything except `test/` (local verification tooling only — never deploy it; a `.vercelignore` is included that excludes it automatically):

```
index.html
package.json
api/tool-registry.json
api/_shared.js
api/generate-mission.js
api/refine.js
api/lib/request-context.js
api/lib/entitlements.js
api/lib/orchestrator.js
api/lib/mission-store.js
```

## Environment variables to add in Vercel

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | **Yes** | — | From platform.openai.com. Set this in Vercel's dashboard only — never in `index.html` or any file that ships to the browser. |
| `OPENAI_MISSION_MODEL` | No | `gpt-5.6-luna` | Model used by `/api/generate-mission`. |
| `OPENAI_REFINE_MODEL` | No | `gpt-5.6-luna` | Model used by `/api/refine`. |

## Commands / actions to deploy

**Dashboard path:**
1. Push this folder to a GitHub repo.
2. Vercel dashboard → Add New → Project → import that repo. No framework preset needed — Vercel auto-detects the static `index.html` plus the `/api` folder as serverless functions.
3. Settings → Environment Variables → add `OPENAI_API_KEY` (and optionally the two model overrides) for the Production environment.
4. Deploy. If you added the env var *after* the first deploy, hit Redeploy so it picks it up.

**CLI path (equivalent):**
```bash
npm i -g vercel        # if you don't already have it
cd hydra-compass        # this folder
vercel login
vercel env add OPENAI_API_KEY production   # paste your key when prompted
vercel --prod
```
`CONFIG.API_BASE` in `index.html` stays `''` either way, since the API routes live on the same domain as the static site.

## Cost control

- Both endpoints default to `gpt-5.6-luna`.
- Idea/prompt text is length-capped server-side before it's sent to OpenAI.
- A basic per-IP rate limiter is included (12 mission generations/hour, 30 refines/hour), keyed by `context.userId` once that's non-null. It's in-memory, so it resets on cold start and isn't shared across serverless instances — a speed bump, not a hard guarantee. For real usage limits, this should become the durable, plan-aware check in `entitlements.js`, backed by a real store (Vercel KV / Upstash / your database).

## What was already verified before you deploy

`test/e2e-test.js` drives a real headless browser against the real `index.html` and the real `api/*.js` handlers — the only thing mocked is the outbound call to `api.openai.com` (no real key needed for this part). It proved, with 51 passing checks: the idea/type/expertise/budget fields all reach `/api/generate-mission` correctly; the server validates every `tool_id` against the registry and rejects a hallucinated one (502, no bad data reaches the browser); a valid structured response renders the exact right number of dynamic nodes with the right tool names; Ask Hydra hits the same endpoint and renders from the same response; the exec panel's "AI Refine" button calls `/api/refine` and updates the prompt text live; and both a rejected-tool-id response and a simulated OpenAI outage fall back cleanly to the original static workflow with no JS errors and the Generate button re-enabled afterward. `test/smoke-test.js` separately checks the backend pipeline's edge cases (missing input, no API key, upstream error) in isolation — 12 more passing checks. Run either with `node test/smoke-test.js` / `node test/e2e-test.js` (the latter needs `playwright` installed and a Chromium binary — see its header comment).

What this can't prove without your real key: that OpenAI itself returns good orchestration for real prompts. That's what the 5 missions below are for.

## Running 5 realistic test missions after deployment (against the real OpenAI API)

These are the same 5 idea/type/expertise/budget combinations already proven to flow correctly end-to-end above — now point them at your live deployment to confirm OpenAI itself produces sensible, registry-grounded plans.

**Fastest way — the UI itself:** open your deployed URL and for each row below, type the idea into the mission input, click the matching Type, Expertise, and Budget buttons, then click Generate Path. Check: the right number of nodes appear (not always the same count), each node names a real tool with a real reason ("why this tool"), the prompt in each node's exec panel is genuinely usable, and a free-budget mission favors free-tier tools while a pro-budget one doesn't have to.

| # | Idea | Type | Expertise | Budget |
|---|---|---|---|---|
| 1 | A 30-second cinematic trailer for my fantasy book | Video | Explorer | Free |
| 2 | Automate my weekly expense report from Gmail receipts | Automate | Builder | Startup |
| 3 | Launch a micro-SaaS billing reminder tool for freelancers | Business | Architect | Professional |
| 4 | Start a true crime storytelling podcast | Audio | Explorer | Free |
| 5 | Build and deploy a personal finance tracker web app | Coding | Architect | Professional |

**Scriptable way — curl directly against the API**, replacing `YOUR-DEPLOYMENT` with your actual Vercel domain:

```bash
BASE="https://YOUR-DEPLOYMENT.vercel.app"

curl -s -X POST "$BASE/api/generate-mission" -H "Content-Type: application/json" -d '{
  "idea":"A 30-second cinematic trailer for my fantasy book","type":"content","level":"explorer","budget":"free"
}' | python3 -m json.tool

curl -s -X POST "$BASE/api/generate-mission" -H "Content-Type: application/json" -d '{
  "idea":"Automate my weekly expense report from Gmail receipts","type":"auto","level":"builder","budget":"startup"
}' | python3 -m json.tool

curl -s -X POST "$BASE/api/generate-mission" -H "Content-Type: application/json" -d '{
  "idea":"Launch a micro-SaaS billing reminder tool for freelancers","type":"business","level":"architect","budget":"pro"
}' | python3 -m json.tool

curl -s -X POST "$BASE/api/generate-mission" -H "Content-Type: application/json" -d '{
  "idea":"Start a true crime storytelling podcast","type":"audio","level":"explorer","budget":"free"
}' | python3 -m json.tool

curl -s -X POST "$BASE/api/generate-mission" -H "Content-Type: application/json" -d '{
  "idea":"Build and deploy a personal finance tracker web app","type":"coding","level":"architect","budget":"pro"
}' | python3 -m json.tool
```

For each response, check: `steps` is a JSON array (not an error object), every `tool_id`/`tool_name` in it is a real tool you recognize from `api/tool-registry.json`, `output.items` describes a coherent final deliverable, and the step count differs sensibly between the simple podcast/trailer missions and the more involved SaaS/app-build ones rather than always being the same number.

If any of the 5 comes back as an error instead of a mission: `{"error":"server_not_configured"}` means `OPENAI_API_KEY` isn't set in Vercel; `{"error":"upstream_error", ...}` means OpenAI itself rejected the request (the `message` field says why — often a billing/quota issue on the OpenAI account); `{"error":"unknown_tool_id", ...}` would mean the model referenced a tool outside the registry and was correctly blocked — if you see this often in practice, it's a signal to broaden `tool-registry.json`, not a bug in the orchestration code.

## Known pre-existing item (not part of this pass)

`index.html` has a Supabase client with a hardcoded project URL and publishable key (used only to log raw mission text). That key is meant to be public, but it's only safe if the `Missions` table's Row Level Security policies are locked down (insert-only, no public select/update/delete) — worth checking in the Supabase dashboard since the key is visible to anyone who views the page source. If you do build real accounts on Supabase Auth later, this same project is a natural home for the `missions`/`usage` tables too.
