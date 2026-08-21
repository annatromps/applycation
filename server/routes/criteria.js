const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const db = require("./../db");

router.get("/", async (req, res) => {
  const data = await db.read();
  res.json(data.criteriaProfiles);
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
