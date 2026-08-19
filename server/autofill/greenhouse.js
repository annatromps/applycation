// BETA: best-effort assisted auto-fill for Greenhouse-hosted application
// forms (the most standardized ATS field layout, which is why it's first).
//
// Deliberately conservative: it fills the fields it recognizes and then
// leaves the browser window open on the filled-in form for you to review
// (especially any custom screening questions it doesn't know about) and
// submit yourself. It never clicks Submit. Treat this as a typing-saver,
// not a submit button — test it on a low-stakes application first.
//
// Requires Playwright, which is NOT a core dependency of this app (keeps
// the base install light for anyone using manual mode only). Enable with:
//   npm install playwright && npx playwright install chromium

function firstName(fullName = "") {
  return fullName.trim().split(/\s+/)[0] || "";
}
function lastName(fullName = "") {
  const parts = fullName.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : "";
}

async function autofillGreenhouse(job, materials, candidateProfile) {
  let playwright;
  try {
    playwright = require("playwright");
  } catch (e) {
    throw new Error(
      "Playwright isn't installed. Run `npm install playwright && npx playwright install chromium` to enable assisted auto-fill, or use manual mode instead."
    );
  }

  const { chromium } = playwright;
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto(job.url, { waitUntil: "domcontentloaded" });

  const fill = async (selector, value) => {
    if (!value) return;
    try {
      await page.fill(selector, value);
    } catch (_) {
      /* field not present on this specific posting, skip it */
    }
  };
  // Materials are stored as base64 (see routes/jobs.js) rather than local
  // file paths, so they survive on hosted deployments — but Playwright's
  // setInputFiles happily accepts an in-memory buffer directly, no temp
  // file needed.
  const setFileIfPresent = async (selector, base64, filename, mimeType) => {
    if (!base64) return;
    try {
      const input = await page.$(selector);
      if (input) await input.setInputFiles({ name: filename, mimeType, buffer: Buffer.from(base64, "base64") });
    } catch (_) {
      /* no matching file input on this posting */
    }
  };

  await fill('input[name="job_application[first_name]"]', firstName(candidateProfile.name));
  await fill('input[name="job_application[last_name]"]', lastName(candidateProfile.name));
  await fill('input[name="job_application[email]"]', candidateProfile.email);
  await fill('input[name="job_application[phone]"]', candidateProfile.phone);
  const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  await setFileIfPresent("#resume", materials && materials.cvBase64, materials && materials.cvFilename, DOCX_MIME);
  await setFileIfPresent("#cover_letter", materials && materials.coverLetterBase64, materials && materials.coverLetterFilename, DOCX_MIME);

  // Intentionally no submit click and no browser.close() — left open for review.
  return {
    browserLeftOpenForReview: true,
    note:
      "Common fields filled where present. Custom screening questions, resume/cover-letter uploads on non-standard forms, and the final Submit click are left for you to review and complete.",
  };
}

module.exports = { autofillGreenhouse };
