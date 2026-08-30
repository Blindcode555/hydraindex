// Shared helpers for Hydra's serverless API functions.
// Kept dependency-free (no npm install required) so this deploys on Vercel with zero config.

const registry = require('./tool-registry.json');

const VALID_TYPES = ['content', 'audio', 'writing', 'business', 'coding', 'auto', 'research', 'social'];
const VALID_LEVELS = ['explorer', 'builder', 'architect']; // matches CLEARANCE_LEVELS ids in index.html
const VALID_BUDGETS = ['free', 'startup', 'pro']; // matches RESOURCE_BUDGETS ids in index.html

const MAX_IDEA_LENGTH = 300; // keep prompts small and cheap; the UI's own char-counter caps at 120 for the main field

function getRegistryToolIds() {
  return registry.tools.map((t) => t.tool_id);
}

function getRegistrySummaryForPrompt() {
  // Send only the fields the model needs to reason well and cite accurately —
  // not the full record — to keep the request small and cheap.
  return registry.tools.map((t) => ({
    tool_id: t.tool_id,
    name: t.name,
    categories: t.categories,
    capabilities: t.capabilities,
    expertise_level: t.expertise_level,
    pricing_model: t.pricing_model,
    free_tier: t.free_tier,
    estimated_cost: t.estimated_cost,
    api_available: t.api_available,
    current_status: t.current_status,
  }));
}

function lookupTool(tool_id) {
  return registry.tools.find((t) => t.tool_id === tool_id) || null;
}

// Extremely small in-memory rate limiter. This resets on every cold start and is
// NOT shared across serverless instances — it is a best-effort speed bump against
// naive abuse, not a real defense. Before real traffic, replace with a durable
// store (Vercel KV / Upstash Redis) keyed the same way.
const _hits = new Map();
function rateLimit(key, { limit = 12, windowMs = 60 * 60 * 1000 } = {}) {
  const now = Date.now();
  const arr = (_hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  _hits.set(key, arr);
  return arr.length <= limit;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

function sanitizeIdea(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, MAX_IDEA_LENGTH);
}

module.exports = {
  registry,
  VALID_TYPES,
  VALID_LEVELS,
  VALID_BUDGETS,
  MAX_IDEA_LENGTH,
  getRegistryToolIds,
  getRegistrySummaryForPrompt,
  lookupTool,
  rateLimit,
  getClientIp,
  sanitizeIdea,
};
