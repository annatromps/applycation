// Greenhouse job boards public API — free, no API key required.
// Works per-company: you configure the list of Greenhouse board tokens
// (the slug in a company's careers URL, e.g. boards.greenhouse.io/<token>)
// you want this to watch. Docs: https://developers.greenhouse.io/job-board.html

const SOURCE = "greenhouse";

async function fetchJobs({ companies = [] } = {}) {
  const results = [];
  for (const token of companies) {
    try {
      const res = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`,
        { headers: { "User-Agent": "Applycation/0.1 (personal job search agent)" } }
      );
      if (!res.ok) continue;
      const data = await res.json();
      for (const j of data.jobs || []) {
        results.push({
          source: SOURCE,
          sourceId: String(j.id),
          title: j.title,
          company: token,
          location: j.location && j.location.name ? j.location.name : "",
          remote: /remote/i.test((j.location && j.location.name) || ""),
          url: j.absolute_url,
          salary: null,
          description: (j.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
          postedAt: j.updated_at || null,
          tags: [],
        });
      }
    } catch (e) {
      console.error(`[greenhouse] fetch failed for "${token}":`, e.message);
    }
  }
  return results;
}

module.exports = { fetchJobs, SOURCE };
