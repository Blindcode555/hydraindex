// Offline smoke test for the Hydra backend pipeline:
//   request-context -> entitlements -> orchestrator -> mission-store -> handler
// Mocks global.fetch so no real OpenAI key/network call is needed.
// Run with: node test/smoke-test.js

process.env.OPENAI_API_KEY = 'test-key';
// Must be set before api/lib/supabase-server.js is first required (it reads
// these once, at module load) — everything below transitively requires it
// via request-context.js.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://mock.supabase.test';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'mock-anon-key';

const path = require('path');
const genMissionPath = path.join(__dirname, '..', 'api', 'generate-mission.js');
const refinePath = path.join(__dirname, '..', 'api', 'refine.js');
const projectsPath = path.join(__dirname, '..', 'api', 'projects.js');
const projectByIdPath = path.join(__dirname, '..', 'api', 'projects', '[id].js');
const configPath = path.join(__dirname, '..', 'api', 'config.js');
const { registry } = require(path.join(__dirname, '..', 'api', '_shared.js'));
const { getRequestContext } = require(path.join(__dirname, '..', 'api', 'lib', 'request-context.js'));
const supabaseMock = require('./supabase-mock');

// Backs the same in-memory Supabase mock used by dev-server.js/e2e tests,
// but routed through global.fetch directly instead of a real HTTP server —
// enough to exercise api/lib/supabase-server.js's request-building for real
// (headers, query strings, response parsing) without a live project.
function supabaseFetchMock(url, opts) {
  const u = new URL(url);
  const method = (opts && opts.method) || 'GET';
  if (u.pathname === '/auth/v1/user') {
    const headers = (opts && opts.headers) || {};
    const result = supabaseMock.authGetUser(headers.Authorization || headers.authorization);
    return { ok: result.status < 400, status: result.status, json: async () => result.body, text: async () => JSON.stringify(result.body) };
  }
  const m = /^\/rest\/v1\/([^/]+)$/.exec(u.pathname);
  if (m) {
    const body = opts && opts.body ? JSON.parse(opts.body) : undefined;
    const result = supabaseMock.restRequest(m[1], method, u.search.slice(1), body);
    return { ok: result.status < 400, status: result.status, json: async () => result.body, text: async () => JSON.stringify(result.body) };
  }
  throw new Error('supabaseFetchMock: unhandled URL ' + url);
}

let passed = 0, failed = 0;
function ok(label, cond) {
  if (cond) { passed++; console.log('  PASS -', label); }
  else { failed++; console.error('  FAIL -', label); }
}

function fakeReq(body) {
  return { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.' + Math.floor(Math.random() * 250) }, body };
}
function fakeRes() {
  const r = { _status: null, _json: null };
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  return r;
}

async function run() {
  const validToolId = registry.tools[0].tool_id;
  const generateMission = require(genMissionPath);
  const refine = require(refinePath);

  // 0. Architecture seam sanity: request context resolves without any auth
  //    system wired up, and never fabricates an identity from thin air.
  {
    const ctx = await getRequestContext(fakeReq({}));
    ok('request-context: anonymous by default, no invented user id', ctx.userId === null && ctx.isAuthenticated === false && ctx.plan === 'anonymous');
  }

  // 1. Missing input -> 400
  {
    const req = fakeReq({});
    const res = fakeRes();
    await generateMission(req, res);
    ok('generate-mission: missing idea/type -> 400', res._status === 400);
  }

  // 2. Happy path with a valid tool_id from the registry
  {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              title: 'Test Mission',
              tags: ['Test'],
              steps: [{
                step: 1, title: 'Do the thing', purpose: 'Because testing',
                tool_id: validToolId, tool_name: registry.tools[0].name,
                why_this_tool: 'It is registered', instructions: 'Do it',
                prompt: 'Please do the thing', estimated_time: '10 min',
                estimated_cost: 'Free', difficulty: 'beginner', output: 'A thing',
              }],
              output: { title: 'Done', desc: 'It is done', items: ['A thing'] },
            }),
          },
        }],
      }),
    });
    const req = fakeReq({ idea: 'test idea', type: 'content', level: 'explorer', budget: 'free' });
    const res = fakeRes();
    await generateMission(req, res);
    ok('generate-mission: valid response -> 200', res._status === 200);
    ok('generate-mission: step enriched with registry url', res._json && res._json.steps[0].url === registry.tools[0].url);
    ok('generate-mission: response carries a mission_id (persistence-ready)', typeof res._json.mission_id === 'string' && res._json.mission_id.length > 0);
    ok('generate-mission: saved is explicitly false (no DB wired up yet)', res._json.saved === false);
    ok('generate-mission: plan reflects anonymous context', res._json.plan === 'anonymous');
  }

  // 3. Model hallucinates an unregistered tool_id -> rejected, not passed through
  {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              title: 'Bad Mission',
              tags: ['Test'],
              steps: [{
                step: 1, title: 'X', purpose: 'Y', tool_id: 'totally-made-up-tool',
                tool_name: 'Fake Tool', why_this_tool: 'z', instructions: 'z',
                prompt: 'z', estimated_time: '1 min', estimated_cost: 'Free',
                difficulty: 'beginner', output: 'z',
              }],
              output: { title: 'Done', desc: 'z', items: ['z'] },
            }),
          },
        }],
      }),
    });
    const req = fakeReq({ idea: 'test idea 2' });
    const res = fakeRes();
    await generateMission(req, res);
    ok('generate-mission: hallucinated tool_id -> rejected (502)', res._status === 502 && res._json.error === 'unknown_tool_id');
  }

  // 4. Upstream OpenAI error -> graceful 502, not a crash
  {
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) });
    const req = fakeReq({ idea: 'test idea 3' });
    const res = fakeRes();
    await generateMission(req, res);
    ok('generate-mission: upstream failure -> 502, no throw', res._status === 502);
  }

  // 5. No API key configured -> 500 with clear error, not a crash
  {
    delete process.env.OPENAI_API_KEY;
    const req = fakeReq({ idea: 'x' });
    const res = fakeRes();
    await generateMission(req, res);
    ok('generate-mission: no OPENAI_API_KEY -> 500 server_not_configured', res._status === 500 && res._json.error === 'server_not_configured');
    process.env.OPENAI_API_KEY = 'test-key';
  }

  // 6. refine.js happy path
  {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'A refined prompt.' } }] }),
    });
    const req = fakeReq({ idea: 'x', stepName: 'Step', templatePrompt: 'do x' });
    const res = fakeRes();
    await refine(req, res);
    ok('refine: happy path -> 200 with refined text', res._status === 200 && res._json.refined === 'A refined prompt.');
  }

  // 7. Wrong HTTP method rejected
  {
    const req = { method: 'GET' };
    const res = fakeRes();
    await refine(req, res);
    ok('refine: GET -> 405', res._status === 405);
  }

  // 8-14. /api/projects and /api/projects/[id] — the account-gated
  // persistence layer added for Supabase. Backed by the same in-memory
  // mock as dev-server.js/e2e-test.js, routed through global.fetch so
  // api/lib/supabase-server.js's real request-building runs unmocked.
  {
    global.fetch = supabaseFetchMock;
    supabaseMock.resetSupabaseMock();
    const createProjects = require(projectsPath);
    const projectById = require(projectByIdPath);

    const signup = supabaseMock.authSignUp({ email: 'smoke@example.com', password: 'hunter22' });
    const token = signup.body.access_token;

    function projReq(method, body, opts) {
      return {
        method,
        url: '/api/projects' + (opts && opts.id ? '/' + opts.id : ''),
        headers: Object.assign({}, opts && opts.auth ? { authorization: 'Bearer ' + token } : {}),
        body,
      };
    }

    // 8. Unauthenticated -> 401
    {
      const req = projReq('GET', undefined, {});
      const res = fakeRes();
      await createProjects(req, res);
      ok('projects: unauthenticated GET -> 401', res._status === 401 && res._json.error === 'auth_required');
    }

    // 9. Authenticated, no projects yet
    {
      const req = projReq('GET', undefined, { auth: true });
      const res = fakeRes();
      await createProjects(req, res);
      ok('projects: authenticated GET -> 200 with empty list + profile', res._status === 200 && Array.isArray(res._json.projects) && res._json.projects.length === 0 && res._json.profile.plan === 'free');
    }

    // 10. POST missing mission -> 400
    {
      const req = projReq('POST', { idea: 'launch a podcast' }, { auth: true });
      const res = fakeRes();
      await createProjects(req, res);
      ok('projects: POST missing mission -> 400', res._status === 400 && res._json.error === 'missing_input');
    }

    // 11. POST valid -> creates project + mission snapshot ("Save Project")
    let savedProjectId = null;
    {
      const mission = { title: 'Podcast Launch', steps: [{ step: 1, title: 'X' }], output: { title: 'Done', desc: 'z', items: ['z'] } };
      const req = projReq('POST', { idea: 'launch a podcast', type: 'content', level: 'explorer', budget: 'free', mission }, { auth: true });
      const res = fakeRes();
      await createProjects(req, res);
      savedProjectId = res._json && res._json.project && res._json.project.id;
      ok('projects: POST valid -> 200 with project + mission rows', res._status === 200 && !!savedProjectId && res._json.mission.workflow_json.title === 'Podcast Launch');
    }

    // 12. GET /api/projects now lists the saved project
    {
      const req = projReq('GET', undefined, { auth: true });
      const res = fakeRes();
      await createProjects(req, res);
      ok('projects: saved project now appears in list', res._json.projects.length === 1 && res._json.projects[0].id === savedProjectId);
    }

    // 13. GET /api/projects/:id -> what "Resume" needs
    {
      const req = projReq('GET', undefined, { auth: true, id: savedProjectId });
      const res = fakeRes();
      await projectById(req, res);
      ok('projects/[id]: GET -> project + latest mission for resume', res._status === 200 && res._json.project.id === savedProjectId && res._json.mission.workflow_json.title === 'Podcast Launch');
    }

    // 14. PATCH /api/projects/:id -> "Save Current Progress"
    {
      const req = projReq('PATCH', { current_node: 3 }, { auth: true, id: savedProjectId });
      const res = fakeRes();
      await projectById(req, res);
      ok('projects/[id]: PATCH updates current_node', res._status === 200 && res._json.project.current_node === 3);
    }

    // 15. Unauthenticated /api/projects/:id -> 401 (RLS is the real backstop
    //     in production; this just confirms the handler itself gates too)
    {
      const req = projReq('GET', undefined, { id: savedProjectId });
      const res = fakeRes();
      await projectById(req, res);
      ok('projects/[id]: unauthenticated GET -> 401', res._status === 401);
    }
  }

  // 16-18. /api/config — must expose exactly the two public Supabase values
  // + configured, nothing else, ever (see api/config.js's own header comment
  // for why this must never grow into a generic env-var passthrough).
  {
    const getConfig = require(configPath);

    const req = { method: 'GET' };
    const res = fakeRes();
    await getConfig(req, res);
    ok('config: GET -> 200', res._status === 200);
    ok('config: configured reflects the test SUPABASE_URL/SUPABASE_ANON_KEY being set', res._json.configured === true);
    ok('config: supabaseUrl matches the configured env var', res._json.supabaseUrl === process.env.SUPABASE_URL);
    ok('config: supabaseAnonKey matches the configured env var', res._json.supabaseAnonKey === process.env.SUPABASE_ANON_KEY);
    const keys = Object.keys(res._json).sort();
    ok('config: response has ONLY supabaseUrl/supabaseAnonKey/configured — no other fields', keys.join(',') === 'configured,supabaseAnonKey,supabaseUrl');
    const serialized = JSON.stringify(res._json);
    ok('config: no OPENAI_API_KEY leak', !serialized.includes(process.env.OPENAI_API_KEY));

    const postReq = { method: 'POST' };
    const postRes = fakeRes();
    await getConfig(postReq, postRes);
    ok('config: POST -> 405', postRes._status === 405);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
