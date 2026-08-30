// Hydra's actual "brain": idea + params + tool registry in, structured
// workflow JSON out. Deliberately pure — no req/res, no auth, no rate
// limiting, no entitlement checks, no persistence. Those all live in the
// route handlers and the other lib/ modules so this file never has to change
// when accounts, plans, or billing are added later. It also makes this
// function directly unit-testable and reusable from anywhere (a future batch
// job, an authenticated endpoint, a CLI) without dragging in HTTP concerns.

const {
  getRegistryToolIds,
  getRegistrySummaryForPrompt,
  lookupTool,
} = require('../_shared');

const MISSION_MODEL = process.env.OPENAI_MISSION_MODEL || 'gpt-5.6-luna';
const REFINE_MODEL = process.env.OPENAI_REFINE_MODEL || 'gpt-5.6-luna';

class OrchestratorError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.code = code;
    this.status = status || 502;
  }
}

function buildMissionSchema(toolIds) {
  return {
    name: 'hydra_mission',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'tags', 'steps', 'output'],
      properties: {
        title: { type: 'string', description: 'Short mission name, e.g. "AI Book Trailer Pipeline".' },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          description: 'Ordered execution steps. Use as few or as many as the mission genuinely needs — do not pad to a fixed count.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'step', 'title', 'purpose', 'tool_id', 'tool_name',
              'why_this_tool', 'instructions', 'prompt',
              'estimated_time', 'estimated_cost', 'difficulty', 'output',
            ],
            properties: {
              step: { type: 'integer', minimum: 1 },
              title: { type: 'string' },
              purpose: { type: 'string', description: 'What this step accomplishes and why it exists in this order.' },
              tool_id: { type: 'string', enum: toolIds, description: 'Must be a tool_id from the provided registry. Never invent one.' },
              tool_name: { type: 'string' },
              why_this_tool: { type: 'string', description: 'Why this specific tool fits this node given the mission type/expertise/budget.' },
              instructions: { type: 'string', description: 'Plain-language instructions for what to actually do in the tool.' },
              prompt: { type: 'string', description: 'A ready-to-paste prompt for this step, written for the target tool.' },
              estimated_time: { type: 'string' },
              estimated_cost: { type: 'string', description: 'Approximate cost for THIS step given the chosen tool and budget tier, e.g. "Free" or "~$5".' },
              difficulty: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
              output: { type: 'string', description: 'The concrete artifact this step produces, which feeds the next step.' },
            },
          },
        },
        output: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'desc', 'items'],
          properties: {
            title: { type: 'string' },
            desc: { type: 'string' },
            items: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
          },
        },
      },
    },
  };
}

function buildMissionSystemPrompt(registrySummary) {
  return `You are Hydra's orchestration layer. You are NOT a chatbot answering the user directly — you design an execution workflow.

Given a user's goal plus their TYPE (kind of project), EXPERTISE (beginner/intermediate/advanced), and BUDGET (free/startup/pro), you must:
1. Understand the actual objective.
2. Reason about what CAPABILITIES are required to accomplish it (e.g. scripting, image generation, video generation, voice, editing, publishing) BEFORE picking any tool.
3. Select the best tool for EACH capability/node from the TOOL REGISTRY below — this is the only source of truth for what tools exist, what they cost, and what they're good at. Never invent a tool, price, capability, or URL that isn't in this registry. If nothing in the registry fits a needed capability well, pick the closest reasonable match and say so honestly in why_this_tool rather than inventing something better.
4. Respect EXPERTISE: beginners get fewer nodes, simpler language, more hand-holding, and tools with free_tier=true or a gentle learning curve where reasonable. Advanced users can get more specialized/technical tools, APIs, and automation.
5. Respect BUDGET: if budget is "free", strongly prefer tools with free_tier=true and avoid paid-only tools unless there is truly no free-capable alternative in the registry for a required capability (explain why in why_this_tool if so). If budget is "pro", you may prioritize the highest-quality tool even if paid.
6. Do NOT default to any one provider for every node just because it's convenient — match each node to whichever registry tool is actually best suited for that specific job.
7. The number of steps must fit the mission's real complexity — a simple task may need 1-2 steps, a complex multi-media project may need up to 10. Do not pad the plan to hit a fixed count.
8. Every step needs a genuinely useful, ready-to-use "prompt" field the user can paste into the chosen tool — don't just say "use X", help them actually use it.
9. Each step's "output" should be the concrete artifact that becomes the input to the next step, so the pipeline reads as a coherent chain.

TOOL REGISTRY (JSON array — the only tools you may reference by tool_id):
${JSON.stringify(registrySummary)}

Return only the structured mission as defined by the schema.`;
}

async function callOpenAIChat(payload) {
  if (!process.env.OPENAI_API_KEY) {
    throw new OrchestratorError('server_not_configured', 'OPENAI_API_KEY is not set.', 500);
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
    throw new OrchestratorError('upstream_unreachable', 'Could not reach OpenAI.', 502);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch (e) {}
    throw new OrchestratorError('upstream_error', detail || `OpenAI returned ${res.status}`, 502);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new OrchestratorError('upstream_bad_response', 'OpenAI response was not valid JSON.', 502);
  }
}

// idea/type/level/budget in -> {title, tags, steps, output} out. Every
// tool_id is re-verified against the registry after the call (schema enum
// should already guarantee this, but a model can still misbehave) and
// enriched with the registry's real url/pricing so nothing rendered to the
// user was invented by the model.
async function generateMissionPlan({ idea, type, level, budget }) {
  const toolIds = getRegistryToolIds();
  const schema = buildMissionSchema(toolIds);
  const system = buildMissionSystemPrompt(getRegistrySummaryForPrompt());
  const userMessage = [
    `IDEA: ${idea || '(none given — infer a reasonable default mission for this type)'}`,
    `TYPE: ${type || '(not specified)'}`,
    `EXPERTISE: ${level || '(not specified — assume intermediate)'}`,
    `BUDGET: ${budget || '(not specified — assume startup/moderate)'}`,
  ].join('\n');

  const data = await callOpenAIChat({
    model: MISSION_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMessage },
    ],
    response_format: { type: 'json_schema', json_schema: schema },
    temperature: 0.7,
  });

  let mission;
  try {
    mission = JSON.parse(data.choices[0].message.content);
  } catch (e) {
    throw new OrchestratorError('invalid_mission_json', 'Model response was not valid JSON.', 502);
  }

  const steps = Array.isArray(mission.steps) ? mission.steps : [];
  const badStep = steps.find((s) => !lookupTool(s.tool_id));
  if (badStep) {
    throw new OrchestratorError('unknown_tool_id', `Model referenced unregistered tool_id "${badStep.tool_id}".`, 502);
  }

  const enrichedSteps = steps.map((s) => {
    const tool = lookupTool(s.tool_id);
    return { ...s, url: tool.url, tool_verified_cost: tool.estimated_cost, tool_free_tier: tool.free_tier };
  });

  return { title: mission.title, tags: mission.tags || [], steps: enrichedSteps, output: mission.output };
}

// Refines a single step's prompt. Kept just as pure/context-free as
// generateMissionPlan for the same reasons.
async function refineStepPrompt({ idea, stepName, templatePrompt }) {
  const system = 'You refine a single execution-step prompt for Hydra, an AI workflow orchestrator. ' +
    'Given the project idea, the step name, and a template prompt, rewrite it into a sharper, ' +
    'more specific, ready-to-paste prompt for that step. Be concrete and actionable. ' +
    'Return ONLY the refined prompt text — no preamble, no markdown fences, no explanation.';
  const user = `PROJECT: ${idea}\nSTEP: ${stepName}\nTEMPLATE PROMPT: ${templatePrompt}`;

  const data = await callOpenAIChat({
    model: REFINE_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.6,
  });

  const refined = data.choices?.[0]?.message?.content?.trim();
  if (!refined) {
    throw new OrchestratorError('empty_response', 'Model returned an empty refinement.', 502);
  }
  return refined;
}

module.exports = {
  generateMissionPlan,
  refineStepPrompt,
  OrchestratorError,
  MISSION_MODEL,
  REFINE_MODEL,
};
