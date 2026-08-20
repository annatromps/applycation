// Ties the pieces together: fetch new job-alert digest emails from a
// connected inbox (LinkedIn, Indeed, Welcome to the Jungle, Wellfound, or
// any other job site whose alert emails land there — see
// server/email/inbox.js's senderFilter), extract the job listings mentioned
// in them, and try to resolve each to the employer's own posting
// (Greenhouse/Lever/Ashby/Recruitee) before falling back to the original
// link from the email. Output is normalized to the same shape every other
// job source in server/sources/ produces, so it flows through the exact
// same dedup/scoring pipeline in discovery.js with no special casing there.

const crypto = require("crypto");
const { fetchNewLinkedInDigests } = require("./inbox");
const { extractDigestEntries } = require("./parseDigest");
const { resolveApplyLink } = require("./resolveApplyLink");

const SOURCE = "email-digest";

/**
 * @param {object} settings
 * @param {string[]} processedIds - previously-imported Message-IDs, passed
 *   straight through to fetchNewLinkedInDigests — see that function's docs.
 * @returns {Promise<{jobs: Array, emailsChecked: number, processedIds: string[]}>}
 *   jobs in the same shape server/sources/*.js produce, plus a
 *   `resolvedVia` field ("greenhouse" | "lever" | "ashby" | "recruitee" |
 *   "original") noting whether the URL/description came from the
 *   employer's own ATS or is the original digest-email link passed through
 *   unresolved. `emailsChecked` is how many new matching emails were
 *   fetched this run (not how many contained a job) — used to power the
 *   Settings health indicator. `processedIds` is the updated list to
 *   persist back to meta.emailDigestProcessedIds.
 */
async function discoverFromEmailDigests(settings, processedIds = []) {
  const { results: emails, processedIds: updatedProcessedIds } = await fetchNewLinkedInDigests(settings, processedIds);
  if (!emails.length) return { jobs: [], emailsChecked: 0, processedIds: updatedProcessedIds };

  const jobs = [];
  const seenKeys = new Set();
  for (const email of emails) {
    let entries = [];
    try {
      entries = await extractDigestEntries(email, settings);
    } catch (e) {
      console.error("[email/digestImport] failed to parse a digest email:", e.message);
      continue;
    }

    for (const entry of entries) {
      if (!entry.applyUrl) continue;
      const key = `${entry.company}|${entry.title}|${entry.applyUrl}`.toLowerCase();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      let resolved;
      try {
        resolved = await resolveApplyLink(entry);
      } catch (e) {
        resolved = { url: entry.applyUrl, description: "", resolvedVia: "original" };
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
  return { jobs, emailsChecked: emails.length, processedIds: updatedProcessedIds };
}

module.exports = { discoverFromEmailDigests, SOURCE };
