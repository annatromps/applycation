const express = require("express");
const router = express.Router();
const db = require("./../db");
const scheduler = require("./../scheduler");
const { testConnection, suggestSenderDomains } = require("./../email/inbox");
const { testAIConnection } = require("./../ai/client");

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
    // Only ever set by the on-demand "Test connection" button below — there
    // is no automatic recurring AI health check (unlike email, which piggy-
    // backs on every discovery cycle for free; testing the AI provider
    // costs a real, tiny API call, so it only happens when asked).
    aiProviderHealth: meta ? meta.aiProviderHealth || null : null,
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

// Read-only scan of recent inbox mail for sender domains that look like job
// alerts you haven't added yet — see server/email/inbox.js's
// suggestSenderDomains for the actual heuristic and its limits. Tests
// against the form's current credentials (same masked-password fallback as
// /email-inbox/test above), so you don't need to save first. Passes along
// the already-saved AI provider settings (not overridable from this form)
// so suggestSenderDomains can use AI classification to weed out
// marketing/newsletter false positives when a provider is configured.
router.post("/email-inbox/suggest-domains", async (req, res) => {
  const data = await db.read();
  const incoming = (req.body && req.body.emailInbox) || {};
  const effective = { ...data.settings.emailInbox, ...incoming };
  if (!incoming.appPassword || incoming.appPassword === "••••••••") {
    effective.appPassword = data.settings.emailInbox.appPassword;
  }
  const result = await suggestSenderDomains({ ...data.settings, emailInbox: effective });
  res.json(result);
});

// On-demand connectivity check for the AI provider, mirroring the email
// inbox test above — verifies the currently-typed provider/key/model
// combination actually works with one small real request, without needing
// to save first or wait for a discovery/scoring pass to happen to surface a
// bad key. Never exercises the separately-billed web-search posting lookup.
router.post("/ai/test", async (req, res) => {
  const data = await db.read();
  const incoming = req.body || {};
  const effective = { ...data.settings, ...incoming };
  if (!incoming.aiApiKey || incoming.aiApiKey === "••••••••") {
    effective.aiApiKey = data.settings.aiApiKey;
  }
  const result = await testAIConnection(effective);
  data.meta.aiProviderHealth = {
    status: result.ok ? "ok" : "error",
    checkedAt: new Date().toISOString(),
    error: result.error || null,
    provider: effective.aiProvider,
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
