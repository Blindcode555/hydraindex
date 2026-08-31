# Hydra — OpenAI brain + Supabase accounts + Ask Hydra + Workspace

This adds a real orchestration backend behind the existing Mission Builder UI (OpenAI-powered mission generation, unchanged UI) plus a real, Supabase-backed account layer on top of it (sign up, log in, save a project, resume it later), a nested sidebar directory of a signed-in user's saved projects, a dedicated Ask Hydra product assistant with its own endpoint, and a dedicated `/workspace` view. Stripe, external provider execution APIs, and any redesign of the interface are still explicitly out of scope.

## Current state (read this first)

**Real accounts now exist, via Supabase Auth — but they're optional.** Anonymous mission generation still works exactly as before; signing in is required only to save a project or see "My Projects." This was a deliberate product decision (not a limitation): Hydra stays a zero-friction generator for anyone, and an account is the upgrade path for people who want their work to persist.

Two authentication methods were explicitly **not** built: magic-link sign-in (password-only, by request) and any Stripe/billing surface (still a future seam, not implemented). See [Accounts, projects & Supabase](#accounts-projects--supabase) below for the full shape of what was added, and [Setting up Supabase](#setting-up-supabase-step-by-step) for the one-time project setup a deployer needs to do.

**Since then, three more things were added, none of which touch the above:** a nested `PROJECTS (N)` directory in the sidebar (all of a signed-in user's saved projects, not just the active one — see [Nested Projects Directory](#nested-projects-directory-sidebar)); Ask Hydra turned from a thin re-skin of Mission Orchestrator into its own scoped product assistant with its own endpoint (see [Ask Hydra](#ask-hydra-a-dedicated-product-assistant)); and a dedicated `/workspace` view that opens in its own tab (see [Dedicated Workspace view](#dedicated-workspace-view-workspace)). Luna orchestration, AI Refine, Supabase persistence/RLS, and the account flow above are all unchanged by this.

**Most recently, `/workspace` grew a real visual project workspace.** Opening a project there now shows its header (title, goal, type, last updated, progress, current node) and its saved workflow as an ordered stack of node cards (number, title, tool, description, COMPLETE/CURRENT/UPCOMING status), with Open Node / Resume in Mission Console actions — see [The visual project workspace](#the-visual-project-workspace-project--workflow--node--tool) below. It's still the same page, same route, same session mechanism; nothing above changed.

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

Ask Hydra is a **sibling** to this pipeline, not a step inside it — it has its own endpoint, its own system prompt, and its own context builder, and never calls or is called by Mission Orchestrator or AI Refine:

```
Luna / OpenAI backend
├── Mission Orchestrator   (api/generate-mission.js + api/lib/orchestrator.js)   — unchanged
├── AI Refine              (api/refine.js + api/lib/orchestrator.js)            — unchanged
└── Ask Hydra              (api/ask-hydra.js + api/lib/ask-hydra.js)            — new, its own endpoint
```

All three share the same `OPENAI_API_KEY`, the same `getRequestContext()` auth resolution, and the same tool registry (`api/_shared.js`'s `getRegistrySummaryForPrompt()` — Ask Hydra reuses this exact function rather than keeping a second catalog). See [Ask Hydra](#ask-hydra-a-dedicated-product-assistant) below for the full shape.

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

**Frontend** — a "Hydra Workspace" section (own nav item, reuses the existing card/button/input classes — no new visual language introduced): sign up / log in / forgot-password when signed out; when signed in, the user's email, plan, and Hydra credit balance, a "My Projects" list (name, last updated, current node, a Resume button per project), a Save Project button that appears once a mission has been generated, and Log Out / New Mission actions. Since this pass, the same auth/project state also drives a compact always-visible status in the sidebar — see [Global user & project status](#global-user--project-status-sidebar) below — so a user never has to open Workspace just to see who's signed in or what they're working on. `authFetch()` is a thin wrapper that attaches the signed-in user's token to a request when one exists and behaves exactly like a plain `fetch()` otherwise — anonymous mission generation is completely unaffected by any of this.

**Auth method**: email + password only, no magic link. Supabase's own hosted Auth handles signup/login/logout/session refresh/password recovery — `index.html` calls `supabase.auth.signUp/signInWithPassword/signOut/getSession/onAuthStateChange/resetPasswordForEmail/updateUser` directly; nothing about that flow goes through Hydra's own backend, so there's no server-side auth code to review beyond *verifying* the resulting token in `request-context.js`.

## Password recovery

"Forgot password?" on the login form starts the standard Supabase recovery flow, entirely client-side:

1. The user enters their email and Hydra calls `resetPasswordForEmail(email, { redirectTo: <this same page> })`. The UI shows the same message either way — *"If an account exists for that email, we've sent a password reset link"* — regardless of whether that email actually has an account. This is deliberate: nothing in the response should let a visitor learn which emails are registered.
2. Supabase emails the link through the same custom SMTP (Resend) connection configured above — no second email provider, no separate template system.
3. Clicking it returns the user to `hydracompass.com` (the Site URL/Redirect URL configured in Setting up Supabase) with a recovery session Supabase's own client parses automatically, firing a `PASSWORD_RECOVERY` auth event that `index.html` already listens for.
4. Hydra shows a "Set New Password" form instead of treating this as a normal sign-in — a `PASSWORD_RECOVERY` session is real but shouldn't silently log someone in.
5. On submit, `updateUser({ password })` sets the new password, the temporary recovery session is signed out, and the user lands back on a normal login screen with "Password updated — please log in." — matching sign-up-then-login as two distinct, deliberate steps rather than an invisible auto-login.
6. An expired or already-used link redirects back with an error instead of a session; Hydra detects that and shows an explicit "This password reset link is invalid or has expired" state with a way back to the login form, rather than a broken or confusing screen.

No new table, no new backend endpoint — Supabase Auth owns password storage and the recovery email entirely; this is UI plus already-existing Auth calls.

## Global user status (sidebar)

The sidebar footer's user pill (`.sidebar-footer .user-pill` — this element already existed, previously hardcoded to "Explorer" / "Free · Active" and wired to nothing) shows the signed-in user's display name if one is ever collected (no sign-up field for it exists yet, so this currently always falls through to email) or "Guest" with "Sign In / Create Account" when signed out, and plan + Hydra credit balance when signed in (`Free · 0 Hydra Credits`). Clicking it opens the in-page Hydra Workspace section (sign in/up + account) — this is the one and only place a user signs in; the sidebar nav list's "Hydra Workspace" item instead opens the dedicated `/workspace` tab (see below), a deliberately different target. The user pill never shows a Supabase user id, access token, or any other technical identifier.

## Nested Projects Directory (sidebar)

Replaces the earlier single "Project / Progress" line with a persistent `PROJECTS (N)` tree of **all** of a signed-in user's saved projects, not just the active one — hidden entirely for anonymous visitors (there is no private project list to show them).

- The active project is always shown expanded, highlighted, and with a `Node X/Y` badge reflecting live state (`PIPE_LEVEL`/`PIPE_COUNT`/`PIPE_LABELS` — the exact same variables the Mission Console timeline uses).
- Every other saved project shows as a collapsed row. Clicking its **arrow** expands/collapses it; clicking its **name** resumes/loads it into Mission Console in the same tab (never a new tab) via the existing `resumeProject()` — no second project-state system.
- Expanding a project that isn't active lazily fetches its node titles via the same `GET /api/projects/:id` "Resume" already uses — never on initial page load, only on manual expand — and caches the result client-side (`PROJECT_NODE_CACHE`) so re-expanding never re-fetches.
- Clicking a specific **node** under any project loads that project first (if it isn't already active) and then jumps straight to that node.
- `+ New Project` clears the active project (same `startNewMission()` used elsewhere) without removing anything from the list. `View All Projects →` opens the dedicated Workspace in a new tab.
- Both the directory and the Workspace's "Recent Projects" card render from the exact same array (`ALL_PROJECTS`, populated once by `loadWorkspace()`'s existing `GET /api/projects` call) — there is one project list, not two.

## Ask Hydra: a dedicated product assistant

Ask Hydra used to just forward whatever was typed into it straight to `/api/generate-mission` as an "idea" — it was Mission Orchestrator wearing a different label, with no memory, no awareness of Hydra itself, and no way to answer a question like "how do I resume my project?" It now has its own endpoint, `POST /api/ask-hydra`, backed by `api/lib/ask-hydra.js` — a sibling to `orchestrator.js`, not a part of it, so Mission Orchestrator and AI Refine are completely unaffected.

**Scope.** Ask Hydra is explicitly not a general-purpose chatbot. Its system prompt (built fresh per request in `buildSystemPrompt()`) states what it may help with — Hydra navigation, the plan/Hydra Credits concept, saved projects, tool recommendations and combinations, and workflow planning — and instructs it to decline anything else with a redirect back toward a Hydra workflow, rather than answering as a generic assistant. It also carries an explicit **execution-truth rule**: Hydra recommends tools and gives prompts for using them; it does not execute any provider today, and Ask Hydra must never say or imply otherwise (a tool's own `api_available` flag means that tool has an API of its own, not that Hydra calls it).

**Context sent.** Always: a static Hydra product-knowledge block (`api/lib/hydra-knowledge.js` — a hand-maintained string, same pattern as `tool-registry.json`, no database table) and the exact same `getRegistrySummaryForPrompt()` tool-registry summary Mission Orchestrator already uses (reused, not duplicated). When authenticated: plan and Hydra Credits, always re-derived server-side from the verified `context.userId` via the existing `getProfile()` — never trusted from the client — plus, if supplied, minimal active-project display context (title, original idea, current node, node titles) that the browser already holds in memory and passes up in the request body; the server never re-fetches or re-authorizes a project for this. When anonymous: no project context is even accepted — `api/ask-hydra.js` ignores any `activeProject` the caller sends unless `context.isAuthenticated` is true.

**Conversation.** `ASK_HYDRA_HISTORY` is a plain in-memory array in `index.html`, forwarded on each request (capped server-side to the last 10 turns) so follow-up questions have context — and reset on page reload. No new database table, no long-term chat storage, per scope.

**Model.** Its own constant, `ASK_HYDRA_MODEL` (env: `OPENAI_ASK_HYDRA_MODEL`, default `gpt-5.6-luna-ask`) — independent of `OPENAI_MISSION_MODEL`/`OPENAI_REFINE_MODEL`, so it can be tuned without touching either.

**UI.** The existing Ask Hydra panel (same visual language — logo, arcade banner, input) now renders a real back-and-forth transcript (`#ask-hydra-transcript`) instead of a fake numbered step list, with example prompt chips ("How do I use Hydra for an audiobook?", "Which tools can I combine for a SaaS?", etc.) that fill the input for editing rather than sending immediately.

## Dedicated Workspace view (`/workspace`)

Hydra Workspace was previously only reachable by scrolling to a section inside the single-page Mission Console. `workspace.html` is a new, small, self-contained static page — same dark theme/palette, no shared build step needed — showing the signed-in user's plan, Hydra Credits, and their full project list (title, last updated, progress, current node, Resume), or an explicit "not signed in" state with a link back to the main page's sign-in form for anonymous visitors (no second login form — there is exactly one place to sign in, per [Global user status](#global-user-status-sidebar) above).

**Routing.** There's no framework and no client-side router in this app, so `/workspace` is served via a `vercel.json` rewrite (`/workspace` → `/workspace.html`) — the smallest mechanism that gives a clean public URL without inventing a routing system. The sidebar's "Hydra Workspace" nav item and the directory's "View All Projects" link are both plain `<a href="/workspace" target="_blank" rel="noopener">` — real link semantics, no `window.open()` popup.

**Session sharing.** Opening `/workspace` in a new tab picks up the existing signed-in session automatically, because that's what Supabase's own JS client already does by default (`persistSession: true`, stored in `localStorage`) — same-origin tabs share it. `workspace.html` fetches `/api/config` and calls `GET /api/projects` exactly like `index.html` does; there is no second session mechanism.

**Resume, from the list.** Clicking Resume on a project row is a plain link to `/?resume=<project-id>` — a real navigation back to the main page, which reads that query parameter once on load (after its own session check resolves), calls the existing `resumeProject()`, and strips the parameter from the URL. This keeps "resume in Mission Console" as the one true resume path, whether it's triggered from the sidebar directory or from the dedicated Workspace tab.

### The visual project workspace: PROJECT → WORKFLOW → NODE → TOOL

Clicking a project's *title* (rather than its Resume button) opens that project's own workspace view in place — a lightweight, Hydra-specific answer to "show me this project, visually," deliberately stopping well short of a Notion clone. It's built entirely from data the app already has: `GET /api/projects/:id` (the same endpoint the sidebar directory and Resume already use), rendered fresh every time a project is opened — nothing about a project's workflow, progress, or current node is tracked a second time or duplicated client-side.

**Project header.** Title, original goal/idea, project type (the same Video/Audio/Business/Coding/Automate labels used at generation time), last updated, and a progress bar all come straight off the `projects` row and its latest `missions.workflow_json` — current node's name specifically comes from `steps[current_node - 1]`, so it always names a real saved step, never a placeholder.

**Workflow view.** The saved mission's `steps` array is rendered as an ordered stack of node cards — node number, title, recommended tool(s), a short description, and a status of COMPLETE / CURRENT / UPCOMING computed by comparing each node's number against `projects.current_node` (COMPLETE if before it, CURRENT if equal, UPCOMING if after) — with a small "↓" connector between cards. None of this is hardcoded: a project with 3 steps shows 3 cards, one with 8 shows 8, and the labels/tools/descriptions are exactly what was saved in `workflow_json`.

**Actions, not duplication.** Each node card has an "Open Node" link (`/?resume=<id>&node=<n>`) and the header has a "Resume in Mission Console" link (`/?resume=<id>`) — both plain links, no popups. `index.html` already owned `/?resume=<id>` for Resume; this pass added one optional `&node=<n>` it also understands — if present, after resuming the project it calls the existing `setPipeLevel(n)` to jump straight to that exact node instead of wherever the project was last left. Opening a node or a project from `/workspace` always lands back in the one real Mission Console, never a second copy of it.

**Notes / Activity / Files.** The detail view is a tab strip — Workflow, Notes, Activity, Files — so those three have a home to grow into later without restructuring the page. Workflow is the only one built out this phase, per spec; Notes, Activity, and Files render as clearly-labeled "coming in a future update" placeholders rather than broken or missing tabs. Notes specifically was left as a placeholder rather than implemented: a real, synced version of it (something that shows the same notes from any device, not just the browser that typed them) needs a place to persist to, and there is no notes/free-text column on `projects` or `missions` today — adding one would mean an actual schema change, which this phase's constraints explicitly rule out. Nothing here reaches for a new database table or any drag/drop or block-based editing to fake that functionality in the meantime.

## Removed: fake sidebar statistics, and the UTC clock

The sidebar previously showed "Missions: 2,841" (an animated counter hardcoded to fake-count-up to a fixed target on every page load) and "Navigators: 1,204" (a static string with no logic behind it at all) — neither was backed by real data; both were removed in an earlier pass in favor of the Current Project line, which this pass replaced in turn with the [Nested Projects Directory](#nested-projects-directory-sidebar) above. The `UTC` clock beside them was a real, working clock but provided no product value — it's now removed outright, not replaced with another metric; that space is used by the nested directory or is left clean.

## Frontend configuration: `/api/config`

`index.html` no longer hardcodes a Supabase project URL or anon key. Previously it did — two `const` values near the bottom of the file — which meant every new code delivery either had to ship with real production values baked in (fragile: nothing stops a future edit from reverting them) or ship with placeholders that had to be manually re-pasted after every deploy.

Instead, `api/config.js` is a new, narrowly-scoped endpoint that returns exactly:
```json
{ "supabaseUrl": "...", "supabaseAnonKey": "...", "configured": true }
```
reading the same `SUPABASE_URL`/`SUPABASE_ANON_KEY` env vars already set in Vercel for the backend. `index.html` fetches this once on load and initializes the Supabase client from the response instead of a hardcoded value. Both values are meant to be public — this is Supabase's own public-key model, the same anon key that was already visible in the page source before this change — so this endpoint isn't hiding a secret, it's just moving where the two already-public values come from. **It must never be extended to return anything else** — no `OPENAI_API_KEY`, no Resend credentials, no `service_role` key, nothing beyond those three fields; `api/config.js`'s own header comment says so explicitly, and the regression tests (`config: response has ONLY supabaseUrl/supabaseAnonKey/configured`) enforce it.

Practical effect: set `SUPABASE_URL`/`SUPABASE_ANON_KEY` once in Vercel and never touch them again — a future code ZIP's `index.html` ships with no real values in it at all and picks up whatever's already configured. If `/api/config` is unreachable or reports `configured: false` (env vars unset, or a network hiccup), `index.html` disables Sign Up/Log In with a plain "Accounts are temporarily unavailable" message and leaves everything else — including anonymous mission generation, which never depends on this endpoint — working normally.

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
7. **Get your credentials, and set them as Vercel env vars**: Settings → API gives you the Project URL and the `anon`/`public` key. Set these as `SUPABASE_URL` and `SUPABASE_ANON_KEY` in Vercel (see the env var table below) — never the `service_role` key, which must never leave the Supabase dashboard. **As of this pass, that's the only place these values need to be set.** `index.html` no longer hardcodes them — see [Frontend configuration: `/api/config`](#frontend-configuration-apiconfig) below for why, and why that means future code updates no longer require re-entering them.

## Bug found & fixed while verifying the production flow

Automated end-to-end testing (in an earlier pass) surfaced one real, pre-existing bug: `runHydra()` (the "Ask Hydra" box) called `await saveHydraMission(rawValue)` with no error handling. If that Supabase call failed for *any* reason — a blocked CDN, a bad key, a network blip, an ad-blocker — the `await` threw, and every line after it in `runHydra()` never ran. Ask Hydra would look completely dead with no visible error. That was fixed by wrapping the call in try/catch.

As of this pass, `runHydra()` was rewritten to call the new `POST /api/ask-hydra` endpoint instead, and no longer calls `saveHydraMission()` at all — so that specific failure mode can no longer happen. `saveHydraMission()` itself is left in `index.html`, unused, exactly as it was (see "Known pre-existing item" below for what it's for and why it wasn't removed).

## Files to deploy

Everything except `test/` (local verification tooling only — never deploy it; a `.vercelignore` is included that excludes it automatically) and `supabase/schema.sql` (that's run once against your Supabase project's SQL editor — see above — not deployed to Vercel; `.vercelignore` excludes the `supabase/` folder too):

```
index.html
workspace.html
vercel.json
package.json
api/tool-registry.json
api/_shared.js
api/generate-mission.js
api/refine.js
api/ask-hydra.js
api/projects.js
api/projects/[id].js
api/config.js
api/lib/request-context.js
api/lib/entitlements.js
api/lib/orchestrator.js
api/lib/ask-hydra.js
api/lib/hydra-knowledge.js
api/lib/mission-store.js
api/lib/supabase-server.js
```

`vercel.json` is new this pass — it's what turns `/workspace` into a clean route (see "Dedicated Workspace view" above). It contains exactly one rewrite rule and nothing else; it doesn't affect any other route.

## Environment variables to add in Vercel

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | **Yes** | — | From platform.openai.com. Set this in Vercel's dashboard only — never in `index.html`, `workspace.html`, or any file that ships to the browser. |
| `OPENAI_MISSION_MODEL` | No | `gpt-5.6-luna` | Model used by `/api/generate-mission`. |
| `OPENAI_REFINE_MODEL` | No | `gpt-5.6-luna` | Model used by `/api/refine`. |
| `OPENAI_ASK_HYDRA_MODEL` | No | `gpt-5.6-luna-ask` | Model used by `/api/ask-hydra`. Deliberately a separate constant from the two above, so Ask Hydra's traffic/config can be tuned independently of Mission Orchestrator and AI Refine. |
| `SUPABASE_URL` | For accounts to work | — | Your project's URL from Supabase Settings → API. Without this, `/api/projects*` return 401/500 and the server always treats requests as anonymous — mission generation itself is unaffected. |
| `SUPABASE_ANON_KEY` | For accounts to work | — | The `anon`/`public` key from the same page. **Never** the `service_role` key — the server never needs it and must never hold it. |

## Commands / actions to deploy

**Dashboard path:**
1. Complete the Supabase setup above (schema, SMTP, redirect URLs).
2. Push this folder to a GitHub repo.
3. Vercel dashboard → Add New → Project → import that repo. No framework preset needed — Vercel auto-detects the static `index.html` plus the `/api` folder as serverless functions.
4. Settings → Environment Variables → add `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` (and optionally the two model overrides) for the Production environment.
5. Deploy. If you added an env var *after* the first deploy, hit Redeploy so it picks it up.
6. That's it — no file needs hand-editing with real values. A future code update can ship `index.html` as-is and it will pick up whatever's already in these env vars.

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

`test/e2e-test.js` drives a real headless browser against the real `index.html`, the real `workspace.html`, and the real `api/*.js` handlers — the only things mocked are the outbound call to `api.openai.com` and a stand-in Supabase (see below); no real API keys or live Supabase project are needed to run it. It's now up to **135 passing checks**, covering everything from earlier passes plus, new this pass:

- **Nested Projects Directory**: saving a second project adds it alongside the first rather than replacing it; the active project is visually distinguished from the rest; a non-active project starts collapsed and stays collapsed until clicked; expanding one lazily fetches its node titles via `GET /api/projects/:id` (proven by asserting the fetched titles match that project's real steps) and re-expanding it afterward does **not** re-fetch (proven by watching for a repeat request that must not arrive); clicking a project's name resumes it in the same tab (no new tab opens); clicking one of its nodes loads that project if it wasn't already active, then jumps straight to that node.
- **Ask Hydra's new endpoint**: a request with no message is rejected; an anonymous question gets an answer without any account context; an authenticated question is answered using the server's own record of that user's plan and Hydra Credit balance, never whatever the client claims; conversation history is forwarded and used on follow-up questions; an OpenAI-side failure degrades to a visible, non-crashing message; and — the key regression guard — asking Hydra something never fires a request to `/api/generate-mission`, proving Ask Hydra no longer shares a code path with Mission Orchestrator.
- **The dedicated Workspace view (`/workspace`)**: `GET /workspace` returns 200 and renders the Workspace page; a second tab opened in the *same* browser session recognizes the existing sign-in with no new login and shows the same saved projects as the main tab; clicking Resume there navigates back into Mission Console with that project loaded; a *separate*, signed-out browser session visiting `/workspace` sees a signed-out state instead, proving no session leaks across unrelated visitors; and the main Hydra page (sign-up, login, mission generation, project save/resume) keeps passing all of its existing checks, unchanged.
- **The visual project workspace**: opening a project renders its real header — title, goal, type, last updated, and progress ("Node 3 of 5") — and a current-node name pulled from the real saved step, not a placeholder; the workflow view renders exactly one card per saved step (proven against a 5-step and a 3-step mission, not a fixed count) with the recommended tool and description text coming straight out of `workflow_json`; a node before the saved `current_node` shows COMPLETE, the matching one shows CURRENT, and one after shows UPCOMING, all three exercised in a single project; the Notes tab renders a labeled placeholder rather than a blank or broken panel; and following "Open Node" on a node other than the saved current one returns to Mission Console, loads the correct project, and jumps to that exact node rather than wherever the project was left off.

`test/smoke-test.js` separately checks the backend pipeline's edge cases in isolation — **42 passing checks**, up from 27, adding: Ask Hydra's own model constant is verified distinct from Mission Orchestrator's and AI Refine's on every outbound call (so it's provable, not just asserted, that they're on separate code paths); the scope rules and execution-truth language are present in Ask Hydra's system prompt; the tool registry text sent to Ask Hydra is byte-for-byte the same `getRegistrySummaryForPrompt()` output the orchestrator uses, not a second copy; an anonymous caller's context never includes account or project data even if the client tries to send it; an authenticated caller's plan/credits come from the server-side profile lookup, not the request body; and a final regression check re-runs Mission Orchestrator's original happy path end-to-end to confirm this pass didn't disturb it. (The visual project workspace is pure front-end rendering over the existing `GET /api/projects/:id` response, so it's covered end-to-end above rather than duplicated here.)

Run either with `node test/smoke-test.js` / `node test/e2e-test.js` (the latter needs `playwright` installed and a Chromium binary — see its header comment).

**How Supabase is tested without a live project**: `test/supabase-mock.js` is a small in-memory stand-in for Supabase Auth and PostgREST, served by `test/dev-server.js` at the same local origin — including the password-recovery endpoints (`/auth/v1/recover`, `PUT /auth/v1/user`) and a test-only `/__test__/recovery-token` route that hands the test runner a token the same way a person would read one out of their inbox (never exposed to the browser side of the flow). On the server side, `api/lib/supabase-server.js`'s real `fetch()` calls hit it directly. On the browser side, `test/supabase-stub.js` replaces the real `@supabase/supabase-js` CDN script (swapped in only when `dev-server.js` serves `index.html` locally — the actual deployed file always loads the real library) with a lookalike client backed by real same-origin HTTP calls to that same mock, including the one piece of real supabase-js behavior that recovery depends on — parsing an `access_token`/`type=recovery` URL fragment on load. Nothing about `index.html`'s real code path changes between test and production; only the far end (an actual Supabase project) is faked, the same way `api.openai.com` is faked for OpenAI.

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
