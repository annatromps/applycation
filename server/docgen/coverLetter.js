// Generates a tailored cover-letter .docx. Two modes:
//   1. Template mode (default, no API key needed): picks the candidate's
//      most relevant "talking points" for this posting and assembles them
//      into paragraphs.
//   2. AI-assisted mode (if an AI provider is configured in settings): sends
//      the selected talking points + job description + house rules to it
//      for a more naturally-written draft, then falls back to template
//      mode if the API call fails for any reason.
//
// Either way, the output is run through `applyHouseRules` before being
// written to disk, so banned phrasing (e.g. em dashes) never ships.

const fs = require("fs");
const path = require("path");
const { Document, Packer, TextRun, Paragraph } = require("docx");
const { FONT, A4_PAGE } = require("./style");
const { keywordsOf } = require("./cv");
const { callAI, isAIConfigured } = require("./../ai/client");

function p(text, opts = {}) {
  return new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text, font: FONT, size: 22, ...opts })] });
}

function selectTalkingPoints(profile, job, max = 4) {
  const jobKeywords = new Set(keywordsOf(`${job.title || ""} ${job.description || ""}`));
  const scored = (profile.talkingPoints || []).map((tp) => {
    const hits = (tp.keywords || []).filter((k) => jobKeywords.has(k.toLowerCase())).length;
    return { ...tp, hits };
  });
  scored.sort((a, b) => b.hits - a.hits);
  const withHits = scored.filter((tp) => tp.hits > 0);
  const pool = withHits.length ? withHits : scored;
  return pool.slice(0, max);
}

function applyHouseRules(text, houseRules = {}) {
  let out = text;
  // Em dashes are banned by default per house style; also strip any explicitly
  // configured banned phrases.
  out = out.replace(/\s*—\s*/g, ", ");
  for (const phrase of houseRules.bannedPhrases || []) {
    const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(re, "");
  }
  return out;
}

function buildTemplateParagraphs(profile, job, talkingPoints) {
  const paras = [];
  paras.push(
    `${profile.summary ? profile.summary.split(".")[0] + "." : `I'm a ${profile.headline || "candidate"}.`} I'm applying for the ${job.title} role at ${job.company}.`
  );
  for (const tp of talkingPoints) paras.push(tp.text);
  paras.push(
    `Thank you for considering my application, I'd welcome the chance to talk about how this experience applies to the ${job.title} role.`
  );
  return paras;
}

async function draftWithAI({ profile, job, talkingPoints, settings }) {
  if (!isAIConfigured(settings)) return null;
  const prompt = [
    `Candidate summary: ${profile.summary || ""}`,
    `Candidate name: ${profile.name}`,
    `Job title: ${job.title} at ${job.company}`,
    `Job description: ${(job.description || "").slice(0, 4000)}`,
    `Relevant, VERIFIED-TRUE talking points to draw on (do not invent anything beyond these):`,
    ...talkingPoints.map((tp, i) => `${i + 1}. ${tp.text}`),
    "",
    "Write the BODY of a cover letter (no salutation, no sign-off) as 2-4 short, plain, first-person paragraphs.",
    "Cover the majority of the job posting's key requirements using only the talking points given.",
    "Never fabricate experience not present in the talking points. Never use em dashes. Avoid generic AI-sounding phrasing.",
    houseRuleNote(profile.houseRules),
  ].join("\n");

  try {
    const text = await callAI(settings, { prompt, maxTokens: 900 });
    if (!text) return null;
    return text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    console.error("[coverLetter] AI drafting failed, falling back to template:", e.message);
    return null;
  }
}

function houseRuleNote(houseRules = {}) {
  if (!houseRules.notes) return "";
  return `House style notes: ${houseRules.notes}`;
}

/**
 * Builds the tailored cover letter .docx and returns it as a Buffer (does
 * not touch disk) — see cv.js's buildCVBuffer for why.
 * @param {object} profile - candidateProfile
 * @param {object} job - job record being applied to
 * @param {object} settings - app settings (for optional AI drafting)
 * @returns {Promise<Buffer>}
 */
async function buildCoverLetterBuffer(profile, job, settings) {
  const talkingPoints = selectTalkingPoints(profile, job);
  let paragraphs = await draftWithAI({ profile, job, talkingPoints, settings });
  if (!paragraphs) paragraphs = buildTemplateParagraphs(profile, job, talkingPoints);
  paragraphs = paragraphs.map((t) => applyHouseRules(t, profile.houseRules));

  const children = [
    p(profile.name, { bold: true, size: 24 }),
    p([profile.email, profile.phone].filter(Boolean).join("  |  "), { size: 20 }),
    p(""),
    p(`Dear ${job.company} Hiring Team,`),
    ...paragraphs.map((t) => p(t)),
    p("Best,"),
    p(profile.name),
  ];

  const doc = new Document({
    sections: [
      {
        properties: { page: { size: A4_PAGE, margin: { top: 900, bottom: 900, left: 1100, right: 1100 } } },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

/** Convenience wrapper for local/dev use: builds the letter and writes it to a file path. */
async function generateCoverLetter(profile, job, settings, outPath) {
  const buf = await buildCoverLetterBuffer(profile, job, settings);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return outPath;
}

module.exports = { generateCoverLetter, buildCoverLetterBuffer, selectTalkingPoints, applyHouseRules };
