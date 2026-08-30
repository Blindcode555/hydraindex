// Shapes and persists mission/project data. Separated from orchestrator.js
// so the OpenAI logic never needs to know about storage, and separated from
// the HTTP handlers so this is the only file that talks to Supabase.
//
// Two distinct things happen here, on purpose:
//   1. buildMissionRecord/saveMission/getMissionHistory — per-generation
//      bookkeeping called from generate-mission.js on EVERY generation,
//      logged-in or not. saveMission stays a no-op: generating a mission is
//      not the same thing as saving a project. This keeps
//      /api/generate-mission's behavior completely unchanged by adding
//      Supabase — it still just generates.
//   2. getProfile/listProjects/createProject/getProjectWithLatestMission/
//      updateProjectProgress — real persistence, used only by the new
//      /api/projects endpoints, which require a verified user
//      (context.isAuthenticated). This is where "CREATE MISSION -> SAVE
//      PROJECT -> SAVE CURRENT PROGRESS -> ... -> RESUME" actually lives.

const crypto = require('crypto');
const { pgClient } = require('./supabase-server');

function buildMissionRecord({ idea, type, level, budget, mission, context, model }) {
  return {
    id: crypto.randomUUID(),
    user_id: context.userId, // null for anonymous generations
    idea,
    type: type || null,
    level: level || null,
    budget: budget || null,
    title: mission.title,
    tags: mission.tags || [],
    steps: mission.steps,
    output: mission.output,
    model,
    created_at: new Date().toISOString(),
  };
}

async function saveMission(record) {
  return { id: record.id, saved: false };
}

async function getMissionHistory(context) {
  void context;
  return [];
}

function requireClient(context) {
  if (!context.isAuthenticated || !context.accessToken) {
    const err = new Error('not_authenticated');
    err.code = 'not_authenticated';
    throw err;
  }
  return pgClient(context.accessToken);
}

async function getProfile(context) {
  const client = requireClient(context);
  return client.request('profiles', {
    query: `?id=eq.${encodeURIComponent(context.userId)}&select=email,display_name,plan,hydra_credit_balance`,
    single: true,
  });
}

async function listProjects(context) {
  const client = requireClient(context);
  return client.request('projects', {
    query: `?user_id=eq.${encodeURIComponent(context.userId)}` +
      `&select=id,title,original_idea,type,expertise,budget,status,current_node,created_at,updated_at` +
      `&order=updated_at.desc`,
  });
}

// Creates a project and its first mission snapshot together — this is the
// explicit "Save Project" action, distinct from generation itself.
async function createProject(context, { idea, type, level, budget, mission }) {
  const client = requireClient(context);

  const project = await client.request('projects', {
    method: 'POST',
    single: true,
    body: [{
      user_id: context.userId,
      title: mission.title || idea,
      original_idea: idea,
      type: type || null,
      expertise: level || null,
      budget: budget || null,
      status: 'active',
      current_node: 1,
    }],
  });

  const missionRow = await client.request('missions', {
    method: 'POST',
    single: true,
    body: [{ project_id: project.id, workflow_json: mission }],
  });

  return { project, mission: missionRow };
}

// Fetches a project plus its most recent mission snapshot — what "Resume"
// needs to redraw the node timeline and jump to the right step.
async function getProjectWithLatestMission(context, projectId) {
  const client = requireClient(context);

  const project = await client.request('projects', {
    query: `?id=eq.${encodeURIComponent(projectId)}&select=*`,
    single: true,
  });
  if (!project) return null;

  const missions = await client.request('missions', {
    query: `?project_id=eq.${encodeURIComponent(projectId)}&select=*&order=updated_at.desc&limit=1`,
  });

  return { project, mission: (missions && missions[0]) || null };
}

// The explicit "Save Current Progress" action — updates which node the user
// is on (and optionally status), nothing else.
async function updateProjectProgress(context, projectId, { current_node, status }) {
  const client = requireClient(context);

  const patch = { updated_at: new Date().toISOString() };
  if (Number.isInteger(current_node)) patch.current_node = current_node;
  if (typeof status === 'string') patch.status = status;

  const project = await client.request('projects', {
    method: 'PATCH',
    query: `?id=eq.${encodeURIComponent(projectId)}`,
    single: true,
    body: patch,
  });

  return { project };
}

module.exports = {
  buildMissionRecord,
  saveMission,
  getMissionHistory,
  getProfile,
  listProjects,
  createProject,
  getProjectWithLatestMission,
  updateProjectProgress,
};
