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

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'local-e2e-test-key-not-real';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let MOCK = { mode: 'success', mission: null, refined: null };

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

// Load handlers AFTER the fetch shim is installed.
const generateMission = require(path.join(ROOT, 'api', 'generate-mission.js'));
const refine = require(path.join(ROOT, 'api', 'refine.js'));

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

const server = http.createServer(async (req, res) => {
  adaptRes(res);
  const pathname = req.url.split('?')[0];

  try {
    if (req.method === 'POST' && pathname === '/__test__/mock') {
      MOCK = await readBody(req);
      res.status(200).json({ ok: true, mock: MOCK.mode });
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
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(ROOT, 'index.html'));
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
      return;
    }
    res.status(404).json({ error: 'not_found' });
  } catch (err) {
    res.status(500).json({ error: 'dev_server_error', message: String(err) });
  }
});

const PORT = process.env.PORT || 8787;
server.listen(PORT, () => console.log('Hydra local test server on http://localhost:' + PORT));
module.exports = server;
