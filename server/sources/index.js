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
 * return a flat, de-duplicated (by source+sourceId) array of normalized jobs,
 * plus a per-source raw count (before dedup) so a "0 results" cycle can be
 * diagnosed — was a source actually queried, and did it come back empty?
 * Each source module already catches its own fetch errors internally and
 * resolves with [] rather than rejecting (so a network/API failure can't
 * break discovery for the others), which means a 0 here can mean either
 * "genuinely found nothing" or "the request failed" — check the Railway
 * logs for that source's own `console.error` line to tell which.
 * @returns {Promise<{jobs: Array, sourceCounts: Record<string, number>}>}
 */
async function discoverJobs(criteriaProfile) {
  const cfg = criteriaProfile.sources || {};
  const searchTerms = criteriaProfile.titleKeywords || [];
  const tasks = [];
  const labels = [];

  if (cfg.remotive !== false) {
    tasks.push(remotive.fetchJobs({ searchTerms }));
    labels.push("remotive");
  }
  if (cfg.arbeitnow !== false) {
    tasks.push(arbeitnow.fetchJobs());
    labels.push("arbeitnow");
  }
  if (cfg.remoteok !== false) {
    tasks.push(remoteok.fetchJobs());
    labels.push("remoteok");
  }
  if (cfg.greenhouse && cfg.greenhouse.enabled && (cfg.greenhouse.companies || []).length) {
    tasks.push(greenhouse.fetchJobs({ companies: cfg.greenhouse.companies }));
    labels.push("greenhouse");
  }
  if (cfg.lever && cfg.lever.enabled && (cfg.lever.companies || []).length) {
    tasks.push(lever.fetchJobs({ companies: cfg.lever.companies }));
    labels.push("lever");
  }

  const settled = await Promise.allSettled(tasks);
  const all = [];
  const sourceCounts = {};
  settled.forEach((s, i) => {
    const label = labels[i];
    if (s.status === "fulfilled") {
      sourceCounts[label] = s.value.length;
      all.push(...s.value);
    } else {
      // Shouldn't normally happen (each source catches its own errors), but
      // covered defensively so an unexpected throw still shows up here
      // rather than silently vanishing into Promise.allSettled.
      sourceCounts[label] = 0;
      console.error(`[sources] "${label}" fetch rejected unexpectedly:`, s.reason && s.reason.message);
    }
  });

  const seen = new Set();
  const jobs = all.filter((j) => {
    const key = `${j.source}:${j.sourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { jobs, sourceCounts };
}

module.exports = { discoverJobs, REGISTRY };
