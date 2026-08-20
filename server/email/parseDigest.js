// Extracts individual job listings from a job-alert / "jobs for you" style
// digest email — from LinkedIn, Indeed, Welcome to the Jungle, Wellfound, or
// any other job site you've connected via Settings > Advanced > "Job-alert
// email import" (see server/email/inbox.js's senderFilter). Never fetches
// anything from any of those sites directly — works purely from the raw
// email content they already sent you.
//
// AI-assisted when an AI provider is configured (every job site's email
// markup is messy and shifts over time, which AI handles far more robustly
// than a fixed set of regexes, and generalizes to a site this app has never
// seen before without needing a new pattern added for it). Falls back to a
// plain rule-based sweep for known/likely job-listing links when no AI
// provider is set — that reliably finds the postings themselves, but
// usually can't cleanly separate the title and company out of the
// surrounding markup, so those come back blank rather than guessed.

const { callAI, isAIConfigured } = require("./../ai/client");

// Precise URL shapes for job sites worth recognizing by name. Not
// exhaustive by design — the generic fallback below and the AI-assisted
// path (which doesn't depend on either of these patterns at all) are what
// actually make this work for a site not listed here.
const KNOWN_JOB_BOARD_LINK = new RegExp(
  [
    "linkedin\\.com/(comm/)?jobs/view/",
    "indeed\\.[a-z.]+/(rc/clk|viewjob|jobs)",
    "glassdoor\\.[a-z.]+/job",
    "welcometothejungle\\.com/[a-z]{2}/companies/[^/\\s\"'<>]+/jobs",
    "wellfound\\.com/(jobs|company/[^/\\s\"'<>]+/jobs)",
    "angel\\.co/company/[^/\\s\"'<>]+/jobs",
    "ziprecruiter\\.com/(c/|jobs?)",
    "monster\\.[a-z.]+/job",
    "otta\\.com/jobs",
    "dice\\.com/job",
    "totaljobs\\.com/job",
    "reed\\.co\\.uk/jobs",
    "seek\\.[a-z.]+/job",
    "weworkremotely\\.com/(remote-jobs|listings)",
    "remoteok\\.com/remote-jobs",
    "themuse\\.com/jobs",
    "builtin\\.com/job",
  ].join("|"),
  "i"
);

// Generic fallback: most job/vacancy listing URLs contain one of these path
// segments somewhere (English, and a couple of common non-English
// equivalents since job sites aren't all US/UK-only), regardless of which
// specific site it is. Deliberately broad — a false positive here just
// means a link gets treated as a candidate and comes back with a blank
// title, never a fabricated one; a false negative means missing a real job
// entirely, which is the worse failure mode.
const GENERIC_JOB_PATH = /\/(jobs?|vacan(?:c(?:y|ies)|t)|careers?|postings?|emplois?|offres?)\/[^\s"'<>]{2,}/i;

function looksLikeJobLink(text) {
  const t = text || "";
  return KNOWN_JOB_BOARD_LINK.test(t) || GENERIC_JOB_PATH.test(t);
}

// Cheap subject-line signal used only to decide whether an email is worth
// examining at all (see extractDigestEntries below) — a real job digest's
// subject almost always contains one of these words regardless of source.
const JOB_ALERT_SUBJECT_HINT = /\b(job|jobs|career|hiring|vacan\w*|opportunit\w*|new roles?|recommend\w*|for you)\b/i;

// Plain-regex HTML link extraction — deliberately avoids a full HTML parser
// dependency here (one less thing that can break across Node versions);
// this only needs to find <a href="...job link...">title text</a> patterns,
// which digest emails produce very consistently.
function ruleBasedExtract(html, text) {
  const entries = [];
  const seen = new Set();
  try {
    const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = anchorRe.exec(html || ""))) {
      const href = m[1];
      if (!looksLikeJobLink(href)) continue;
      const title = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!title || seen.has(href)) continue;
      seen.add(href);
      entries.push({ title, company: "", applyUrl: href });
    }
  } catch (e) {
    console.error("[email/parseDigest] rule-based HTML parse failed:", e.message);
  }
  if (!entries.length) {
    // Last resort: bare URL sweep over plain text — no title available.
    const urls = (text || "").match(/https?:\/\/[^\s")]+/gi) || [];
    for (const url of new Set(urls)) {
      if (looksLikeJobLink(url)) entries.push({ title: "", company: "", applyUrl: url });
    }
  }
  return entries;
}

async function aiExtract(text, settings) {
  const prompt = [
    "This is the plain text of a job-alert / job-recommendation digest email from a job site (could be LinkedIn, Indeed, Welcome to the Jungle, Wellfound, or any other job board or ATS). Extract every individual job listing mentioned.",
    'Return ONLY a JSON array, no commentary, no markdown fences, shaped like: [{"title": "string", "company": "string", "applyUrl": "string"}]',
    "Rules: only use information literally present in the text below. If you cannot confidently find the company name or the exact job listing URL for an entry, leave that field as an empty string rather than guessing. Never invent a listing that isn't in the text.",
    "",
    "EMAIL TEXT:",
    text.slice(0, 12000),
  ].join("\n");

  try {
    const raw = await callAI(settings, { prompt, maxTokens: 2000 });
    const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) ? parsed.filter((e) => e && e.applyUrl) : [];
  } catch (e) {
    console.error("[email/parseDigest] AI extraction failed, falling back to rule-based:", e.message);
    return null;
  }
}

/**
 * @param {{html: string, text: string, subject: string}} email
 * @param {object} settings
 * @returns {Promise<Array<{title: string, company: string, applyUrl: string}>>}
 */
async function extractDigestEntries({ html, text, subject }, settings) {
  // Cheap short-circuit before spending an AI call: the sender filter can be
  // as broad as a whole domain (see server/email/inbox.js), so plenty of
  // fetched emails (connection requests, marketing, receipts, etc.) will
  // have no job listing in them at all. Two independent, near-free signals
  // — a plausible job link anywhere in the body, or job-ish wording in the
  // subject — catch real digests even from a job site whose URL shape isn't
  // explicitly known yet; only skip when NEITHER signal fires.
  const hasJobLink = looksLikeJobLink(html || "") || looksLikeJobLink(text || "");
  const subjectHints = JOB_ALERT_SUBJECT_HINT.test(subject || "");
  if (!hasJobLink && !subjectHints) return [];

  if (isAIConfigured(settings)) {
    const plain = text || (html || "").replace(/<[^>]+>/g, " ");
    const ai = await aiExtract(plain, settings);
    if (ai && ai.length) return ai;
  }
  return ruleBasedExtract(html, text);
}

module.exports = { extractDigestEntries, looksLikeJobLink };
