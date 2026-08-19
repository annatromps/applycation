// Pluggable job-source registry. Add a new source by dropping a module here
// with a `fetchJobs(config)` export and registering it below — nothing else
// in the app needs to change.
//
// NOTE ON COVERAGE: LinkedIn and Indeed do not offer a free public jobs API
// and scraping them violates their terms of service, so they are
// deliberately not included here. The sources below (Remotive, Arbeitnow,
// RemoteOK, Greenhouse, Lever) are all free, keyless, ToS-friendly public
// APIs. Greenhouse/Lever require you to list specific companies to watch
// (their board token/slug) since those APIs are per-company, not a global
// search — add companies you're interested in via Settings.

const remotive = require("./remotive");
const arbeitnow = require("./arbeitnow");
const remoteok = require("./remoteok");
const greenhouse = require("./greenhouse");
const lever = require("./lever");

const REGISTRY = {
  remotive,
  arbeitnow,
  remoteok,
  greenhouse,
  lever,
};

/**
 * Run all sources enabled in a criteria profile's `sources` config and
 * return a flat, de-duplicated (by source+sourceId) array of normalized jobs.
 */
async function discoverJobs(criteriaProfile) {
  const cfg = criteriaProfile.sources || {};
  const searchTerms = criteriaProfile.titleKeywords || [];
  const tasks = [];

  if (cfg.remotive !== false) tasks.push(remotive.fetchJobs({ searchTerms }));
  if (cfg.arbeitnow !== false) tasks.push(arbeitnow.fetchJobs());
  if (cfg.remoteok !== false) tasks.push(remoteok.fetchJobs());
  if (cfg.greenhouse && cfg.greenhouse.enabled && (cfg.greenhouse.companies || []).length) {
    tasks.push(greenhouse.fetchJobs({ companies: cfg.greenhouse.companies }));
  }
  if (cfg.lever && cfg.lever.enabled && (cfg.lever.companies || []).length) {
    tasks.push(lever.fetchJobs({ companies: cfg.lever.companies }));
  }

  const settled = await Promise.allSettled(tasks);
  const all = [];
  for (const s of settled) {
    if (s.status === "fulfilled") all.push(...s.value);
  }

  const seen = new Set();
  return all.filter((j) => {
    const key = `${j.source}:${j.sourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { discoverJobs, REGISTRY };
