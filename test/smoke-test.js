// Offline smoke test for the Hydra backend pipeline:
//   request-context -> entitlements -> orchestrator -> mission-store -> handler
// Mocks global.fetch so no real OpenAI key/network call is needed.
// Run with: node test/smoke-test.js

process.env.OPENAI_API_KEY = 'test-key';

const path = require('path');
const genMissionPath = path.join(__dirname, '..', 'api', 'generate-mission.js');
const refinePath = path.join(__dirname, '..', 'api', 'refine.js');
const { registry } = require(path.join(__dirname, '..', 'api', '_shared.js'));
const { getRequestContext } = require(path.join(__dirname, '..', 'api', 'lib', 'request-context.js'));

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
    const ctx = getRequestContext(fakeReq({}));
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
