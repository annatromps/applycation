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

// A candidateProfile object existing at all isn't the same as it having
// anything useful in it — uploading a CV file (routes/profile.js's
// /cv-upload) or opening the Me tab's profile editor both leave a
// non-null-but-entirely-blank {name:"", experience:[], ...} object behind,
// which used to be enough to pass every `Boolean(data.candidateProfile)`
// auto-generation check below and in discovery.js/routes/jobs.js. The
// generator would then run "successfully" against nothing and quietly
// produce an essentially blank CV/cover letter (empty name in the
// filename, no experience section) with no error anywhere — exactly what
// happened here: discovery marked materials as ready, but there was
// nothing behind them yet. Requires either a name or at least one real
// experience entry before treating the profile as something worth
// generating from.
function hasMeaningfulProfile(candidateProfile) {
  return Boolean(candidateProfile && (String(candidateProfile.name || "").trim() || (candidateProfile.experience || []).length));
}

async function buildMaterialsForJob(candidateProfile, job, settings) {
  if (!hasMeaningfulProfile(candidateProfile)) {
    throw new Error(
      "Your candidate profile is still empty — add your name and at least one role under the Me tab (or upload a CV and click \"Import profile from CV\") before materials can be generated."
    );
  }
  const safeCompany = (job.company || "company").replace(/[^a-z0-9\- ]/gi, "").trim();
  const cvFilename = `${candidateProfile.name} - CV - ${safeCompany}.docx`;
  const coverLetterFilename = `${candidateProfile.name} - Cover Letter - ${safeCompany}.docx`;

  const [cvBuf, coverLetterBuf, tailoringSummary, reviewQuestions] = await Promise.all([
    buildCVBuffer(candidateProfile, job, settings),
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

module.exports = { buildMaterialsForJob, hasMeaningfulProfile };
