const express = require("express");
const router = express.Router();
const db = require("./../db");
const scheduler = require("./../scheduler");

router.get("/", async (req, res) => {
  const { settings } = await db.read();
  // Never echo secrets back in full to the browser.
  const safe = {
    ...settings,
    aiApiKey: settings.aiApiKey ? "••••••••" : "",
    emailInbox: settings.emailInbox
      ? { ...settings.emailInbox, appPassword: settings.emailInbox.appPassword ? "••••••••" : "" }
      : settings.emailInbox,
  };
  res.json(safe);
});

router.put("/", async (req, res) => {
  const data = await db.read();
  const incoming = req.body || {};
  // Preserve real secrets if the client sent back the masked placeholder.
  if (incoming.aiApiKey === "••••••••") delete incoming.aiApiKey;
  if (incoming.emailInbox && incoming.emailInbox.appPassword === "••••••••") {
    delete incoming.emailInbox.appPassword;
  }
  data.settings = {
    ...data.settings,
    ...incoming,
    notifications: { ...data.settings.notifications, ...(incoming.notifications || {}) },
    emailInbox: { ...data.settings.emailInbox, ...(incoming.emailInbox || {}) },
  };
  await db.write(data);
  await scheduler.reschedule();
  res.json({ ok: true });
});

module.exports = router;
