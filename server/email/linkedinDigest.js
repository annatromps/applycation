// Ties the pieces together: fetch new LinkedIn digest emails from a
// connected inbox, extract the job listings mentioned in them, and try to
// resolve each to the employer's own posting (Greenhouse/Lever) before
// falling back to the LinkedIn link. Output is normalized to the same shape
// every other job source in server/sources/ produces, so it flows through
// the exact same dedup/scoring pipeline in discovery.js with no special
// casing there.

const crypto = require("crypto");
const { fetchNewLinkedInDigests } = require("./inbox");
const { extractDigestEntries } = require("./parseDigest");
const { resolveApplyLink } = require("./resolveApplyLink");

const SOURCE = "linkedin-digest";

/**
 * @param {object} settings
 * @returns {Promise<{jobs: Array, emailsChecked: number}>} jobs in the same
 *   shape server/sources/*.js produce, plus a `resolvedVia` field
 *   ("greenhouse" | "lever" | "linkedin") noting whether the URL/description
 *   came from the employer's own ATS or is a LinkedIn link passed through
 *   unresolved. `emailsChecked` is how many unread matching emails were
 *   fetched this run (not how many contained a job) — used to power the
 *   Settings health indicator.
 */
async function discoverFromLinkedInDigests(settings) {
  const emails = await fetchNewLinkedInDigests(settings);
  if (!emails.length) return { jobs: [], emailsChecked: 0 };

  const jobs = [];
  const seenKeys = new Set();
  for (const email of emails) {
    let entries = [];
    try {
      entries = await extractDigestEntries(email, settings);
    } catch (e) {
      console.error("[email/linkedinDigest] failed to parse a digest email:", e.message);
      continue;
    }

    for (const entry of entries) {
      if (!entry.linkedinUrl) continue;
      const key = `${entry.company}|${entry.title}|${entry.linkedinUrl}`.toLowerCase();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      let resolved;
      try {
        resolved = await resolveApplyLink(entry);
      } catch (e) {
        resolved = { url: entry.linkedinUrl, description: "", resolvedVia: "linkedin" };
      }

      jobs.push({
        source: SOURCE,
        sourceId: crypto.createHash("sha1").update(key).digest("hex"),
        title: entry.title || "(title not found in digest — open the link to view)",
        company: entry.company || "(unknown — see link)",
        location: "",
        remote: false,
        url: resolved.url,
        salary: null,
        description: resolved.description,
        postedAt: email.date,
        tags: [],
        resolvedVia: resolved.resolvedVia,
      });
    }
  }
  return { jobs, emailsChecked: emails.length };
}

module.exports = { discoverFromLinkedInDigests, SOURCE };
