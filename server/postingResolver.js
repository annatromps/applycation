// Best-effort attempt to find a job's real posting URL + full description
// from just its title + company — for jobs that have neither (added
// manually from a screenshot/notes, imported from a board this app doesn't
// scrape, etc).
//
// Two tiers, tried in order:
//   1. Free public ATS APIs (Greenhouse/Lever/Ashby/Recruitee, guessed
//      slugs — see server/atsLookup.js). No scraping, no per-job manual web
//      fetches, nothing that needs a human to approve fetching an
//      individual site. Only works for companies actually on one of those
//      four platforms with a name-matching slug.
//   2. If that finds nothing AND a provider with real search grounding is
//      configured (Anthropic or Gemini — see server/ai/client.js), a
//      web-search-grounded AI lookup (see server/aiPostingSearch.js) — this
//      covers everything else: custom ATS instances, Workday, a plain
//      careers page, whatever. Skipped entirely with no such provider set,
//      or when the caller has hit its per-cycle cap (see server/index.js).
//
// This is designed to run unattended: automatically whenever such a job is
// created or found at startup (see server/index.js's backfill and
// routes/jobs.js's manual-add), and on demand via
// POST /api/jobs/:id/find-posting for a later retry.
//
// Inherently best-effort even with both tiers — returns null, changing
// nothing, when no confident match is found, rather than ever fabricating a
// URL or description.

const { findPosting } = require("./atsLookup");
const { findPostingViaAIWebSearch } = require("./aiPostingSearch");
const { isPostingSearchConfigured } = require("./ai/client");

/**
 * @param {{title: string, company: string}} job
 * @param {object} settings
 * @param {{allowAiWebSearch?: boolean}} [options] - set allowAiWebSearch:
 *   false to skip tier 2 even if AI is configured (used by the startup
 *   backfill to enforce its per-cycle cost cap across many jobs at once).
 * @returns {Promise<{found: true, url: string, description: string, resolvedVia: "greenhouse"|"lever"|"ashby"|"recruitee"|"ai-web-search"} | {found: false, reason: "no_title_or_company"|"no_ai_provider_configured"|"ai_capped_this_run"|"ai_tried_no_confident_match"}>}
 *   Always returns an object now (never bare null) so callers — especially
 *   the "Find missing postings" bulk button — can explain WHY a job stayed
 *   unresolved instead of just reporting a raw count. See each reason's
 *   name for what it means; the AI-specific reasons only ever occur when
 *   tier 1 (the free ATS lookup) already came up empty first.
 */
async function resolvePostingForJob(job, settings, { allowAiWebSearch = true } = {}) {
  if (!job || !job.title || !job.company) return { found: false, reason: "no_title_or_company" };

  try {
    const viaAts = await findPosting(job.company, job.title);
    if (viaAts) return { found: true, ...viaAts };
  } catch (e) {
    console.error(`[postingResolver] ATS lookup failed for "${job.title}" @ "${job.company}":`, e.message);
  }

  if (!allowAiWebSearch) return { found: false, reason: "ai_capped_this_run" };
  if (!isPostingSearchConfigured(settings)) return { found: false, reason: "no_ai_provider_configured" };

  try {
    const viaAi = await findPostingViaAIWebSearch(job, settings);
    if (viaAi) return { found: true, ...viaAi };
    return { found: false, reason: "ai_tried_no_confident_match" };
  } catch (e) {
    console.error(`[postingResolver] AI web-search lookup failed for "${job.title}" @ "${job.company}":`, e.message);
    return { found: false, reason: "ai_tried_no_confident_match" };
  }
}

module.exports = { resolvePostingForJob };
