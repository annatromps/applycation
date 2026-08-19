// RemoteOK public API — free, no API key required, but requires a real User-Agent.
// Docs: https://remoteok.com/api

const SOURCE = "remoteok";

async function fetchJobs() {
  const results = [];
  try {
    const res = await fetch("https://remoteok.com/api", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Applycation/0.1; personal job search agent)",
        Accept: "application/json",
      },
    });
    if (!res.ok) return results;
    const data = await res.json();
    // First element is a legal/metadata notice, not a job — skip it.
    for (const j of data.slice(1)) {
      if (!j || !j.id) continue;
      results.push({
        source: SOURCE,
        sourceId: String(j.id),
        title: j.position,
        company: j.company,
        location: j.location || "Remote",
        remote: true,
        url: j.url || `https://remoteok.com/remote-jobs/${j.id}`,
        salary: j.salary_min && j.salary_max ? `${j.salary_min}-${j.salary_max}` : null,
        description: (j.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        postedAt: j.date || null,
        tags: j.tags || [],
      });
    }
  } catch (e) {
    console.error("[remoteok] fetch failed:", e.message);
  }
  return results;
}

module.exports = { fetchJobs, SOURCE };
