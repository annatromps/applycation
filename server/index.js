const express = require("express");
// Patches Express 4's router so a rejected promise inside an `async (req,
// res) => {...}` route handler is forwarded to the error-handling
// middleware below, instead of becoming an unhandled promise rejection
// that crashes the whole process. Express 4 does not do this on its own
// (Express 5 does) — without this shim, EVERY route across every file in
// server/routes/ that does `await db.read()`/`db.write()` with no try/catch
// of its own (which is nearly all of them) takes the whole server down the
// moment the database is unreachable, one request at a time, in a repeating
// crash-restart loop that looks identical to the app just being broken.
// This must be required before the route files below, since it works by
// patching express.Router.
require("express-async-errors");
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

// Catches whatever express-async-errors forwards here (see the require at
// the top of this file) — turns a failed request into a clean JSON 500
// instead of Express's default HTML error page, and, critically, instead
// of an unhandled rejection that would otherwise crash the process. Must
// be registered after all the route mounts above (Express only sends
// errors to a 4-arg middleware that comes after the routes that can throw
// them). Logged with the route path so a burst of these in the Railway
// logs is easy to tell apart from a genuine code bug once the database is
// reachable again.
app.use((err, req, res, next) => {
  console.error(`[${req.method} ${req.path}] request failed:`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || "Something went wrong handling that request." });
});

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

// Start listening FIRST, unconditionally, then initialize the store as a
// background step — never the other way around. This used to `await
// db.read()` before calling app.listen() at all, which meant any database
// problem (unreachable Postgres, a full disk volume, a transient network
// blip) took the ENTIRE app offline, including the static frontend files
// below, which don't touch the database and have no reason to depend on
// it being reachable. A user hitting the site during a database outage
// should at least see the app shell (and a clear per-request error from
// whichever API call actually needs the database), not nothing at all —
// the same "a slow AI/network hiccup should never look like the app being
// down" principle backfillMissingScores below already follows, just
// applied one step earlier, to the store-initialization step itself.
app.listen(PORT, () => {
  console.log(`Applycation running at http://localhost:${PORT}`);
  console.log(`Storage backend: ${process.env.DATABASE_URL ? "Postgres" : "local file (data/db.json)"}`);
  // scheduler.reschedule() is async and reads the database internally — it
  // was previously called bare, with no .catch(). An async function's
  // rejection with nothing attached to handle it is an unhandled promise
  // rejection, which crashes the whole Node process by default (Node 15+).
  // That means a database problem didn't just leave the scheduler
  // unconfigured, it took the entire freshly-started server back down
  // moments after "Applycation running at ..." printed — the app briefly
  // coming up and then dying, which from the outside looks identical to it
  // never starting at all, and explains a restart-loop under a sustained
  // database outage (Railway would keep relaunching the container, each
  // attempt crashing here the same way).
  // If this fails, the cron schedule just doesn't get set up this time —
  // it'll be attempted again on the next restart, or immediately the next
  // time settings are saved (routes/settings.js's PUT / also calls
  // scheduler.reschedule()). Not catastrophic on its own; manual discovery
  // runs are unaffected either way.
  scheduler.reschedule().catch((e) => console.error("[startup] Scheduler setup failed, will retry on next restart or settings save:", e.message));
  // Ensures the store is initialized (creates the local file, or the
  // Postgres table + row) — still needed before most API routes will work,
  // but a failure here now only means "the database isn't ready yet",
  // logged clearly, rather than "the whole process refuses to start".
  // db.read() is called again by every route that needs it regardless, so
  // this first call is purely a warm/log-early step, not a hard dependency.
  db.read()
    .then(() => backfillMissingScores())
    .catch((e) => console.error("[startup] Database not reachable yet — API requests will fail until it is:", e.message));
});
