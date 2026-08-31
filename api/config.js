// GET /api/config
// Returns ONLY the two Supabase values that are already meant to be public
// (the project URL and the anon/publishable key — the same pair Supabase's
// own docs say are safe to ship to a browser, provided RLS is correctly
// configured, which supabase/schema.sql does) plus a `configured` flag.
//
// Why this exists: index.html has no build step, so it can't have env vars
// injected into it at deploy time. Before this endpoint, the two Supabase
// values were hardcoded directly in index.html — meaning every new
// deployment ZIP had to have them manually re-pasted in, or it would
// silently revert production to placeholder values. Now index.html fetches
// them from here at load time, reading the exact same SUPABASE_URL /
// SUPABASE_ANON_KEY env vars api/lib/supabase-server.js already uses
// server-side — set once in Vercel, never touched again by a code update.
//
// SECURITY: this file must NEVER be extended to return anything else.
// OPENAI_API_KEY, Resend credentials, a Supabase service-role key, or any
// other private value must never appear here. If a future feature needs a
// new *public* config value, add it explicitly and narrowly here — never by
// forwarding process.env wholesale.

const { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } = require('./_lib/supabase-server');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  res.status(200).json({
    supabaseUrl: SUPABASE_URL || '',
    supabaseAnonKey: SUPABASE_ANON_KEY || '',
    configured: isConfigured(),
  });
};
