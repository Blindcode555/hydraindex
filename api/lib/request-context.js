// Resolves "who is calling" for a request. This is the file that changes
// when real authentication is added — every other file (rate limiting,
// entitlements, mission persistence, orchestration) reads the
// { userId, isAuthenticated, plan, accessToken } shape this returns and
// doesn't care how it was determined.
//
// Auth is now real, via Supabase: a request is authenticated by sending
// `Authorization: Bearer <supabase access token>` (the frontend does this
// automatically once a user is signed in). That token is verified against
// Supabase Auth itself (never decoded/trusted locally) before any userId is
// accepted — a request can never simply claim to be a given user. No
// identity header is ever trusted directly, and no service-role key is used
// anywhere in this file or the module it depends on (supabase-server.js).
//
// A request with no token, an invalid token, or arriving before Supabase is
// configured (SUPABASE_URL/SUPABASE_ANON_KEY unset) all resolve to the same
// anonymous context as before Supabase existed — mission generation keeps
// working for signed-out visitors exactly as it always has; only saving
// projects requires a verified identity.

const { verifyAccessToken, pgClient, isConfigured } = require('./supabase-server');

const ANONYMOUS_CONTEXT = { userId: null, isAuthenticated: false, plan: 'anonymous', accessToken: null };

function getBearerToken(req) {
  const header = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

async function getRequestContext(req) {
  const accessToken = getBearerToken(req);
  if (!accessToken || !isConfigured()) {
    return { ...ANONYMOUS_CONTEXT };
  }

  const user = await verifyAccessToken(accessToken);
  if (!user) {
    return { ...ANONYMOUS_CONTEXT };
  }

  // Verified-but-not-yet-billed accounts default to 'free'; look up the real
  // value from their profile, falling back to 'free' if that lookup fails
  // for any reason (a profile read error should never break the request).
  let plan = 'free';
  try {
    const profile = await pgClient(accessToken).request('profiles', {
      query: `?id=eq.${encodeURIComponent(user.id)}&select=plan`,
      single: true,
    });
    if (profile && profile.plan) plan = profile.plan;
  } catch (e) {
    // fall through with the 'free' default
  }

  return { userId: user.id, isAuthenticated: true, plan, accessToken };
}

module.exports = { getRequestContext, getBearerToken };
