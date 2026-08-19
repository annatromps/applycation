// Lever job postings public API — free, no API key required.
// Works per-company: configure the list of Lever company slugs
// (the slug in jobs.lever.co/<slug>) you want this to watch.
// Docs: https://github.com/lever/postings-api

const SOURCE = "lever";

async function fetchJobs({ companies = [] } = {}) {
  const results = [];
  for (const slug of companies) {
    try {
      const res = await fetch(
        `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
        { headers: { "User-Agent": "Applycation/0.1 (personal job search agent)" } }
      );
      if (!res.ok) continue;
      const data = await res.json();
      for (const j of data || []) {
        const loc = j.categories && j.categories.location ? j.categories.location : "";
        results.push({
          source: SOURCE,
          sourceId: j.id,
          title: j.text,
          company: slug,
          location: loc,
          remote: /remote/i.test(loc || ""),
          url: j.hostedUrl,
          salary: null,
          description: (j.descriptionPlain || j.description || "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
          postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
          tags: (j.categories && j.categories.team ? [j.categories.team] : []).filter(Boolean),
        });
      }
    } catch (e) {
      console.error(`[lever] fetch failed for "${slug}":`, e.message);
    }
  }
  return results;
}

module.exports = { fetchJobs, SOURCE };
