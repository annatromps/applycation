const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const db = require("./../db");
const { runDiscoveryCycle } = require("./../discovery");
const { buildMaterialsForJob } = require("./../docgen/materials");
const { scoreJobFully } = require("./../jobScoring");

const VALID_STATUSES = [
  "discovered", "reviewing", "approved", "materials_ready",
  "submitted", "interviewing", "offer", "rejected", "withdrawn", "dismissed",
];
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// The base64 document bytes are large and never needed outside the dedicated
// /materials download endpoints below — every other response strips down to
// this metadata, which now includes the plain-English tailoring summary
// (text, cheap to include everywhere it's relevant).
function publicMaterials(materials) {
  if (!materials) return null;
  return {
    generatedAt: materials.generatedAt,
    cvFilename: materials.cvFilename,
    coverLetterFilename: materials.coverLetterFilename,
    tailoringSummary: materials.tailoringSummary || null,
    reviewQuestions: materials.reviewQuestions || [],
  };
}

router.get("/", async (req, res) => {
  const { jobs } = await db.read();
  const { status } = req.query;
  const filtered = status ? jobs.filter((j) => j.status === status) : jobs;
  const stripped = filtered.map(({ materials, ...rest }) => ({ ...rest, materials: publicMaterials(materials) }));
  res.json(stripped.sort((a, b) => new Date(b.discoveredAt) - new Date(a.discoveredAt)));
});

router.get("/:id", async (req, res) => {
  const { jobs } = await db.read();
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  const { materials, ...rest } = job;
  res.json({ ...rest, materials: publicMaterials(materials) });
});

// Manually add a job found outside the automated sources (e.g. one you
// found yourself on a board this app doesn't search, or an application you
// already had in flight before you started using it). Scored — on every
// dimension, match AND submission ease — exactly like an auto-discovered
// job would be, automatically, using whatever fields you gave it, so a job
// added with just a title/company still gets a real, if thinner, score
// rather than a permanent "–/10". See server/jobScoring.js for the shared
// scoring logic (also used when you edit a job's details, and to backfill
// older jobs at startup) — there's no manual "rescore" step anywhere.
router.post("/", async (req, res) => {
  const { title, company, location, url, status, notes, salary, description, source } = req.body || {};
  if (!title || !company) {
    return res.status(400).json({ error: "title and company are required" });
  }
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `invalid status, must be one of: ${VALID_STATUSES.join(", ")}` });
  }
  const data = await db.read();
  const now = new Date().toISOString();
  const initialStatus = status || "reviewing";

  const jobForScoring = {
    title,
    company,
    location: location || "",
    remote: false,
    salary: salary || "",
    description: description || "",
    url: url || "",
  };

  const scoreFields = await scoreJobFully(jobForScoring, data);

  const record = {
    id: crypto.randomUUID(),
    title,
    company,
    location: location || "",
    remote: false,
    salary: salary || "",
    description: description || "",
    url: url || "",
    source: source || "manual",
    sourceId: crypto.randomUUID(),
    ...scoreFields,
    discoveredAt: now,
    status: initialStatus,
    statusHistory: [{ status: initialStatus, at: now, note: "Added manually" }],
    notes: notes || "",
    feedback: null,
    materials: null,
    appliedAt: ["submitted", "interviewing", "offer", "rejected", "withdrawn"].includes(initialStatus) ? now : null,
    outcomeAt: null,
    outcome: null,
  };

  // Same auto-generation behaviour as discovery: build materials right away
  // if you've left that setting on and have a candidate profile saved, so
  // this job is just as "ready" as one the automated search would surface.
  if (data.settings.autoGenerateMaterials !== false && data.candidateProfile) {
    try {
      record.materials = await buildMaterialsForJob(data.candidateProfile, record, data.settings);
    } catch (e) {
      console.error(`[jobs] Auto-generating materials failed for manually-added "${title}":`, e.message);
    }
  }

  data.jobs.push(record);
  await db.write(data);
  const { materials, ...rest } = record;
  res.status(201).json({ ...rest, materials: publicMaterials(materials) });
});

// Edits the handful of fields a manually-added job often starts out missing
// (the real posting link, its description/"summary", location, salary) —
// e.g. once you've found the actual listing and want to paste its details
// in. Re-scores automatically as part of the same request whenever any of
// those fields change, so a new description immediately feeds into both the
// match score and the submission-ease score — no separate rescore step.
router.patch("/:id", async (req, res) => {
  const { url, description, location, salary } = req.body || {};
  const data = await db.read();
  const job = data.jobs.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  const changedScoringInputs =
    (url !== undefined && url !== job.url) ||
    (description !== undefined && description !== job.description) ||
    (location !== undefined && location !== job.location) ||
    (salary !== undefined && salary !== job.salary);

  if (url !== undefined) job.url = url;
  if (description !== undefined) job.description = description;
  if (location !== undefined) job.location = location;
  if (salary !== undefined) job.salary = salary;

  if (changedScoringInputs) {
    const jobForScoring = {
      title: job.title,
      company: job.company,
      location: job.location || "",
      remote: Boolean(job.remote),
      salary: job.salary || "",
      description: job.description || "",
      url: job.url || "",
    };
    Object.assign(job, await scoreJobFully(jobForScoring, data));
  }

  await db.write(data);
  const { materials, ...rest } = job;
  res.json({ ...rest, materials: publicMaterials(materials) });
});

router.post("/discover", async (req, res) => {
  try {
    const added = await runDiscoveryCycle();
    res.json({ added: added.length, jobs: added });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/status", async (req, res) => {
  const { status, note, outcome } = req.body || {};
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `invalid status, must be one of: ${VALID_STATUSES.join(", ")}` });
  }
  const data = await db.read();
  const job = data.jobs.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  const now = new Date().toISOString();
  const APPLIED_OR_LATER = ["submitted", "interviewing", "offer", "rejected", "withdrawn"];
  if (status) {
    job.status = status;
    job.statusHistory.push({ status, at: now, note: note || undefined });
    if (status === "submitted") job.appliedAt = now;
    // Moving back to a pre-application stage (e.g. correcting a mistaken
    // "submitted") clears the applied date — it's no longer true.
    else if (!APPLIED_OR_LATER.includes(status)) job.appliedAt = null;
    if (["offer", "rejected", "withdrawn"].includes(status)) {
      job.outcomeAt = now;
      job.outcome = outcome || status;
    }
  }
  if (note && !status) job.notes = note;
  await db.write(data);
  const { materials, ...rest } = job;
  res.json({ ...rest, materials: publicMaterials(materials) });
});

// Thumbs up/down + optional note on a suggested job. Stored per-job and fed
// back into the AI-assisted scoring pass on future discovery runs (see
// scoring.js's buildFeedbackContext / discovery.js) so match quality
// improves over time — most useful once an Anthropic API key + AI
// preferences are set in Settings, since that's the pass that actually
// reads it; without a key it's still stored and shown, just not yet acted on.
router.post("/:id/feedback", async (req, res) => {
  const { rating, note } = req.body || {};
  if (rating !== undefined && rating !== null && !["up", "down"].includes(rating)) {
    return res.status(400).json({ error: 'rating must be "up", "down", or null' });
  }
  const data = await db.read();
  const job = data.jobs.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  const existing = job.feedback || {};
  const nextRating = rating !== undefined ? rating : existing.rating || null;
  const nextNote = note !== undefined ? note : existing.note || "";
  job.feedback = nextRating || nextNote
    ? { rating: nextRating, note: nextNote, ratedAt: new Date().toISOString() }
    : null;
  await db.write(data);
  res.json({ feedback: job.feedback });
});

router.post("/:id/generate-materials", async (req, res) => {
  const data = await db.read();
  const job = data.jobs.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  if (!data.candidateProfile) return res.status(400).json({ error: "No candidate profile configured yet — set one up under Settings first." });

  // Stored as base64 inside the same JSON blob as everything else, rather
  // than written to local disk — keeps generated documents persistent
  // across restarts/redeploys on hosts with ephemeral filesystems.
  try {
    job.materials = await buildMaterialsForJob(data.candidateProfile, job, data.settings);
  } catch (e) {
    return res.status(500).json({ error: `Materials generation failed: ${e.message}` });
  }
  job.status = "materials_ready";
  job.statusHistory.push({ status: "materials_ready", at: new Date().toISOString() });
  await db.write(data);
  const { materials, ...rest } = job;
  res.json({ ...rest, materials: publicMaterials(materials) });
});

function sendDocx(res, base64, filename) {
  res.setHeader("Content-Type", DOCX_MIME);
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
  res.send(Buffer.from(base64, "base64"));
}

router.get("/:id/materials/cv", async (req, res) => {
  const { jobs } = await db.read();
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job || !job.materials) return res.status(404).json({ error: "not generated yet" });
  sendDocx(res, job.materials.cvBase64, job.materials.cvFilename);
});

router.get("/:id/materials/cover-letter", async (req, res) => {
  const { jobs } = await db.read();
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job || !job.materials) return res.status(404).json({ error: "not generated yet" });
  sendDocx(res, job.materials.coverLetterBase64, job.materials.coverLetterFilename);
});

router.post("/:id/autofill", async (req, res) => {
  if (process.env.DATABASE_URL) {
    // Running on a hosted deployment: this feature opens a real, visible
    // browser window for you to review before submitting, which only makes
    // sense on a machine you're sitting at. It's disabled here rather than
    // failing confusingly on a remote server with no display.
    return res.status(400).json({
      error: "Assisted auto-fill only works when Applycation is running on your own machine (it opens a browser window for you to review). Use manual mode here, or run this app locally for that job.",
    });
  }
  const data = await db.read();
  const job = data.jobs.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  if (!/greenhouse/i.test(job.url) && job.source !== "greenhouse") {
    return res.status(400).json({
      error: "Assisted auto-fill is currently only implemented for Greenhouse-hosted postings. Use manual mode for this one.",
    });
  }
  try {
    const { autofillGreenhouse } = require("./../autofill/greenhouse");
    const result = await autofillGreenhouse(job, job.materials, data.candidateProfile);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
