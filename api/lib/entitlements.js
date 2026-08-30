// Entitlement / usage-limit checks — deliberately separate from
// orchestrator.js so that plugging in real plans, credits, and Stripe later
// never touches the OpenAI call itself. The orchestrator has no idea plans
// exist; it just generates a mission. This file is the only place that
// decides whether it's allowed to.
//
// TODAY: no billing exists, so every action is allowed for everyone
// (anonymous included) and these limits are enforced only via the soft,
// in-memory rate limiter in _shared.js — not a real per-user quota.
//
// LATER: once accounts + usage tracking exist, checkEntitlement should:
//   1. Look up the user's plan (context.plan) and their usage so far this
//      period (e.g. a `usage` table keyed by user_id, or Stripe metering).
//   2. Compare against FREE_LIMITS / a paid-plan equivalent.
//   3. Return { allowed:false, reason:'limit_reached' } once exceeded, which
//      the route handler already knows how to turn into a 402/429 response.
// The action names below ('generate_mission', 'refine_step') are also the
// hooks for future paid-only features noted in the product plan — e.g.
// 'refine_step' or higher mission complexity could become paid-only by
// changing only this file.

const FREE_LIMITS = {
  generate_mission: 12, // per hour — mirrors today's anonymous rate limit
  refine_step: 30,      // per hour
};

function checkEntitlement(context, action) {
  // TODO(billing): real plan/usage check goes here. Until then, everything
  // is allowed — anonymous included — which is the intended free-tier
  // experience the product plan describes ("free version should let users
  // experience the core value of Hydra").
  return {
    allowed: true,
    plan: context.plan,
    reason: null,
    limit: FREE_LIMITS[action] || null,
  };
}

module.exports = { checkEntitlement, FREE_LIMITS };
