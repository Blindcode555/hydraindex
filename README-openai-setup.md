# Hydra — OpenAI brain + Supabase accounts

This adds a real orchestration backend behind the existing Mission Builder UI (OpenAI-powered mission generation, unchanged UI) plus a real, Supabase-backed account layer on top of it (sign up, log in, save a project, resume it later). Stripe, external provider APIs, and any redesign of the interface are still explicitly out of scope for this pass.

## Current state (read this first)

**Real accounts now exist, via Supabase Auth — but they're optional.** Anonymous mission generation still works exactly as before; signing in is required only to save a project or see "My Projects." This was a deliberate product decision (not a limitation): Hydra stays a zero-friction generator for anyone, and an account is the upgrade path for people who want their work to persist.

Two authentication methods were explicitly **not** built: magic-link sign-in (password-only, by request) and any Stripe/billing surface (still a future seam, not implemented). See [Accounts, projects & Supabase](#accounts-projects--supabase) below for the full shape of what was added, and [Setting up Supabase](#setting-up-supabase-step-by-step) for the one-time project setup a deployer needs to do.

## Pipeline

Each request to `/api/generate-mission` (and `/api/refine`) flows through this exact order, matching the target architecture:

```
FRONTEND
  ↓
api/lib/request-context.js   — AUTH / USER CONTEXT        (verifies a Supabase session if one is presented; anonymous otherwise)
  ↓
api/lib/entitlements.js      — ENTITLEMENT / USAGE CHECK  (still: always allowed — plans/credits are read, not yet enforced)
  ↓
api/lib/orchestrator.js      — OPENAI ORCHESTRATION       (unchanged — still the Luna models, unchanged prompt)
  ↓
api/tool-registry.json       — TOOL REGISTRY               (unchanged)
  ↓
(workflow JSON)
  ↓
api/lib/mission-store.js     — SHAPE + SAVE MISSION       (per-generation record: still shaped, not persisted)
                              — PROJECTS / RESUME          (new: real Supabase reads/writes, only for signed-in requests)
  ↓
RENDER NODES (index.html, unchanged mission UI + new Hydra Workspace panel)
```

`api/generate-mission.js` and `api/refine.js` are thin — they just call these in order and turn the result into an HTTP response. Each stage is its own file so one can be upgraded without touching the others:

- **`api/lib/request-context.js`** — `getRequestContext(req)` → `{ userId, isAuthenticated, plan, accessToken }`. Now does what the original version was scaffolded for: reads the `Authorization: Bearer <token>` header, verifies it against Supabase Auth (`GET /auth/v1/user`), and — if valid — looks up that user's plan from `profiles`. No token, an invalid token, or Supabase not configured all resolve to the same anonymous context as before. It still never trusts a client-supplied user id; the only identity that reaches downstream code is one Supabase itself verified.
- **`api/lib/entitlements.js`** — unchanged this pass. `checkEntitlement(context, action)` → `{ allowed, plan, reason, limit }` still always allows; `context.plan` is now a real value (`'anonymous' | 'free' | ...`) instead of always `'anonymous'`, so real plan-based gating later is still a one-line change here, not a rewrite.
- **`api/lib/orchestrator.js`** — untouched. Same Luna models (`OPENAI_MISSION_MODEL` / `OPENAI_REFINE_MODEL`), same schema, same registry-validation, same system prompt.
- **`api/lib/mission-store.js`** — `buildMissionRecord`/`saveMission`/`getMissionHistory` (the per-generation, works-for-everyone path) are **unchanged and still no-ops** — generating a mission still never requires an account. New alongside them: `getProfile`, `listProjects`, `createProject`, `getProjectWithLatestMission`, `updateProjectProgress` — real Supabase reads/writes, used only by the new `/api/projects` endpoints, and only after `request-context.js` has confirmed `context.isAuthenticated`.
- **`api/lib/supabase-server.js`** — new. A small, dependency-free wrapper around Supabase's HTTP APIs (`fetch` directly to `/auth/v1/user` and `/rest/v1/<table>`) — no `@supabase/supabase-js` on the server, so no new npm dependency and nothing to bundle. It never uses a service-role key: every request is made with either the caller's own verified access token or the public anon key, so Postgres Row Level Security (`supabase/schema.sql`) is what actually enforces per-user isolation, exactly as required.
- **`api/tool-registry.json`** — unchanged.

The JSON response from `/api/generate-mission` still includes `mission_id`, `saved: false`, and `plan` (now `'anonymous'` or the caller's real plan) — the frontend's Hydra Workspace panel is the first thing reading `plan` (and a Supabase-derived credit balance) for a signed-in user.

## What was deliberately NOT built in this pass

Per your instructions: no Stripe, no external provider APIs beyond OpenAI + Supabase, no change to the Luna orchestration (models, prompt, or tool registry), no redesign of the existing interface, and no magic-link auth (password-only, by request). Usage-limit *enforcement* is still the soft in-memory rate limiter from the first pass — `entitlements.js` reads a real plan now but doesn't yet act on it differently per plan. Everything above and in the next section is a clearly-marked seam: adding Stripe or plan-based limits later touches `entitlements.js` and a new `api/billing/*`, not the orchestration or the accounts layer.

## Adding each future piece later (pointers, not built yet)

- **Usage limits / free vs paid**: implement real plan-aware limits in `entitlements.js` — `context.plan` is already populated from Supabase.
- **Stripe / billing**: new `api/billing/*` endpoints + webhook, feeding a plan value into `profiles.plan` (and from there into `entitlements.js`) only.
- **Richer account dashboard**: the current Hydra Workspace panel is intentionally minimal (per your instruction not to build a Notion clone yet); a fuller dashboard reads from the same `/api/projects` endpoints already in place.
- **Magic-link / OAuth sign-in**: `handleSignUp`/`handleLogIn` in `index.html` and the Supabase Auth settings would both need extending; today only email+password is wired up.

## Accounts, projects & Supabase

**Tables** (`supabase/schema.sql` creates all of this — see the next section for how to run it):

- **`profiles`** — one row per user (`id` = `auth.users.id`), `email`, `display_name`, `plan` (defaults `'free'`), `hydra_credit_balance` (defaults `0`). Created automatically by a `handle_new_user` trigger the moment someone signs up — the API never has to special-case "no profile yet."
- **`projects`** — a saved mission workspace: `user_id`, `title`, `original_idea`, `type`, `expertise`, `budget`, `status`, `current_node`. One row per "Save Project."
- **`missions`** — the generated workflow JSON snapshot for a project (`project_id`, `workflow_json`). Kept separate from `projects` so a project's saved plan is a distinct, queryable blob rather than a column crammed onto the project row.

**Security**: Row Level Security is enabled on all three tables, with policies scoping every read/write to `auth.uid()` (via a join through `projects` for the `missions` table, since ownership there is indirect). This is not optional and not a formality — the browser only ever holds the public/anon key, so RLS is the *only* thing stopping one user from reading or writing another user's data. Nothing in this codebase uses a service-role key, and nothing should be added that does. The OpenAI key stays server-only exactly as before; the anon key is the one credential the browser has, and it's meant to be public — Supabase's own docs are explicit that the anon key is safe to ship to a browser as long as RLS is correctly configured, which `schema.sql` does.

**Endpoints** (all in `api/`, following the same thin-handler pattern as `generate-mission.js`):

- `GET /api/projects` → `{ profile, projects }` for the signed-in caller. 401 if not authenticated.
- `POST /api/projects` → `{ idea, type, level, budget, mission }` creates a project + its first mission snapshot. This is the explicit "Save Project" action — a separate step from generating the mission, matching the required flow.
- `GET /api/projects/:id` → `{ project, mission }`, everything "Resume" needs to redraw the node timeline and jump to the right step.
- `PATCH /api/projects/:id` → `{ current_node?, status? }`, the explicit "Save Current Progress" action, fired automatically as the user moves through the workflow nodes.

**Frontend** — a new "Hydra Workspace" section (own nav item, reuses the existing card/button/input classes — no new visual language introduced): a sign up / log in form when signed out; when signed in, the user's email, plan, and Hydra credit balance, a "My Projects" list (name, last updated, current node, a Resume button per project), a Save Project button that appears once a mission has been generated, and Log Out / New Mission actions. `authFetch()` is a thin wrapper that attaches the signed-in user's token to a request when one exists and behaves exactly like a plain `fetch()` otherwise — anonymous mission generation is completely unaffected by any of this.

**Auth method**: email + password only, no magic link. Supabase's own hosted Auth handles signup/login/logout/session refresh — `index.html` calls `supabase.auth.signUp/signInWithPassword/signOut/getSession/onAuthStateChange` directly; nothing about that flow goes through Hydra's own backend, so there's no server-side auth code to review beyond *verifying* the resulting token in `request-context.js`.

## Setting up Supabase (step by step)

Do this once per environment (a single project is fine for a first production launch):

1. **Create the project** at supabase.com if you haven't already, and open its SQL Editor.
2. **Run `supabase/schema.sql`** there in full. It's idempotent (`create table if not exists`, `drop policy if exists` before each `create policy`) so re-running it later is safe.
3. **Require email confirmation**: Authentication → Providers → Email → make sure "Confirm email" is ON. This is what makes `handleSignUp()`'s two outcomes correct — no confirmation required yet shows "Check your email to confirm your account, then log in," which is the flow you asked for (sign up and log in as distinct steps, not auto-login).
4. **Turn off magic link** (or simply don't expose it) — this project only calls `signInWithPassword`, but Authentication → Providers → Email lets you disable "Magic Link" outright if you want it unreachable even via the Supabase-hosted API.
5. **Site URL and Redirect URLs** (Authentication → URL Configuration): set the Site URL to `https://hydracompass.com` and add `https://hydracompass.com/*` (and your Vercel preview domain, if you want confirmation links to work from preview deploys too) to the Redirect URLs allow-list. A confirmation or password-reset email links back to whatever URL is configured here — get this wrong and users land on an error page after clicking a real, valid link.
6. **Custom SMTP (Resend)** — required before real users sign up. Supabase's built-in email sender is low-volume, unbranded, and not meant for production traffic; it will not deliver reliably at any real signup volume. In Resend: verify the `hydracompass.com` domain (Resend gives you SPF and DKIM DNS records to add — add both, and add a DMARC record too, e.g. `v=DMARC1; p=quarantine; rua=mailto:dmarc@hydracompass.com`, since Gmail/Yahoo now require it for bulk senders), then create an API key. In Supabase: Authentication → Settings → SMTP Settings → enable custom SMTP with:
   - Host: `smtp.resend.com`
   - Port: `465` (SSL) or `587` (STARTTLS) — either works
   - Username: `resend`
   - Password: your Resend API key
   - Sender email: `no-reply@hydracompass.com`
   - Sender name: `Hydra Compass`

   This one setting covers every transactional email Supabase Auth sends — signup confirmation and password reset today; email-change and other security notices too, the moment any of those flows gets exercised (they use the same SMTP config, no extra setup). Magic-link email is templated but irrelevant here since that sign-in method isn't exposed. You can customize the actual email copy/branding under Authentication → Email Templates, still delivered through the same Resend connection.
7. **Get your credentials**: Settings → API gives you the Project URL and the `anon`/`public` key. Use exactly these two for the Vercel env vars below — never the `service_role` key, which must never leave the Supabase dashboard.
8. **Point the frontend at your project**: `index.html`'s Supabase client is a hardcoded client-side constant (there's no build step to inject an env var into a static HTML file), near the bottom of the file:
   ```js
   const HYDRA_SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
   const HYDRA_SUPABASE_KEY = "YOUR-ANON-PUBLIC-KEY";
   ```
   Replace both with your real project's values before deploying — this is the one manual edit required outside of environment variables, and it's the same anon key from step 7, safe to embed because RLS is what actually protects the data behind it.

## Bug found & fixed while verifying the production flow

Automated end-to-end testing (below) surfaced one real, pre-existing bug: `runHydra()` (the "Ask Hydra" box) called `await saveHydraMission(rawValue)` with no error handling. If that Supabase call fails for *any* reason — a blocked CDN, a bad key, a network blip, an ad-blocker — the `await` throws, and every line after it in `runHydra()`, including the mission-generation call, never runs. Ask Hydra would look completely dead with no visible error. Fixed by wrapping that call in try/catch (mission logging is now best-effort and never blocks mission generation) and downgrading its failure log from `console.error` to `console.warn` since it's non-fatal. This is the only behavior change beyond the OpenAI wiring itself.

## Files to deploy

Everything except `test/` (local verification tooling only — never deploy it; a `.vercelignore` is included that excludes it automatically) and `supabase/schema.sql` (that's run once against your Supabase project's SQL editor — see above — not deployed to Vercel; `.vercelignore` excludes the `supabase/` folder too):

```
index.html
package.json
api/tool-registry.json
api/_shared.js
api/generate-mission.js
api/refine.js
api/projects.js
api/projects/[id].js
api/lib/request-context.js
api/lib/entitlements.js
api/lib/orchestrator.js
api/lib/mission-store.js
api/lib/supabase-server.js
```

## Environment variables to add in Vercel

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | **Yes** | — | From platform.openai.com. Set this in Vercel's dashboard only — never in `index.html` or any file that ships to the browser. |
| `OPENAI_MISSION_MODEL` | No | `gpt-5.6-luna` | Model used by `/api/generate-mission`. |
| `OPENAI_REFINE_MODEL` | No | `gpt-5.6-luna` | Model used by `/api/refine`. |
| `SUPABASE_URL` | For accounts to work | — | Your project's URL from Supabase Settings → API. Without this, `/api/projects*` return 401/500 and the server always treats requests as anonymous — mission generation itself is unaffected. |
| `SUPABASE_ANON_KEY` | For accounts to work | — | The `anon`/`public` key from the same page. **Never** the `service_role` key — the server never needs it and must never hold it. |

## Commands / actions to deploy

**Dashboard path:**
1. Complete the Supabase setup above (schema, SMTP, redirect URLs) and update the two hardcoded `HYDRA_SUPABASE_URL`/`HYDRA_SUPABASE_KEY` constants in `index.html`.
2. Push this folder to a GitHub repo.
3. Vercel dashboard → Add New → Project → import that repo. No framework preset needed — Vercel auto-detects the static `index.html` plus the `/api` folder as serverless functions.
4. Settings → Environment Variables → add `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` (and optionally the two model overrides) for the Production environment.
5. Deploy. If you added an env var *after* the first deploy, hit Redeploy so it picks it up.

**CLI path (equivalent):**
```bash
npm i -g vercel        # if you don't already have it
cd hydra-compass        # this folder
vercel login
vercel env add OPENAI_API_KEY production      # paste your key when prompted
vercel env add SUPABASE_URL production        # your project URL
vercel env add SUPABASE_ANON_KEY production   # the anon/public key — never service_role
vercel --prod
```
`CONFIG.API_BASE` in `index.html` stays `''` either way, since the API routes live on the same domain as the static site.

## Cost control

- Both endpoints default to `gpt-5.6-luna`.
- Idea/prompt text is length-capped server-side before it's sent to OpenAI.
- A basic per-IP rate limiter is included (12 mission generations/hour, 30 refines/hour), keyed by `context.userId` once that's non-null. It's in-memory, so it resets on cold start and isn't shared across serverless instances — a speed bump, not a hard guarantee. For real usage limits, this should become the durable, plan-aware check in `entitlements.js`, backed by a real store (Vercel KV / Upstash / your database).

## What was already verified before you deploy

`test/e2e-test.js` drives a real headless browser against the real `index.html` and the real `api/*.js` handlers — the only things mocked are the outbound call to `api.openai.com` and a stand-in Supabase (see below); no real API keys or live Supabase project are needed to run it. It's now up to 63 passing checks, including the original mission-generation coverage plus the full required account flow driven through the real UI: sign up → new profile defaults to the free plan → generate a mission → save it as a project → advance a node (which PATCHes saved progress) → log out → log back in → the project is still there → resume it → the saved node position comes back correctly — and a separate check that an anonymous visitor can still generate a mission end-to-end and never even sees the Save Project button. `test/smoke-test.js` separately checks the backend pipeline's edge cases in isolation (missing input, no API key, upstream error, plus the new `/api/projects` and `/api/projects/:id` handlers — auth gating, save, list, resume, patch) — 20 passing checks. Run either with `node test/smoke-test.js` / `node test/e2e-test.js` (the latter needs `playwright` installed and a Chromium binary — see its header comment).

**How Supabase is tested without a live project**: `test/supabase-mock.js` is a small in-memory stand-in for Supabase Auth and PostgREST, served by `test/dev-server.js` at the same local origin. On the server side, `api/lib/supabase-server.js`'s real `fetch()` calls hit it directly. On the browser side, `test/supabase-stub.js` replaces the real `@supabase/supabase-js` CDN script (swapped in only when `dev-server.js` serves `index.html` locally — the actual deployed file always loads the real library) with a lookalike client backed by real same-origin HTTP calls to that same mock. Nothing about `index.html`'s real code path changes between test and production; only the far end (an actual Supabase project) is faked, the same way `api.openai.com` is faked for OpenAI.

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

The original "Ask Hydra" widget's mission-log write (`saveHydraMission`, near the bottom of `index.html`) inserts raw idea text into a `Missions` table (capital M) — separate from, and unrelated to, the new `profiles`/`projects`/`missions` (lowercase) tables this pass adds. It was already in the project before this work and is out of scope to change, but it's worth pointing out explicitly now that real tables exist alongside it: `Missions` has no RLS-scoped ownership (it was never tied to a user), so its own Row Level Security policies should still be checked in the Supabase dashboard (insert-only, no public select/update/delete) independently of `schema.sql`, which does not touch that table at all. If you'd rather retire it in favor of the real `projects`/`missions` tables, that's a small, separate follow-up — not needed for anything in this pass to work.
