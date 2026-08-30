// Shapes and (eventually) persists mission records. Separated from
// orchestrator.js so the OpenAI logic never needs to know about storage, and
// separated from the HTTP handlers so storage can move from "no-op" to "a
// real database" without touching request parsing or entitlement checks.
//
// TODAY: saveMission() does not persist anything — there is no database wired
// up for this yet (Supabase is already in the stack for one unrelated insert;
// it's the natural place to add a `missions` table later). It still returns a
// stable mission id and an explicit saved:false so the response shape the
// frontend receives will not change the day persistence is turned on.
//
// LATER, to add real persistence:
//   1. Create a `missions` table (user_id, idea, type, level, budget, title,
//      tags, steps, output, model, created_at) — buildMissionRecord() below
//      already produces exactly this shape.
//   2. Implement saveMission() to insert that record when context.userId is
//      set (skip/no-op for anonymous requests, or store ephemerally if you
//      want anonymous history pre-signup).
//   3. Add getMissionHistory(context) to list a user's past missions, and new
//      endpoints (e.g. /api/missions, /api/missions/:id) that call it — none
//      of which requires changing generate-mission.js or orchestrator.js.

const crypto = require('crypto');

function buildMissionRecord({ idea, type, level, budget, mission, context, model }) {
  return {
    id: crypto.randomUUID(),
    user_id: context.userId, // null today; populated once auth exists
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
  // TODO(persistence): insert `record` into a real store (Supabase table is
  // the natural fit given it's already in this project) once one exists.
  return { id: record.id, saved: false };
}

async function getMissionHistory(context) {
  // TODO(persistence): return this user's saved missions once storage exists.
  void context;
  return [];
}

module.exports = { buildMissionRecord, saveMission, getMissionHistory };
