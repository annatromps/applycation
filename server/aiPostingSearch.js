// AI-assisted fallback for finding a job's real posting URL when the free
// ATS-pattern lookup (server/atsLookup.js — Greenhouse/Lever/Ashby/
// Recruitee, guessed slugs) comes up empty. That happens a lot: most
// companies aren't on one of those four platforms with a public board, or
// the slug guess just doesn't land. This uses a real, grounded web search —
// Anthropic's hosted web_search tool, or Google's Gemini grounding via its
// Interactions API — to actually search the web and ground the answer in a
// real result, rather than letting a model guess/recall a URL from training
// data. This app never fabricates a link anywhere else, and an AI-guessed
// URL that turns out to be wrong or dead would be worse than no link at all.
//
// Only runs when a provider with real search grounding wired in is
// configured — currently Anthropic or Gemini (see
// server/ai/client.js's isAnthropicSearchConfigured/isGeminiSearchConfigured).
// Both providers bill grounded search separately from normal token usage
// (Gemini specifically requires a billing-enabled key even though the rest
// of its usage is free-tier-friendly), so this is capped per
// discovery-cycle backfill run via settings.maxAiPostingSearchesPerCycle —
// see server/index.js. The manual-add and on-demand "Find posting" button
// paths are one-off, single-job calls with no separate cap.
//
// IMPORTANT for whoever picks this up next: the Gemini path
// (findViaGemini below) is built from Google's published API reference for
// its Interactions API, NOT verified against a live key — this sandbox has
// no outbound network access to test it. If Anna reports the Gemini
// posting-search silently finding nothing, check the Railway logs for a
// "[aiPostingSearch] Gemini lookup failed" line — it'll include the raw
// HTTP status + response body from Google, which is the fastest way to spot
// a wrong field/endpoint name and fix it. The Anthropic path has been
// unit-tested with mocked responses (this app has no live Anthropic access
// either) and shipped previously without issue.

const { callAI, callGeminiWithSearch, isAnthropicSearchConfigured, isGeminiSearchConfigured } = require("./ai/client");

function isRealUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

function buildPrompt(title, company) {
  return [
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
}

function parseFoundJson(raw) {
  const jsonMatch = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim().match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  const parsed = JSON.parse(jsonMatch[0]);
  if (!parsed || !parsed.found || !isRealUrl(parsed.url)) return null;
  return { url: parsed.url, description: String(parsed.description || "").trim() };
}

async function findViaAnthropic({ title, company }, settings) {
  const raw = await callAI(settings, { prompt: buildPrompt(title, company), maxTokens: 1200, allowWebSearch: true });
  const result = parseFoundJson(raw);
  if (!result) return null;
  return { ...result, resolvedVia: "ai-web-search" };
}

async function findViaGemini({ title, company }, settings) {
  const model = settings.aiModel || "gemini-2.5-flash";
  const { text, citationUrls } = await callGeminiWithSearch({
    apiKey: settings.aiApiKey,
    model,
    prompt: buildPrompt(title, company),
    maxTokens: 1200,
  });
  const result = parseFoundJson(text);
  if (!result) return null;
  // Extra fabrication guard specific to this path: Gemini's response also
  // hands back the URLs its own grounding actually found (citationUrls), so
  // cross-check the model's claimed URL against those when any are present,
  // rather than trusting the model's JSON text alone. If the API response
  // didn't include citations at all (possible schema drift — see the
  // header comment), fall back to just the isRealUrl check already applied
  // in parseFoundJson so a real, working feature doesn't get blocked by a
  // documentation gap.
  if (citationUrls.length && !citationUrls.some((u) => u === result.url || result.url.startsWith(u) || u.startsWith(result.url))) {
    console.error(`[aiPostingSearch] Gemini claimed a URL not in its own citations for "${title}" @ "${company}" — discarding: ${result.url}`);
    return null;
  }
  return { ...result, resolvedVia: "ai-web-search" };
}

/**
 * @param {{title: string, company: string}} job
 * @param {object} settings
 * @returns {Promise<{url: string, description: string, resolvedVia: "ai-web-search"}|null>}
 */
async function findPostingViaAIWebSearch({ title, company }, settings) {
  if (!title || !company) return null;

  if (isAnthropicSearchConfigured(settings)) {
    try {
      return await findViaAnthropic({ title, company }, settings);
    } catch (e) {
      console.error(`[aiPostingSearch] Anthropic lookup failed for "${title}" @ "${company}":`, e.message);
      return null;
    }
  }

  if (isGeminiSearchConfigured(settings)) {
    try {
      return await findViaGemini({ title, company }, settings);
    } catch (e) {
      console.error(`[aiPostingSearch] Gemini lookup failed for "${title}" @ "${company}":`, e.message);
      return null;
    }
  }

  return null;
}

module.exports = { findPostingViaAIWebSearch };
