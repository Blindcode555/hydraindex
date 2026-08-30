// Resolves "who is calling" for a request. This is the ONLY place that should
// ever change when real authentication is added — every other file (rate
// limiting, entitlements, mission persistence, orchestration) reads the
// { userId, isAuthenticated, plan } shape this returns and doesn't care how
// it was determined.
//
// TODAY: there is no authentication anywhere in this project (verified by
// inspection — no login flow, no session/JWT handling, nothing in Supabase
// beyond an anonymous insert). So this always resolves to an anonymous
// context. It does NOT trust any client-supplied identity header/cookie —
// a request cannot claim to be a given user_id until a real verification
// step exists here, because doing otherwise would let anyone impersonate
// anyone else's saved missions/usage the moment persistence is wired up.
//
// LATER, when accounts exist (e.g. Supabase Auth):
//   1. Read the session cookie or `Authorization: Bearer <jwt>` header.
//   2. Verify it server-side (e.g. supabase.auth.getUser(token)).
//   3. Set userId/isAuthenticated/plan from that VERIFIED identity.
// Nothing downstream needs to change to support that — they already key off
// context.userId when present and fall back to anonymous behavior when not.

function getRequestContext(req) {
  // TODO(auth): replace with real session/JWT verification once accounts exist.
  const verifiedUserId = null;

  return {
    userId: verifiedUserId,
    isAuthenticated: !!verifiedUserId,
    // Default plan for a verified-but-not-yet-billed account is 'free'; an
    // unauthenticated visitor is 'anonymous'. Both are distinct from 'paid'
    // so entitlements.js can treat them differently once plans exist.
    plan: verifiedUserId ? 'free' : 'anonymous',
  };
}

module.exports = { getRequestContext };
