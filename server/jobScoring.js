// Shared "score this job-shaped object right now" logic — used by the
// manual-add endpoint, the auto-rescore-on-edit behaviour in PATCH /:id, and
// the one-time startup backfill for older jobs that predate a scoring field.
// Kept in one place so all three stay in sync instead of drifting apart.
//
// Scoring is always automatic here — there is deliberately no "rescore"
// button anywhere in the UI. Whenever a job's own details change (added,
// edited) or the app starts up and finds a job missing a score, it just gets
// scored, same as a freshly-discovered job would.
const { scoreJob, scoreJobWithAI, buildFeedbackContext, scoreSubmissionEaseFull } = require("./scoring");
const { isAIConfigured } = require("./ai/client");

// Scores a job-shaped object against every active criteria profile, keeping
// whichever fits best (same idea as discovery.js, just for one job), with an
// optional AI-assisted blend on top when configured and a real description
// is available. Returns the null-scored shape unchanged if there's no active
// criteria profile at all to score against.
async function scoreAgainstCriteria(jobForScoring, data) {
  let scoreFields = {
    matchedCriteriaId: null,
    matchedCriteriaName: null,
    score: null,
    candidateFitScore: null,
    roleAppealScore: null,
    scoreReasons: [],
    reasonsByCategory: { candidateFit: [], roleAppeal: [] },
  };

  const activeProfiles = (data.criteriaProfiles || []).filter((c) => c.active !== false);
  if (!activeProfiles.length) return scoreFields;

  let best = null;
  for (const criteria of activeProfiles) {
    const r = scoreJob(jobForScoring, criteria);
    if (r.hardFail) continue;
    if (!best || r.score > best.result.score) best = { criteria, result: r };
  }
  if (!best) return scoreFields;

  let { score, candidateFitScore, roleAppealScore, reasons, reasonsByCategory } = best.result;
  const useAI =
    isAIConfigured(data.settings) &&
    Boolean((best.criteria.aiPreferences || "").trim()) &&
    Boolean(jobForScoring.description && jobForScoring.description.trim());
  if (useAI) {
    try {
      const feedbackContext = buildFeedbackContext(data.jobs);
      const ai = await scoreJobWithAI(jobForScoring, best.criteria, data.settings, feedbackContext);
      candidateFitScore = Math.round((candidateFitScore + ai.candidateFitScore) / 2);
      roleAppealScore = Math.round((roleAppealScore + ai.roleAppealScore) / 2);
      reasonsByCategory = {
        candidateFit: [...reasonsByCategory.candidateFit, ...ai.candidateFitReasons],
        roleAppeal: [...reasonsByCategory.roleAppeal, ...ai.roleAppealReasons],
      };
      reasons = [...reasonsByCategory.candidateFit, ...reasonsByCategory.roleAppeal];
      score = Math.round((candidateFitScore + roleAppealScore) / 2);
    } catch (e) {
      console.error(`[jobScoring] AI scoring failed for "${jobForScoring.title}":`, e.message);
    }
  }
  return {
    matchedCriteriaId: best.criteria.id,
    matchedCriteriaName: best.criteria.name,
    score,
    candidateFitScore,
    roleAppealScore,
    scoreReasons: reasons,
    reasonsByCategory,
  };
}

// Runs both the criteria match score and the (criteria-independent)
// submission-ease score for a job in one go — this is the entry point every
// caller should use so a job always ends up fully scored on every dimension.
async function scoreJobFully(jobForScoring, data) {
  const [criteriaFields, easeFields] = await Promise.all([
    scoreAgainstCriteria(jobForScoring, data),
    scoreSubmissionEaseFull(jobForScoring, data.settings),
  ]);
  return { ...criteriaFields, ...easeFields };
}

module.exports = { scoreAgainstCriteria, scoreJobFully };
