// Explains, in plain English, how a candidate's CV was tailored for one
// specific job. Important honesty note: cv.js's tailorBullets() NEVER adds,
// invents, or removes content — it only reorders each role's existing,
// true bullets so the most relevant one leads. So "what was added" is
// really "what was promoted to the top, and why" — this module produces
// that explanation, rule-based by default, optionally polished into a
// short natural paragraph by Claude (which is given only these same facts,
// so it can't introduce anything not already in the profile).

const { keywordsOf } = require("./cv");

function relevance(bulletText, jobKeywordSet) {
  const words = keywordsOf(bulletText);
  let hits = 0;
  for (const w of words) if (jobKeywordSet.has(w)) hits++;
  return hits;
}

function ruleBasedNotes(profile, job) {
  if (!job || !job.description) return [];
  const jobKeywords = new Set(keywordsOf(`${job.title || ""} ${job.description}`));
  const notes = [];
  for (const role of profile.experience || []) {
    const original = role.bullets || [];
    if (original.length < 2) continue; // nothing to reorder
    const scored = original.map((text, i) => ({ text, i, score: relevance(text, jobKeywords) }));
    const top = [...scored].sort((a, b) => b.score - a.score || a.i - b.i)[0];
    if (top.i === 0 || top.score === 0) continue; // already led with this bullet, or no keyword overlap at all
    const matchedKeywords = keywordsOf(top.text).filter((w) => jobKeywords.has(w));
    notes.push({ role: `${role.title} at ${role.company}`, promotedBullet: top.text, matchedKeywords: matchedKeywords.slice(0, 5) });
  }
  return notes;
}

function notesToPlainText(notes) {
  if (!notes.length) {
    return "Your bullet order was kept as your default for this application — nothing in your experience stood out as more relevant to this specific posting than usual.";
  }
  return notes
    .map(
      (n) =>
        `${n.role}: led with "${n.promotedBullet}"${n.matchedKeywords.length ? ` — matches this posting's mention of ${n.matchedKeywords.join(", ")}` : ""}.`
    )
    .join(" ");
}

async function draftWithAI(notes, job, settings) {
  if (!settings.anthropicApiKey || !notes.length) return null;
  const model = settings.anthropicModel || "claude-sonnet-4-5";
  const prompt = [
    "Explain, in 2-4 short plain-English sentences (no bullet points, no headers), how a candidate's CV was tailored for a specific job application.",
    "IMPORTANT: the CV's CONTENT was not changed — only the ORDER of existing, true bullet points under each role was adjusted so the most relevant one leads. Never imply anything was added, invented, or embellished. Just explain what was promoted to the top of each affected role and why it's relevant to this posting, in a natural, confident tone.",
    "",
    `Job: ${job.title} at ${job.company}`,
    `Job description excerpt: ${(job.description || "").slice(0, 1500)}`,
    "",
    "Facts — the bullet promoted to the top of each affected role, and the job-relevant keywords it hit (use ONLY these facts, do not add anything beyond them):",
    JSON.stringify(notes, null, 2),
  ].join("\n");

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": settings.anthropicApiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || "").join("\n").trim();
    return text || null;
  } catch (e) {
    console.error("[tailoringSummary] AI drafting failed, falling back to rule-based summary:", e.message);
    return null;
  }
}

/**
 * Returns a short, human-readable explanation of how this job's CV differs
 * — in ORDER, never content — from the candidate's default profile. Stored
 * as job.materials.tailoringSummary alongside the generated documents.
 * @returns {Promise<string>}
 */
async function buildTailoringSummary(profile, job, settings) {
  const notes = ruleBasedNotes(profile, job);
  const ai = await draftWithAI(notes, job, settings);
  return ai || notesToPlainText(notes);
}

module.exports = { buildTailoringSummary };
