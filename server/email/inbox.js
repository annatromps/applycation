// Polls an IMAP inbox for new job-alert digest emails — from LinkedIn,
// Indeed, Welcome to the Jungle, Wellfound, or any other job site you've
// pointed senderFilter at (see below). Only ever reads mail already sitting
// in an inbox you've explicitly connected in Settings > Advanced >
// "Job-alert email import" — it never fetches anything from any job site
// directly. Marks processed emails as \Seen so the same digest isn't
// imported twice; never deletes or moves anything.

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { callAI, isAIConfigured } = require("./../ai/client");

// senderFilter is a single string in settings, but supports multiple
// comma-separated addresses/domains so one inbox + app password can watch
// for job digests from several different sites at once — e.g.
// "linkedin.com, indeed.com, welcometothejungle.com". Left at the default
// of just "linkedin.com" it matches ANY mail from LinkedIn's domain — a
// deliberate catch-all so you don't have to know their exact sender
// addresses (which change over time); add whichever other job sites you get
// alert emails from to the list, and server/email/parseDigest.js cheaply
// skips anything that doesn't actually look like a job digest, so a broad
// filter here costs nothing beyond one extra IMAP fetch per non-job email.
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

// Scans recent inbox mail for sender domains that look like job-alert
// senders you haven't already added to the watch list — so you don't have
// to already know a site's exact sending domain to add it. Used by the
// Settings "Scan inbox for job sites" button (routes/settings.js's
// /email-inbox/suggest-domains). Read-only: opens the mailbox read-only,
// fetches only envelopes (sender + subject, never the body), and never
// marks anything read or touches flags. Capped to a recent window and
// message count so a large inbox doesn't turn one scan into a long wait.
//
// Two-stage filtering for candidate quality:
//   1. A subject-line regex (below) as a cheap first pass, purely to avoid
//      running every single sender past the (slower, and if AI-assisted,
//      billed) second stage.
//   2. If an AI provider is configured, a batched classification call over
//      whatever survives stage 1 — the regex alone lets through a lot of
//      retail/marketing noise (e.g. "Cat Socks: Purr-fect for You!" matches
//      naive "for you" wording), and AI is much better at telling an actual
//      job-alert digest apart from unrelated bulk mail that just happens to
//      share some vocabulary. Falls back to the stage-1 regex list alone
//      when no provider is configured, or if the AI call fails — a noisier
//      list is better than none, especially since nothing here gets added
//      without you explicitly confirming it anyway.
const SUGGEST_LOOKBACK_DAYS = 90;
const SUGGEST_MAX_MESSAGES = 400;
const SUGGEST_MAX_CANDIDATES = 15;

// Deliberately narrower than parseDigest.js's JOB_ALERT_SUBJECT_HINT (which
// is paired with a body-link check there, so it can afford to be broad).
// Here the subject line is all there is, so generic personalization phrases
// like "for you" or "recommended" are excluded — they're exactly what was
// producing false positives from newsletters/retail mail in practice.
const SUGGEST_SUBJECT_HINT = /\b(jobs?|careers?|hiring|vacan\w*|opportunit\w*|new roles?)\b/i;

function domainOf(address) {
  const at = String(address || "").lastIndexOf("@");
  return at === -1 ? null : address.slice(at + 1).toLowerCase();
}

function alreadyWatched(address, senders) {
  const a = String(address || "").toLowerCase();
  return senders.some((s) => a.includes(s.toLowerCase()));
}

async function classifyCandidatesWithAI(candidates, settings) {
  if (!isAIConfigured(settings) || !candidates.length) return { candidates, aiFiltered: false };
  const prompt = [
    "Below is a list of email sender domains and example subject lines from emails they sent to one inbox. For each domain, decide whether it looks like an automated JOB-ALERT / JOB-RECOMMENDATION digest from a job board, recruiter, or company careers page (e.g. \"5 new jobs matching your search\", \"Jobs recommended for you\", \"New openings at...\") as opposed to unrelated marketing, retail, loyalty programs, surveys, newsletters, or other bulk email that just happens to share a word or two.",
    'Return ONLY a JSON array of the domain strings that ARE genuine job-alert senders, no commentary, no markdown fences — e.g. ["indeed.com", "wellfound.com"]. Return [] if none qualify. When genuinely unsure about a domain, leave it OUT rather than guessing yes — a human reviews this list before anything is added, so a missed real one is a smaller cost than adding noise.',
    "",
    ...candidates.map((c) => `Domain: ${c.domain}\nExample subject(s): ${c.examples.join(" | ")}`),
  ].join("\n");
  try {
    const raw = await callAI(settings, { prompt, maxTokens: 500 });
    const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const keep = new Set(JSON.parse(jsonText));
    return { candidates: candidates.filter((c) => keep.has(c.domain)), aiFiltered: true };
  } catch (e) {
    console.error("[email/inbox] AI classification of sender candidates failed, keeping rule-based results:", e.message);
    return { candidates, aiFiltered: false };
  }
}

async function suggestSenderDomains(settings) {
  const cfg = (settings && settings.emailInbox) || {};
  if (!cfg.user || !cfg.appPassword) {
    return { ok: false, error: "Email address and app password are both required." };
  }
  const existingSenders = parseSenderList(cfg.senderFilter);
  const client = buildImapClient(cfg);
  const byDomain = new Map();
  let scanned = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.folder || "INBOX", { readOnly: true });
    try {
      const since = new Date(Date.now() - SUGGEST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
      const uids = await client.search({ since }, { uid: true });
      // Most recent messages first (highest UIDs), capped — this is a
      // "what am I getting lately" scan, not an exhaustive archive sweep.
      const recentUids = (uids || []).slice(-SUGGEST_MAX_MESSAGES);
      if (recentUids.length) {
        // One FETCH command over the whole range rather than N round trips
        // — envelopes only, so this stays fast even for a few hundred
        // messages.
        for await (const msg of client.fetch(recentUids, { envelope: true }, { uid: true })) {
          scanned++;
          const from = (msg.envelope && msg.envelope.from) || [];
          const address = from[0] && from[0].address;
          if (!address || alreadyWatched(address, existingSenders)) continue;
          const subject = (msg.envelope && msg.envelope.subject) || "";
          if (!SUGGEST_SUBJECT_HINT.test(subject)) continue;
          const domain = domainOf(address);
          if (!domain) continue;
          if (!byDomain.has(domain)) byDomain.set(domain, { domain, count: 0, examples: [] });
          const entry = byDomain.get(domain);
          entry.count++;
          if (entry.examples.length < 3 && !entry.examples.includes(subject)) entry.examples.push(subject);
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await client.logout().catch(() => {});
  }
  let candidates = [...byDomain.values()].sort((a, b) => b.count - a.count).slice(0, SUGGEST_MAX_CANDIDATES);
  const classified = await classifyCandidatesWithAI(candidates, settings);
  candidates = classified.candidates;
  return { ok: true, scanned, candidates, aiFiltered: classified.aiFiltered };
}

module.exports = { fetchNewLinkedInDigests, testConnection, suggestSenderDomains, parseSenderList };
