// GET  /api/projects  -> { profile, projects } for the signed-in user.
// POST /api/projects  -> { idea, type, level, budget, mission } creates a
//                         project + its first mission snapshot ("Save
//                         Project" — a separate, explicit action from
//                         generating the mission in the first place).
//
// Requires a verified Supabase session (Authorization: Bearer <token>).
// Unauthenticated requests get 401 — mission generation itself stays
// available to signed-out visitors via /api/generate-mission; only saving
// and viewing projects requires an account.

const { getRequestContext } = require('./_lib/request-context');
const { getProfile, listProjects, createProject } = require('./_lib/mission-store');

module.exports = async (req, res) => {
  const context = await getRequestContext(req);
  if (!context.isAuthenticated) {
    res.status(401).json({ error: 'auth_required' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const [profile, projects] = await Promise.all([getProfile(context), listProjects(context)]);
      res.status(200).json({ profile, projects: projects || [] });
    } catch (err) {
      res.status(502).json({ error: 'supabase_error', message: String(err && err.message || err) });
    }
    return;
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};
    const { idea, type, level, budget, mission } = body;

    if (!idea || !mission || !Array.isArray(mission.steps) || !mission.steps.length) {
      res.status(400).json({ error: 'missing_input', message: 'idea and a generated mission are required.' });
      return;
    }

    try {
      const result = await createProject(context, { idea, type, level, budget, mission });
      res.status(200).json(result);
    } catch (err) {
      res.status(502).json({ error: 'supabase_error', message: String(err && err.message || err) });
    }
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
};
