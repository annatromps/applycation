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
      autoGenerateMaterials: true, // build & save a tailored CV + cover letter for every surfaced match automatically
      maxMaterialsGeneratedPerCycle: 20, // cost guard: cap auto-generated materials per discovery run (AI cover-letter drafting costs an API call each)
      coverLetterInstructions: "", // free-text prompt fed to the AI-assisted cover letter drafter (server/docgen/coverLetter.js) — tone/emphasis preferences, e.g. "keep it under 200 words" or "lead with enthusiasm for the mission, not just the skills match". Only used when an AI provider is configured; template mode ignores it.
      timezone: "Europe/Madrid",
      // Optional: import LinkedIn job-alert digest emails via IMAP. Only
      // ever reads mail already sent to this inbox — never fetches
      // anything from linkedin.com itself. See server/email/.
      emailInbox: {
        enabled: false,
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        user: "",
        appPassword: "", // a Gmail "App password", not your real password
        folder: "INBOX",
        // Comma-separated list of senders/domains to watch for, all read
        // through this one inbox + app password. Defaults to the whole
        // "linkedin.com" domain — a catch-all so every kind of LinkedIn job
        // digest gets picked up rather than only one specific address —
        // narrow it to specific addresses here if you want to be pickier.
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
      // Health of the LinkedIn digest import — see server/discovery.js and
      // routes/settings.js's /email-inbox/test. null until it's been run or
      // tested at least once.
      emailInboxHealth: null,
    },
  };
}

module.exports = { defaultData };
