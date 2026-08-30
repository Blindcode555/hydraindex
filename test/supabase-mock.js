// LOCAL VERIFICATION HARNESS ONLY — never deployed. A minimal, in-memory
// stand-in for Supabase Auth + PostgREST, reachable at the same origin as
// the rest of the local test server (SUPABASE_URL is pointed at
// http://localhost:<port> for the duration of the test run — see
// dev-server.js). This is what lets api/lib/supabase-server.js's real
// fetch() calls (GET /auth/v1/user, GET/POST/PATCH /rest/v1/<table>) be
// exercised for real, without a live Supabase project or its own network
// access. It intentionally mirrors just the handful of operations
// api/lib/mission-store.js actually performs — it is not a general
// PostgREST clone.
//
// Reset between test runs with resetSupabaseMock().

const crypto = require('crypto');

let users; // email -> { id, email, password }
let tokens; // access_token -> user id
let tables; // { profiles: [...], projects: [...], missions: [...] }
let recoveryTokensByEmail; // email -> the most recent recovery access_token issued for it

function resetSupabaseMock() {
  users = new Map();
  tokens = new Map();
  tables = { profiles: [], projects: [], missions: [] };
  recoveryTokensByEmail = new Map();
}
resetSupabaseMock();

function issueToken(userId) {
  const token = 'test-token-' + userId + '-' + crypto.randomBytes(6).toString('hex');
  tokens.set(token, userId);
  return token;
}

function userIdForToken(authHeader) {
  const token = (authHeader || '').startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  return token ? tokens.get(token) || null : null;
}

function now() {
  return new Date().toISOString();
}

// -- Auth ---------------------------------------------------------------

function authSignUp(body) {
  const email = (body && body.email || '').trim().toLowerCase();
  const password = body && body.password;
  if (!email || !password) return { status: 400, body: { message: 'email and password are required' } };
  if (users.has(email)) return { status: 400, body: { message: 'User already registered' } };

  const id = crypto.randomUUID();
  users.set(email, { id, email, password });

  // Mirrors the handle_new_user trigger in supabase/schema.sql: a profile
  // row is provisioned automatically the moment a user is created.
  tables.profiles.push({
    id, email, display_name: null, plan: 'free', hydra_credit_balance: 0,
    created_at: now(), updated_at: now(),
  });

  const access_token = issueToken(id);
  return { status: 200, body: { access_token, refresh_token: 'refresh-' + id, user: { id, email } } };
}

function authSignIn(body) {
  const email = (body && body.email || '').trim().toLowerCase();
  const password = body && body.password;
  const record = users.get(email);
  if (!record || record.password !== password) {
    return { status: 400, body: { message: 'Invalid login credentials' } };
  }
  const access_token = issueToken(record.id);
  return { status: 200, body: { access_token, refresh_token: 'refresh-' + record.id, user: { id: record.id, email } } };
}

function authGetUser(authHeader) {
  const userId = userIdForToken(authHeader);
  if (!userId) return { status: 401, body: { message: 'invalid or expired token' } };
  const record = [...users.values()].find((u) => u.id === userId);
  return { status: 200, body: { id: userId, email: record ? record.email : null } };
}

// resetPasswordForEmail(). Mirrors the real endpoint's non-revealing shape —
// it responds the same way whether or not the email is on file — while
// stashing an issued recovery token for the TEST RUNNER (not the browser)
// to retrieve via getRecoveryToken(), simulating "reading the reset email"
// out of band. A real deployment sends this token only inside the emailed
// link; nothing here exposes it to the browser side of the flow.
function authRequestRecovery(body) {
  const email = (body && body.email || '').trim().toLowerCase();
  const record = users.get(email);
  if (record) {
    const access_token = issueToken(record.id);
    recoveryTokensByEmail.set(email, access_token);
  }
  return { status: 200, body: {} };
}

// Test-only accessor — NOT part of Supabase's real API surface. Lets the
// e2e test fetch the token a real user would only see inside their email.
function getRecoveryToken(email) {
  return recoveryTokensByEmail.get((email || '').trim().toLowerCase()) || null;
}

// updateUser({password}) — PUT /auth/v1/user in real Supabase. Requires a
// valid (here: any valid, including a recovery) access token.
function authUpdateUser(authHeader, body) {
  const userId = userIdForToken(authHeader);
  if (!userId) return { status: 401, body: { message: 'invalid or expired token' } };
  const record = [...users.values()].find((u) => u.id === userId);
  if (!record) return { status: 401, body: { message: 'invalid or expired token' } };
  const password = body && body.password;
  if (!password || password.length < 6) {
    return { status: 400, body: { message: 'Password should be at least 6 characters.' } };
  }
  record.password = password;
  return { status: 200, body: { id: userId, email: record.email } };
}

// -- PostgREST-alike ------------------------------------------------------

function parseQuery(qs) {
  const filters = [];
  let order = null;
  let limit = null;
  (qs || '').split('&').filter(Boolean).forEach((pair) => {
    const eq = pair.indexOf('=');
    const key = decodeURIComponent(pair.slice(0, eq));
    const val = decodeURIComponent(pair.slice(eq + 1));
    if (key === 'select') return;
    if (key === 'order') { const [column, dir] = val.split('.'); order = { column, dir: dir || 'asc' }; return; }
    if (key === 'limit') { limit = parseInt(val, 10); return; }
    const dot = val.indexOf('.');
    const op = val.slice(0, dot);
    const value = val.slice(dot + 1);
    filters.push({ column: key, op, value });
  });
  return { filters, order, limit };
}

function applyFilters(rows, filters) {
  return rows.filter((row) => filters.every((f) => {
    if (f.op === 'eq') return String(row[f.column]) === f.value;
    return true; // only eq. is used anywhere in this codebase
  }));
}

function restRequest(table, method, qs, body) {
  if (!tables[table]) return { status: 404, body: { message: 'unknown table: ' + table } };
  const { filters, order, limit } = parseQuery(qs);

  if (method === 'GET') {
    let rows = applyFilters(tables[table], filters);
    if (order) {
      rows = rows.slice().sort((a, b) => {
        const av = a[order.column], bv = b[order.column];
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return order.dir === 'desc' ? -cmp : cmp;
      });
    }
    if (limit != null) rows = rows.slice(0, limit);
    return { status: 200, body: rows };
  }

  if (method === 'POST') {
    const incoming = Array.isArray(body) ? body : [body];
    const inserted = incoming.map((r) => {
      const row = Object.assign({ id: crypto.randomUUID(), created_at: now(), updated_at: now() }, r);
      tables[table].push(row);
      return row;
    });
    return { status: 201, body: inserted };
  }

  if (method === 'PATCH') {
    const matches = applyFilters(tables[table], filters);
    matches.forEach((row) => Object.assign(row, body, { updated_at: now() }));
    return { status: 200, body: matches };
  }

  return { status: 405, body: { message: 'method not supported in mock: ' + method } };
}

module.exports = {
  resetSupabaseMock, authSignUp, authSignIn, authGetUser, restRequest,
  authRequestRecovery, authUpdateUser, getRecoveryToken,
};
