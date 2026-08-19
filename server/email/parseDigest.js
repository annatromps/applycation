// Extracts individual job listings from a LinkedIn "jobs for you" / saved
// search digest email. Never fetches anything from linkedin.com — works
// purely from the raw email content LinkedIn already sent you.
//
// AI-assisted when an AI provider is configured (LinkedIn's email markup is
// messy and shifts over time, which AI handles far more robustly than a
// fixed set of regexes). Falls back to a plain rule-based sweep for
// linkedin.com job links when no AI provider is set — that reliably finds
// the postings themselves, but usually can't cleanly separate the title and
// company out of the surrounding markup, so those come back blank rather
// than guessed.

const cheerio = require("cheerio");
const { callAI, isAIConfigured } = require("./../ai/client");

const LINKEDIN_JOB_LINK = /linkedin\.com\/(comm\/)?jobs\/view\//i;

function ruleBasedExtract(html, text) {
  const entries = [];
  const seen = new Set();
  try {
    const $ = cheerio.load(html || "");
    $("a").each((_, el) => {
      const href = $(el).attr("href") || "";
      if (!LINKEDIN_JOB_LINK.test(href)) return;
      const title = $(el).text().replace(/\s+/g, " ").trim();
      if (!title || seen.has(href)) return;
      seen.add(href);
      entries.push({ title, company: "", linkedinUrl: href });
    });
  } catch (e) {
    console.error("[email/parseDigest] rule-based HTML parse failed:", e.message);
  }
  if (!entries.length) {
    // Last resort: bare URL sweep over plain text — no title available.
    const matches = (text || "").match(/https:\/\/[^\s")]*linkedin\.com\/(comm\/)?jobs\/view\/[^\s")]*/gi) || [];
    for (const url of new Set(matches)) entries.push({ title: "", company: "", linkedinUrl: url });
  }
  return entries;
}

async function aiExtract(text, settings) {
  const prompt = [
    "This is the plain text of a LinkedIn job-alert digest email. Extract every individual job listing mentioned.",
    'Return ONLY a JSON array, no commentary, no markdown fences, shaped like: [{"title": "string", "company": "string", "linkedinUrl": "string"}]',
    "Rules: only use information literally present in the text below. If you cannot confidently find the company name or the exact linkedin.com job URL for a listing, leave that field as an empty string rather than guessing. Never invent a listing that isn't in the text.",
    "",
    "EMAIL TEXT:",
    text.slice(0, 12000),
  ].join("\n");

  try {
    const raw = await callAI(settings, { prompt, maxTokens: 2000 });
    const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) ? parsed.filter((e) => e && e.linkedinUrl) : [];
  } catch (e) {
    console.error("[email/parseDigest] AI extraction failed, falling back to rule-based:", e.message);
    return null;
  }
}

/**
 * @param {{html: string, text: string}} email
 * @param {object} settings
 * @returns {Promise<Array<{title: string, company: string, linkedinUrl: string}>>}
 */
async function extractDigestEntries({ html, text }, settings) {
  if (isAIConfigured(settings)) {
    const plain = text || (html || "").replace(/<[^>]+>/g, " ");
    const ai = await aiExtract(plain, settings);
    if (ai && ai.length) return ai;
  }
  return ruleBasedExtract(html, text);
}

module.exports = { extractDigestEntries };
