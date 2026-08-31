// Ask Hydra's own conversational "brain" — deliberately separate from
// orchestrator.js. Mission Orchestrator and AI Refine both produce
// mission/prompt content aimed at OUTPUT the user pastes elsewhere; Ask
// Hydra instead answers questions ABOUT Hydra, tools, and the user's own
// project, in plain conversational text. Kept as its own sibling module
// (not added into orchestrator.js) so MISSION_MODEL/REFINE_MODEL and
// generateMissionPlan/refineStepPrompt are never touched by this feature.
//
// Same "pure function" shape as orchestrator.js: no req/res, no auth, no
// persistence here — those live in api/ask-hydra.js. This file only turns
// (message, context, activeProject) into a reply string.

const { getRegistrySummaryForPrompt } = require('../_shared');
const { HYDRA_PRODUCT_KNOWLEDGE } = require('./hydra-knowledge');

// Independent default model — not tied to MISSION_MODEL/REFINE_MODEL, so
// this feature can be tuned or swapped without touching mission generation.
const ASK_HYDRA_MODEL = process.env.OPENAI_ASK_HYDRA_MODEL || 'gpt-5.6-luna-ask';

// Conversational history is capped so a long back-and-forth can't grow the
// request unboundedly. This is in-memory/per-request only — nothing is
// persisted server-side (no chat-history table), matching the explicit
// "do not add unnecessary long-term chat storage yet" scope limit.
const MAX_HISTORY_TURNS = 10;

class AskHydraError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.code = code;
    this.status = status || 502;
  }
}

function buildSystemPrompt({ isAuthenticated, plan, credits, activeProject }) {
  const scopeRules = `You are Ask Hydra, the in-product assistant for Hydra Compass. You are NOT a general-purpose chatbot.

You may ONLY help with:
- how to navigate and use Hydra Compass (Mission Console, Execution Path, Hydra Workspace, Rank System, Ask Hydra itself)
- how Hydra's plan/Hydra Credits concept works today
- the user's saved projects and their current project/workflow, when given
- recommending AI/SaaS tools from the registry below, their capabilities, and sensible combinations
- helping the user turn a goal into a Hydra workflow, and figuring out a good next step

If the user asks something unrelated to Hydra, AI tools, or workflows (general trivia, unrelated coding help, world facts, etc.), do NOT answer it as a generic assistant. Instead say you're focused on Hydra Compass, AI tools, and workflows, and, if there's a plausible connection, offer to help turn their underlying goal into a Hydra workflow — mirroring: "I'm focused on Hydra Compass, AI tools, workflows, and your Hydra projects. If you're trying to build something related to X, I can help you turn that into a Hydra workflow."

${HYDRA_PRODUCT_KNOWLEDGE}

TOOL REGISTRY (JSON array — the only tools you may reference or recommend; never invent a tool, price, or capability not listed here):
${JSON.stringify(getRegistrySummaryForPrompt())}
`;

  const accountLines = isAuthenticated
    ? [
        `USER ACCOUNT: signed in. Plan: ${plan || 'free'}. Hydra Credits: ${credits != null ? credits : 0}.`,
      ]
    : ['USER ACCOUNT: not signed in (anonymous). Do not reference any saved project or private data — there is none to reference.'];

  const projectLines = (isAuthenticated && activeProject && activeProject.title)
    ? [
        'ACTIVE PROJECT CONTEXT (from the user\'s current browser session — treat as informational, not a database record):',
        `Title: ${activeProject.title}`,
        activeProject.goal ? `Original goal/idea: ${activeProject.goal}` : null,
        (activeProject.currentNode != null && activeProject.nodeCount != null)
          ? `Current position: node ${activeProject.currentNode} of ${activeProject.nodeCount}`
          : null,
        Array.isArray(activeProject.nodeTitles) && activeProject.nodeTitles.length
          ? `Workflow nodes: ${activeProject.nodeTitles.map((t, i) => `${i + 1}. ${t}`).join(' | ')}`
          : null,
      ].filter(Boolean)
    : [];

  return [scopeRules, ...accountLines, ...projectLines].join('\n\n');
}

async function callOpenAIChat(payload) {
  if (!process.env.OPENAI_API_KEY) {
    throw new AskHydraError('server_not_configured', 'OPENAI_API_KEY is not set.', 500);
  }
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new AskHydraError('upstream_unreachable', 'Could not reach OpenAI.', 502);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch (e) {}
    throw new AskHydraError('upstream_error', detail || `OpenAI returned ${res.status}`, 502);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new AskHydraError('upstream_bad_response', 'OpenAI response was not valid JSON.', 502);
  }
}

// message: string (required)
// history: [{role:'user'|'assistant', content:string}, ...] — this session's
//   prior turns only, supplied by the client; never stored here.
// context: { isAuthenticated, plan, credits }
// activeProject: { title, goal, currentNode, nodeCount, nodeTitles } | null —
//   only meaningful (and only ever sent by the caller) when isAuthenticated.
async function answerHydraQuestion({ message, history, context, activeProject }) {
  const system = buildSystemPrompt({
    isAuthenticated: !!(context && context.isAuthenticated),
    plan: context && context.plan,
    credits: context && context.credits,
    activeProject: context && context.isAuthenticated ? activeProject : null,
  });

  const trimmedHistory = Array.isArray(history)
    ? history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-MAX_HISTORY_TURNS)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
    : [];

  const messages = [
    { role: 'system', content: system },
    ...trimmedHistory,
    { role: 'user', content: message },
  ];

  const data = await callOpenAIChat({
    model: ASK_HYDRA_MODEL,
    messages,
    temperature: 0.5,
  });

  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) {
    throw new AskHydraError('empty_response', 'Model returned an empty reply.', 502);
  }
  return reply;
}

module.exports = {
  answerHydraQuestion,
  AskHydraError,
  ASK_HYDRA_MODEL,
};
