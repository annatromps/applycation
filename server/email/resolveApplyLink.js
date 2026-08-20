// Best-effort resolution of a job-alert digest entry (from LinkedIn, Indeed,
// Welcome to the Jungle, Wellfound, or any other connected job site — see
// server/email/parseDigest.js) to the employer's OWN application page — see
// server/atsLookup.js for the actual lookup (shared with
// server/postingResolver.js). This never touches the original job site
// itself; it only guesses a company's public ATS slug from its name and
// checks that company's own Greenhouse/Lever/Ashby/Recruitee board.
//
// Falls back to the original link from the digest email, unchanged, when no
// confident match is found — never fabricates a URL or description.

const { findPosting } = require("./../atsLookup");

/**
 * @param {{title: string, company: string, applyUrl: string}} entry
 * @returns {Promise<{url: string, description: string, resolvedVia: "greenhouse"|"lever"|"ashby"|"recruitee"|"original"}>}
 */
async function resolveApplyLink(entry) {
  const found = await findPosting(entry.company, entry.title);
  if (found) return found;
  return { url: entry.applyUrl, description: "", resolvedVia: "original" };
}

module.exports = { resolveApplyLink };
