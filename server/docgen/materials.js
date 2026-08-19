// Builds the base64 "materials" blob (tailored CV + cover letter, both
// .docx) stored against a job record. Shared by:
//   - the manual "Generate/Regenerate CV & cover letter" API endpoint
//     (routes/jobs.js), triggered from the job detail view
//   - automatic generation at discovery time (discovery.js), so materials
//     are already waiting by the time you open a newly-surfaced match
// Kept in one place so both paths produce identically-shaped output.

const { buildCVBuffer } = require("./cv");
const { buildCoverLetterBuffer } = require("./coverLetter");
const { buildTailoringSummary } = require("./tailoringSummary");
const { buildReviewQuestions } = require("./reviewQuestions");

async function buildMaterialsForJob(candidateProfile, job, settings) {
  const safeCompany = (job.company || "company").replace(/[^a-z0-9\- ]/gi, "").trim();
  const cvFilename = `${candidateProfile.name} - CV - ${safeCompany}.docx`;
  const coverLetterFilename = `${candidateProfile.name} - Cover Letter - ${safeCompany}.docx`;

  const [cvBuf, coverLetterBuf, tailoringSummary, reviewQuestions] = await Promise.all([
    buildCVBuffer(candidateProfile, job),
    buildCoverLetterBuffer(candidateProfile, job, settings),
    buildTailoringSummary(candidateProfile, job, settings),
    buildReviewQuestions(candidateProfile, job, settings),
  ]);

  return {
    cvBase64: cvBuf.toString("base64"),
    coverLetterBase64: coverLetterBuf.toString("base64"),
    cvFilename,
    coverLetterFilename,
    tailoringSummary, // plain-English explanation of how the CV's bullet order was tailored for this job — see tailoringSummary.js
    reviewQuestions, // short list of things to consider before applying — see reviewQuestions.js
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildMaterialsForJob };
