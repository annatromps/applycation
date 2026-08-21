const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const db = require("./../db");
const { importCriteriaFromCV } = require("./../docgen/importCriteria");

router.get("/", async (req, res) => {
  const data = await db.read();
  res.json(data.criteriaProfiles);
});

// AI-drafted starting point for a NEW profile, read from the uploaded
// baseline CV — see server/docgen/importCriteria.js for exactly what is
// (and deliberately isn't) inferred from it. Draft only: nothing is
// created here — the frontend opens the criteria editor pre-filled with
// the result and the usual POST / below only runs once the user hits Save.
router.post("/import-from-cv", async (req, res) => {
  const data = await db.read();
  if (!data.cvUpload) return res.status(400).json({ error: "Upload a CV file first, on the Me tab." });
  try {
    const draft = await importCriteriaFromCV({
      text: data.cvUpload.extractedText,
      candidateProfile: data.candidateProfile,
      settings: data.settings,
    });
    res.json(draft);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/", async (req, res) => {
  const data = await db.read();
  const profile = {
    id: crypto.randomUUID(),
    active: true,
    name: "",
    // Location
    locations: [],
    // Multiselect: any of "remote"|"hybrid"|"office" — see
    // server/scoring.js's getWorkArrangements for how this is matched
    // against a job (which only ever has a boolean job.remote to check
    // against, no separate hybrid/office signal). Defaults to all three,
    // i.e. no restriction, matching the old remoteOk:true default.
    workArrangements: ["remote", "hybrid", "office"],
    remoteLocations: [],
    visaSponsorshipRequired: false,
    languages: [],
    // Role
    titleKeywords: [],
    excludeKeywords: [],
    roleTypes: [],
    seniority: [],
    minSalary: null,
    rolePriorities: [],
    dealbreakers: [],
    // Industries
    sectorsInclude: [],
    sectorsExclude: [],
    // Technologies
    favouriteTechnologies: [],
    hiddenTechnologies: [],
    // Company
    companySizes: [],
    followedCompanies: [],
    // Free-text, used by the optional AI-assisted scoring pass
    aiPreferences: "",
    sources: { remotive: true, arbeitnow: true, remoteok: true, greenhouse: { enabled: false, companies: [] }, lever: { enabled: false, companies: [] } },
    ...req.body,
  };
  data.criteriaProfiles.push(profile);
  await db.write(data);
  res.status(201).json(profile);
});

router.put("/:id", async (req, res) => {
  const data = await db.read();
  const idx = data.criteriaProfiles.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  data.criteriaProfiles[idx] = { ...data.criteriaProfiles[idx], ...req.body, id: req.params.id };
  await db.write(data);
  res.json(data.criteriaProfiles[idx]);
});

router.delete("/:id", async (req, res) => {
  const data = await db.read();
  data.criteriaProfiles = data.criteriaProfiles.filter((c) => c.id !== req.params.id);
  await db.write(data);
  res.json({ ok: true });
});

module.exports = router;
