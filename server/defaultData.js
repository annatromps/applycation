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
      anthropicApiKey: "", // optional: enables AI-assisted scoring/drafting
      anthropicModel: "claude-sonnet-4-5",
      maxAiScoredPerCycle: 15, // cost guard: cap AI-assisted scoring calls per discovery run
      autoGenerateMaterials: true, // build & save a tailored CV + cover letter for every surfaced match automatically
      maxMaterialsGeneratedPerCycle: 20, // cost guard: cap auto-generated materials per discovery run (AI cover-letter drafting costs an API call each)
      timezone: "Europe/Madrid",
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
    },
  };
}

module.exports = { defaultData };
