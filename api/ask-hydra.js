// POST /api/ask-hydra
// Body: { message: string, history?: [{role,content}], activeProject?: {...} }
// Returns: { reply: string }
//
// A dedicated endpoint for the Ask Hydra assistant — separate from
// /api/generate-mission (Mission Orchestrator) and /api/refine (AI Refine).
// Ask Hydra used to just call /api/generate-mission with the typed text as
// an "idea"; it now has its own system prompt/context builder (see
// api/lib/ask-hydra.js) so it can actually answer questions about Hydra
// itself instead of only ever producing a mission plan.
//
// Same pipeline shape as the other two endpoints: AUTH/CONTEXT -> RATE LIMIT
// -> (best-effort profile lookup) -> ASK-HYDRA LOGIC -> RESPOND. No new
// entitlement gating, no new persistence, no new auth mechanism — this
// reuses getRequestContext exactly like generate-mission.js and refine.js
// do, so anonymous vs. authenticated is decided the same trusted way
// everywhere.

const { getRequestContext } = require('./_lib/request-context');
const { getProfile } = require('./_lib/mission-store');
const { answerHydraQuestion, AskHydraError } = require('./_lib/ask-hydra');
const { rateLimit, getClientIp } = require('./_shared');

const MAX_MESSAGE_LENGTH = 800;
const MAX_FIELD_LENGTH = 300;

function clip(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max || MAX_FIELD_LENGTH) : '';
}

// Only ever forwarded to the model when the caller is authenticated (see
// api/lib/ask-hydra.js) — but sanitized defensively here regardless, since
// this is client-supplied display context, not a database lookup, and must
// never be trusted to carry more than a few short fields.
function sanitizeActiveProject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const nodeTitles = Array.isArray(raw.nodeTitles)
    ? raw.nodeTitles.filter((t) => typeof t === 'string').slice(0, 10).map((t) => clip(t, 120))
    : [];
  return {
    title: clip(raw.title, 120) || null,
    goal: clip(raw.goal, 300) || null,
    currentNode: Number.isInteger(raw.currentNode) ? raw.currentNode : null,
    nodeCount: Number.isInteger(raw.nodeCount) ? raw.nodeCount : null,
    nodeTitles,
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // 1. AUTH / USER CONTEXT — identical resolution to every other endpoint.
  const context = await getRequestContext(req);

  const limitKey = context.userId || getClientIp(req);
  if (!rateLimit(`ask-hydra:${limitKey}`, { limit: 30, windowMs: 60 * 60 * 1000 })) {
    res.status(429).json({ error: 'rate_limited', message: 'Too many Ask Hydra requests. Try again later.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const message = clip(body.message, MAX_MESSAGE_LENGTH);
  if (!message) {
    res.status(400).json({ error: 'missing_input', message: 'A message is required.' });
    return;
  }

  const history = Array.isArray(body.history) ? body.history.slice(-10) : [];

  // 2. Minimal, best-effort profile lookup — only when authenticated, and
  //    never blocking: a failed profile read just falls back to defaults
  //    rather than breaking the assistant. Never send the client-claimed
  //    plan/credits to the model; only what the server itself looked up.
  let plan = context.plan;
  let credits = 0;
  if (context.isAuthenticated) {
    try {
      const profile = await getProfile(context);
      if (profile) {
        plan = profile.plan || plan;
        credits = profile.hydra_credit_balance != null ? profile.hydra_credit_balance : 0;
      }
    } catch (e) {
      // fall through with defaults — Ask Hydra must still work if the
      // profile lookup fails for any reason.
    }
  }

  // Active-project context is display context the user's own browser
  // already holds (not re-fetched/re-authorized against the database here)
  // — see api/lib/ask-hydra.js's comment on why that's an intentional,
  // narrow trust boundary. Only ever used when authenticated.
  const activeProject = context.isAuthenticated ? sanitizeActiveProject(body.activeProject) : null;

  // 3. ASK HYDRA LOGIC -------------------------------------------------------
  try {
    const reply = await answerHydraQuestion({
      message,
      history,
      context: { isAuthenticated: context.isAuthenticated, plan, credits },
      activeProject,
    });
    res.status(200).json({ reply });
  } catch (err) {
    if (err instanceof AskHydraError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    res.status(502).json({ error: 'ask_hydra_failed' });
  }
};
