// Full end-to-end verification of the production flow, driven by a real
// headless browser against the real index.html + real api/*.js handlers.
// Only the outbound OpenAI network call is mocked (via test/dev-server.js's
// fetch shim) — everything else (browser DOM, real HTTP requests, real JSON
// parsing, real schema validation, real tool-registry checks, real
// rendering code) runs exactly as it will in production.
//
// Run with: node test/e2e-test.js
// Requires: npm i -D playwright   (or a global playwright install)

const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const PORT = 8787;
const BASE = `http://localhost:${PORT}`;
const CHROME_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let passed = 0, failed = 0;
const results = [];
function ok(label, cond, detail) {
  if (cond) { passed++; results.push({ label, pass: true }); console.log('  PASS -', label); }
  else { failed++; results.push({ label, pass: false, detail }); console.error('  FAIL -', label, detail ? '(' + detail + ')' : ''); }
}

// This local harness runs with no internet egress, so Google Fonts fail to
// load here purely because of that — they load fine on a real deployment.
// (The real Supabase CDN script would fail the same way; dev-server.js
// swaps it for a local same-origin stub — see test/supabase-stub.js — so
// that particular gap doesn't apply here.) Filter this specific, known,
// environment-only noise out so a real regression in Hydra's own code
// isn't lost in it.
const KNOWN_SANDBOX_NOISE = [
  'ERR_TUNNEL_CONNECTION_FAILED',       // no internet egress in this sandbox (Google Fonts)
  '404 (Not Found)',                    // no favicon.ico route on the local test server
  '502 (Bad Gateway)',                  // Chrome's own network-tab log of the DELIBERATE failure we're testing in this block — not a JS bug
];
function realErrors(errs) {
  return errs.filter((e) => !KNOWN_SANDBOX_NOISE.some((n) => e.includes(n)));
}

function setMock(mock) {
  return fetch(`${BASE}/__test__/mock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mock),
  });
}

function mkStep(step, title, tool_id, tool_name, output) {
  return {
    step, title, purpose: `Purpose of ${title}`, tool_id, tool_name,
    why_this_tool: `${tool_name} fits this node given the mission's type/expertise/budget.`,
    instructions: `Do the following in ${tool_name}: ${title}.`,
    prompt: `Please help me with: ${title}`,
    estimated_time: '30 min', estimated_cost: 'Free', difficulty: 'beginner',
    output,
  };
}

// The 5 realistic test missions asked for — same idea/type/level/budget
// combos are documented in README-openai-setup.md for re-running against
// the REAL OpenAI API after deployment.
const TEST_MISSIONS = [
  {
    name: 'Cinematic book trailer (beginner, free)',
    idea: 'A 30-second cinematic trailer for my fantasy book',
    type: 'content', level: 'explorer', budget: 'free',
    mission: {
      title: 'AI Book Trailer Pipeline', tags: ['Video', 'Book Marketing'],
      steps: [
        mkStep(1, 'Write the Trailer Script', 'claude', 'Claude', 'A 30-second script'),
        mkStep(2, 'Generate Key Art', 'adobe_firefly', 'Adobe Firefly', 'Character/scene art'),
        mkStep(3, 'Generate Video Clips', 'pika', 'Pika', 'Short cinematic clips'),
        mkStep(4, 'Record Narration', 'elevenlabs', 'ElevenLabs', 'Voiceover track'),
        mkStep(5, 'Edit Final Trailer', 'capcut', 'CapCut', 'Finished 30s trailer'),
      ],
      output: { title: 'Published Book Trailer', desc: 'A finished 30-second trailer.', items: ['🎬 Trailer', '🖼 Key art', '🎙 Narration'] },
    },
  },
  {
    name: 'Expense report automation (intermediate, startup budget)',
    idea: 'Automate my weekly expense report from Gmail receipts',
    type: 'auto', level: 'builder', budget: 'startup',
    mission: {
      title: 'Automated Expense Reporting', tags: ['Automation', 'Finance'],
      steps: [
        mkStep(1, 'Trigger on New Receipt Email', 'zapier', 'Zapier', 'Configured email trigger'),
        mkStep(2, 'Extract Line Items', 'chatgpt', 'ChatGPT', 'Structured expense data'),
        mkStep(3, 'Log to Tracking Doc', 'notion', 'Notion', 'Updated expense log'),
      ],
      output: { title: 'Running Expense Automation', desc: 'Receipts auto-logged weekly.', items: ['⚡ Automation', '📊 Expense log'] },
    },
  },
  {
    name: 'Freelancer billing micro-SaaS (advanced, pro budget)',
    idea: 'Launch a micro-SaaS billing reminder tool for freelancers',
    type: 'business', level: 'architect', budget: 'pro',
    mission: {
      title: 'Billing Reminder SaaS', tags: ['SaaS', 'Coding'],
      steps: [
        mkStep(1, 'Write Product Spec', 'claude', 'Claude', 'Feature + data spec'),
        mkStep(2, 'Build the App', 'cursor', 'Cursor', 'Working MVP codebase'),
        mkStep(3, 'Set Up Database & Auth', 'supabase', 'Supabase', 'Backend ready'),
        mkStep(4, 'Deploy', 'vercel', 'Vercel', 'Live production URL'),
        mkStep(5, 'Set Up CI', 'github_actions', 'GitHub Actions', 'Automated deploy pipeline'),
      ],
      output: { title: 'Live Micro-SaaS', desc: 'Deployed billing reminder tool.', items: ['🚀 Live app', '🗄 Database', '🔁 CI/CD'] },
    },
  },
  {
    name: 'True crime podcast (beginner, free)',
    idea: 'Start a true crime storytelling podcast',
    type: 'audio', level: 'explorer', budget: 'free',
    mission: {
      title: 'True Crime Podcast Launch', tags: ['Podcast', 'Audio'],
      steps: [
        mkStep(1, 'Research Cases', 'perplexity', 'Perplexity AI', 'Case research notes'),
        mkStep(2, 'Write Episode Script', 'claude', 'Claude', 'Full episode script'),
        mkStep(3, 'Record Episode', 'riverside', 'Riverside.fm', 'Raw recording'),
        mkStep(4, 'Edit Episode', 'descript', 'Descript', 'Edited episode'),
        mkStep(5, 'Promote Clips', 'buffer', 'Buffer', 'Scheduled promo posts'),
      ],
      output: { title: 'Published Episode', desc: 'A produced, promoted episode.', items: ['🎙 Episode', '📱 Promo clips'] },
    },
  },
  {
    name: 'Personal finance tracker web app (advanced, pro budget)',
    idea: 'Build and deploy a personal finance tracker web app',
    type: 'coding', level: 'architect', budget: 'pro',
    mission: {
      title: 'Finance Tracker App', tags: ['Coding', 'Web App'],
      steps: [
        mkStep(1, 'Write Technical Spec', 'claude', 'Claude', 'Data model + spec'),
        mkStep(2, 'Build the App', 'cursor', 'Cursor', 'Working codebase'),
        mkStep(3, 'Set Up Database', 'supabase', 'Supabase', 'Postgres schema live'),
        mkStep(4, 'Deploy', 'vercel', 'Vercel', 'Live production URL'),
      ],
      output: { title: 'Deployed Finance Tracker', desc: 'Live personal finance web app.', items: ['🚀 Live app', '🗄 Database'] },
    },
  },
];

async function run() {
  const devServerPath = path.join(__dirname, 'dev-server.js');
  delete require.cache[require.resolve(devServerPath)];
  process.env.PORT = String(PORT);
  const server = require(devServerPath);
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.on('listening', resolve);
  });
  console.log(`\nLocal test server up at ${BASE}\n`);

  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  // ---- 1-3, 5-7: five realistic missions through the real UI ----
  for (const tm of TEST_MISSIONS) {
    consoleErrors.length = 0;
    await setMock({ mode: 'success', mission: tm.mission });
    await page.goto(BASE, { waitUntil: 'load' });

    let capturedBody = null;
    const reqPromise = page.waitForRequest((req) => req.url().includes('/api/generate-mission') && req.method() === 'POST');

    await page.fill('#mission-input', tm.idea);
    await page.click(`.type-btn[data-id="${tm.type}"]`);
    await page.locator('#level-grid .stk-btn', { hasText: levelLabel(tm.level) }).click();
    await page.locator('#budget-grid .stk-btn', { hasText: budgetLabel(tm.budget) }).click();
    await page.click('#btn-generate');

    const req = await reqPromise;
    capturedBody = JSON.parse(req.postData());

    ok(`[${tm.name}] idea sent correctly`, capturedBody.idea === tm.idea);
    ok(`[${tm.name}] type sent correctly`, capturedBody.type === tm.type);
    ok(`[${tm.name}] level (expertise) sent correctly`, capturedBody.level === tm.level);
    ok(`[${tm.name}] budget sent correctly`, capturedBody.budget === tm.budget);

    await page.waitForSelector('#mission-output:not([hidden])', { timeout: 5000 });
    const nodeCount = await page.locator('#node-timeline .node-row').count();
    ok(`[${tm.name}] rendered node count matches mission (${tm.mission.steps.length})`, nodeCount === tm.mission.steps.length, `got ${nodeCount}`);

    const mbName = await page.locator('#mb-name').textContent();
    ok(`[${tm.name}] mission name/idea rendered`, mbName.trim() === tm.idea);

    const firstNodeTool = await page.locator('#node-timeline .node-row').first().locator('.node-tool').textContent();
    ok(`[${tm.name}] first node shows correct registry tool`, firstNodeTool.includes(tm.mission.steps[0].tool_name));

    ok(`[${tm.name}] no console errors during render`, realErrors(consoleErrors).length === 0, realErrors(consoleErrors).join(' | '));
  }

  // ---- 5 (again, adversarial) + 10: hallucinated tool_id -> rejected -> fallback ----
  {
    consoleErrors.length = 0;
    await setMock({ mode: 'bad_tool_id' });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.fill('#mission-input', 'A weird idea to trigger a bad tool id');
    await page.click('.type-btn[data-id="content"]');
    await page.click('#btn-generate');
    await page.waitForSelector('#mission-output:not([hidden])', { timeout: 5000 });
    const nodeCount = await page.locator('#node-timeline .node-row').count();
    // The mocked "bad" mission has exactly 1 step; a real static WORKFLOWS
    // fallback always has 6. Seeing 6 proves the server rejected the
    // hallucinated tool_id AND the frontend fell back cleanly.
    ok('hallucinated tool_id: server rejects it (frontend falls back to static 6-step workflow)', nodeCount === 6, `got ${nodeCount} nodes`);
    ok('hallucinated tool_id fallback: no console errors / UI did not break', realErrors(consoleErrors).length === 0, realErrors(consoleErrors).join(' | '));
  }

  // ---- 10 (again): upstream OpenAI failure -> fallback ----
  {
    consoleErrors.length = 0;
    await setMock({ mode: 'upstream_error' });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.fill('#mission-input', 'Start a youtube channel about vintage cars');
    await page.click('#btn-generate');
    await page.waitForSelector('#mission-output:not([hidden])', { timeout: 5000 });
    const nodeCount = await page.locator('#node-timeline .node-row').count();
    ok('OpenAI upstream failure: frontend falls back and still renders a mission', nodeCount > 0, `got ${nodeCount} nodes`);
    ok('OpenAI upstream failure fallback: no console errors / UI did not break', realErrors(consoleErrors).length === 0, realErrors(consoleErrors).join(' | '));

    const btn = await page.locator('#btn-generate');
    const disabled = await btn.getAttribute('disabled');
    ok('Generate button re-enabled after fallback (not stuck on "Generating…")', disabled === null);
  }

  // ---- 8: Ask Hydra uses the same backend ----
  {
    consoleErrors.length = 0;
    const askMission = TEST_MISSIONS[1].mission; // reuse the automation mission
    await setMock({ mode: 'success', mission: askMission });
    await page.goto(BASE, { waitUntil: 'load' });

    const reqPromise = page.waitForRequest((req) => req.url().includes('/api/generate-mission') && req.method() === 'POST');
    await page.fill('#ask-hydra-input', 'automate my expense reports');
    await page.click('#ask-hydra-btn');
    const req = await reqPromise;
    const body = JSON.parse(req.postData());
    ok('Ask Hydra: calls /api/generate-mission (same backend)', body.idea === 'automate my expense reports');

    await page.waitForSelector('#ask-hydra-output:not([hidden])', { timeout: 5000 });
    const liCount = await page.locator('.ask-output-list li').count();
    ok('Ask Hydra: renders steps from the real orchestrator response', liCount === askMission.steps.length, `got ${liCount}`);
    ok('Ask Hydra: no console errors', realErrors(consoleErrors).length === 0, realErrors(consoleErrors).join(' | '));
  }

  // ---- 9: refine.js works end-to-end through the exec panel ----
  {
    consoleErrors.length = 0;
    await setMock({ mode: 'success', mission: TEST_MISSIONS[0].mission });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.fill('#mission-input', TEST_MISSIONS[0].idea);
    await page.click('#btn-generate');
    await page.waitForSelector('#mission-output:not([hidden])', { timeout: 5000 });

    await page.locator('#node-timeline .node-row').first().locator('.btn-execute').click();
    await page.waitForSelector('#exec-panel.open', { timeout: 5000 });
    const before = await page.locator('#exec-prompt').textContent();

    const REFINED_MARKER = 'REFINED_MARKER_XYZ_' + Date.now();
    await setMock({ mode: 'success', mission: TEST_MISSIONS[0].mission, refined: REFINED_MARKER });
    const refinePromise = page.waitForRequest((req) => req.url().includes('/api/refine') && req.method() === 'POST');
    await page.click('#exec-refine');
    const refineReq = await refinePromise;
    const refineBody = JSON.parse(refineReq.postData());
    ok('refine.js: receives idea/stepName/templatePrompt', !!refineBody.idea && !!refineBody.stepName && !!refineBody.templatePrompt);

    await page.waitForFunction(
      (marker) => document.getElementById('exec-prompt').textContent.includes(marker),
      REFINED_MARKER,
      { timeout: 5000 }
    );
    const after = await page.locator('#exec-prompt').textContent();
    ok('refine.js: exec panel prompt updates with the refined text', after.includes(REFINED_MARKER) && after !== before);
    ok('refine.js: no console errors', realErrors(consoleErrors).length === 0, realErrors(consoleErrors).join(' | '));

    await page.screenshot({ path: path.join(__dirname, 'e2e-screenshot-refined-node.png') });
  }

  // ---- Supabase-backed workspace: the full required flow —
  //      SIGN UP -> LOGIN -> CREATE MISSION -> SAVE PROJECT ->
  //      SAVE CURRENT PROGRESS -> LOG OUT -> LOG BACK IN ->
  //      SEE MY PROJECTS -> RESUME LAST WORKFLOW STEP.
  // Backed by test/supabase-mock.js via dev-server.js (real Auth + PostgREST
  // HTTP calls on both the browser side, through test/supabase-stub.js
  // swapped in for the CDN script, and the server side, through
  // api/lib/supabase-server.js) — nothing about this test bypasses the real
  // request paths, only the far end (an actual Supabase project) is faked.
  {
    consoleErrors.length = 0;
    await fetch(`${BASE}/__test__/reset`, { method: 'POST' });
    const workspaceMission = TEST_MISSIONS[3].mission; // True Crime Podcast, 5 steps
    await setMock({ mode: 'success', mission: workspaceMission });
    await page.goto(BASE, { waitUntil: 'load' });

    const email = `hydra.tester.${Date.now()}@example.com`;
    const password = 'hunter22-test';

    // SIGN UP
    await page.click('[data-target="workspace"]');
    await page.fill('#ws-email', email);
    await page.fill('#ws-password', password);
    await page.click('#ws-signup-btn');
    await page.waitForSelector('#ws-signed-in:not([hidden])', { timeout: 5000 });
    const shownEmail = await page.locator('#ws-user-email').textContent();
    ok('Workspace: sign up logs the new user in', shownEmail.trim() === email);
    const plan = await page.locator('#ws-plan').textContent();
    ok('Workspace: new profile defaults to free plan', plan.trim() === 'free');

    // CREATE MISSION
    await page.fill('#mission-input', TEST_MISSIONS[3].idea);
    await page.click('#btn-generate');
    await page.waitForSelector('#mission-output:not([hidden])', { timeout: 5000 });

    // SAVE PROJECT
    await page.click('#ws-save-btn');
    await page.waitForFunction(
      () => (document.getElementById('ws-save-msg').textContent || '').startsWith('Saved'),
      { timeout: 5000 }
    );
    await page.waitForSelector('.ws-resume-btn', { timeout: 5000 });
    let resumeButtons = await page.locator('.ws-resume-btn').count();
    ok('Workspace: saved project appears in My Projects', resumeButtons === 1, `got ${resumeButtons}`);

    // SAVE CURRENT PROGRESS — advancing a node PATCHes the open project.
    const patchPromise = page.waitForRequest((req) => /\/api\/projects\/[^/]+$/.test(req.url()) && req.method() === 'PATCH');
    await page.click('#pipe-next');
    const patchReq = await patchPromise;
    const patchBody = JSON.parse(patchReq.postData());
    ok('Workspace: advancing a node saves progress via PATCH', patchBody.current_node === 2);

    // LOG OUT
    await page.click('#ws-logout-btn');
    await page.waitForSelector('#ws-signed-out:not([hidden])', { timeout: 5000 });
    const projectsHiddenAfterLogout = await page.getAttribute('#ws-projects-card', 'hidden');
    ok('Workspace: logging out hides the projects panel', projectsHiddenAfterLogout !== null);

    // LOG BACK IN
    await page.fill('#ws-email', email);
    await page.fill('#ws-password', password);
    await page.click('#ws-login-btn');
    await page.waitForSelector('#ws-signed-in:not([hidden])', { timeout: 5000 });

    // SEE MY PROJECTS
    await page.waitForSelector('.ws-resume-btn', { timeout: 5000 });
    resumeButtons = await page.locator('.ws-resume-btn').count();
    ok('Workspace: project still there after logging back in', resumeButtons === 1, `got ${resumeButtons}`);

    // RESUME LAST WORKFLOW STEP
    const getPromise = page.waitForRequest((req) => /\/api\/projects\/[^/]+$/.test(req.url()) && req.method() === 'GET');
    await page.click('.ws-resume-btn');
    await getPromise;
    await page.waitForSelector('#mission-output:not([hidden])', { timeout: 5000 });
    const nodeCountResumed = await page.locator('#node-timeline .node-row').count();
    ok('Workspace: resume redraws the saved mission', nodeCountResumed === workspaceMission.steps.length, `got ${nodeCountResumed}`);
    const activeNode = await page.locator('.pipe-node.active').getAttribute('data-n');
    ok('Workspace: resume restores the last workflow step (node 2)', activeNode === '2', `got node ${activeNode}`);

    ok('Workspace: no console errors across the full auth/save/resume flow', realErrors(consoleErrors).length === 0, realErrors(consoleErrors).join(' | '));
  }

  // ---- Anonymous generation still works with no account at all (the
  //      explicit product decision: login is required to save/see projects,
  //      never to generate a mission in the first place) ----
  {
    consoleErrors.length = 0;
    await setMock({ mode: 'success', mission: TEST_MISSIONS[0].mission });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.fill('#mission-input', TEST_MISSIONS[0].idea);
    await page.click('#btn-generate');
    await page.waitForSelector('#mission-output:not([hidden])', { timeout: 5000 });
    const nodeCount = await page.locator('#node-timeline .node-row').count();
    ok('Anonymous generation still works with no account', nodeCount === TEST_MISSIONS[0].mission.steps.length, `got ${nodeCount}`);
    const saveBtnHidden = await page.getAttribute('#ws-save-btn', 'hidden');
    ok('Anonymous visitor never sees the Save Project button', saveBtnHidden !== null);
    ok('Anonymous generation: no console errors', realErrors(consoleErrors).length === 0, realErrors(consoleErrors).join(' | '));
  }

  await browser.close();
  server.close();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

function levelLabel(id) {
  return { explorer: 'Explorer', builder: 'Builder', architect: 'Architect' }[id];
}
function budgetLabel(id) {
  return { free: 'Free', startup: 'Startup', pro: 'Professional' }[id];
}

run().catch((err) => { console.error('E2E RUNNER CRASHED:', err); process.exit(1); });
