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

/**
 * Builds the tailored CV .docx and returns it as a Buffer (does not touch
 * disk) — the primary API, so generated documents can be stored wherever
 * the active db backend keeps them (embedded in Postgres, in this app's
 * case) rather than assuming a writable local filesystem.
 * @param {object} profile - candidateProfile from the data store
 * @param {object|null} job - a job record to tailor bullet order against (optional)
 * @returns {Promise<Buffer>}
 */
async function buildCVBuffer(profile, job) {
  const children = [];

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
