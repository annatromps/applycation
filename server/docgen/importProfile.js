// Turns raw extracted CV text into the structured candidate-profile shape
// the CV/cover-letter generators use (see README's "Data model" section).
// Requires an Anthropic API key (set in Settings) — there's no reliable
// keyless way to reconstruct structured experience/bullets from arbitrary
// CV formatting. Always returns a DRAFT for the user to review; nothing is
// saved until they explicitly hit Save in the UI.

const SCHEMA_HINT = `{
  "name": "string",
  "email": "string",
  "phone": "string",
  "linkedin": "string",
  "headline": "string (current job title / professional headline)",
  "summary": "string (2-4 sentence professional summary)",
  "skills": [{ "label": "string e.g. Product or Tools", "value": "comma-separated string of skills" }],
  "experience": [
    {
      "title": "string",
      "company": "string",
      "dates": "string e.g. Jan 2022 - Present",
      "subtitle": "string, one line of company/role context (industry, company description), or empty string",
      "bullets": ["string", "..."]
    }
  ],
  "education": [{ "school": "string", "dates": "string", "detail": "string" }],
  "additional": [{ "label": "string e.g. Languages or Interests", "value": "string" }]
}`;

async function importProfileFromText({ text, existingProfile, settings }) {
  if (!settings.anthropicApiKey) {
    throw new Error("Add an Anthropic API key in Settings first — AI-assisted profile import needs it to read your CV.");
  }
  if (!text || text.trim().length < 40) {
    throw new Error("Couldn't find enough readable text in that file to import from.");
  }

  const model = settings.anthropicModel || "claude-sonnet-4-5";
  const prompt = [
    "Extract this person's CV/resume into structured JSON matching EXACTLY this shape (no extra top-level keys):",
    SCHEMA_HINT,
    "",
    "Rules:",
    "- Only use facts actually present in the text below. Never invent employers, dates, or achievements.",
    "- Keep bullet points close to the original wording; light cleanup for grammar/clarity is fine.",
    "- If a field genuinely isn't present in the text (e.g. no LinkedIn URL), use an empty string or empty array.",
    "- Respond with ONLY the JSON object, no markdown code fences, no commentary.",
    "",
    "CV TEXT:",
    text.slice(0, 15000),
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Anthropic API request failed (${res.status}): ${errBody.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = (data.content || []).map((c) => c.text || "").join("\n").trim();
  const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`AI response wasn't valid JSON, try again (${e.message})`);
  }

  // Merge over the existing profile so hand-authored fields that a CV file
  // wouldn't contain (talking points, house rules) survive the import.
  const merged = {
    ...(existingProfile || {}),
    ...parsed,
    talkingPoints: (existingProfile && existingProfile.talkingPoints) || [],
    houseRules: (existingProfile && existingProfile.houseRules) || { bannedPhrases: [], notes: "" },
  };
  return merged;
}

module.exports = { importProfileFromText };
