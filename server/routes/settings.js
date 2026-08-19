const express = require("express");
const router = express.Router();
const db = require("./../db");
const scheduler = require("./../scheduler");

router.get("/", async (req, res) => {
  const { settings } = await db.read();
  // Never echo the API key back in full to the browser.
  const safe = { ...settings, anthropicApiKey: settings.anthropicApiKey ? "••••••••" : "" };
  res.json(safe);
});

router.put("/", async (req, res) => {
  const data = await db.read();
  const incoming = req.body || {};
  // Preserve the real key if the client sent back the masked placeholder.
  if (incoming.anthropicApiKey === "••••••••") delete incoming.anthropicApiKey;
  data.settings = { ...data.settings, ...incoming, notifications: { ...data.settings.notifications, ...(incoming.notifications || {}) } };
  await db.write(data);
  await scheduler.reschedule();
  res.json({ ok: true });
});

module.exports = router;
