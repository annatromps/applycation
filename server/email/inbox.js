// Polls an IMAP inbox for new LinkedIn job-alert digest emails. Only ever
// reads mail already sitting in an inbox you've explicitly connected in
// Settings > Advanced > LinkedIn digest import — it never fetches anything
// from linkedin.com itself. Marks processed emails as \Seen so the same
// digest isn't imported twice; never deletes or moves anything.

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

/**
 * @param {object} settings - app settings; reads settings.emailInbox
 * @returns {Promise<Array<{subject: string, date: string|null, html: string, text: string}>>}
 */
async function fetchNewLinkedInDigests(settings) {
  const cfg = (settings && settings.emailInbox) || {};
  if (!cfg.enabled || !cfg.user || !cfg.appPassword) return [];

  const client = new ImapFlow({
    host: cfg.host || "imap.gmail.com",
    port: cfg.port || 993,
    secure: cfg.secure !== false,
    auth: { user: cfg.user, pass: cfg.appPassword },
    logger: false,
  });

  const results = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(cfg.folder || "INBOX");
    try {
      const senderFilter = cfg.senderFilter || "jobs-noreply@linkedin.com";
      const uids = await client.search({ seen: false, from: senderFilter }, { uid: true });
      for (const uid of uids || []) {
        try {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const parsed = await simpleParser(msg.source);
          results.push({
            subject: parsed.subject || "",
            date: parsed.date ? parsed.date.toISOString() : null,
            html: parsed.html || "",
            text: parsed.text || "",
          });
          // Mark read regardless of what we manage to extract below — the
          // goal is "don't reprocess this email again", not "don't mark it
          // read until every job in it was successfully imported".
          await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
        } catch (e) {
          console.error(`[email/inbox] failed reading message uid ${uid}:`, e.message);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return results;
}

module.exports = { fetchNewLinkedInDigests };
