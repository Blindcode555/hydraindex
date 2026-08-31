// Talks to Supabase's own HTTP APIs (Auth + PostgREST) directly via fetch —
// no @supabase/supabase-js dependency. Every call here uses EITHER the
// public anon key alone, or the anon key plus a specific user's own access
// token — never a service-role key — so every request is still subject to
// Row Level Security exactly as if the browser had made it directly.
//
// SUPABASE_URL / SUPABASE_ANON_KEY are not secrets (this is Supabase's
// public-key model, same values already embedded in index.html); they're
// env vars here purely so the backend doesn't hardcode them a second time.

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

function isConfigured() {
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
}

// Verifies a user's access token against Supabase Auth and returns the
// verified user object, or null if missing/invalid/expired/unconfigured.
// This is the ONLY way a userId may enter the system — a request can never
// just claim to be a given user.
async function verifyAccessToken(token) {
  if (!isConfigured() || !token) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch (e) {
    return null;
  }
}

// Minimal PostgREST client scoped to `accessToken` (RLS applies as that
// user). Omitting accessToken scopes it to the anon role alone — our RLS
// policies grant that role nothing on profiles/projects/missions.
function pgClient(accessToken) {
  const authHeader = `Bearer ${accessToken || SUPABASE_ANON_KEY}`;

  async function request(table, { method = 'GET', query = '', body, single } = {}) {
    if (!isConfigured()) {
      const err = new Error('supabase_not_configured');
      err.code = 'supabase_not_configured';
      throw err;
    }
    const headers = {
      apikey: SUPABASE_ANON_KEY,
      Authorization: authHeader,
      'Content-Type': 'application/json',
    };
    if (method === 'POST' || method === 'PATCH') {
      headers.Prefer = 'return=representation';
    }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = text; }
    }

    if (!res.ok) {
      const message = (data && (data.message || data.error_description || data.error)) || `PostgREST ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      err.details = data;
      throw err;
    }

    if (single) {
      return Array.isArray(data) ? (data[0] || null) : data;
    }
    return data;
  }

  return { request };
}

module.exports = { isConfigured, verifyAccessToken, pgClient, SUPABASE_URL, SUPABASE_ANON_KEY };
