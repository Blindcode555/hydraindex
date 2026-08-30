// POST /api/generate-mission
// Body: { idea: string, type?: string, level?: string, budget?: string }
// Returns: { mission_id, saved, title, tags, steps, output, plan, meta }
//
// This handler is intentionally thin — it wires together the pipeline in the
// order the product is meant to grow into:
//
//   AUTH/USER CONTEXT -> ENTITLEMENT CHECK -> OPENAI ORCHESTRATION
//     -> SHAPE FOR PERSISTENCE -> SAVE (stub) -> RESPOND
//
// Every stage after context resolution already reads `context` (userId,
// plan) even though today it is always the anonymous default — so adding
// real accounts later means implementing request-context.js honestly, not
// restructuring this file or the orchestrator.
//
// SECURITY: the OpenAI API key lives only in orchestrator.js on the server.
// It is never sent to, or reachable from, the browser. Do not add a
// client-side fetch straight to api.openai.com anywhere in index.html —
// always come through an endpoint like this one.

const { getRequestContext } = require('./lib/request-context');
const { checkEntitlement } = require('./lib/entitlements');
const { buildMissionRecord, saveMission } = require('./lib/mission-store');
const { generateMissionPlan, OrchestratorError, MISSION_MODEL } = require('./lib/orchestrator');
const {
  VALID_TYPES,
  VALID_LEVELS,
  VALID_BUDGETS,
  rateLimit,
  getClientIp,
  sanitizeIdea,
} = require('./_shared');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // 1. AUTH / USER CONTEXT (future: real accounts) --------------------------
  const context = await getRequestContext(req);

  // Rate-limit key prefers a verified user id once auth exists; today that's
  // always null, so this falls back to IP exactly as before.
  const limitKey = context.userId || getClientIp(req);
  if (!rateLimit(`mission:${limitKey}`, { limit: 12, windowMs: 60 * 60 * 1000 })) {
    res.status(429).json({ error: 'rate_limited', message: 'Too many mission requests. Try again later.' });
    return;
  }

  // 2. ENTITLEMENT / USAGE CHECK (future: plans, credits, Stripe) -----------
  const entitlement = checkEntitlement(context, 'generate_mission');
  if (!entitlement.allowed) {
    res.status(402).json({ error: 'entitlement_denied', reason: entitlement.reason });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const idea = sanitizeIdea(body.idea);
  const type = VALID_TYPES.includes(body.type) ? body.type : null;
  const level = VALID_LEVELS.includes(body.level) ? body.level : null;
  const budget = VALID_BUDGETS.includes(body.budget) ? body.budget : null;

  if (!idea && !type) {
    res.status(400).json({ error: 'missing_input', message: 'Provide an idea or a mission type.' });
    return;
  }

  // 3. OPENAI ORCHESTRATION + TOOL REGISTRY ----------------------------------
  let mission;
  try {
    mission = await generateMissionPlan({ idea, type, level, budget });
  } catch (err) {
    if (err instanceof OrchestratorError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    res.status(502).json({ error: 'orchestration_failed' });
    return;
  }

  // 4. SHAPE FOR PERSISTENCE, then 5. SAVE (no-op until a database exists) --
  const record = buildMissionRecord({ idea, type, level, budget, mission, context, model: MISSION_MODEL });
  const saveResult = await saveMission(record);

  // 6. RESPOND -> frontend renders nodes -------------------------------------
  res.status(200).json({
    mission_id: record.id,
    saved: saveResult.saved, // always false today; a future signed-in UI can use this to prompt "sign in to save"
    title: mission.title,
    tags: mission.tags,
    steps: mission.steps,
    output: mission.output,
    plan: context.plan,
    meta: { model: MISSION_MODEL, generated_at: record.created_at },
  });
};
