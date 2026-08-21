// AI-assisted starting point for a NEW criteria profile, drafted from the
// candidate's own CV — same spirit as importProfile.js's CV-to-profile
// import, applied to the "what am I searching for" side instead of the
// "who am I" side. Only ever returns a DRAFT for review in the criteria
// editor modal; nothing is saved until the user explicitly hits Save there
// (same "never silently write" rule as importProfile.js).
//
// Important distinction from importProfile.js: a CV is a record of past
// experience and skills — it can genuinely tell you what titles/seniority/
// technologies/industries someone is qualified for. It says NOTHING about
// job-search PREFERENCES: whether they want remote work, their minimum
// salary, dealbreakers, industries to avoid, or company size — those are
// subjective choices a CV doesn't state, so this deliberately leaves every
// preference-only field at the same sensible defaults a blank new profile
// would get (see server/routes/criteria.js's POST /) rather than inventing
// values for them. Populating those from thin air would look like a
// real answer while actually just being a guess dressed up as one.

const { callAI, isAIConfigured } = require("./../ai/client");

const SCHEMA_HINT = `{
  "name": "string — a short label for this search, e.g. 'Senior Product Manager roles'",
  "titleKeywords": ["string", "... 2-5 job titles this person's experience actually qualifies them for, based on their most recent/strongest roles"],
  "seniority": ["string", "... e.g. Senior, Staff, Lead — only if their experience clearly implies a level, otherwise empty array"],
  "locations": ["string", "... cities/countries/regions, ONLY if an address or explicit location is stated in the CV text, otherwise empty array — never guess a location from company HQs or job history alone"],
  "languages": ["string", "... spoken/written languages the CV explicitly says this person speaks, otherwise empty array — do not include programming languages here"],
  "favouriteTechnologies": ["string", "... up to 8 tools/technologies/methodologies that show up repeatedly in their actual experience, otherwise empty array"],
  "sectorsInclude": ["string", "... up to 5 industries their past employers were actually in, otherwise empty array"]
}`;

async function importCriteriaFromCV({ text, candidateProfile, settings }) {
  if (!isAIConfigured(settings)) {
    throw new Error("Add an AI provider + API key under Advanced settings first — this needs it to read your CV.");
  }
  if (!text || text.trim().length < 40) {
    throw new Error("Couldn't find enough readable text in your uploaded CV to draft from.");
  }

  const prompt = [
    "Below is a candidate's CV. Draft a JOB SEARCH criteria starting point from it, matching EXACTLY this JSON shape (no extra top-level keys):",
    SCHEMA_HINT,
    "",
    "Rules:",
    "- Only include what the CV's actual content genuinely supports — titles/seniority/technologies/industries they're qualified for based on real experience. Never invent a location, language, or industry not evidenced in the text.",
    "- This is a DRAFT the candidate will review and edit before anything is saved, but it still needs to be honest — when genuinely unsure, prefer an empty array over a guess.",
    "- This CV says nothing about job-search PREFERENCES (remote/hybrid/office, minimum salary, dealbreakers, industries to avoid, company size) — don't try to infer those; they're intentionally not part of the requested shape.",
    "- Respond with ONLY the JSON object, no markdown code fences, no commentary.",
    "",
    "CV TEXT:",
    text.slice(0, 15000),
  ].join("\n");

  const raw = await callAI(settings, { prompt, maxTokens: 1000 });
  const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`AI response wasn't valid JSON, try again (${e.message})`);
  }

  // Merge the AI's CV-derived fields over a blank profile's defaults (same
  // shape as server/routes/criteria.js's POST /) so every preference-only
  // field stays at its normal "no restriction yet" default rather than
  // missing entirely — the criteria editor modal expects the full shape.
  return {
    active: true,
    name: parsed.name || (candidateProfile && candidateProfile.headline) || "",
    locations: Array.isArray(parsed.locations) ? parsed.locations : [],
    workArrangements: ["remote", "hybrid", "office"],
    remoteLocations: [],
    visaSponsorshipRequired: false,
    languages: Array.isArray(parsed.languages) ? parsed.languages : [],
    titleKeywords: Array.isArray(parsed.titleKeywords) ? parsed.titleKeywords : [],
    excludeKeywords: [],
    roleTypes: [],
    seniority: Array.isArray(parsed.seniority) ? parsed.seniority : [],
    minSalary: null,
    rolePriorities: [],
    dealbreakers: [],
    sectorsInclude: Array.isArray(parsed.sectorsInclude) ? parsed.sectorsInclude : [],
    sectorsExclude: [],
    favouriteTechnologies: Array.isArray(parsed.favouriteTechnologies) ? parsed.favouriteTechnologies : [],
    hiddenTechnologies: [],
    companySizes: [],
    followedCompanies: [],
    aiPreferences: "",
    sources: { remotive: true, arbeitnow: true, remoteok: true, greenhouse: { enabled: false, companies: [] }, lever: { enabled: false, companies: [] } },
  };
}

module.exports = { importCriteriaFromCV };
