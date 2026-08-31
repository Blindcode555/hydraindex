// GET   /api/projects/:id -> { project, mission } — what "Resume" needs to
//                             redraw the node timeline and jump to the
//                             right step.
// PATCH /api/projects/:id -> { current_node?, status? } — the explicit
//                             "Save Current Progress" action as the user
//                             moves through the workflow.
//
// Requires a verified Supabase session, same as /api/projects. RLS on the
// `projects`/`missions` tables is what actually prevents one user from
// reading or updating another user's project — this handler doesn't need to
// (and doesn't) re-check ownership itself.

const { getRequestContext } = require('../_lib/request-context');
const { getProjectWithLatestMission, updateProjectProgress } = require('../_lib/mission-store');

function extractId(req) {
  if (req.query && req.query.id) return req.query.id; // Vercel populates this for [id].js
  const match = /\/api\/projects\/([^/?]+)/.exec(req.url || '');
  return match ? decodeURIComponent(match[1]) : null;
}

module.exports = async (req, res) => {
  const context = await getRequestContext(req);
  if (!context.isAuthenticated) {
    res.status(401).json({ error: 'auth_required' });
    return;
  }

  const id = extractId(req);
  if (!id) {
    res.status(400).json({ error: 'missing_id' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const result = await getProjectWithLatestMission(context, id);
      if (!result || !result.project) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.status(200).json(result);
    } catch (err) {
      res.status(502).json({ error: 'supabase_error', message: String(err && err.message || err) });
    }
    return;
  }

  if (req.method === 'PATCH') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};
    try {
      const result = await updateProjectProgress(context, id, body);
      res.status(200).json(result);
    } catch (err) {
      res.status(502).json({ error: 'supabase_error', message: String(err && err.message || err) });
    }
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
};
