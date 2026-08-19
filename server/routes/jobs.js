const express = require("express");
const router = express.Router();
const db = require("./../db");
const { runDiscoveryCycle } = require("./../discovery");
const { buildCVBuffer } = require("./../docgen/cv");
const { buildCoverLetterBuffer } = require("./../docgen/coverLetter");

const VALID_STATUSES = [
  "discovered", "reviewing", "approved", "materials_ready",
  "submitted", "interviewing", "offer", "rejected", "withdrawn", "dismissed",
];
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

router.get("/", async (req, res) => {
  const { jobs } = await db.read();
  const { status } = req.query;
  const filtered = status ? jobs.filter((j) => j.status === status) : jobs;
  // Materials bytes are large and never needed for a list view — strip before sending.
  const stripped = filtered.map(({ materials, ...rest }) => ({
    ...rest,
    materials: materials ? { generatedAt: materials.generatedAt, cvFilename: materials.cvFilename, coverLetterFilename: materials.coverLetterFilename } : null,
  }));
  res.json(stripped.sort((a, b) => new Date(b.discoveredAt) - new Date(a.discoveredAt)));
});

router.get("/:id", async (req, res) => {
  const { jobs } = await db.read();
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  // Strip the base64 document bytes from the detail response too — the UI
  // downloads them via the dedicated /materials endpoints below instead.
  const { materials, ...rest } = job;
  res.json({
    ...rest,
    materials: materials ? { generatedAt: materials.generatedAt, cvFilename: materials.cvFilename, coverLetterFilename: materials.coverLetterFilename } : null,
  });
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
  if (status) {
    job.status = status;
    job.statusHistory.push({ status, at: now, note: note || undefined });
    if (status === "submitted") job.appliedAt = now;
    if (["offer", "rejected", "withdrawn"].includes(status)) {
      job.outcomeAt = now;
      job.outcome = outcome || status;
    }
  }
  if (note && !status) job.notes = note;
  await db.write(data);
  const { materials, ...rest } = job;
  res.json({ ...rest, materials: materials ? { generatedAt: materials.generatedAt, cvFilename: materials.cvFilename, coverLetterFilename: materials.coverLetterFilename } : null });
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

  const safeCompany = (job.company || "company").replace(/[^a-z0-9\- ]/gi, "").trim();
  const cvFilename = `${data.candidateProfile.name} - CV - ${safeCompany}.docx`;
  const coverLetterFilename = `${data.candidateProfile.name} - Cover Letter - ${safeCompany}.docx`;

  let cvBuf, clBuf;
  try {
    cvBuf = await buildCVBuffer(data.candidateProfile, job);
    clBuf = await buildCoverLetterBuffer(data.candidateProfile, job, data.settings);
  } catch (e) {
    return res.status(500).json({ error: `Materials generation failed: ${e.message}` });
  }

  // Stored as base64 inside the same JSON blob as everything else, rather
  // than written to local disk — keeps generated documents persistent
  // across restarts/redeploys on hosts with ephemeral filesystems.
  job.materials = {
    cvBase64: cvBuf.toString("base64"),
    coverLetterBase64: clBuf.toString("base64"),
    cvFilename,
    coverLetterFilename,
    generatedAt: new Date().toISOString(),
  };
  job.status = "materials_ready";
  job.statusHistory.push({ status: "materials_ready", at: new Date().toISOString() });
  await db.write(data);
  const { materials, ...rest } = job;
  res.json({ ...rest, materials: { generatedAt: materials.generatedAt, cvFilename: materials.cvFilename, coverLetterFilename: materials.coverLetterFilename } });
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
