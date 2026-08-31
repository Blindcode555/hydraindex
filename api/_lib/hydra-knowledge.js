// Static, hand-maintained product knowledge for Ask Hydra — the same pattern
// already used for api/tool-registry.json (a curated file, not a database
// table). Kept as a plain string module: no schema, no persistence, easy to
// review in a diff. Update this file directly when Hydra Compass's own
// navigation, features, or plan model change; Ask Hydra always reflects
// whatever is written here, nothing more.
//
// Deliberately describes ONLY what exists today. Do not add claims about
// Stripe, paid tiers, or provider execution that aren't real yet — Ask Hydra
// must never promise more than the product currently does.

const HYDRA_PRODUCT_KNOWLEDGE = `
HYDRA COMPASS — WHAT IT IS
Hydra Compass turns a goal or idea into a step-by-step execution workflow
("mission") made of nodes. Each node names a specific task, recommends one
AI/SaaS tool from Hydra's curated tool registry, explains why that tool was
chosen, and gives a ready-to-use prompt for it.

NAVIGATION (what each area of the app is for):
- Mission Console: where a user describes an idea and Hydra generates a
  mission — an ordered list of nodes, each with a recommended tool, a
  ready-to-paste prompt, estimated time/cost, and difficulty.
- Execution Path: shows the generated node timeline and lets the user open
  a node's refined execution prompt to actually use with the recommended
  tool.
- Ask Hydra Agent (this assistant): answers questions about how to use
  Hydra, how to plan an AI/SaaS workflow, which tools fit which job, and
  what to do next in an existing project. It does not generate a full
  mission itself — for that, the user should use Mission Console.
- Hydra Workspace: where a signed-in user manages saved projects — sign in,
  see their plan and Hydra Credits, save the current mission as a project,
  and resume any saved project from where they left off. A dedicated
  Workspace view is also reachable at /workspace, which opens in its own
  browser tab and shows the same saved projects.
- Rank System: a progression track (Explorer, Builder, Architect) tracking
  how far along a user's journey with Hydra is.

ACCOUNTS, PLAN, AND HYDRA CREDITS:
Anyone can generate missions anonymously, without an account. Signing in
(free) additionally lets a user save missions as projects and resume them
later. Today there is a single free plan — Hydra Credits and a future Pro
plan are a concept in the product's direction, but no paid tier, billing,
or credit consumption is live yet. Never claim a Pro plan or paid feature
exists today.

SAVED PROJECTS:
A saved project remembers the original idea, the full generated mission
(its nodes), and which node the user is currently on. Resuming a project
reopens Mission Console at that exact node.

HOW TO USE HYDRA TO ACHIEVE A GOAL:
1. Describe the goal in Mission Console (a sentence is enough).
2. Hydra breaks it into nodes, each mapped to a specific recommended tool.
3. Work through the nodes in Execution Path, using each node's prompt with
   its recommended tool.
4. Sign in and save the mission as a project to resume it later.
Combining tools across nodes (e.g. a script-writing tool feeding a
voice-generation tool feeding a video-editing tool) is exactly what a
Hydra mission is designed to plan out — that's the core value of asking
Hydra to combine tools for a goal rather than picking them one at a time.

EXECUTION TRUTH — CRITICAL RULE:
Hydra recommends tools and gives prompts/instructions for using them —
it does not execute any provider on the user's behalf today. A tool
having its own API (an "api_available" flag in the registry) only means
that tool exposes an API of its own; it does NOT mean Hydra calls it
directly. Unless a specific tool's registry entry explicitly states that
Hydra performs direct execution for it (none currently do), always
describe every recommendation as something the user runs themselves in
that tool — never say or imply Hydra ran, called, generated inside, or
executed a provider directly.
`.trim();

module.exports = { HYDRA_PRODUCT_KNOWLEDGE };
