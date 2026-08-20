// Best-effort attempt to find a job's real posting URL + full description
// from just its title + company — for jobs that have neither (added
// manually from a screenshot/notes, imported from a board this app doesn't
// scrape, etc). Uses the same free public Greenhouse/Lever board APIs as
// regular discovery (see server/atsLookup.js) — no scraping, no per-job
// manual web fetches, and nothing that needs a human to approve fetching an
// individual site. This is designed to run unattended: automatically
// whenever such a job is created or found at startup (see server/index.js's
// backfill and routes/jobs.js's manual-add), and on demand via
// POST /api/jobs/:id/find-posting for a later retry.
//
// Inherently best-effort: only works for companies on Greenhouse or Lever,
// and only when the slug guessed from the company name happens to be
// right. Returns null — changes nothing — when no confident match is
// found, rather than ever fabricating a URL or description.

const { findPosting } = require("./atsLookup");

/**
 * @param {{title: string, company: string}} job
 * @returns {Promise<{url: string, description: string, resolvedVia: "greenhouse"|"lever"}|null>}
 */
async function resolvePostingForJob(job) {
  if (!job || !job.title || !job.company) return null;
  try {
    return await findPosting(job.company, job.title);
  } catch (e) {
    console.error(`[postingResolver] Lookup failed for "${job.title}" @ "${job.company}":`, e.message);
    return null;
  }
}

module.exports = { resolvePostingForJob };
