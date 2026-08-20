const express = require("express");
const cors = require("cors");
const path = require("path");
const db = require("./db");
const scheduler = require("./scheduler");
const { scoreJobFully } = require("./jobScoring");
const { resolvePostingForJob } = require("./postingResolver");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use("/api/settings", require("./routes/settings"));
app.use("/api/profile", require("./routes/profile"));
app.use("/api/criteria", require("./routes/criteria"));
app.use("/api/jobs", require("./routes/jobs"));
app.use("/api/stats", require("./routes/stats"));

app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 3000;

// One-time, fully automatic pass over existing jobs that are missing a
// score and/or a real posting URL (added before scoring existed, imported
// manually from a screenshot/notes, etc.) — runs on every startup so there
// is never a manual "rescore" or "go find this myself" step. Only touches
// jobs that are actually missing something; cheap and safe to run every
// restart. Deliberately fire-and-forget, run AFTER the server is already
// listening — it must never be able to delay or block startup (an AI
// provider hiccup, or a slow Greenhouse/Lever lookup, should never look
// like the app being down).
async function backfillMissingScores() {
  const data = await db.read();
  const activeProfiles = (data.criteriaProfiles || []).filter((c) => c.active !== false);
  let changed = false;
  // AI web-search posting lookups (tier 2 of postingResolver.js) cost real
  // money on top of the free ATS-API tier, so cap how many of THOSE get
  // used in one backfill pass across potentially many jobs — the free tier
  // above it has no such cap since it's free. Manual-add and the on-demand
  // "Find posting" button are single-job actions and don't need this.
  let aiPostingSearchesUsed = 0;
  const maxAiPostingSearches = data.settings.maxAiPostingSearchesPerCycle ?? 10;

  for (const job of data.jobs) {
    // Try to find a real posting URL/description first (see
    // server/postingResolver.js) — free public ATS-API lookups, then an
    // AI web-search lookup if those come up empty and a provider's
    // configured. No scraping, nothing for you to approve per job. If this
    // finds something, the scoring pass right after picks up the new
    // description too.
    if (!job.url) {
      const found = await resolvePostingForJob(
        { title: job.title, company: job.company },
        data.settings,
        { allowAiWebSearch: aiPostingSearchesUsed < maxAiPostingSearches }
      );
      if (found.found) {
        job.url = found.url;
        if (!job.description) job.description = found.description;
        changed = true;
        if (found.resolvedVia === "ai-web-search") aiPostingSearchesUsed++;
      }
    }

    const missingMatch = job.score == null && job.matchedCriteriaId == null && activeProfiles.length > 0;
    const missingEase = job.submissionEaseScore == null && Boolean(job.description || job.url);
    if (!missingMatch && !missingEase) continue;

    const jobForScoring = {
      title: job.title,
      company: job.company,
      location: job.location || "",
      remote: Boolean(job.remote),
      salary: job.salary || "",
      description: job.description || "",
      url: job.url || "",
    };

    let fields;
    try {
      fields = await scoreJobFully(jobForScoring, data);
    } catch (e) {
      console.error(`[backfill] Scoring failed for "${job.title}":`, e.message);
      continue;
    }

    if (missingMatch && fields.matchedCriteriaId != null) {
      job.matchedCriteriaId = fields.matchedCriteriaId;
      job.matchedCriteriaName = fields.matchedCriteriaName;
      job.score = fields.score;
      job.candidateFitScore = fields.candidateFitScore;
      job.roleAppealScore = fields.roleAppealScore;
      job.scoreReasons = fields.scoreReasons;
      job.reasonsByCategory = fields.reasonsByCategory;
      changed = true;
    }
    if (missingEase && fields.submissionEaseScore != null) {
      job.submissionEaseScore = fields.submissionEaseScore;
      job.easeReasons = fields.easeReasons;
      changed = true;
    }
  }

  if (changed) {
    await db.write(data);
    console.log("[backfill] Filled in missing scores/posting links for existing jobs.");
  }
}

(async () => {
  // Ensure the store is initialized (creates the local file, or the Postgres
  // table + row, depending on which backend is active) before serving traffic.
  await db.read();
  app.listen(PORT, () => {
    console.log(`Applycation running at http://localhost:${PORT}`);
    console.log(`Storage backend: ${process.env.DATABASE_URL ? "Postgres" : "local file (data/db.json)"}`);
    scheduler.reschedule();
    backfillMissingScores().catch((e) => console.error("[backfill] failed:", e.message));
  });
})().catch((e) => {
  console.error("Failed to start:", e);
  process.exit(1);
});
