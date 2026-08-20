const express = require("express");
const router = express.Router();
const db = require("./../db");
const scheduler = require("./../scheduler");
const { testConnection } = require("./../email/inbox");

router.get("/", async (req, res) => {
  const { settings, meta } = await db.read();
  // Never echo secrets back in full to the browser.
  const safe = {
    ...settings,
    aiApiKey: settings.aiApiKey ? "••••••••" : "",
    emailInbox: settings.emailInbox
      ? { ...settings.emailInbox, appPassword: settings.emailInbox.appPassword ? "••••••••" : "" }
      : settings.emailInbox,
    // Surfaced here (rather than a separate endpoint) so the Settings page
    // only needs the one fetch it already makes — see server/discovery.js
    // for what actually keeps this up to date, and /email-inbox/test below
    // for the on-demand check.
    emailInboxHealth: meta ? meta.emailInboxHealth || null : null,
  };
  res.json(safe);
});

// On-demand connectivity check for the Settings health indicator — tests
// against whatever's currently in the form (falling back to the already-
// saved app password if the field still shows the masked placeholder),
// without needing to save first or wait for a discovery cycle. Logs in and
// opens the mailbox, never searches for or touches any messages.
router.post("/email-inbox/test", async (req, res) => {
  const data = await db.read();
  const incoming = (req.body && req.body.emailInbox) || {};
  const effective = { ...data.settings.emailInbox, ...incoming };
  if (!incoming.appPassword || incoming.appPassword === "••••••••") {
    effective.appPassword = data.settings.emailInbox.appPassword;
  }
  const result = await testConnection({ emailInbox: effective });
  data.meta.emailInboxHealth = {
    status: result.ok ? "ok" : "error",
    checkedAt: new Date().toISOString(),
    error: result.error || null,
    emailsChecked: null,
    jobsFound: null,
    source: "manual_test",
  };
  await db.write(data);
  res.json(result);
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
