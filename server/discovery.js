const crypto = require("crypto");
const db = require("./db");
const { discoverJobs } = require("./sources");
const { scoreJob, scoreJobWithAI, buildFeedbackContext } = require("./scoring");
const { buildMaterialsForJob } = require("./docgen/materials");
const { sendNotification } = require("./notify");

const AI_PRESCREEN_THRESHOLD = 35; // don't bother spending an AI call on jobs the rules already hate

/**
 * Runs one full discovery cycle across all active criteria profiles:
 * fetch from sources, score against criteria (rules, then optionally an AI
 * pass driven by the profile's free-text "AI preferences"), insert new
 * matches into the jobs table (deduped against jobs already known), notify
 * if configured. Used by both the scheduler and the manual "run now" API endpoint.
 */
async function runDiscoveryCycle() {
  const data = await db.read();
  const activeProfiles = (data.criteriaProfiles || []).filter((c) => c.active !== false);
  const existingKeys = new Set(data.jobs.map((j) => `${j.source}:${j.sourceId}`));
  const newlyAdded = [];
  const maxAiPerCycle = data.settings.maxAiScoredPerCycle ?? 15;
  // Built once per cycle (not per job) — your accumulated 👍/👎 feedback,
  // fed into the AI scoring pass below so matching actually improves over
  // time instead of just displaying the feedback back at you.
  const feedbackContext = buildFeedbackContext(data.jobs);

  // Auto-generate a tailored CV + cover letter for every surfaced match, so
  // materials are already waiting when you open it — on by default, but a
  // real cost guard: AI-assisted cover-letter drafting (if an Anthropic key
  // is set) makes one API call per job, so this is capped per cycle just
  // like the AI scoring pass above. Skipped entirely with no candidate
  // profile set yet; anything skipped by the cap can still be generated
  // manually from the job's detail view.
  const autoGenerateMaterials = data.settings.autoGenerateMaterials !== false && Boolean(data.candidateProfile);
  const maxMaterialsPerCycle = data.settings.maxMaterialsGeneratedPerCycle ?? 20;
  let materialsGeneratedThisCycle = 0;
  let materialsSkippedForCap = 0;

  for (const criteria of activeProfiles) {
    const found = await discoverJobs(criteria);
    const candidates = [];

    for (const job of found) {
      const key = `${job.source}:${job.sourceId}`;
      if (existingKeys.has(key)) continue; // already discovered in a prior run
      existingKeys.add(key);

      const { score, candidateFitScore, roleAppealScore, hardFail, reasons, reasonsByCategory } = scoreJob(job, criteria);
      if (hardFail) continue; // never surface dealbreaker matches at all
      candidates.push({
        job,
        ruleScore: score,
        ruleCandidateFit: candidateFitScore,
        ruleRoleAppeal: roleAppealScore,
        reasons,
        reasonsByCategory,
      });
    }

    // Optional AI-assisted second pass, driven by the profile's free-text
    // preferences. Bounded in two ways to control cost: only jobs that
    // already cleared a low rule-based bar are considered, and at most
    // `maxAiScoredPerCycle` calls are made, spent on the strongest
    // rule-based candidates first.
    const useAI = Boolean(data.settings.anthropicApiKey && (criteria.aiPreferences || "").trim());
    if (useAI) {
      const eligible = candidates
        .filter((c) => c.ruleScore >= AI_PRESCREEN_THRESHOLD)
        .sort((a, b) => b.ruleScore - a.ruleScore)
        .slice(0, maxAiPerCycle);
      for (const c of eligible) {
        try {
          const ai = await scoreJobWithAI(c.job, criteria, data.settings, feedbackContext);
          c.finalCandidateFit = Math.round((c.ruleCandidateFit + ai.candidateFitScore) / 2);
          c.finalRoleAppeal = Math.round((c.ruleRoleAppeal + ai.roleAppealScore) / 2);
          c.reasonsByCategory = {
            candidateFit: [...c.reasonsByCategory.candidateFit, ...ai.candidateFitReasons],
            roleAppeal: [...c.reasonsByCategory.roleAppeal, ...ai.roleAppealReasons],
          };
          c.reasons = [...c.reasonsByCategory.candidateFit, ...c.reasonsByCategory.roleAppeal];
        } catch (e) {
          console.error(`[discovery] AI scoring failed for "${c.job.title}":`, e.message);
        }
      }
    }

    for (const c of candidates) {
      const candidateFitScore = c.finalCandidateFit ?? c.ruleCandidateFit;
      const roleAppealScore = c.finalRoleAppeal ?? c.ruleRoleAppeal;
      const finalScore = Math.round((candidateFitScore + roleAppealScore) / 2);
      if (finalScore < (data.settings.minScoreToSurface ?? 55)) continue;

      const record = {
        id: crypto.randomUUID(),
        ...c.job,
        matchedCriteriaId: criteria.id,
        matchedCriteriaName: criteria.name,
        score: finalScore,
        candidateFitScore, // 0-100 — "how good a match am I for its requirements"
        roleAppealScore, // 0-100 — "how good does this look for me" (perks/salary/fit)
        scoreReasons: c.reasons,
        reasonsByCategory: c.reasonsByCategory,
        discoveredAt: new Date().toISOString(),
        status: "discovered",
        statusHistory: [{ status: "discovered", at: new Date().toISOString() }],
        notes: "",
        feedback: null, // { rating: "up" | "down", note: "", ratedAt } — see routes/jobs.js's /feedback endpoint
        materials: null,
        appliedAt: null,
        outcomeAt: null,
        outcome: null,
      };

      if (autoGenerateMaterials) {
        if (materialsGeneratedThisCycle < maxMaterialsPerCycle) {
          try {
            record.materials = await buildMaterialsForJob(data.candidateProfile, record, data.settings);
            materialsGeneratedThisCycle++;
          } catch (e) {
            console.error(`[discovery] Auto-generating materials failed for "${record.title}":`, e.message);
          }
        } else {
          materialsSkippedForCap++;
        }
      }

      data.jobs.push(record);
      newlyAdded.push(record);
    }
  }

  if (materialsSkippedForCap) {
    console.log(
      `[discovery] Skipped auto-generating materials for ${materialsSkippedForCap} match(es) — hit the ${maxMaterialsPerCycle}/cycle cap. Generate manually from each job's detail view, or raise "Max materials generated per cycle" in Settings.`
    );
  }

  data.meta.lastDiscoveryRun = new Date().toISOString();
  await db.write(data);

  if (newlyAdded.length) {
    await sendNotification(data.settings, {
      title: `Applycation: ${newlyAdded.length} new match${newlyAdded.length === 1 ? "" : "es"}`,
      body: newlyAdded.map((j) => `${j.title} @ ${j.company} (score ${j.score}) — ${j.url}`).join("\n"),
    });
  }

  return newlyAdded;
}

module.exports = { runDiscoveryCycle };
