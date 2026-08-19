// Arbeitnow public job board API — free, no API key required.
// Docs: https://www.arbeitnow.com/api/job-board-api

const SOURCE = "arbeitnow";

async function fetchJobs() {
  const results = [];
  try {
    const res = await fetch("https://www.arbeitnow.com/api/job-board-api", {
      headers: { "User-Agent": "Applycation/0.1 (personal job search agent)" },
    });
    if (!res.ok) return results;
    const data = await res.json();
    for (const j of data.data || []) {
      results.push({
        source: SOURCE,
        sourceId: j.slug,
        title: j.title,
        company: j.company_name,
        location: j.location || (j.remote ? "Remote" : ""),
        remote: !!j.remote,
        url: j.url,
        salary: null,
        description: (j.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        postedAt: j.created_at ? new Date(j.created_at * 1000).toISOString() : null,
        tags: j.tags || [],
      });
    }
  } catch (e) {
    console.error("[arbeitnow] fetch failed:", e.message);
  }
  return results;
}

module.exports = { fetchJobs, SOURCE };
