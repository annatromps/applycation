// Polls an IMAP inbox for new LinkedIn job-alert digest emails. Only ever
// reads mail already sitting in an inbox you've explicitly connected in
// Settings > Advanced > LinkedIn digest import — it never fetches anything
// from linkedin.com itself. Marks processed emails as \Seen so the same
// digest isn't imported twice; never deletes or moves anything.

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

// senderFilter is a single string in settings, but supports multiple
// comma-separated addresses/domains so one Gmail app password can watch for
// several kinds of LinkedIn email at once (LinkedIn sends job alerts from
// more than one address, and it changes over time). Left at the default of
// just "linkedin.com" it matches ANY mail from LinkedIn's domain — a
// deliberate catch-all so you don't have to know their exact sender
// addresses; server/email/parseDigest.js cheaply skips anything that
// doesn't actually contain a job listing link, so a broad filter here costs
// nothing beyond one extra IMAP fetch per non-job LinkedIn email.
function parseSenderList(senderFilter) {
  return String(senderFilter || "linkedin.com")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildImapClient(cfg) {
  return new ImapFlow({
    host: cfg.host || "imap.gmail.com",
    port: cfg.port || 993,
    secure: cfg.secure !== false,
    auth: { user: cfg.user, pass: cfg.appPassword },
    logger: false,
    // Without these, a bad host/network issue can hang the connection
    // indefinitely instead of failing — bad for a background discovery run,
    // and especially bad for a health check whose whole point is to give a
    // fast, clear answer.
    connectionTimeout: 10000,
    greetingTimeout: 8000,
    socketTimeout: 20000,
  });
}

/**
 * @param {object} settings - app settings; reads settings.emailInbox
 * @returns {Promise<Array<{subject: string, date: string|null, html: string, text: string}>>}
 */
async function fetchNewLinkedInDigests(settings) {
  const cfg = (settings && settings.emailInbox) || {};
  if (!cfg.enabled || !cfg.user || !cfg.appPassword) return [];

  const client = buildImapClient(cfg);
  const results = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(cfg.folder || "INBOX");
    try {
      const senders = parseSenderList(cfg.senderFilter);
      const searchQuery =
        senders.length > 1 ? { seen: false, or: senders.map((from) => ({ from })) } : { seen: false, from: senders[0] };
      const uids = await client.search(searchQuery, { uid: true });
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

// Lightweight connectivity check for the Settings health indicator and the
// "Test connection" button — logs in and opens the mailbox, but never
// searches for or touches any messages. Distinguishes a config/credential
// problem (bad app password, wrong host) from "it's fine, just nothing new
// right now", which fetchNewLinkedInDigests alone can't tell you.
async function testConnection(settings) {
  const cfg = (settings && settings.emailInbox) || {};
  if (!cfg.user || !cfg.appPassword) {
    return { ok: false, error: "Email address and app password are both required." };
  }
  const client = buildImapClient(cfg);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.folder || "INBOX");
    lock.release();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await client.logout().catch(() => {});
  }
}

module.exports = { fetchNewLinkedInDigests, testConnection, parseSenderList };
