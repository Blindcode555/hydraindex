// Automatic, mission-LEVEL quality gate — runs ONCE per generated mission,
// immediately after generateMissionPlan() returns and before the mission is
// shown to the user. This is deliberately a single extra OpenAI call, not a
// per-node refinement pass: a six-step workflow must not turn into six
// additional OpenAI calls. See README-openai-setup.md's "Automatic Quality
// Gate" section for the full cost/latency reasoning.
//
// Architecture: a sibling to orchestrator.js and ask-hydra.js, not a part
// of either. It never changes how a mission is originally generated —
// generate-mission.js calls generateMissionPlan() exactly as before, then
// separately calls validateMissionQuality() on the result. generate-
// mission.js is responsible for the fail-open contract: if this call throws
// for ANY reason, the original, unmodified mission from generateMissionPlan
// is still what gets shown to the user (see generate-mission.js's own
// try/catch around this call). This module only ever throws — it never
// silently swaps in a different, unrelated workflow itself.
//
// This is a check on REASONING, not wording. It must be able to say "this
// workflow is semantically wrong for what the user asked for" and rebuild
// it around the right domain — not just polish the prompt text of a step
// that shouldn't exist at all.

const {
  getRegistryToolIds,
  getRegistrySummaryForPrompt,
  lookupTool,
} = require('../_shared');
const { buildMissionSchema } = require('./orchestrator');

const QUALITY_MODEL = process.env.OPENAI_QUALITY_MODEL || 'gpt-5.6-luna-quality';

class QualityGateError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function buildQualitySchema(toolIds) {
  const missionSchema = buildMissionSchema(toolIds);
  return {
    name: 'hydra_mission_quality_check',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'reasoning', 'mission'],
      properties: {
        status: {
          type: 'string',
          enum: ['ok', 'corrected'],
          description: '"ok" if the candidate mission already correctly matches the user\'s actual goal, domain, and any explicit selection. "corrected" if you changed it.',
        },
        reasoning: {
          type: 'string',
          description: 'One or two sentences: what you checked, and — if corrected — specifically what was wrong (wrong domain, irrelevant step/tool, generic prompt, contamination from an unrelated category, etc.) and why the fix is right.',
        },
        mission: missionSchema.schema,
      },
    },
  };
}

function buildQualitySystemPrompt(registrySummaryJson) {
  return `You are Hydra's automatic quality gate. A separate process already generated a CANDIDATE mission (an ordered workflow of tool-based steps) for a user's idea. Your ONLY job is to check whether that candidate is actually right for what the user asked for, and correct it if it is not. You are not a copyeditor — you are checking REASONING, not wording. Improving a prompt's phrasing is not enough if the step itself should not exist.

Check the candidate mission against ALL of the following:
A. GOAL ALIGNMENT — does this workflow actually accomplish what the user asked for?
B. DOMAIN ALIGNMENT — does the mission's category/domain match the user's actual intended deliverable (a physical product, written content, software, a video, a business, research, etc.), not just a superficial keyword that happened to appear in the idea text?
C. USER SELECTION — if the user explicitly selected a TYPE, does the mission respect it as a strong constraint rather than silently replacing it with an unrelated domain?
D. STEP RELEVANCE — does every step genuinely contribute to the project's actual goal?
E. TOOL RELEVANCE — is each recommended tool actually appropriate for that specific step's real job?
F. SEQUENCE — are the steps in a sensible execution order?
G. PROMPT QUALITY — is each step's prompt specific to this exact project, not a generic template that could apply to any project?
H. CONTAMINATION — are there any categories, tags, or tools present that look like leftovers from a different, unrelated kind of project?
I. REDUNDANCY — are there unnecessary or duplicate steps?
J. EXECUTION TRUTH — does the mission avoid implying Hydra directly executes a tool/provider on the user's behalf? (It never does — every step is something the user does themselves in the recommended tool.)

If the candidate passes all of these, return status "ok" and return the mission back EXACTLY UNCHANGED — same steps, same tool_ids, same text, same order, same everything. Do not paraphrase or rewrite anything for its own sake when nothing is actually wrong.

If the candidate genuinely fails one or more of these — most importantly A, B, C, D, or H — restructure it; do not merely improve the wording of a step that is wrong for the project. Example: if a physical-product idea was mistakenly turned into a YouTube/video research mission, the fix is to rebuild the workflow around the real primary domain (market/customer research, product requirements, design, prototyping, sourcing/manufacturing, pricing, launch) — not to write a better YouTube research prompt. Video may reappear later only as a clearly-labeled supporting marketing step if it genuinely earns a place, never as the mission's category. Return status "corrected" and the fully corrected mission.

Every tool_id you use, in an unchanged or corrected mission alike, MUST come from this TOOL REGISTRY — never invent one:
${registrySummaryJson}

Return only the structured result as defined by the schema.`;
}

async function callOpenAIChat(payload) {
  if (!process.env.OPENAI_API_KEY) {
    throw new QualityGateError('server_not_configured', 'OPENAI_API_KEY is not set.');
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
    throw new QualityGateError('upstream_unreachable', 'Could not reach OpenAI.');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch (e) {}
    throw new QualityGateError('upstream_error', detail || `OpenAI returned ${res.status}`);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new QualityGateError('upstream_bad_response', 'OpenAI response was not valid JSON.');
  }
}

// Validates (and, if needed, corrects) a fully-generated mission in ONE
// additional OpenAI call. Never throws to signal "the mission needed
// fixing" or "the mission was already fine" — those are both successful
// outcomes, returned as { status, reasoning, mission }. Only throws
// (QualityGateError) when the check itself could not be completed: no API
// key, a network/upstream failure, invalid JSON back, or a "corrected"
// mission that references a tool outside the registry. Callers MUST treat
// a thrown QualityGateError as "quality check unavailable" and keep
// showing the original candidate mission — never as a reason to discard it
// or fall back to an unrelated hardcoded workflow.
async function validateMissionQuality({ idea, type, level, budget, mission }) {
  const toolIds = getRegistryToolIds();
  const schema = buildQualitySchema(toolIds);
  const system = buildQualitySystemPrompt(JSON.stringify(getRegistrySummaryForPrompt()));
  const userMessage = [
    `IDEA: ${idea || '(none given)'}`,
    `TYPE: ${type || '(not specified)'}`,
    `EXPERTISE: ${level || '(not specified)'}`,
    `BUDGET: ${budget || '(not specified)'}`,
    'CANDIDATE MISSION (JSON):',
    JSON.stringify(mission),
  ].join('\n');

  const data = await callOpenAIChat({
    model: QUALITY_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMessage },
    ],
    response_format: { type: 'json_schema', json_schema: schema },
    temperature: 0.3,
  });

  let result;
  try {
    result = JSON.parse(data.choices[0].message.content);
  } catch (e) {
    throw new QualityGateError('invalid_quality_json', 'Quality gate response was not valid JSON.');
  }

  if (result.status !== 'ok' && result.status !== 'corrected') {
    throw new QualityGateError('invalid_quality_status', 'Quality gate returned an unrecognized status.');
  }

  const steps = Array.isArray(result.mission && result.mission.steps) ? result.mission.steps : [];
  const badStep = steps.find((s) => !lookupTool(s.tool_id));
  if (badStep) {
    // A "corrected" mission that references an unregistered tool is worse
    // than not correcting at all — fail the gate (caller falls back to the
    // original mission) rather than show something that was never
    // registry-verified.
    throw new QualityGateError('unknown_tool_id_in_correction', `Quality gate referenced unregistered tool_id "${badStep.tool_id}".`);
  }

  const enrichedSteps = steps.map((s) => {
    const tool = lookupTool(s.tool_id);
    return { ...s, url: tool.url, tool_verified_cost: tool.estimated_cost, tool_free_tier: tool.free_tier };
  });

  return {
    status: result.status,
    reasoning: typeof result.reasoning === 'string' ? result.reasoning.slice(0, 500) : '',
    mission: {
      title: result.mission.title,
      tags: result.mission.tags || [],
      steps: enrichedSteps,
      output: result.mission.output,
    },
  };
}

module.exports = {
  validateMissionQuality,
  QualityGateError,
  QUALITY_MODEL,
};
