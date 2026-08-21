// Generates a tailored CV .docx from a candidate profile + (optionally) a
// target job. Tailoring = reordering each role's bullets so the ones most
// relevant to the job description surface first. It never invents or removes
// facts — only reorders what's already in the profile.

const fs = require("fs");
const path = require("path");
const { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle } = require("docx");
const {
  FONT, NAVY, GREY, RULE, A4_PAGE, BULLET_NUMBERING,
  bullet, roleHeader, roleSub, sectionHeading, eduEntry,
} = require("./style");
const { callAI, isAIConfigured } = require("./../ai/client");

const STOPWORDS = new Set([
  "the","a","an","and","or","of","to","in","on","for","with","at","by","from",
  "is","are","be","as","that","this","will","you","your","our","we","it","its",
  "into","across","using","use","team","teams","role","work","working","experience",
]);

function keywordsOf(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function relevance(bulletText, jobKeywordSet) {
  const words = keywordsOf(bulletText);
  let hits = 0;
  for (const w of words) if (jobKeywordSet.has(w)) hits++;
  return hits;
}

function tailorBullets(bullets, job) {
  if (!job || !job.description) return bullets;
  const jobKeywords = new Set(keywordsOf(`${job.title || ""} ${job.description}`));
  return [...bullets].sort((a, b) => relevance(b, jobKeywords) - relevance(a, jobKeywords));
}

// The CV never invents or drops facts — see file header. This is the one
// place that pulls in anything beyond the profile's structured `experience`
// bullets, and it stays inside that same rule: the "experience bank" is a
// free-text scratchpad of Anna's own true background notes (Settings ->
// Candidate profile), and the AI here is only allowed to select/lightly trim
// snippets that already exist in it verbatim — never combine, embellish, or
// invent anything beyond what's literally written there. Skipped entirely
// without an AI provider configured, since picking "what's relevant" well
// needs real reading comprehension, not keyword matching.
async function selectFromExperienceBank(profile, job, settings) {
  const bank = (profile.experienceBank || "").trim();
  if (!bank || !job || !job.description || !job.description.trim() || !isAIConfigured(settings)) return [];

  const prompt = [
    "Below is a candidate's free-form bank of additional true experience/background notes, followed by a job description.",
    "Pick at most 2 short snippets from the bank that are directly relevant to THIS job and would strengthen a CV for it.",
    "Each snippet you return must be a DIRECT QUOTE, or a lightly trimmed version, of text that already appears in the bank below — never invent, embellish, combine separate notes into one claim, or state anything not literally written there.",
    "If nothing in the bank is genuinely relevant to this job, return an empty array — don't force it.",
    'Return ONLY a JSON array of strings, no markdown fences, no commentary, e.g. ["snippet one", "snippet two"]',
    "",
    "CANDIDATE'S EXPERIENCE BANK:",
    bank.slice(0, 6000),
    "",
    `JOB TITLE: ${job.title || ""} at ${job.company || ""}`,
    `JOB DESCRIPTION: ${job.description.slice(0, 3000)}`,
    // Feedback on a previous draft of this CV (job detail view's
    // "Regenerate" flow) — e.g. "drop the internship mention" should mean
    // don't pick a bank snippet about it even if it would otherwise match.
    ...(job.materialsFeedback && job.materialsFeedback.trim()
      ? ["", `The candidate reviewed an earlier draft of this exact CV and left this feedback — take it into account when picking snippets: ${job.materialsFeedback.trim()}`]
      : []),
  ].join("\n");

  try {
    const raw = await callAI(settings, { prompt, maxTokens: 400 });
    const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string" && s.trim()).slice(0, 2) : [];
  } catch (e) {
    console.error("[cv] Experience-bank selection failed, skipping:", e.message);
    return [];
  }
}

/**
 * Builds the tailored CV .docx and returns it as a Buffer (does not touch
 * disk) — the primary API, so generated documents can be stored wherever
 * the active db backend keeps them (embedded in Postgres, in this app's
 * case) rather than assuming a writable local filesystem.
 * @param {object} profile - candidateProfile from the data store
 * @param {object|null} job - a job record to tailor bullet order against (optional)
 * @param {object} [settings] - app settings; only used for the optional AI-assisted
 *   experience-bank selection below (see selectFromExperienceBank) — omit or leave
 *   AI unconfigured and the CV still builds fine, just without that section.
 * @returns {Promise<Buffer>}
 */
async function buildCVBuffer(profile, job, settings = {}) {
  const children = [];
  const bankSnippets = await selectFromExperienceBank(profile, job, settings);

  children.push(
    new Paragraph({
      spacing: { after: 40 },
      children: [new TextRun({ text: profile.name, bold: true, font: FONT, size: 40, color: NAVY })],
    }),
    new Paragraph({
      spacing: { after: 220 },
      children: [new TextRun({ text: profile.headline || "", font: FONT, size: 24, color: GREY })],
    }),
    new Paragraph({
      spacing: { after: 260 },
      border: { bottom: { color: RULE, space: 8, style: BorderStyle.SINGLE, size: 6 } },
      children: [
        new TextRun({ text: profile.email || "", font: FONT, size: 20 }),
        ...(profile.phone ? [new TextRun({ text: "   |   ", font: FONT, size: 20, color: GREY }), new TextRun({ text: profile.phone, font: FONT, size: 20 })] : []),
        ...(profile.linkedin ? [new TextRun({ text: "   |   ", font: FONT, size: 20, color: GREY }), new TextRun({ text: `LinkedIn: ${profile.linkedin}`, font: FONT, size: 20 })] : []),
      ],
    })
  );

  if (profile.summary) {
    children.push(
      sectionHeading("Profile"),
      new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({ text: profile.summary, font: FONT, size: 21 })],
      })
    );
  }

  if ((profile.skills || []).length) {
    children.push(sectionHeading("Skills & Technologies"));
    profile.skills.forEach((s, i) => {
      children.push(
        new Paragraph({
          spacing: { after: i === profile.skills.length - 1 ? 0 : 60 },
          children: [
            new TextRun({ text: `${s.label}: `, bold: true, font: FONT, size: 21 }),
            new TextRun({ text: s.value, font: FONT, size: 21 }),
          ],
        })
      );
    });
  }

  if ((profile.experience || []).length) {
    children.push(sectionHeading("Work Experience"));
    for (const role of profile.experience) {
      children.push(roleHeader(role.title, role.company, role.dates));
      if (role.subtitle) children.push(roleSub(role.subtitle));
      const orderedBullets = tailorBullets(role.bullets || [], job);
      for (const b of orderedBullets) children.push(bullet(b));
    }
  }

  if (bankSnippets.length) {
    // Pulled from the Candidate Profile's free-text "experience bank" — see
    // selectFromExperienceBank above. Kept as its own labelled section
    // (rather than silently merged into a role's bullets) so it's always
    // clear this came from that scratchpad, not the structured work history.
    children.push(sectionHeading("Additional Relevant Experience"));
    for (const s of bankSnippets) children.push(bullet(s));
  }

  if ((profile.education || []).length) {
    children.push(sectionHeading("Education"));
    for (const e of profile.education) children.push(...eduEntry(e.school, e.dates, e.detail));
  }

  if ((profile.additional || []).length) {
    children.push(sectionHeading("Additional Information"));
    profile.additional.forEach((a, i) => {
      children.push(
        new Paragraph({
          spacing: { after: i === profile.additional.length - 1 ? 0 : 60 },
          children: [
            new TextRun({ text: `${a.label}: `, bold: true, font: FONT, size: 21 }),
            new TextRun({ text: a.value, font: FONT, size: 21 }),
          ],
        })
      );
    });
  }

  const doc = new Document({
    numbering: BULLET_NUMBERING,
    sections: [
      {
        properties: { page: { size: A4_PAGE, margin: { top: 620, bottom: 620, left: 620, right: 620 } } },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

/** Convenience wrapper for local/dev use: builds the CV and writes it to a file path. */
async function generateCV(profile, job, outPath) {
  const buf = await buildCVBuffer(profile, job);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return outPath;
}

module.exports = { generateCV, buildCVBuffer, tailorBullets, keywordsOf };
