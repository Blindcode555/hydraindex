// LOCAL VERIFICATION HARNESS ONLY — never deploy this file.
// Serves index.html + the real api/*.js handlers over plain HTTP (mimicking
// Vercel's req/res contract) so the actual frontend and actual backend code
// can be exercised end-to-end with a real browser, without needing a live
// OpenAI key. It intercepts only the outbound call to api.openai.com and
// lets everything else (routing, JSON parsing, schema validation, tool
// registry checks, response shaping) run for real.
//
// Test-only control channel: POST /__test__/mock {mode, mission, refined}
// configures what the next OpenAI-bound call returns:
//   mode: 'success'        -> mission generation returns `mission` (a full
//                              {title,tags,steps,output} object)
//   mode: 'bad_tool_id'    -> mission generation returns a step referencing
//                              a tool_id NOT in the registry (proves server-
//                              side rejection, not just schema hope)
//   mode: 'upstream_error' -> OpenAI call returns ok:false (proves fallback)
//   mode: 'network_fail'   -> fetch itself throws (proves fallback)
//   refined: string        -> what /api/refine's mocked call returns
//
// Also stands up a mock Supabase (Auth + PostgREST) so the sign up -> log in
// -> save project -> log out -> log back in -> resume flow can be exercised
// with real HTTP calls on both the server side (api/lib/supabase-server.js)
// and the browser side (see test/supabase-stub.js, swapped in for the real
// CDN script only when this server serves index.html). SUPABASE_URL is
// pointed at this same server so there is exactly one mock backing both.
const PORT = process.env.PORT || 8787;
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'local-e2e-test-key-not-real';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || ('http://localhost:' + PORT);
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'local-e2e-test-anon-key';

const http = require('http');
const fs = require('fs');
const path = require('path');
const supabaseMock = require('./supabase-mock');

const ROOT = path.join(__dirname, '..');

let MOCK = { mode: 'success', mission: null, refined: null };
// Test-only override for GET /api/config, so a test can prove the frontend
// degrades gracefully when Supabase isn't configured — without needing a
// second server process with different env vars. null = use the real
// api/config.js handler (the normal path for every other test).
let CONFIG_OVERRIDE = null;

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.startsWith('https://api.openai.com/')) {
    if (MOCK.mode === 'network_fail') {
      throw new Error('simulated network failure (test harness)');
    }
    if (MOCK.mode === 'upstream_error') {
      return { ok: false, status: 500, json: async () => ({ error: { message: 'simulated upstream error (test harness)' } }) };
    }
    const body = JSON.parse(opts.body);
    const isMissionCall = !!body.response_format; // only generate-mission sets structured output
    if (!isMissionCall) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: MOCK.refined || 'Mocked refined prompt for local testing.' } }] }) };
    }
    let missionPayload = MOCK.mission;
    if (MOCK.mode === 'bad_tool_id') {
      missionPayload = {
        title: 'Broken Mission',
        tags: ['Test'],
        steps: [{
          step: 1, title: 'X', purpose: 'Y', tool_id: 'not-a-real-registry-id',
          tool_name: 'Fake Tool', why_this_tool: 'z', instructions: 'z', prompt: 'z',
          estimated_time: '1 min', estimated_cost: 'Free', difficulty: 'beginner', output: 'z',
        }],
        output: { title: 'Done', desc: 'z', items: ['z'] },
      };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(missionPayload) } }] }) };
  }
  return realFetch(url, opts);
};

// Load handlers AFTER the fetch shim is installed AND after SUPABASE_URL is
// set above (api/lib/supabase-server.js reads it once, at require time).
const generateMission = require(path.join(ROOT, 'api', 'generate-mission.js'));
const refine = require(path.join(ROOT, 'api', 'refine.js'));
const projects = require(path.join(ROOT, 'api', 'projects.js'));
const projectById = require(path.join(ROOT, 'api', 'projects', '[id].js'));
const config = require(path.join(ROOT, 'api', 'config.js'));

function adaptRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
  };
  return res;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
    });
  });
}

const REAL_SUPABASE_CDN_TAG = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>';
const LOCAL_SUPABASE_STUB_TAG = '<script src="/__test__/supabase-stub.js"></script>';

const server = http.createServer(async (req, res) => {
  adaptRes(res);
  const pathname = req.url.split('?')[0];
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';

  try {
    if (req.method === 'POST' && pathname === '/__test__/mock') {
      MOCK = await readBody(req);
      res.status(200).json({ ok: true, mock: MOCK.mode });
      return;
    }
    if (req.method === 'POST' && pathname === '/__test__/reset') {
      supabaseMock.resetSupabaseMock();
      res.status(200).json({ ok: true });
      return;
    }
    if (req.method === 'POST' && pathname === '/__test__/force-config') {
      CONFIG_OVERRIDE = await readBody(req);
      res.status(200).json({ ok: true });
      return;
    }
    if (req.method === 'POST' && pathname === '/__test__/clear-force-config') {
      CONFIG_OVERRIDE = null;
      res.status(200).json({ ok: true });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/generate-mission') {
      req.body = await readBody(req);
      await generateMission(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/refine') {
      req.body = await readBody(req);
      await refine(req, res);
      return;
    }
    if (pathname === '/api/projects') {
      req.body = await readBody(req);
      await projects(req, res);
      return;
    }
    if (/^\/api\/projects\/[^/]+$/.test(pathname)) {
      req.body = await readBody(req);
      await projectById(req, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/config') {
      if (CONFIG_OVERRIDE) { res.status(200).json(CONFIG_OVERRIDE); return; }
      await config(req, res);
      return;
    }

    // -- Test-only: fetch a recovery token as if reading it out of the
    //    password-reset email (see supabase-mock.js's authRequestRecovery).
    //    Not part of Supabase's real API surface.
    if (req.method === 'GET' && pathname === '/__test__/recovery-token') {
      const email = new URLSearchParams(qs).get('email');
      const token = supabaseMock.getRecoveryToken(email);
      res.status(200).json({ token });
      return;
    }

    // -- Mock Supabase Auth --------------------------------------------
    if (req.method === 'POST' && pathname === '/auth/v1/signup') {
      const body = await readBody(req);
      const result = supabaseMock.authSignUp(body);
      res.status(result.status).json(result.body);
      return;
    }
    if (req.method === 'POST' && pathname === '/auth/v1/token') {
      const body = await readBody(req);
      const result = supabaseMock.authSignIn(body);
      res.status(result.status).json(result.body);
      return;
    }
    if (req.method === 'POST' && pathname === '/auth/v1/logout') {
      res.status(204).end();
      return;
    }
    if (req.method === 'POST' && pathname === '/auth/v1/recover') {
      const body = await readBody(req);
      const result = supabaseMock.authRequestRecovery(body);
      res.status(result.status).json(result.body);
      return;
    }
    if (req.method === 'GET' && pathname === '/auth/v1/user') {
      const result = supabaseMock.authGetUser(req.headers.authorization);
      res.status(result.status).json(result.body);
      return;
    }
    if (req.method === 'PUT' && pathname === '/auth/v1/user') {
      const body = await readBody(req);
      const result = supabaseMock.authUpdateUser(req.headers.authorization, body);
      res.status(result.status).json(result.body);
      return;
    }

    // -- Mock Supabase PostgREST ----------------------------------------
    const restMatch = /^\/rest\/v1\/([^/?]+)$/.exec(pathname);
    if (restMatch) {
      const body = await readBody(req);
      const result = supabaseMock.restRequest(restMatch[1], req.method, qs, body);
      res.status(result.status).json(result.body);
      return;
    }

    if (req.method === 'GET' && pathname === '/__test__/supabase-stub.js') {
      const js = fs.readFileSync(path.join(__dirname, 'supabase-stub.js'));
      res.setHeader('Content-Type', 'application/javascript');
      res.end(js);
      return;
    }
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      // Swap the real Supabase CDN script for the local stub — see
      // test/supabase-stub.js for why (no internet egress in this
      // sandbox, and no live Supabase project to talk to locally anyway).
      // The deployed index.html is never touched; this rewrite happens
      // only in this response.
      html = html.replace(REAL_SUPABASE_CDN_TAG, LOCAL_SUPABASE_STUB_TAG);
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
      return;
    }
    res.status(404).json({ error: 'not_found' });
  } catch (err) {
    res.status(500).json({ error: 'dev_server_error', message: String(err) });
  }
});

server.listen(PORT, () => console.log('Hydra local test server on http://localhost:' + PORT));
module.exports = server;
