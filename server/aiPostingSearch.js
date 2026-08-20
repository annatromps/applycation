// AI-assisted fallback for finding a job's real posting URL when the free
// ATS-pattern lookup (server/atsLookup.js — Greenhouse/Lever/Ashby/
// Recruitee, guessed slugs) comes up empty. That happens a lot: most
// companies aren't on one of those four platforms with a public board, or
// the slug guess just doesn't land. This uses Claude's hosted web search
// tool (see server/ai/client.js's isWebSearchConfigured/callAI) to actually
// search the web and ground the answer in a real result, rather than
// letting a model guess/recall a URL from training data — this app never
// fabricates a link anywhere else, and an AI-guessed URL that turns out to
// be wrong or dead would be worse than no link at all.
//
// Only runs when an Anthropic provider is configured (that's the only
// provider this app wires a real web-search capability into). Anthropic
// bills web search usage separately from normal tokens, so this is capped
// per discovery-cycle backfill run via
// settings.maxAiPostingSearchesPerCycle — see server/index.js. The
// manual-add and on-demand "Find posting" button paths are one-off,
// single-job calls with no separate cap.

const { callAI, isWebSearchConfigured } = require("./ai/client");

function isRealUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

/**
 * @param {{title: string, company: string}} job
 * @param {object} settings
 * @returns {Promise<{url: string, description: string, resolvedVia: "ai-web-search"}|null>}
 */
async function findPostingViaAIWebSearch({ title, company }, settings) {
  if (!isWebSearchConfigured(settings) || !title || !company) return null;

  const prompt = [
    "Search the web for the exact, current job application page for this specific role at this specific company. Do not guess or construct a URL from a pattern — only use a URL that actually appears in your search results.",
    `Company: ${company}`,
    `Job title: ${title}`,
    "",
    "Return ONLY a JSON object, no commentary, no markdown fences, shaped like one of:",
    '{"found": true, "url": "https://...", "description": "a short 1-3 sentence summary of the role, from the posting itself"}',
    '{"found": false}',
    "",
    "Rules: the URL must come from an actual search result you found just now — never invent one. If the employer's own careers page or ATS listing (Greenhouse, Lever, Ashby, Workday, etc.) is available, prefer that over a third-party job board aggregator or an expired/cached listing. If you cannot find a confident match for this exact company and role, return {\"found\": false} rather than a low-confidence guess.",
  ].join("\n");

  try {
    const raw = await callAI(settings, { prompt, maxTokens: 1200, allowWebSearch: true });
    const jsonMatch = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim().match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || !parsed.found || !isRealUrl(parsed.url)) return null;
    return { url: parsed.url, description: String(parsed.description || "").trim(), resolvedVia: "ai-web-search" };
  } catch (e) {
    console.error(`[aiPostingSearch] lookup failed for "${title}" @ "${company}":`, e.message);
    return null;
  }
}

module.exports = { findPostingViaAIWebSearch };
