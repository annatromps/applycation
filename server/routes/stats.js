const express = require("express");
const router = express.Router();
const db = require("./../db");

router.get("/", async (req, res) => {
  const { jobs, meta } = await db.read();
  const counts = {};
  for (const j of jobs) counts[j.status] = (counts[j.status] || 0) + 1;
  const submittedOrLater = jobs.filter((j) =>
    ["submitted", "interviewing", "offer", "rejected", "withdrawn"].includes(j.status)
  ).length;
  const interviewOrLater = jobs.filter((j) => ["interviewing", "offer"].includes(j.status)).length;
  res.json({
    totalDiscovered: jobs.length,
    counts,
    submitted: submittedOrLater,
    interviewed: interviewOrLater,
    offers: counts.offer || 0,
    lastDiscoveryRun: meta.lastDiscoveryRun,
  });
});

module.exports = router;
