// Surfaces short, concrete things to think about before applying to a
// specific job — e.g. "it asks for 5+ years running paid campaigns, do you
// have examples of that?" or "this looks like a step up in seniority from
// your last two roles". Pulled from two sources:
//   1. Rule-based: any already-computed scoring reasons that read as a
//      concern (negative signal), reused as-is — never re-derived or guessed.
//   2. AI-assisted (only when a provider is configured and the job has a
//      real description): a short pass comparing the job's stated
//      requirements against the candidate's profile, instructed to only
//      flag things it can point to directly in the text — never invents a
//      requirement that isn't there.

const { callAI, isAIConfigured } = require("./../ai/client");

// Phrases scoring.js's bump() calls use for negative signals — kept here as
// a simple, transparent allowlist rather than trying to infer sentiment.
const NEGATIVE_HINTS = [
  "no target title",
  "contains excluded",
  "suggests a more junior",
  "dealbreaker matched",
  "doesn't match your target",
  "no visa sponsorship",
  "below your minimum",
  "hidden industry signal",
  "hidden technology signal",
];

function ruleBasedFlags(reasonsByCategory) {
  const all = [...((reasonsByCategory && reasonsByCategory.candidateFit) || []), ...((reasonsByCategory && reasonsByCategory.roleAppeal) || [])];
  return all.filter((r) => NEGATIVE_HINTS.some((h) => r.toLowerCase().includes(h)));
}

async function aiQuestions(profile, job, settings) {
  if (!isAIConfigured(settings) || !job.description || !job.description.trim()) return null;
  const prompt = [
    "You're helping someone decide whether/how to apply for a job. Compare the JOB DESCRIPTION below against their CANDIDATE PROFILE, and list 2-4 short, direct, actionable questions or flags they should think about before applying.",
    'Focus on concrete gaps: required experience/skills the profile doesn\'t clearly show, seniority mismatches, or anything that looks like a stretch. Phrase each as a short direct question or flag, e.g. "It asks for 5+ years running paid growth campaigns — do you have examples of that?"',
    "Rules: only reference requirements ACTUALLY STATED in the job description below. Never invent a requirement that isn't there. If there's genuinely nothing notable to flag, return an empty array — don't manufacture filler.",
    "Return ONLY a JSON array of strings, no commentary, no markdown fences.",
    "",
    `JOB: ${job.title} at ${job.company}`,
    `JOB DESCRIPTION: ${job.description.slice(0, 4000)}`,
    "",
    `CANDIDATE SUMMARY: ${profile.summary || ""}`,
    `CANDIDATE EXPERIENCE: ${JSON.stringify((profile.experience || []).map((e) => ({ title: e.title, company: e.company, bullets: e.bullets })))}`,
  ].join("\n");

  try {
    const raw = await callAI(settings, { prompt, maxTokens: 500 });
    const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) ? parsed.filter((q) => typeof q === "string" && q.trim()) : null;
  } catch (e) {
    console.error("[reviewQuestions] AI pass failed:", e.message);
    return null;
  }
}

/**
 * @param {object} profile - candidateProfile
 * @param {object} job - job record, including reasonsByCategory from scoring
 * @param {object} settings
 * @returns {Promise<string[]>} short list of things to consider — may be empty
 */
async function buildReviewQuestions(profile, job, settings) {
  const rule = ruleBasedFlags(job.reasonsByCategory);
  const ai = await aiQuestions(profile, job, settings);

  const combined = [...(ai || []), ...rule];
  const seen = new Set();
  const out = [];
  for (const q of combined) {
    const key = q.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= 5) break; // keep it a quick read, not a wall of text
  }
  return out;
}

module.exports = { buildReviewQuestions };
