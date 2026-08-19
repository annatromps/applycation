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

If you skip `seed-anna.js`, the app starts with an empty candidate profile and no criteria profiles — go to **Settings** and fill both in before running discovery.

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
- **Scoring — two ratings out of 10, not one black-box number**: every discovered job gets rated on two separate dimensions, each shown as X/10 with its own plain-English reason list:
  - **Match for requirements** (🎯) — how good a match *you* are for what the posting is asking for: title/role keywords, seniority/level, role type, language requirements, visa sponsorship needs. This is "would they hire me", not "would I want it".
  - **Good for you** (✨) — how good the role looks *for you*: location/remote fit, salary vs. your minimum, sectors, technologies, company size, followed companies, and any free-form role priorities (4-day week, async, etc.). This is "would I want it", not "would they hire me".
  
  Both are rule-based out of the box (transparent, no AI required) and, if you've set an Anthropic API key + a criteria profile's free-text "AI preferences", get a second AI-assisted pass blended in — this is where nuance like perks, holiday allowance, and culture mentioned in the posting text actually gets read and factored in, since keyword rules can't parse that well. An overall 0-100 "score" (the average of the two, unchanged in meaning from before this feature) still drives your surfacing threshold and default sort order. Only jobs above your configured threshold, and with no dealbreaker hit, are surfaced.
- **AI preferences (optional)**: each criteria profile also has a free-text box for describing fit in your own words (culture, pace, red flags, anything the structured fields can't capture). If you've set an Anthropic API key in Settings, the strongest rule-based matches each cycle get a second pass where that text is sent to Claude alongside the posting for qualitative "match for requirements" and "good for you" scores, each blended with its rule-based counterpart above. Bounded by a configurable "max AI-scored jobs per cycle" so cost stays predictable; skipped entirely with no key set.
- **Review queue**: new matches wait for your approval before anything else happens. Dismiss → it's dropped. Approve → status moves forward (materials are usually already generated by this point, see below — Approve just confirms it).
- **Feedback (👍/👎 + notes)**: rate any suggested job — from the Review Queue or a job's detail view — as a good or bad match, with an optional note on why. This is stored per job and, on future discovery runs, gets fed into the AI-assisted scoring pass (see below) as real signal about your taste, so match quality should improve the more you use it. It's most useful once an Anthropic API key + AI preferences are set, since that's the pass that actually reads it; without a key, feedback is still stored and shown, just not yet acted on by the rule-based scorer (see Roadmap).
- **Baseline CV upload**: upload your CV as PDF or Word in Settings — it's stored, viewable/downloadable in-app (PDF previews inline), and text gets extracted automatically. An "Auto-fill profile from this CV" button (needs an Anthropic API key) turns that extracted text into the structured profile below, shown as a draft for you to review before saving — nothing is applied silently.
- **Materials generation**: builds a tailored CV (.docx) and cover letter (.docx) from your profile data for a job, stored against that job and downloadable from the Review Queue or its detail view. The CV reorders each role's bullets to surface the most relevant ones first, without inventing or dropping anything. The cover letter picks your most relevant "talking points" for that posting; if you provide an Anthropic API key in Settings it drafts more naturally with Claude, otherwise it assembles a straightforward template — either way it's run through your house rules (e.g. no em dashes) before saving.
  - **On by default, for every match**: as soon as a job clears your score threshold during discovery, its CV and cover letter are generated and saved automatically — by the time you see it in the Review Queue, both are usually already sitting there ready to download. Turn this off in Settings ("Application materials") if you'd rather only generate on Approve, and you can always regenerate (e.g. after editing your profile) from a job's detail view.
  - **Cost guard**: since AI-assisted cover-letter drafting (if an Anthropic key is set) is one API call per job, auto-generation is capped per discovery run ("Max materials auto-generated per discovery run" in Settings, default 20). Anything a cycle skips because it hit the cap is logged and can still be generated manually from that job's detail view — nothing is silently dropped forever.
- **Tracker**: every job moves through a status pipeline (discovered → reviewing → approved → materials ready → submitted → interviewing → offer/rejected/withdrawn), with full history, notes, and dates, filterable in the Tracker tab.
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
- **Manually add a job** (until there's a UI for it): `POST /api/jobs` doesn't exist yet, but you can insert directly via `node -e "..."` against `server/db.js`, following the shape used in the discovery pipeline — happy to add a proper "Add job manually" form if you want it next.
- **Storage backend**: everything goes through `server/db.js`'s `read()`/`write()`/`update()`, backed by either `server/db-file.js` (local JSON, no `DATABASE_URL`) or `server/db-postgres.js` (any Postgres connection string). Both keep the entire app state — including uploaded/generated document bytes as base64 — in one JSONB blob / JSON file; see the multi-tenancy note below for why that's a single-user design.

## If you're going to sell this

A few things worth doing before it's multi-tenant / customer-facing, flagged honestly rather than glossed over:

1. **Per-user data isolation.** Right now everything (across every backend) lives in one shared blob/file — one deployment currently means one user. Selling this means either one deployment per customer, or a real multi-tenant schema (a proper `users`/`jobs`/`profiles` table structure with a `user_id` column, replacing the single JSONB blob in `db-postgres.js`).
2. **Secrets handling.** The Anthropic API key currently sits in plaintext in the stored JSON (file or Postgres row). Fine for your own use; not fine once other people's keys are involved — move to environment variables or a proper secrets store (e.g. your cloud provider's secrets manager) before that happens.
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
  scoring.js      rule-based fit scoring + optional AI-assisted scoring pass
  notify.js       webhook/console notifications
  sources/        one file per job source, pluggable
  docgen/         CV + cover letter .docx generation (as Buffers), materials.js ties both together per job, CV text extraction (PDF/DOCX), AI profile import
  autofill/       assisted auto-fill (beta, Greenhouse only, local-run only)
  routes/         REST API
public/           frontend (plain HTML/CSS/JS, no build step)
data/db.json      all persistent data when running the file backend (gitignored)
generated/        empty by default (kept for local/dev convenience — generated documents are stored as base64 in the data store itself, not on disk)
seed-anna.js      optional one-off seed with Anna's real CV data
```

## Roadmap ideas (not built yet)

- Structured (non-JSON) profile and criteria editors
- "Add job manually" UI for roles found outside the automated sources
- Real multi-tenant schema + auth if this goes multi-user
- Broader assisted auto-fill coverage beyond Greenhouse (and a way to use it from a hosted deployment, e.g. a browser extension companion)
- Feed 👍/👎 feedback into the rule-based scorer too (e.g. soft nudges for companies/keywords that show up repeatedly in dislikes), not just the AI-assisted pass, so learning helps even without an Anthropic key
