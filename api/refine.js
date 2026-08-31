// POST /api/refine
// Body: { idea, stepName, templatePrompt } — the exact contract
// refineExecPrompt() in index.html already sends (the "AI Refine" button on
// a node). Returns: { refined: string }
//
// Follows the same pipeline shape as generate-mission.js (context ->
// entitlement -> orchestration -> respond) since "workflow refinement" is
// explicitly called out as a candidate paid-tier feature in the product
// plan — gating it later means changing entitlements.js only.

const { getRequestContext } = require('./_lib/request-context');
const { checkEntitlement } = require('./_lib/entitlements');
const { refineStepPrompt, OrchestratorError } = require('./_lib/orchestrator');
const { rateLimit, getClientIp } = require('./_shared');

const MAX_FIELD_LENGTH = 1500;
function clip(v) {
  return typeof v === 'string' ? v.trim().slice(0, MAX_FIELD_LENGTH) : '';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const context = await getRequestContext(req);

  const limitKey = context.userId || getClientIp(req);
  if (!rateLimit(`refine:${limitKey}`, { limit: 30, windowMs: 60 * 60 * 1000 })) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  const entitlement = checkEntitlement(context, 'refine_step');
  if (!entitlement.allowed) {
    res.status(402).json({ error: 'entitlement_denied', reason: entitlement.reason });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const idea = clip(body.idea);
  const stepName = clip(body.stepName);
  const templatePrompt = clip(body.templatePrompt);

  if (!idea && !stepName && !templatePrompt) {
    res.status(400).json({ error: 'missing_input' });
    return;
  }

  try {
    const refined = await refineStepPrompt({ idea, stepName, templatePrompt });
    res.status(200).json({ refined });
  } catch (err) {
    if (err instanceof OrchestratorError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    res.status(502).json({ error: 'refine_failed' });
  }
};
