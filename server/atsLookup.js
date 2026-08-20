// Shared helpers for finding a company's own job posting via free, public,
// unauthenticated ATS JSON APIs, from just a company name + job title.
// Never scrapes anything — each of these is a documented public API meant
// to be read programmatically by third parties (the same kind of endpoint
// server/sources/ already reads from for regular discovery).
//
// Coverage is inherently partial, and it's worth being honest about the
// ceiling here rather than implying this can find anything: a match
// requires ALL of (a) the company being on one of the ATS platforms below,
// (b) that platform's public job-board API actually being enabled/reachable
// for them, and (c) the slug guessed from the company name lining up with
// theirs. Large enterprises on Workday, iCIMS, Taleo, SuccessFactors, or
// anyone running a fully custom careers page, have no public read API at
// all — there is no legal, keyless way to find those automatically. That's
// a real limit on this feature, not a bug, and it's why the job detail
// view always has a manual "paste the link yourself" fallback. When
// nothing confident turns up here, callers get null back — never a guess.
//
// Used by:
//   - server/email/resolveApplyLink.js (LinkedIn digest import — falls
//     back to the original LinkedIn link if nothing is found here)
//   - server/postingResolver.js (any job with NO known link at all —
//     manually added, imported, or backfilled — returns null if nothing is
//     found, since there's no original link to fall back to)

const GENERIC_USER_AGENT = { "User-Agent": "Applycation/0.1 (personal job search agent)" };
const FETCH_TIMEOUT_MS = 6000;

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html) {
  return (html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// Only ever hand back a URL that actually looks like one — a schema
// mismatch or an unexpected null field in a provider's response should
// silently fall through to "not found", never surface a broken link.
function isRealUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

// Corporate-suffix words that often appear in a company's display name but
// never in its ATS slug (e.g. "Acme Technologies Inc" -> slug "acme").
const SUFFIX_WORDS = new Set([
  "inc", "llc", "ltd", "limited", "co", "corp", "corporation", "group",
  "labs", "lab", "technologies", "technology", "tech", "hq", "holdings",
  "plc", "gmbh", "srl", "ag", "company", "the",
]);

function slugCandidates(companyName) {
  const base = (companyName || "").toLowerCase().trim();
  if (!base) return [];
  const stripped = base.replace(/[^a-z0-9\s-]/g, "");
  const words = stripped.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const withoutSuffixes = words.filter((w) => !SUFFIX_WORDS.has(w));

  const candidates = new Set();
  const add = (arr) => {
    if (!arr.length) return;
    candidates.add(arr.join(""));
    candidates.add(arr.join("-"));
  };
  add(words);
  if (withoutSuffixes.length && withoutSuffixes.length !== words.length) add(withoutSuffixes);
  // A single distinctive first word is often the real slug for multi-word
  // names (e.g. "Boundless Labs" -> "boundless", "Scarlet Technologies" ->
  // "scarlet") — worth trying on its own, not just as part of the full name.
  if (withoutSuffixes.length > 1) candidates.add(withoutSuffixes[0]);

  return [...candidates].filter(Boolean);
}

function normalize(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Loose word-overlap match — a listing's title on one source is sometimes
// shortened or reformatted vs. the employer's own listing title, so an
// exact match would miss too much.
function titlesMatch(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wordsA = new Set(na.split(" ").filter((w) => w.length > 2));
  const wordsB = new Set(nb.split(" ").filter((w) => w.length > 2));
  if (!wordsA.size || !wordsB.size) return false;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.min(wordsA.size, wordsB.size) >= 0.6;
}

async function tryGreenhouse(slug, title) {
  try {
    const res = await fetchWithTimeout(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
      { headers: GENERIC_USER_AGENT }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const match = (data.jobs || []).find((j) => titlesMatch(j.title, title));
    if (!match || !isRealUrl(match.absolute_url)) return null;
    return { url: match.absolute_url, description: stripHtml(match.content), resolvedVia: "greenhouse" };
  } catch {
    return null;
  }
}

async function tryLever(slug, title) {
  try {
    const res = await fetchWithTimeout(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`, {
      headers: GENERIC_USER_AGENT,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const match = (Array.isArray(data) ? data : []).find((j) => titlesMatch(j.text, title));
    if (!match || !isRealUrl(match.hostedUrl)) return null;
    return { url: match.hostedUrl, description: stripHtml(match.descriptionPlain || match.description), resolvedVia: "lever" };
  } catch {
    return null;
  }
}

// Ashby's public job-board API — https://developers.ashbyhq.com, no key
// needed for a company's own listed board.
async function tryAshby(slug, title) {
  try {
    const res = await fetchWithTimeout(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`, {
      headers: GENERIC_USER_AGENT,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const match = (data.jobs || []).find((j) => titlesMatch(j.title, title));
    if (!match) return null;
    const url = match.jobUrl || match.applyUrl;
    if (!isRealUrl(url)) return null;
    return { url, description: stripHtml(match.descriptionPlain || match.descriptionHtml), resolvedVia: "ashby" };
  } catch {
    return null;
  }
}

// Recruitee's public offers API — {company}.recruitee.com/api/offers/,
// no key needed. (Confirmed shape against a real company board while
// investigating one of your own jobs — this one's solid.)
async function tryRecruitee(slug, title) {
  try {
    const res = await fetchWithTimeout(`https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`, {
      headers: GENERIC_USER_AGENT,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const match = (data.offers || []).find((j) => titlesMatch(j.title, title));
    if (!match) return null;
    const url = match.careers_url || match.url;
    if (!isRealUrl(url)) return null;
    return { url, description: stripHtml(match.description), resolvedVia: "recruitee" };
  } catch {
    return null;
  }
}

const PROVIDERS = [tryGreenhouse, tryLever, tryAshby, tryRecruitee];

/**
 * @param {string} company
 * @param {string} title
 * @returns {Promise<{url: string, description: string, resolvedVia: "greenhouse"|"lever"|"ashby"|"recruitee"}|null>}
 */
async function findPosting(company, title) {
  for (const slug of slugCandidates(company)) {
    // Try every provider for this slug guess concurrently rather than one
    // at a time — same total requests, a lot less wall-clock time spent on
    // guesses that don't pan out.
    const results = await Promise.all(PROVIDERS.map((fn) => fn(slug, title)));
    const found = results.find(Boolean);
    if (found) return found;
  }
  return null;
}

module.exports = { findPosting, titlesMatch, slugCandidates };
