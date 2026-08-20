# Applycation

A configurable job-hunting automation app: discovers roles matching your criteria, scores them for fit, tracks every application through its lifecycle, and prepares (and optionally helps submit) tailored CVs and cover letters — with your approval at every step that matters.

Built as a real, standalone full-stack app (Node/Express backend + a small JSON data store + a plain HTML/JS frontend) rather than a one-off script, so it's something you can run continuously, configure per-user, and — since you mentioned it — package up to sell.

## Quick start

```bash
npm install
node seed-anna.js   # optional: loads Anna's own CV data + a starter search profile
npm start
```

Then open `http://localhost:3000`.

If you skip `seed-anna.js`, the app starts with an empty candidate profile and no criteria profiles — go to the **Me** tab and fill both in before running discovery.

By default this stores everything (settings, jobs, your profile, generated documents) in a local `data/db.json` file — zero setup, but not suitable for most hosted deployments (see "Deploying it" below).

## Deploying it (so it's a real URL, not a local terminal session)

Running `npm start` on your own machine works, but stops the moment you close the terminal, and most free hosting tiers wipe local files on every restart/redeploy. To get a persistent, always-on deployment:

1. **Get a free Postgres database.** [Neon](https://neon.tech) or [Supabase](https://supabase.com) both offer a free tier that doesn't require a card. Create a project, grab its connection string (looks like `postgresql://user:pass@host/dbname`).
2. **Push this repo to GitHub** (a private repo is fine).
3. **Create a Web Service on a host that auto-deploys from GitHub** — Render, Railway, and Fly.io all work; Render is the simplest to point-and-click. Connect it to your repo, and set:
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variable: `DATABASE_URL` = the connection string from step 1
4. Deploy. The app detects `DATABASE_URL` automatically and switches to the Postgres backend (see `server/db.js`) — no code changes needed either way.
5. Run `node seed-anna.js` once against the deployed database to load the starting profile (see below for how to point a one-off script at a remote database instead of your local file).

To run `seed-anna.js` (or anything else) against the deployed database instead of your local file, prefix the command with the connection string:
```bash
DATABASE_URL="postgresql://..." node seed-anna.js
```

**One feature that only works run locally:** assisted auto-fill (the Greenhouse beta button) opens a real, visible browser window for you to review before submitting — that only makes sense on a machine you're sitting at. It's automatically disabled when `DATABASE_URL` is set (i.e. on a hosted deployment) rather than failing confusingly; use manual mode there, or run the app locally for that specific job if you want to try it.

## What it actually does today

- **Discovery**: pulls live postings from free, keyless public job APIs — Remotive, Arbeitnow, RemoteOK (all searched automatically), plus Greenhouse and Lever (per-company, you list the companies to watch). See "On LinkedIn / Indeed" below for why those aren't included.
- **Scoring — three ratings out of 10, not one black-box number**: every job gets rated on three separate dimensions, each shown as X/10 with its own plain-English reason list:
  - **You're a match** (🎯) — how good a match *you* are for what the posting is asking for: title/role keywords, seniority/level, role type, language requirements, visa sponsorship needs. This is "would they hire me", not "would I want it".
  - **You'll like this** (✨) — how good the role looks *for you*: location/remote fit, salary vs. your minimum, sectors, technologies, company size, followed companies, and any free-form role priorities (4-day week, async, etc.). This is "would I want it", not "would they hire me".
  - **Easy to submit** (⚡) — how quick/low-effort the *application itself* looks, independent of fit: penalised for a required cover letter, a take-home assignment/case study, a portfolio ask, open-ended screening questions, multiple interview rounds mentioned up front, or just a very long/dense posting; boosted for a short posting or a known low-friction ATS (Greenhouse, Lever, Ashby, Workable). This one doesn't depend on having a criteria profile set up — it's computed from the posting itself, so even a manually-added job with no matching profile still gets a real ease score.

  All three are rule-based out of the box (transparent, no AI required) and, if you've set an AI provider + API key (Anthropic, or a free option like Groq/Gemini — see Settings), get a second AI-assisted pass blended in — for the first two, this needs a criteria profile's free-text "AI preferences" set too; for "Easy to submit" it kicks in automatically whenever the job has a real description, since it isn't tied to a profile. This is where nuance like perks, holiday allowance, culture, or how involved a hiring process reads gets factored in, since keyword rules can't parse that well. An overall 0-100 "score" (the average of the match/appeal pair, unchanged in meaning from before this feature) still drives your surfacing threshold and default sort order. Only jobs above your configured threshold, and with no dealbreaker hit, are surfaced.
  - **Always automatic, no "rescore" button**: scoring happens as a side effect of things you already do — adding a job, editing its posting URL/description/location/salary (`PATCH /api/jobs/:id` re-scores inline whenever any of those change), or the app finding new matches during discovery. On top of that, every startup runs a one-time, silent backfill (`server/index.js`) that scores any existing job still missing a score or ease rating — so jobs imported before this feature existed, or added without a criteria profile in place yet, pick it up automatically on the next deploy/restart with nothing for you to click. See `server/jobScoring.js` for the shared logic all of these call into.
- **AI preferences (optional)**: each criteria profile also has a free-text box for describing fit in your own words (culture, pace, red flags, anything the structured fields can't capture). If you've set an AI provider + API key in Settings (Anthropic, or a free option like Groq/Gemini), the strongest rule-based matches each cycle get a second pass where that text is sent to it alongside the posting for qualitative "You're a match" and "You'll like this" scores, each blended with its rule-based counterpart above. Bounded by a configurable "max AI-scored jobs per cycle" so cost stays predictable; skipped entirely with no key set.
- **Review queue**: new matches wait for your approval before anything else happens. Dismiss → it's dropped. Approve → status moves forward (materials are usually already generated by this point, see below — Approve just confirms it).
- **Feedback (👍/👎 + notes)**: rate any suggested job — from the Review Queue or a job's detail view — as a good or bad match, with an optional note on why. This is stored per job and, on future discovery runs, gets fed into the AI-assisted scoring pass (see below) as real signal about your taste, so match quality should improve the more you use it. It's most useful once an AI provider + API key + AI preferences are set, since that's the pass that actually reads it; without one, feedback is still stored and shown, just not yet acted on by the rule-based scorer (see Roadmap).
- **Baseline CV upload**: upload your CV as PDF or Word on the **Me** tab — it's stored, viewable/downloadable in-app (PDF previews inline), and text gets extracted automatically. An "Auto-fill profile from this CV" button (needs an AI provider + API key set under Settings → Advanced) turns that extracted text into the structured profile below it, shown as a draft for you to review before saving — nothing is applied silently.
- **Materials generation**: builds a tailored CV (.docx) and cover letter (.docx) from your profile data for a job, stored against that job and downloadable from the Review Queue or its detail view. The CV reorders each role's bullets to surface the most relevant ones first, without inventing or dropping anything. The cover letter picks your most relevant "talking points" for that posting; if you provide an AI provider + API key in Settings it drafts more naturally, otherwise it assembles a straightforward template — either way it's run through your house rules (e.g. no em dashes) before saving.
  - **Experience bank**: a free-text scratchpad on your Candidate Profile (own labelled textarea on the **Me** tab, no JSON editing needed) for extra true achievements/examples you haven't formally written into a CV bullet yet. When an AI provider is configured, the cover letter drafter and review-question generator can both draw on it for more specific, job-relevant examples, and the CV gets an optional "Additional Relevant Experience" section pulling in at most 2 directly-relevant snippets from it — always a quote or light trim of what's actually written there, never combined or embellished into a new claim. Without an AI provider, it's just stored and otherwise unused.
  - **Cover letter AI instructions**: a free-text box in Settings ("Optional: AI-assisted scoring & cover letter drafting") for your own preferences on tone/length/structure — e.g. "keep it under 200 words" — sent alongside every AI-assisted cover letter draft. Only applies when an AI provider is configured; template mode ignores it.
  - **Tailoring summary**: alongside the two documents, you get a short plain-English note on what was tailored for that specific application — since the CV never invents content, this explains which existing bullet got promoted to the top of each role and why (matched against the posting's own wording), not "what was added." Rule-based by default; with an AI provider + API key set, it's phrased as a short natural paragraph instead — still built only from those same facts, so it can't introduce anything not already in your profile. Shown on the Review Queue card and in the job's detail view.
  - **On by default, for every match**: as soon as a job clears your score threshold during discovery, its CV and cover letter are generated and saved automatically — by the time you see it in the Review Queue, both are usually already sitting there ready to download. Turn this off in Settings ("Application materials") if you'd rather only generate on Approve, and you can always regenerate (e.g. after editing your profile) from a job's detail view.
  - **Cost guard**: since AI-assisted cover-letter drafting (if an AI provider + key is set) is one API call per job, auto-generation is capped per discovery run ("Max materials auto-generated per discovery run" in Settings, default 20). Anything a cycle skips because it hit the cap is logged and can still be generated manually from that job's detail view — nothing is silently dropped forever.
  - **Things to consider before applying**: alongside the CV, cover letter, and tailoring summary, each job also gets a short list (0-5 items) of concrete questions or flags worth thinking about — e.g. "it asks for 5+ years running paid campaigns, do you have examples of that?" Built from two sources: any negative rule-based scoring signal already computed for that job (a location mismatch, an excluded keyword, etc. — reused as-is, never re-derived), plus, when an AI provider is configured and the job has a real description, a short pass comparing the posting's stated requirements against your candidate profile (and your Experience bank, so it doesn't flag a "gap" that's actually covered by a bank note). The AI pass is instructed to only flag things it can point to directly in the job description text — never invents a requirement that isn't there, and returns nothing rather than manufacturing filler when there's nothing notable. See `server/docgen/reviewQuestions.js`. Shown on the Review Queue card and in the job's detail view — and in the detail view, each set of questions has a text box right below it: type in an example/answer and it's saved straight to your Experience bank (tagged with which job/question prompted it) and materials are regenerated immediately, so a flagged gap can go from "noticed" to "actually used in this cover letter" in one step.
- **Automatic posting resolution**: any job without a real posting URL/description (added manually, imported from a board this app doesn't scrape, etc.) automatically gets a lookup attempt against the company's own job board — checks Greenhouse, Lever, Ashby, and Recruitee in parallel, using each one's free, public, unauthenticated JSON API (the same kind `server/sources/` already reads from for regular discovery — see `server/atsLookup.js`), matched by title + company name. Several slug variants are tried per company (the full name, with corporate suffixes like "Inc"/"Labs"/"Technologies" stripped, and just the first word for multi-word names), since the guessed slug rarely equals the literal company name. No scraping, no per-job manual web fetches, nothing to approve. Runs automatically when such a job is added and, for anything still missing a URL, once more at every server startup (`server/index.js`'s backfill). You can also retry it on demand from a job's detail view ("Try to find the real posting automatically"), or in bulk from the Tracker's "Find missing postings" button, which runs it across every job in view that's still missing a link and reports back how many it found. Inherently best-effort, and worth being honest about the ceiling: this can only ever find a posting for a company on one of those four platforms with a public board and a slug that matches the guess. Larger companies on Workday, iCIMS, Taleo, SuccessFactors, or a fully custom careers site have no public read API at all — there's no legal, keyless way to reach those automatically, full stop. When nothing confident turns up, the job is left exactly as it was and the detail view's "Posting details" section lets you paste the real URL/description/location/salary in yourself instead.
- **Tracker**: every job moves through a status pipeline (discovered → reviewing → approved → materials ready → submitted → interviewing → offer/rejected/withdrawn), with full history, notes, and dates, filterable in the Tracker tab. Click any row to open its full detail view — ratings breakdown, review questions, notes, status history, generated materials, and an editable "Posting details" section (URL, description, location, salary — auto-rescored the moment you save a change, see the "Always automatic, no rescore button" note above). Company name is the prominent element everywhere a job is listed (Dashboard, Review Queue, Tracker, detail view), each shown next to a best-effort logo (Clearbit's free logo API, falling back to Google's favicon service, falling back to a plain initial-letter avatar when neither has a match — never blocks on this), with a direct link to the actual posting wherever a URL is on file. The Dashboard's "Awaiting review" stat card jumps to the Review Queue, and "Applied"/"Interviewing" jump to the Tracker pre-filtered to every status that counts towards that stat (not just one exact status).
- **LinkedIn digest import (optional)**: LinkedIn has no public jobs API, and scraping it breaks their terms of service, so this app never fetches anything from linkedin.com directly — full stop. Instead, under Settings → Advanced → "LinkedIn digest import", you can connect an email inbox (IMAP, e.g. a Gmail account with an [App password](https://myaccount.google.com/apppasswords)) that receives LinkedIn's alert emails. The sender filter defaults to the whole `linkedin.com` domain — a catch-all so every kind of LinkedIn alert email gets picked up rather than just one specific address (LinkedIn sends job alerts from more than one, and it changes) — or you can narrow it to a comma-separated list of specific addresses if you'd rather be pickier; either way it's all read through this one inbox + app password. Each discovery cycle, if enabled, the app reads any new unread matching emails from that inbox (marking them read, never deleting), cheaply skips anything with no actual job-posting link in it (connection requests, InMail, etc. — so a broad sender filter doesn't waste AI calls), extracts the individual job listings mentioned from what's left (AI-assisted when a provider is configured, since LinkedIn's email markup shifts over time; a plain regex sweep for job links otherwise), and tries to resolve each one to the employer's own posting using the same free public ATS APIs (`server/atsLookup.js`) the regular sources and automatic posting resolution use — giving you a direct company link and real description instead of a LinkedIn link, when a confident match exists. Falls back to the original LinkedIn link, untouched, when it can't find one — never fabricates a URL or description. These jobs flow through the exact same scoring/materials/review-questions pipeline as anything else, tagged `source: "linkedin-digest"`. A health indicator (green/red dot + last result) sits right under the "Import LinkedIn digest emails" checkbox, updated automatically after every discovery cycle and on-demand via its "Test connection" button — so a bad app password or connection problem is visible at a glance instead of silently doing nothing. See `server/email/`.
- **Submission**: three configurable modes in Settings —
  - **Manual** (default): you always submit yourself; the app just gets your materials ready and tracks the outcome.
  - **Assisted (beta)**: for Greenhouse-hosted postings only, an "Attempt auto-fill" button opens a real browser window, fills the fields it recognizes (name, email, phone, resume/cover-letter upload), and **stops** — it never clicks Submit. You review the whole form yourself before submitting. Requires `npm install playwright && npx playwright install chromium` (deliberately not a core dependency, so people who only want manual mode don't need to download a browser).
  - **Ask each time**: no default — you decide per job.
- **Scheduling**: pick Manual or "At a set time" in Settings; the latter reveals a frequency (daily / every 2-3 days / weekly / custom cron) and a time picker, driving an in-process scheduler that re-runs discovery automatically. This only fires while the app process is running — see "Running it 24/7" below.
- **Notifications**: optional webhook (Slack/Discord/anything that accepts a JSON POST) fired whenever new matches are found.

## On LinkedIn / Indeed

Neither offers a free public jobs API, and scraping either violates their Terms of Service, so they're deliberately not included as sources. If you want that coverage, the realistic options are: (a) a paid third-party jobs aggregator API (e.g. one of the commercial job-board data providers), which would be a straightforward new file under `server/sources/` following the same pattern as the existing ones, or (b) manual review — the app is still useful as a tracker/materials engine even for roles you find yourself; there's nothing stopping you from adding a job manually (see "Extending it" below for a quick way to do that until a manual-add UI exists).

## Data model (for the Settings → Candidate Profile JSON editor)

```jsonc
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "phone": "+44 ...",
  "linkedin": "linkedin.com/in/...",
  "headline": "Senior Product Manager",
  "summary": "1-2 sentence professional summary...",
  "skills": [{ "label": "Product", "value": "comma-separated skills..." }],
  "experience": [
    {
      "title": "Senior Product Manager",
      "company": "Acme",
      "dates": "Jan 2022 – Present",
      "subtitle": "One-line company/role context",
      "bullets": ["Achievement bullet 1", "Achievement bullet 2"]
    }
  ],
  "education": [{ "school": "...", "dates": "...", "detail": "..." }],
  "additional": [{ "label": "Languages", "value": "..." }],
  "talkingPoints": [
    { "keywords": ["growth", "plg"], "text": "A real, verified sentence or two the cover-letter generator can use when a posting mentions these keywords." }
  ],
  "experienceBank": "Free-text scratchpad — extra true achievements/examples not yet written into `experience` above. Has its own labelled textarea in Settings (no JSON editing needed). Only the AI-assisted passes read it (cover letter drafting, the CV's optional 'Additional Relevant Experience' section, and review-question generation) — when read, the AI is only allowed to quote/lightly trim what's literally written here, never combine or embellish it into a new claim.",
  "houseRules": { "bannedPhrases": ["once things get sticky"], "notes": "Tone/style notes for AI-assisted drafting." }
}
```

A structured (non-JSON) editor for this is the natural next UI improvement — see "Roadmap" below.

## Running it 24/7

The scheduler only runs while the Node process is alive, so for genuinely unattended daily discovery you need to host it somewhere persistent:

- Simplest: a small always-on VM (or a Raspberry Pi, or a spare machine) running `npm start` under `pm2` or a systemd service.
- PaaS options (Render, Railway, Fly.io, a basic DigitalOcean droplet) all work fine — it's a standard Node app with no native build step.
- Alternative: keep `cadence: "manual"` and trigger discovery externally on a schedule (e.g. a cron job or GitHub Action hitting `POST /api/jobs/discover`), if you'd rather not keep a process running continuously.

## Extending it

- **New job source**: add a file to `server/sources/` exporting `fetchJobs(config)` that returns normalized job objects (see any existing file for the shape), then register it in `server/sources/index.js`.
- **Smarter matching**: `server/scoring.js`'s `scoreJobWithAI` already does a qualitative Claude-based pass driven by each profile's free-text "AI preferences" — extend the prompt/blending logic there if you want it to weigh things differently.
- **Manually add a job**: use the "+ Add job manually" button on the Tracker page (title/company required; location, URL, status, and notes optional), or `POST /api/jobs` directly with the same fields. Scored against your active criteria profile(s) exactly like an auto-discovered job — using whatever fields you gave it, so even a bare title/company gets a real score rather than a placeholder — and materials are auto-generated the same way too, if that setting's on. Only stays "–/10" if you have no active criteria profile configured at all. Defaults to "reviewing" status.
- **Storage backend**: everything goes through `server/db.js`'s `read()`/`write()`/`update()`, backed by either `server/db-file.js` (local JSON, no `DATABASE_URL`) or `server/db-postgres.js` (any Postgres connection string). Both keep the entire app state — including uploaded/generated document bytes as base64 — in one JSONB blob / JSON file; see the multi-tenancy note below for why that's a single-user design.

## If you're going to sell this

A few things worth doing before it's multi-tenant / customer-facing, flagged honestly rather than glossed over:

1. **Per-user data isolation.** Right now everything (across every backend) lives in one shared blob/file — one deployment currently means one user. Selling this means either one deployment per customer, or a real multi-tenant schema (a proper `users`/`jobs`/`profiles` table structure with a `user_id` column, replacing the single JSONB blob in `db-postgres.js`).
2. **Secrets handling.** The AI provider API key currently sits in plaintext in the stored JSON (file or Postgres row). Fine for your own use; not fine once other people's keys are involved — move to environment variables or a proper secrets store (e.g. your cloud provider's secrets manager) before that happens.
3. **Auth.** There's currently no login — anyone who can reach the server can see everything. Needs a real auth layer (even something simple like Auth.js) before it's exposed beyond your own machine.
4. **Assisted auto-fill coverage.** Only Greenhouse is implemented, and only common fields. Broader ATS coverage (Lever, Workday, iCIMS) and handling of custom screening questions is real, non-trivial work — scope it as its own project phase rather than assuming it generalizes.
5. **Rate limits / ToS on sources.** Remotive/Arbeitnow/RemoteOK are free and public but not infinite — if this runs for many users, check their current rate limits before scaling up call volume.

None of this blocks using it for yourself today — it's just the gap between "personal tool" and "product," named plainly so it doesn't surprise you later.

## Project layout

```
server/
  index.js        entry point
  db.js           picks the storage backend (file vs Postgres) based on DATABASE_URL
  db-file.js       local JSON-file backend (default, no setup)
  db-postgres.js   Postgres backend (used when DATABASE_URL is set — see "Deploying it")
  defaultData.js   shared default app-state shape, used by both backends
  scheduler.js    cron-based auto-discovery
  discovery.js    one full discovery cycle (fetch -> score -> optional AI pass -> insert -> notify)
  scoring.js      rule-based fit + submission-ease scoring, plus their optional AI-assisted passes
  jobScoring.js   shared "score this job right now" glue (criteria match + ease) used by manual-add, PATCH-triggered auto-rescore, and the startup backfill
  atsLookup.js    shared Greenhouse/Lever/Ashby/Recruitee public-API lookup (slug guessing incl. corporate-suffix stripping, fuzzy title match) — used by both postingResolver.js and email/resolveApplyLink.js
  postingResolver.js  finds a job's real posting URL/description from just title+company via atsLookup.js — used on manual-add, the startup backfill, and the detail view's "Find real posting" button
  ai/client.js    single callAI(settings, {prompt, maxTokens}) wrapper over Anthropic, Groq (free), or Google Gemini (free) — whichever provider is configured in Settings
  notify.js       webhook/console notifications
  sources/        one file per job source, pluggable
  docgen/         CV + cover letter .docx generation (as Buffers), materials.js ties both together per job (+ tailoringSummary.js's plain-English "what changed" note, reviewQuestions.js's "worth thinking about" flags), CV text extraction (PDF/DOCX), AI profile import
  email/          optional LinkedIn digest import — inbox.js (IMAP polling), parseDigest.js (entry extraction), resolveApplyLink.js (best-effort Greenhouse/Lever resolution via atsLookup.js), linkedinDigest.js (ties them together into the discovery pipeline)
  autofill/       assisted auto-fill (beta, Greenhouse only, local-run only)
  routes/         REST API
public/           frontend (plain HTML/CSS/JS, no build step)
data/db.json      all persistent data when running the file backend (gitignored)
generated/        empty by default (kept for local/dev convenience — generated documents are stored as base64 in the data store itself, not on disk)
seed-anna.js      optional one-off seed with Anna's real CV data
```

## Roadmap ideas (not built yet)

- Structured (non-JSON) profile and criteria editors
- Real multi-tenant schema + auth if this goes multi-user
- Broader assisted auto-fill coverage beyond Greenhouse (and a way to use it from a hosted deployment, e.g. a browser extension companion)
- Feed 👍/👎 feedback into the rule-based scorer too (e.g. soft nudges for companies/keywords that show up repeatedly in dislikes), not just the AI-assisted pass, so learning helps even without an AI provider configured
