// Shared default app-state shape, used by both storage backends (see db.js).
function defaultData() {
  return {
    settings: {
      cadence: "manual", // "manual" | "daily" | "every_2_3_days" | "weekly" | "custom"
      customCron: "", // used when cadence === "custom"
      cadenceHourLocal: 7, // hour of day (local server time) auto-runs fire at
      cadenceMinuteLocal: 0, // minute of the hour auto-runs fire at
      notifications: {
        mode: "none", // "none" | "webhook" | "console"
        webhookUrl: "",
      },
      submissionMode: "manual", // "manual" | "assisted" | "ask_each_time"
      minScoreToSurface: 55,
      aiProvider: "none", // "none" | "anthropic" (paid) | "groq" (free) | "gemini" (free) — see server/ai/client.js
      aiApiKey: "", // key for whichever provider is selected above
      aiModel: "", // blank = provider's sensible default (see server/ai/client.js's DEFAULT_MODELS)
      maxAiScoredPerCycle: 15, // cost guard: cap AI-assisted scoring calls per discovery run
      maxAiPostingSearchesPerCycle: 10, // cost guard: cap AI web-search posting lookups (server/aiPostingSearch.js) per startup backfill pass — only used when the free ATS-API lookup finds nothing and an Anthropic provider is configured; Anthropic bills web search separately from normal tokens
      // Hard cap on total AI provider calls per day, across EVERY AI-assisted
      // feature combined (scoring, cover-letter drafting, CV auto-fill,
      // posting search, connection tests — anything that goes through
      // server/ai/client.js's callAI/callGeminiWithSearch) — unlike the
      // per-discovery-cycle guards above, which only bound one code path
      // each and reset every run, this is a single running total for the
      // day so it actually reflects a provider's daily free-tier quota.
      // null = no limit (default: this app has no way to know your actual
      // plan's quota, so it doesn't guess one). See server/ai/client.js's
      // checkAndRecordAIUsage for the enforcement + reset logic.
      aiDailyUsageLimit: null,
      autoGenerateMaterials: true, // build & save a tailored CV + cover letter for every surfaced match automatically
      maxMaterialsGeneratedPerCycle: 20, // cost guard: cap auto-generated materials per discovery run (AI cover-letter drafting costs an API call each)
      coverLetterInstructions: "", // free-text prompt fed to the AI-assisted cover letter drafter (server/docgen/coverLetter.js) — tone/emphasis preferences, e.g. "keep it under 200 words" or "lead with enthusiasm for the mission, not just the skills match". Only used when an AI provider is configured; template mode ignores it.
      timezone: "Europe/Madrid",
      // Optional: import job-alert digest emails via IMAP — LinkedIn,
      // Indeed, Welcome to the Jungle, Wellfound, or any other job site
      // that emails you listings. Only ever reads mail already sent to
      // this inbox — never fetches anything from any job site itself. See
      // server/email/.
      emailInbox: {
        enabled: false,
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        user: "",
        appPassword: "", // a Gmail "App password", not your real password
        folder: "INBOX",
        // Comma-separated list of senders/domains to watch for, all read
        // through this one inbox + app password — e.g.
        // "linkedin.com, indeed.com, welcometothejungle.com". Defaults to
        // just the "linkedin.com" domain as a starting point (a catch-all
        // for every kind of LinkedIn alert email, not just one address) —
        // add any other job site you get digest emails from to the list.
        senderFilter: "linkedin.com",
      },
    },
    criteriaProfiles: [],
    candidateProfile: null,
    // Metadata + extracted text for an uploaded baseline CV file (PDF/DOCX).
    // Deliberately kept separate from candidateProfile so uploading a file
    // never clobbers the structured profile the generator actually uses —
    // see server/routes/profile.js's "import-from-cv" endpoint for how the
    // two get connected (always with a review step before saving).
    cvUpload: null,
    jobs: [],
    meta: {
      lastDiscoveryRun: null,
      appVersion: "0.1.0",
      // Health of the job-alert email digest import — see
      // server/discovery.js and routes/settings.js's /email-inbox/test.
      // null until it's been run or tested at least once.
      emailInboxHealth: null,
      // RFC Message-IDs of job-alert digest emails already imported, so
      // the same email isn't re-parsed (or re-billed for AI extraction)
      // every cycle. Deliberately independent of IMAP's \Seen flag — see
      // server/email/inbox.js's header comment. Capped/FIFO; see
      // MAX_PROCESSED_IDS there.
      emailDigestProcessedIds: [],
      // Health of the configured AI provider — only ever set by the
      // on-demand "Test connection" button next to it in Settings (see
      // routes/settings.js's /ai/test). null until tested at least once.
      aiProviderHealth: null,
      // Running total of AI provider calls made "today" (UTC calendar date,
      // not settings.timezone — see server/ai/client.js's checkAndRecordAIUsage
      // for why), against settings.aiDailyUsageLimit. Rolls over to
      // { date: <new date>, count: 0 } the first time a call is attempted
      // on a new day; never reset by a timer, only lazily on next use.
      aiUsage: { date: null, count: 0 },
    },
  };
}

module.exports = { defaultData };
