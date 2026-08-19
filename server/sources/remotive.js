// Remotive public API — free, no API key required.
// Docs: https://remotive.com/api-documentation

const SOURCE = "remotive";

async function fetchJobs({ searchTerms = [] } = {}) {
  const results = [];
  const terms = searchTerms.length ? searchTerms : [""];
  for (const term of terms) {
    const url = new URL("https://remotive.com/api/remote-jobs");
    if (term) url.searchParams.set("search", term);
    url.searchParams.set("limit", "50");
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Applycation/0.1 (personal job search agent)" } });
      if (!res.ok) continue;
      const data = await res.json();
      for (const j of data.jobs || []) {
        results.push({
          source: SOURCE,
          sourceId: String(j.id),
          title: j.title,
          company: j.company_name,
          location: j.candidate_required_location || "Remote",
          remote: true,
          url: j.url,
          salary: j.salary || null,
          description: (j.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
          postedAt: j.publication_date || null,
          tags: j.tags || [],
        });
      }
    } catch (e) {
      // A single source failing shouldn't break discovery for the others.
      console.error(`[remotive] fetch failed for term "${term}":`, e.message);
    }
  }
  return dedupe(results);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((j) => {
    const key = `${j.source}:${j.sourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { fetchJobs, SOURCE };
