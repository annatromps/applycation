// Best-effort resolution of a LinkedIn digest job entry to the employer's
// OWN application page — see server/atsLookup.js for the actual lookup
// (shared with server/postingResolver.js). This never touches linkedin.com
// itself; it only guesses a company's public ATS slug from its name and
// checks that company's own Greenhouse/Lever board.
//
// Falls back to the original LinkedIn link, unchanged, when no confident
// match is found — never fabricates a URL or description.

const { findPosting } = require("./../atsLookup");

/**
 * @param {{title: string, company: string, linkedinUrl: string}} entry
 * @returns {Promise<{url: string, description: string, resolvedVia: "greenhouse"|"lever"|"linkedin"}>}
 */
async function resolveApplyLink(entry) {
  const found = await findPosting(entry.company, entry.title);
  if (found) return found;
  return { url: entry.linkedinUrl, description: "", resolvedVia: "linkedin" };
}

module.exports = { resolveApplyLink };
