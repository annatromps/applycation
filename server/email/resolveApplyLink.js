// Best-effort resolution of a LinkedIn digest job entry to the employer's
// OWN application page, via the same free Greenhouse/Lever public APIs the
// regular discovery sources already use (see server/sources/). This never
// touches linkedin.com — it only guesses a company's public ATS slug from
// its name and checks that company's own job board.
//
// This is inherently best-effort: guessing a slug from a company name
// doesn't always work, and not every company uses Greenhouse or Lever. When
// no confident match is found, the original LinkedIn link is passed through
// unchanged rather than fabricating a URL or description.

const GENERIC_USER_AGENT = { "User-Agent": "Applycation/0.1 (personal job search agent)" };

function slugCandidates(companyName) {
  const base = (companyName || "").toLowerCase().trim();
  if (!base) return [];
  const stripped = base.replace(/[^a-z0-9\s-]/g, "");
  const noSpaces = stripped.replace(/\s+/g, "");
  const hyphenated = stripped.replace(/\s+/g, "-");
  return [...new Set([noSpaces, hyphenated])].filter(Boolean);
}

function normalize(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Loose word-overlap match — LinkedIn digest titles are sometimes shortened
// or reformatted vs. the employer's own listing title, so an exact match
// would miss too much.
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
    const res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
      { headers: GENERIC_USER_AGENT }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const match = (data.jobs || []).find((j) => titlesMatch(j.title, title));
    if (!match) return null;
    return {
      url: match.absolute_url,
      description: (match.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      resolvedVia: "greenhouse",
    };
  } catch {
    return null;
  }
}

async function tryLever(slug, title) {
  try {
    const res = await fetch(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`, {
      headers: GENERIC_USER_AGENT,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const match = (Array.isArray(data) ? data : []).find((j) => titlesMatch(j.text, title));
    if (!match) return null;
    return {
      url: match.hostedUrl,
      description: (match.descriptionPlain || match.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      resolvedVia: "lever",
    };
  } catch {
    return null;
  }
}

/**
 * @param {{title: string, company: string, linkedinUrl: string}} entry
 * @returns {Promise<{url: string, description: string, resolvedVia: "greenhouse"|"lever"|"linkedin"}>}
 */
async function resolveApplyLink(entry) {
  for (const slug of slugCandidates(entry.company)) {
    const gh = await tryGreenhouse(slug, entry.title);
    if (gh) return gh;
    const lv = await tryLever(slug, entry.title);
    if (lv) return lv;
  }
  return { url: entry.linkedinUrl, description: "", resolvedVia: "linkedin" };
}

module.exports = { resolveApplyLink, titlesMatch, slugCandidates };
