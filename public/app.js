const main = document.getElementById("main");
const modalRoot = document.getElementById("modal-root");

// Rotated on the "Run discovery now" button while a cycle is in flight —
// see runDiscoveryCycle in server/discovery.js for the real order of
// operations this is approximating (it's one atomic request under the
// hood, not real streamed progress).
const DISCOVERY_LOADING_MESSAGES = [
  "🔍 Checking job boards…",
  "📬 Scanning your email digests…",
  "🏢 Looking up company postings…",
  "🧠 Scoring matches against your criteria…",
  "📝 Drafting tailored materials…",
];

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error) || `Request failed: ${res.status}`);
  return data;
}

// Separate from api() because file uploads must NOT set a JSON content-type
// header — the browser needs to set its own multipart boundary.
async function apiUpload(path, formData) {
  const res = await fetch(`/api${path}`, { method: "POST", body: formData });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error) || `Request failed: ${res.status}`);
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// ---------- Job-alert email import health indicator ----------
// health is settings.emailInboxHealth (see server/defaultData.js /
// server/discovery.js) — null until the feature has actually run or been
// tested at least once. Updated automatically on every discovery cycle
// (success or failure) and on-demand via the "Test connection" button, so
// this reflects real recent behaviour rather than a synthetic ping.
function emailHealthHtml(health) {
  if (!health) {
    return `<span class="health-dot health-unknown"></span><span class="hint">Not checked yet — hit "Test connection" below, or save settings and run a discovery cycle.</span>`;
  }
  if (health.status === "ok") {
    const detail =
      health.source === "manual_test"
        ? `Connected successfully (tested ${fmtDate(health.checkedAt)}).`
        : `Working as of ${fmtDate(health.checkedAt)} — checked ${health.emailsChecked ?? 0} email(s), found ${health.jobsFound ?? 0} job listing(s).`;
    return `<span class="health-dot health-ok"></span><span class="hint">${esc(detail)}</span>`;
  }
  return `<span class="health-dot health-error"></span><span class="hint">Failing as of ${fmtDate(health.checkedAt)} — ${esc(health.error || "unknown error")}</span>`;
}

// Same idea as emailHealthHtml above, for the AI provider — only ever set
// by the "Test connection" button next to it (see routes/settings.js's
// /ai/test), since there's no free recurring check like the email one gets
// from riding along on every discovery cycle.
function aiHealthHtml(health) {
  if (!health) {
    return `<span class="health-dot health-unknown"></span><span class="hint">Not tested yet — hit "Test connection" below.</span>`;
  }
  if (health.status === "ok") {
    return `<span class="health-dot health-ok"></span><span class="hint">Connected successfully (tested ${fmtDate(health.checkedAt)}).</span>`;
  }
  return `<span class="health-dot health-error"></span><span class="hint">Failing as of ${fmtDate(health.checkedAt)} — ${esc(health.error || "unknown error")}</span>`;
}

function scoreClass(score) {
  if (score >= 75) return "high";
  if (score >= 55) return "mid";
  return "low";
}

// ---------- Two-category ratings (candidate fit vs role appeal) ----------
// job.candidateFitScore/roleAppealScore are 0-100 (see server/scoring.js);
// displayed as X/10. Older jobs discovered before this feature exists won't
// have these fields — fall back to "–" rather than guessing.
function toTen(score100) {
  return score100 == null ? null : Math.max(0, Math.min(10, Math.round(score100 / 10)));
}

function ratingsBadgesHtml(j) {
  const cf = toTen(j.candidateFitScore);
  const ra = toTen(j.roleAppealScore);
  const ez = toTen(j.submissionEaseScore);
  return `<span class="rating-badge" title="You're a match">🎯 ${cf ?? "–"}/10</span><span class="rating-badge" title="You'll like this">✨ ${ra ?? "–"}/10</span><span class="rating-badge" title="Easy to submit">⚡ ${ez ?? "–"}/10</span>`;
}

function ratingsDetailHtml(j) {
  const cf = toTen(j.candidateFitScore);
  const ra = toTen(j.roleAppealScore);
  const ez = toTen(j.submissionEaseScore);
  const byCat = j.reasonsByCategory || {};
  const list = (arr) =>
    arr && arr.length ? arr.map((r) => `<li>${esc(r)}</li>`).join("") : `<li class="hint">No breakdown available for this job.</li>`;
  return `
    <div class="ratings-grid">
      <div class="rating-block">
        <div class="rating-label">🎯 You're a match</div>
        <div class="rating-value">${cf ?? "–"}/10</div>
        <ul class="reasons">${list(byCat.candidateFit || (j.candidateFitScore == null ? null : []))}</ul>
      </div>
      <div class="rating-block">
        <div class="rating-label">✨ You'll like this</div>
        <div class="rating-value">${ra ?? "–"}/10</div>
        <ul class="reasons">${list(byCat.roleAppeal || (j.roleAppealScore == null ? null : []))}</ul>
      </div>
      <div class="rating-block">
        <div class="rating-label">⚡ Easy to submit</div>
        <div class="rating-value">${ez ?? "–"}/10</div>
        <ul class="reasons">${list(j.easeReasons)}</ul>
      </div>
    </div>
  `;
}

// ---------- Company logo (best-effort — guessed from the company name, not
// stored data) ----------
// There's no reliable source of each company's actual domain/logo in the
// data we have, so this guesses a ".com" domain from the company name and
// asks Clearbit's free logo endpoint for it. When that guess is wrong (or
// the company has no Clearbit-indexed logo) the <img> fails to load and the
// onerror handler swaps in a plain initial-letter avatar instead — so this
// never blocks on or fabricates anything, it just degrades gracefully.
function guessCompanyDomain(company) {
  return `${String(company || "").toLowerCase().replace(/[^a-z0-9]+/g, "")}.com`;
}

// Two logo services tried in order before giving up and showing initials —
// Clearbit's free logo endpoint has gotten unreliable (frequently returns
// nothing at all now), so Google's favicon service is tried next since it's
// still consistently available; only after both fail does it fall back to
// the plain initial-letter avatar. window.__logoFallback (defined once,
// used by every rendered logo <img>) tracks which tier each image is on via
// a data attribute, since inline onerror can't hold that state itself.
window.__logoFallback = function (img) {
  const stage = Number(img.dataset.stage || "0");
  const domain = img.dataset.domain || "";
  if (stage === 0 && domain) {
    img.dataset.stage = "1";
    img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
  } else {
    img.style.display = "none";
    if (img.nextElementSibling) img.nextElementSibling.style.display = "flex";
  }
};

function companyLogoHtml(company, size = 36) {
  const domain = guessCompanyDomain(company);
  const initial = esc((String(company || "?").trim().charAt(0) || "?").toUpperCase());
  return `<span class="company-logo" style="width:${size}px;height:${size}px;">
    <img src="https://logo.clearbit.com/${esc(domain)}" alt="" loading="lazy"
      data-domain="${esc(domain)}" data-stage="0" onerror="window.__logoFallback(this)" />
    <span class="company-logo-fallback">${initial}</span>
  </span>`;
}

function closeModal() {
  modalRoot.innerHTML = "";
}

// Navigates the SPA to `hash`, then scrolls to and focuses `fieldId` once
// that page's async render has actually put it in the DOM — polls briefly
// rather than assuming a fixed delay, since renderSettings()/renderMe() both
// fetch before rendering. Opens a collapsed <details> (e.g. "Advanced
// settings") first if the field lives inside one, since scrollIntoView on a
// closed <details> child doesn't reveal it.
function navigateAndFocusField(hash, fieldId, { detailsId } = {}) {
  closeModal();
  location.hash = hash;
  let attempts = 0;
  const tryFocus = () => {
    attempts++;
    const field = document.getElementById(fieldId);
    if (field) {
      if (detailsId) {
        const details = document.getElementById(detailsId);
        if (details) details.open = true;
      }
      field.scrollIntoView({ behavior: "smooth", block: "center" });
      field.focus();
      return;
    }
    if (attempts < 40) setTimeout(tryFocus, 100);
  };
  setTimeout(tryFocus, 50);
}

// Dealbreakers live inside a specific criteria profile's own Edit modal, not
// on a fixed page/field — so this navigates to Me, opens the first profile's
// editor (that fetch is itself async, hence the same poll-until-clicked
// pattern), then scrolls to and focuses its dealbreakers field. If you have
// more than one profile this always opens the first — fine for the common
// single-profile case; with several, it's a starting point rather than a
// guaranteed match for which profile actually filtered a given job.
function navigateAndOpenCriteriaField(fieldId) {
  closeModal();
  location.hash = "#/me";
  let attempts = 0;
  let clicked = false;
  const tryStep = () => {
    attempts++;
    if (!clicked) {
      const editBtn = document.querySelector("[data-edit-criteria]");
      if (editBtn) {
        clicked = true;
        editBtn.click();
      }
    } else {
      const field = document.getElementById(fieldId);
      if (field) {
        field.scrollIntoView({ behavior: "smooth", block: "center" });
        field.focus();
        return;
      }
    }
    if (attempts < 60) setTimeout(tryStep, 100);
  };
  setTimeout(tryStep, 50);
}

function openModal(html, extraClass = "") {
  modalRoot.innerHTML = `<div class="modal-backdrop" id="modal-backdrop"><div class="modal ${extraClass}">${html}</div></div>`;
  document.getElementById("modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") closeModal();
  });
}

// A styled, readable stand-in for a plain browser alert() — for anything
// with more than one short line to say, or a suggested next step, since a
// native alert can't hold formatting or a link to where that next step
// actually lives. `linkHtml`, if given, is rendered as its own line above
// the closing hint — pass a real `<a>`/`<button>` with an id and wire up
// its click handler yourself right after calling this (mirrors the pattern
// used by discoveryZeroResultsHtml/findMissingPostingsSummaryHtml's own
// bespoke modals, just for the simpler single-message case).
function showMessageModal(title, bodyHtml) {
  openModal(`
    <span class="close-x" id="close-modal">&times;</span>
    <h3>${esc(title)}</h3>
    ${bodyHtml}
  `);
  document.getElementById("close-modal").addEventListener("click", closeModal);
}

// Shared "nothing here" treatment for empty lists/tables — a dashed-border
// card with an icon and a plain-language explanation, instead of bare
// muted text floating in the middle of a page (which reads as "something's
// broken" more than "there's genuinely nothing here right now"). In quite a
// few of these spots an empty list is actually a GOOD thing — an empty
// Review Queue means you're caught up, an empty Archive means you haven't
// passed on anything — so the copy at each call site leans into that rather
// than treating every empty state as a shortfall. `message` may contain
// trusted HTML (e.g. a link) — it's inserted as-is, not escaped; `title` is
// always plain text and is escaped. Mirrors the CV-upload empty state's own
// dashed-card look (.cv-empty in styles.css) rather than inventing a second
// pattern.
function emptyStateHtml(icon, title, message) {
  return `
    <div class="empty-state">
      <div class="empty-state-icon">${icon}</div>
      <p class="empty-state-title">${esc(title)}</p>
      ${message ? `<p class="empty-state-msg">${message}</p>` : ""}
    </div>
  `;
}

// ---------- Job feedback (👍/👎 + optional note) ----------
// Shared between the Review Queue and the job detail modal. Feedback is
// stored per-job and, if you've set an AI provider + API key, gets fed into the
// AI-assisted scoring pass on future discovery runs so matching improves
// over time — see server/scoring.js's buildFeedbackContext.
function feedbackRowHtml(j) {
  const fb = j.feedback || {};
  return `
    <div class="feedback-row" data-feedback-id="${j.id}">
      <button class="fb-btn up ${fb.rating === "up" ? "active" : ""}" data-fb="up" title="Good match">👍</button>
      <button class="fb-btn down ${fb.rating === "down" ? "active" : ""}" data-fb="down" title="Not for me">👎</button>
      <a href="#" class="fb-note-link" data-fb-note>${fb.note ? "Edit note" : "+ Add note"}</a>
      ${fb.note ? `<span class="hint">“${esc(fb.note)}”</span>` : ""}
    </div>
  `;
}

// Compact "materials ready" line reused in the Review Queue — job.materials
// is auto-generated at discovery time by default (see Settings), so it's
// often already there before you've even opened the job.
function materialsLineHtml(j) {
  if (!j.materials) return `<p class="hint">📄 CV &amp; cover letter not generated yet.</p>`;
  const questions = j.materials.reviewQuestions || [];
  // Default action is an in-app preview (previewMaterial(), same modal the
  // job detail view uses) — not a direct link to the download endpoint,
  // which browsers treat as "save this .docx" rather than "show me this."
  // The preview modal itself still offers "Download .docx" for the real
  // file. Needs its caller to wire up [data-preview] via previewMaterial()
  // after inserting this into the DOM (see renderReview's draw()).
  return `<p class="hint">📄 CV &amp; cover letter ready (${fmtDate(j.materials.generatedAt)}) — <button class="link-btn" data-preview="cv" data-job="${j.id}">👁️ View CV</button> &nbsp;·&nbsp; <button class="link-btn" data-preview="cover-letter" data-job="${j.id}">👁️ View cover letter</button></p>
    ${j.materials.tailoringSummary ? `<p class="hint">✏️ ${esc(j.materials.tailoringSummary)}</p>` : ""}
    ${questions.length ? reviewQuestionsHtml(questions) : ""}`;
}

// "Things to consider" — short, concrete questions/flags before you apply
// (e.g. a missing required skill, a seniority mismatch). See
// server/docgen/reviewQuestions.js for how these are generated; never
// fabricated, only drawn from the job's own stated requirements.
function reviewQuestionsHtml(questions) {
  if (!questions || !questions.length) return "";
  return `<div class="review-questions">
    <div class="rating-label">🤔 Worth thinking about before you apply</div>
    <ul>${questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>
  </div>`;
}

// Interactive follow-up to reviewQuestionsHtml, shown only in the job detail
// modal (the compact Review Queue card just shows the questions — this needs
// somewhere to actually act on them). Whatever you type gets appended to
// your Candidate Profile's "Experience bank" (Settings), tagged with which
// job/question prompted it, then materials are regenerated immediately so
// the new context can actually feed into this job's CV/cover letter draft —
// closing the loop instead of just displaying the question and moving on.
function reviewAnswerBoxHtml(job) {
  const questions = (job.materials && job.materials.reviewQuestions) || [];
  if (!questions.length) return "";
  return `
    <div class="review-answer-box">
      <label>Got examples or context for any of these? Add them here — saved to your Experience bank and used next time this job's materials are (re)generated.</label>
      <textarea id="review-answer" placeholder="e.g. Re: paid growth campaigns — I ran a Meta Ads test at Worldpay that lifted conversion 8%..."></textarea>
      <button id="save-review-answer" class="secondary">Save &amp; regenerate materials</button>
      <span id="review-answer-msg" class="hint"></span>
    </div>
  `;
}

function attachFeedbackHandlers(root, jobsById, onChange) {
  root.querySelectorAll(".feedback-row").forEach((row) => {
    const id = row.dataset.feedbackId;
    const job = jobsById[id] || {};
    row.querySelectorAll("[data-fb]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const rating = btn.classList.contains("active") ? null : btn.dataset.fb;
        await api(`/jobs/${id}/feedback`, { method: "POST", body: JSON.stringify({ rating }) });
        // A 👎 on a job still awaiting review is a decision, not just a
        // taste signal — treat it the same as hitting "Dismiss" and move it
        // straight to the Archive, instead of leaving a thumbed-down job
        // sitting in the Review Queue looking unresolved. Once a job has
        // moved further (submitted/interviewing/etc.), a 👎 there is just
        // feedback for future scoring — it doesn't touch status.
        if (rating === "down" && job.status === "discovered") {
          await api(`/jobs/${id}/status`, { method: "POST", body: JSON.stringify({ status: "dismissed" }) });
        }
        onChange();
      });
    });
    const noteLink = row.querySelector("[data-fb-note]");
    if (noteLink) {
      noteLink.addEventListener("click", async (e) => {
        e.preventDefault();
        const note = prompt(
          "Feedback note (optional) — what made this a good or bad match? Helps the AI scoring learn your taste.",
          (job.feedback && job.feedback.note) || ""
        );
        if (note === null) return; // cancelled
        await api(`/jobs/${id}/feedback`, { method: "POST", body: JSON.stringify({ note }) });
        onChange();
      });
    }
  });
}

// ---------- Router ----------
const routes = {
  dashboard: renderDashboard,
  review: renderReview,
  tracker: renderTracker,
  archive: renderArchive,
  me: renderMe,
  settings: renderSettings,
};

// Archive is a sub-tab of Review Queue (see reviewSubTabsHtml), not its own
// left-nav entry, so #/archive should still highlight "Review Queue" there.
const NAV_HIGHLIGHT_ALIAS = { archive: "review" };

function route() {
  const hash = (location.hash || "#/dashboard").replace("#/", "");
  const [view, param] = hash.split("/");
  const highlightAs = NAV_HIGHLIGHT_ALIAS[view] || view;
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === highlightAs));
  (routes[view] || renderDashboard)(param);
}
window.addEventListener("hashchange", route);

// ---------- Dashboard ----------
async function renderDashboard() {
  main.innerHTML = `<h2>Dashboard</h2><div id="dash-body">Loading…</div>`;
  const [stats, jobs] = await Promise.all([api("/stats"), api("/jobs")]);
  const recent = jobs.slice(0, 8);
  document.getElementById("dash-body").innerHTML = `
    <div class="stats-row">
      <div class="stat-card"><div class="stat-icon">📋</div><div class="value">${stats.totalDiscovered}</div><div class="label">Jobs discovered</div></div>
      <div class="stat-card clickable" data-nav="#/review"><div class="stat-icon">🕵️</div><div class="value">${stats.counts.discovered || 0}</div><div class="label">Awaiting review</div></div>
      <div class="stat-card clickable" data-nav="#/tracker/applied_or_later"><div class="stat-icon">📨</div><div class="value">${stats.submitted}</div><div class="label">Applied</div></div>
      <div class="stat-card clickable" data-nav="#/tracker/interviewing_or_later"><div class="stat-icon">🎤</div><div class="value">${stats.interviewed}</div><div class="label">Interviewing</div></div>
      <div class="stat-card"><div class="stat-icon">🏆</div><div class="value">${stats.offers}</div><div class="label">Offers</div></div>
    </div>
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <strong>Last discovery run:</strong> ${stats.lastDiscoveryRun ? fmtDate(stats.lastDiscoveryRun) : "never"}
        </div>
        <button id="run-discovery">Run discovery now</button>
      </div>
    </div>
    <h3>Recent activity</h3>
    ${recent.length ? recent.map(jobRowHtml).join("") : emptyStateHtml("🧭", "No jobs yet", `Set up a <a href="#/me">criteria profile</a>, then hit "Run discovery now" above to start finding matches.`)}
  `;
  document.getElementById("dash-body").querySelectorAll("[data-nav]").forEach((card) => {
    card.addEventListener("click", () => {
      location.hash = card.dataset.nav;
    });
  });
  document.getElementById("run-discovery").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    // A single atomic backend call, not real step-by-step progress — this
    // just cycles through what a cycle is roughly doing at any given moment
    // so a multi-source run (job boards + email digests + posting lookups +
    // scoring) doesn't sit on a bare "Running…" for what can be 10-20+
    // seconds. See server/discovery.js's runDiscoveryCycle for the actual
    // steps this is approximating.
    let msgIndex = 0;
    btn.textContent = DISCOVERY_LOADING_MESSAGES[0];
    const rotateLoadingMessage = setInterval(() => {
      msgIndex = (msgIndex + 1) % DISCOVERY_LOADING_MESSAGES.length;
      btn.textContent = DISCOVERY_LOADING_MESSAGES[msgIndex];
    }, 1800);
    try {
      const result = await api("/jobs/discover", { method: "POST" });
      clearInterval(rotateLoadingMessage);
      if (result.added > 0) {
        alert(`Discovery complete: ${result.added} new match(es) found.`);
      } else {
        // A bare "0 new matches" alert can't tell you whether it actually
        // searched anywhere — show what really happened this run instead.
        openModal(discoveryZeroResultsHtml(result.diagnostics));
        document.getElementById("close-modal").addEventListener("click", closeModal);
        const gotoCriteria = document.getElementById("goto-criteria-setup");
        if (gotoCriteria) gotoCriteria.addEventListener("click", closeModal);
        const gotoDealbreakers = document.getElementById("goto-dealbreakers");
        if (gotoDealbreakers) {
          gotoDealbreakers.addEventListener("click", (e) => {
            e.preventDefault();
            navigateAndOpenCriteriaField("c-dealbreakers");
          });
        }
        const gotoMinScore = document.getElementById("goto-min-score");
        if (gotoMinScore) {
          gotoMinScore.addEventListener("click", (e) => {
            e.preventDefault();
            navigateAndFocusField("#/settings", "minScore", { detailsId: "advanced-settings" });
          });
        }
      }
      renderDashboard();
    } catch (err) {
      clearInterval(rotateLoadingMessage);
      showMessageModal("Discovery run failed", `
        <p>${esc(err.message)}</p>
        <p class="hint">Usually a job-board or email-inbox connection hiccup — try again in a minute. If it keeps happening, check your <a href="#/settings">Settings</a> (email inbox credentials, AI provider key) for anything that looks wrong.</p>
      `);
      btn.disabled = false;
      btn.textContent = "Run discovery now";
    }
  });
  attachRowHandlers();
}

// Explains a 0-new-matches discovery cycle instead of leaving it looking
// like nothing happened — see server/discovery.js's `diagnostics` for what
// each field means. The single most common cause (no active criteria
// profile, so the whole per-source/email-scoring loop never even runs) gets
// its own direct call-out with a link straight to where it's fixed.
function discoveryZeroResultsHtml(diag) {
  if (!diag) {
    return `<span class="close-x" id="close-modal">&times;</span><h3>Discovery complete</h3><p>0 new matches found.</p>`;
  }
  if (diag.activeProfileCount === 0) {
    return `
      <span class="close-x" id="close-modal">&times;</span>
      <h3>Discovery complete: 0 new matches</h3>
      <p><strong>No active criteria profile is set up</strong> — with none, this doesn't search job boards or check your email digest at all, since there's nothing to score jobs against. ${
        diag.totalProfileCount
          ? `You have ${diag.totalProfileCount} profile${diag.totalProfileCount === 1 ? "" : "s"} saved, but none are marked active.`
          : "You haven't created one yet."
      }</p>
      <p><a href="#/me" id="goto-criteria-setup">Set up a criteria profile on the Me tab</a> — that's what actually turns discovery on.</p>
    `;
  }
  const sourceLines =
    Object.entries(diag.sourceCounts || {})
      .map(([src, count]) => `${esc(src)}: ${count}`)
      .join(", ") || "none enabled";
  return `
    <span class="close-x" id="close-modal">&times;</span>
    <h3>Discovery complete: 0 new matches</h3>
    <p>Here's what actually ran this cycle, so "0" doesn't look like nothing happened:</p>
    <ul>
      <li>Job board sources checked (raw results before filtering) — ${sourceLines}</li>
      <li>Email digest: ${diag.emailDigestJobsFound} job listing(s) extracted from new emails</li>
      <li>${diag.newAfterDedup} of those weren't already-known jobs</li>
      <li>${diag.hardFailed} ruled out by a <a href="#" id="goto-dealbreakers">dealbreaker in your criteria profile</a></li>
      <li>${diag.belowThreshold} scored below your <a href="#" id="goto-min-score">match threshold</a></li>
    </ul>
    <p class="hint">If every source above shows 0, that usually means the request itself failed (network/API issue) rather than genuinely finding nothing — check the Railway logs for a matching <code>[sources]</code> or fetch-failed error line. Otherwise, click either link above to jump straight to where it's set and adjust it.</p>
  `;
}

// Groups the still-missing jobs by WHY they stayed missing (the `reason`
// codes from server/postingResolver.js, attached per-job client-side in the
// "Find missing postings" handler) and lists each job by name under its
// reason — not just a bare count, so there's something to actually click
// through to instead of a dead end. Mirrors discoveryZeroResultsHtml's
// "explain the bottleneck, then link to it" approach. `results` is an array
// of `{job, found, reasonCode}`.
function findMissingPostingsSummaryHtml(results) {
  const LABELS = {
    no_ai_provider_configured: "Not on Greenhouse/Lever/Ashby/Recruitee, and no AI provider is set up to try a web search instead",
    ai_capped_this_run: "Not on those four platforms — AI web search was skipped (this run's cost cap was reached)",
    ai_tried_no_confident_match: "Not on those four platforms, and an AI web search didn't find a confident match either",
    // Distinct from the row above — this means the AI web search call
    // itself broke (not just "searched and found nothing"). The actual
    // error is shown inline below since a label alone can't say what
    // specifically failed.
    ai_error: "Not on those four platforms, and the AI web search itself failed to run — this is a real error, not just \"nothing found\"",
    no_title_or_company: "Missing a title or company to search for",
    request_failed: "The request itself failed (network/API issue) — worth retrying",
    other: "Couldn't find it automatically",
  };
  const found = results.filter((r) => r.found).length;
  const groups = {};
  results
    .filter((r) => !r.found)
    .forEach((r) => {
      (groups[r.reasonCode] = groups[r.reasonCode] || []).push(r.job);
    });
  // Every ai_error job likely failed for the SAME underlying reason (a
  // misconfigured key, a broken endpoint) rather than each having its own
  // distinct problem, so one representative example is more useful here
  // than repeating it per job — this is what actually tells you (or
  // whoever's debugging this) what's really wrong instead of just "AI
  // couldn't find it," which looks identical to a clean miss otherwise.
  const aiErrorExample = results.find((r) => r.reasonCode === "ai_error" && r.detail)?.detail;
  const groupHtml = Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length)
    .map(
      ([code, jobs]) => `
      <div class="posting-reason-group">
        <p class="posting-reason-label">${esc(LABELS[code] || code)} <span class="hint">(${jobs.length})</span></p>
        ${code === "ai_error" && aiErrorExample ? `<p class="hint">Actual error: <code>${esc(aiErrorExample)}</code></p>` : ""}
        <ul class="posting-reason-jobs">
          ${jobs.map((j) => `<li><button class="link-btn" data-open-job="${j.id}">${esc(j.company)} — ${esc(j.title)}</button></li>`).join("")}
        </ul>
      </div>`
    )
    .join("");
  const noAiConfigured = Boolean(groups.no_ai_provider_configured);
  const hasAiError = Boolean(groups.ai_error);
  return `
    <span class="close-x" id="close-modal">&times;</span>
    <h3>Found ${found} of ${results.length}</h3>
    ${groupHtml}
    <p class="hint">${
      noAiConfigured
        ? `<a href="#" id="goto-ai-setup">Add an Anthropic or Gemini API key</a> in Settings to let a web search try the ones tier 1 can't reach. `
        : hasAiError
        ? `<a href="#" id="goto-ai-setup">Check your AI provider settings</a> — the error above suggests something's misconfigured, not that these jobs are unfindable. `
        : ""
    }Click a job above to open it straight to Posting details and paste the link in yourself, if you have it.</p>
  `;
}

function jobRowHtml(j) {
  return `
    <div class="list-item job-row" data-job-id="${j.id}">
      ${companyLogoHtml(j.company)}
      <div class="job-row-main">
        <h4>${esc(j.company)} <span class="badge ${j.status}">${j.status.replace(/_/g, " ")}</span></h4>
        <div class="meta">${esc(j.title)} · ${esc(j.location || "—")}${
    j.url ? ` · <a href="${esc(j.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation();">View posting ↗</a>` : ""
  }</div>
        <div class="meta">${ratingsBadgesHtml(j)} · discovered ${fmtDate(j.discoveredAt)}</div>
      </div>
    </div>
  `;
}

function attachRowHandlers() {
  document.querySelectorAll("[data-job-id]").forEach((el) => {
    el.addEventListener("click", () => openJobDetail(el.dataset.jobId));
  });
}

// Wires up the Tracker table's per-row ★ favourite toggle and 📝 notes
// button. Kept separate from attachRowHandlers() since those two buttons
// need event.stopPropagation() (already set inline in the row markup) plus
// their own PATCH calls, and this is Tracker-specific rather than shared
// with the Dashboard/Review Queue row lists.
function attachTrackerRowActionHandlers(jobs, onChange) {
  const jobsById = Object.fromEntries(jobs.map((j) => [j.id, j]));
  document.querySelectorAll("[data-fav]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.fav;
      const job = jobsById[id] || {};
      btn.disabled = true;
      try {
        await api(`/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ favorite: !job.favorite }) });
        onChange();
      } catch (err) {
        showMessageModal("Couldn't update favourite", `<p>${esc(err.message)}</p>`);
        btn.disabled = false;
      }
    });
  });
  document.querySelectorAll("[data-notes]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.notes;
      const job = jobsById[id] || {};
      const note = prompt("Note for this job:", job.notes || "");
      if (note === null) return; // cancelled
      try {
        await api(`/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ notes: note }) });
        onChange();
      } catch (err) {
        showMessageModal("Couldn't save note", `<p>${esc(err.message)}</p>`);
      }
    });
  });
}

// ---------- Review Queue ----------
// Archive lives under Review Queue as a sub-tab (not its own sidebar entry —
// see NAV_HIGHLIGHT_ALIAS above) since it's really just "the other status
// filter" on the same underlying list of jobs you haven't moved forward
// with yet. Shared by renderReview() and renderArchive().
function reviewSubTabsHtml(active) {
  return `
    <div class="subtabs">
      <a href="#/review" class="${active === "review" ? "active" : ""}">Awaiting review</a>
      <a href="#/archive" class="${active === "archive" ? "active" : ""}">Archive</a>
    </div>
  `;
}

function reviewJobRowHtml(j) {
  return `
    <div class="list-item job-row">
      ${companyLogoHtml(j.company, 44)}
      <div class="job-row-main">
        <h4>${esc(j.company)} <span class="score ${scoreClass(j.score)}">Score ${j.score}/100</span></h4>
        <div class="meta">${esc(j.title)} · ${esc(j.location || "—")} · via ${esc(j.source)} · discovered ${fmtDate(j.discoveredAt)}
          ${j.url ? `&nbsp;<a class="posting-link-btn" href="${esc(j.url)}" target="_blank" rel="noopener">View posting ↗</a>` : ""}
        </div>
        ${ratingsDetailHtml(j)}
        ${feedbackRowHtml(j)}
        ${materialsLineHtml(j)}
        <button data-approve="${j.id}">${j.materials ? "Approve" : "Approve & prepare materials"}</button>
        <button class="secondary" data-detail="${j.id}">Details</button>
        <button class="secondary" data-dismiss="${j.id}">Dismiss</button>
      </div>
    </div>
  `;
}

const REVIEW_SORTS = {
  "score-desc": (a, b) => (b.score ?? 0) - (a.score ?? 0),
  "score-asc": (a, b) => (a.score ?? 0) - (b.score ?? 0),
  "date-desc": (a, b) => new Date(b.discoveredAt) - new Date(a.discoveredAt),
  "date-asc": (a, b) => new Date(a.discoveredAt) - new Date(b.discoveredAt),
};

async function renderReview() {
  main.innerHTML = `<h2>Review Queue</h2>${reviewSubTabsHtml("review")}<div id="review-body">Loading…</div>`;
  const jobs = await api("/jobs?status=discovered");
  const body = document.getElementById("review-body");
  if (!jobs.length) {
    body.innerHTML = emptyStateHtml("✅", "You're all caught up", "No new matches waiting for review right now — check back after your next discovery run.");
    return;
  }

  const jobsById = Object.fromEntries(jobs.map((j) => [j.id, j]));
  const sources = [...new Set(jobs.map((j) => j.source).filter(Boolean))].sort();

  body.innerHTML = `
    <div class="filters" style="justify-content:space-between;">
      <div class="filters" style="margin:0;">
        <label style="margin:0;">Sort:</label>
        <select id="review-sort">
          <option value="score-desc">Score, high to low</option>
          <option value="score-asc">Score, low to high</option>
          <option value="date-desc">Newest first</option>
          <option value="date-asc">Oldest first</option>
        </select>
      </div>
      <div class="filters" style="margin:0;">
        <label style="margin:0;">Min score:</label>
        <input type="number" id="review-min-score" min="0" max="100" placeholder="0" style="width:70px;" />
        <label style="margin:0;">Source:</label>
        <select id="review-source-filter">
          <option value="">All</option>
          ${sources.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}
        </select>
      </div>
      <button id="recheck-criteria" class="secondary">🔄 Re-check against current criteria</button>
    </div>
    <div id="review-list"></div>
  `;
  const listEl = document.getElementById("review-list");

  // If you've edited a criteria profile since these were discovered
  // (tightened a location, added a dealbreaker, turned off remote, etc.),
  // scores here are stale — they were computed against whatever the profile
  // looked like at discovery time and are never silently touched again
  // afterwards (same "always automatic, but never re-decided behind your
  // back" rule as everywhere else in this app). This re-scores every job
  // still awaiting review against your CURRENT profiles and shows exactly
  // which ones would no longer clear the bar, so you can decide — nothing
  // gets dismissed without you checking the list and confirming.
  document.getElementById("recheck-criteria").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    const noLongerMatch = [];
    for (let i = 0; i < jobs.length; i++) {
      btn.textContent = `Re-checking… (${i + 1}/${jobs.length})`;
      try {
        const result = await api(`/jobs/${jobs[i].id}/recheck-match`, { method: "POST" });
        Object.assign(jobsById[jobs[i].id], result); // keep the row list's own score in sync either way
        if (!result.stillMatches) noLongerMatch.push(jobsById[jobs[i].id]);
      } catch (err) {
        console.error(`Re-check failed for ${jobs[i].title} @ ${jobs[i].company}:`, err.message);
      }
    }
    btn.disabled = false;
    btn.textContent = "🔄 Re-check against current criteria";
    draw();

    if (!noLongerMatch.length) {
      showMessageModal("Re-checked against your current criteria", `<p>All ${jobs.length} job(s) still clear your match threshold — nothing to update.</p>`);
      return;
    }
    openModal(`
      <span class="close-x" id="close-modal">&times;</span>
      <h3>${noLongerMatch.length} of ${jobs.length} no longer match</h3>
      <p class="hint">Scores above have already been updated. These specific jobs would no longer clear your match threshold under your current criteria — review the list and dismiss whichever ones you agree with (unchecked ones are left as-is).</p>
      <ul class="recheck-list">
        ${noLongerMatch
          .map(
            (j) => `<li><label><input type="checkbox" checked data-recheck-job="${j.id}" /> ${esc(j.company)} — ${esc(j.title)} <span class="hint">(now ${j.score ?? "—"}/100)</span></label></li>`
          )
          .join("")}
      </ul>
      <div style="margin-top:14px;">
        <button id="confirm-dismiss-recheck">Dismiss the checked ones</button>
        <button class="secondary" id="close-modal-2">Cancel</button>
      </div>
    `);
    const close = () => closeModal();
    document.getElementById("close-modal").addEventListener("click", close);
    document.getElementById("close-modal-2").addEventListener("click", close);
    document.getElementById("confirm-dismiss-recheck").addEventListener("click", async () => {
      const checked = [...document.querySelectorAll("[data-recheck-job]:checked")].map((el) => el.dataset.recheckJob);
      for (const id of checked) {
        await api(`/jobs/${id}/status`, { method: "POST", body: JSON.stringify({ status: "dismissed" }) });
      }
      closeModal();
      renderReview();
    });
  });

  const draw = () => {
    const sortKey = document.getElementById("review-sort").value;
    const minScore = Number(document.getElementById("review-min-score").value) || 0;
    const source = document.getElementById("review-source-filter").value;
    const list = jobs
      .filter((j) => (j.score ?? 0) >= minScore && (!source || j.source === source))
      .sort(REVIEW_SORTS[sortKey] || REVIEW_SORTS["score-desc"]);

    if (!list.length) {
      listEl.innerHTML = emptyStateHtml("🔍", "No matches for these filters", "Try lowering the minimum score or clearing the source filter above.");
      return;
    }
    listEl.innerHTML = list.map(reviewJobRowHtml).join("");

    attachFeedbackHandlers(listEl, jobsById, renderReview);

    listEl.querySelectorAll("[data-approve]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const id = btn.dataset.approve;
        const job = jobsById[id];
        const alreadyHasMaterials = Boolean(job && job.materials);
        btn.disabled = true;
        btn.textContent = alreadyHasMaterials ? "Approving…" : "Preparing…";
        try {
          if (alreadyHasMaterials) {
            // Materials were already auto-generated at discovery time — just move the status forward.
            await api(`/jobs/${id}/status`, { method: "POST", body: JSON.stringify({ status: "materials_ready" }) });
          } else {
            await api(`/jobs/${id}/status`, { method: "POST", body: JSON.stringify({ status: "approved" }) });
            await api(`/jobs/${id}/generate-materials`, { method: "POST" });
          }
          renderReview();
        } catch (err) {
          showMessageModal("Couldn't prepare materials", `
            <p>${esc(err.message)}</p>
            <p class="hint">This usually means your <a href="#/me">candidate profile</a> is missing something the generator needs (e.g. no experience entries yet), or the AI provider configured under <a href="#/settings">Settings</a> is unreachable. Fix that and try "Approve" again.</p>
          `);
          btn.disabled = false;
          btn.textContent = alreadyHasMaterials ? "Approve" : "Approve & prepare materials";
        }
      })
    );
    listEl.querySelectorAll("[data-dismiss]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await api(`/jobs/${btn.dataset.dismiss}/status`, { method: "POST", body: JSON.stringify({ status: "dismissed" }) });
        renderReview();
      })
    );
    listEl.querySelectorAll("[data-detail]").forEach((btn) => btn.addEventListener("click", () => openJobDetail(btn.dataset.detail)));
    listEl.querySelectorAll("[data-preview]").forEach((btn) =>
      btn.addEventListener("click", () => previewMaterial(btn.dataset.job, btn.dataset.preview))
    );
  };

  document.getElementById("review-sort").addEventListener("change", draw);
  document.getElementById("review-min-score").addEventListener("input", draw);
  document.getElementById("review-source-filter").addEventListener("change", draw);
  draw();
}

// ---------- Tracker ----------
// Status groups used by the Dashboard's "Applied"/"Interviewing" stat cards
// (see renderDashboard) — clicking one jumps here pre-filtered to every
// status that counts towards that stat, not just the single exact status.
const TRACKER_STATUS_GROUPS = {
  applied_or_later: {
    label: "Applied (any stage)",
    statuses: ["submitted", "interviewing", "offer", "rejected", "withdrawn"],
  },
  interviewing_or_later: {
    label: "Interviewing (any stage)",
    statuses: ["interviewing", "offer"],
  },
};

async function renderTracker(initialFilter) {
  // "dismissed" is deliberately excluded here — those live in the Archive
  // tab now instead of cluttering the Tracker's status dropdown.
  const singleStatuses = ["reviewing","approved","materials_ready","submitted","interviewing","offer","rejected","withdrawn"];
  main.innerHTML = `
    <h2>Tracker</h2>
    <div class="filters" style="justify-content:space-between;">
      <div class="filters" style="margin:0;">
        <label style="margin:0;">Status:</label>
        <select id="status-filter" style="width:240px;">
          <option value="">All</option>
          ${Object.entries(TRACKER_STATUS_GROUPS)
            .map(([key, g]) => `<option value="${key}" ${initialFilter === key ? "selected" : ""}>${g.label}</option>`)
            .join("")}
          ${singleStatuses
            .map((s) => `<option value="${s}" ${initialFilter === s ? "selected" : ""}>${s.replace(/_/g, " ")}</option>`)
            .join("")}
        </select>
      </div>
      <div class="filters" style="margin:0;">
        <label style="margin:0;"><input type="checkbox" id="favorites-only-filter" /> ★ Favourites only</label>
      </div>
      <div>
        <button id="find-missing-postings" class="secondary">🔎 Find missing postings</button>
        <button id="add-job-manually" class="secondary">+ Add job manually</button>
        <a class="btn-pill" href="#/archive">🗄 Archive</a>
      </div>
    </div>
    <div class="card"><table id="tracker-table">
      <thead><tr><th>Company</th><th>Role</th><th>Status</th><th>Score /100</th><th>Discovered</th><th>Applied</th><th>Notes</th><th></th><th></th></tr></thead>
      <tbody id="tracker-body"><tr><td colspan="9">Loading…</td></tr></tbody>
    </table></div>
  `;
  const load = async () => {
    const filterValue = document.getElementById("status-filter").value;
    const favoritesOnly = document.getElementById("favorites-only-filter").checked;
    const group = TRACKER_STATUS_GROUPS[filterValue];
    // A group filter (from a Dashboard stat card) covers several statuses at
    // once, so it's applied client-side over the full job list rather than
    // as a single-status server query.
    const allJobs = await api(`/jobs${!group && filterValue ? `?status=${filterValue}` : ""}`);
    let jobs = group
      ? allJobs.filter((j) => group.statuses.includes(j.status))
      : filterValue
      ? allJobs
      : allJobs.filter((j) => j.status !== "discovered" && j.status !== "dismissed");
    if (favoritesOnly) jobs = jobs.filter((j) => j.favorite);
    const tbody = document.getElementById("tracker-body");
    if (!jobs.length) {
      tbody.innerHTML = `<tr><td colspan="9">${emptyStateHtml("📋", "No jobs in this view", `Try a different status filter above, or turn off "Favourites only".`)}</td></tr>`;
      return;
    }
    tbody.innerHTML = jobs
      .map(
        (j) => `
      <tr data-job-id="${j.id}">
        <td class="company-cell">${companyLogoHtml(j.company, 24)}<strong>${esc(j.company)}</strong></td>
        <td>${esc(j.title)}</td>
        <td><span class="badge ${j.status}">${j.status.replace(/_/g, " ")}</span></td>
        <td class="score ${scoreClass(j.score ?? -1)}">${j.score ?? "–"}<div class="rating-mini">${ratingsBadgesHtml(j)}</div></td>
        <td>${fmtDate(j.discoveredAt)}</td>
        <td>${fmtDate(j.appliedAt)}</td>
        <td class="notes-cell"><button class="icon-btn ${j.notes ? "active" : ""}" data-notes="${j.id}" title="${
          j.notes ? esc(j.notes) : "Add a note"
        }" onclick="event.stopPropagation();">${j.notes ? "📝" : "🗒️"}</button></td>
        <td>${j.url ? `<a href="${esc(j.url)}" target="_blank" rel="noopener" title="View posting" onclick="event.stopPropagation();">↗</a>` : ""}</td>
        <td class="fav-cell"><button class="star-btn ${j.favorite ? "active" : ""}" data-fav="${j.id}" title="${
          j.favorite ? "Remove favourite" : "Mark as favourite"
        }" onclick="event.stopPropagation();">${j.favorite ? "★" : "☆"}</button></td>
      </tr>`
      )
      .join("");
    attachRowHandlers();
    attachTrackerRowActionHandlers(jobs, load);
  };
  document.getElementById("status-filter").addEventListener("change", load);
  document.getElementById("favorites-only-filter").addEventListener("change", load);
  document.getElementById("add-job-manually").addEventListener("click", () => openAddJobModal(load));

  // Runs the automatic posting lookup (server/postingResolver.js) against
  // every job in the Tracker still missing a URL, one at a time, so it's
  // one click instead of opening each job individually. Best-effort by
  // nature — only finds a posting for companies actually on Greenhouse,
  // Lever, Ashby, or Recruitee with a slug that matches their name (tier 1),
  // or that a grounded AI web search can find (tier 2, Anthropic or Gemini
  // only, needs a provider + key set below). The completion message checks
  // whether tier 2 is actually configured rather than just saying "(if
  // configured)" — no point being vague when we know the real answer.
  document.getElementById("find-missing-postings").addEventListener("click", async (e) => {
    const btn = e.target;
    const allJobs = await api("/jobs");
    const missing = allJobs.filter((j) => !j.url && j.status !== "dismissed");
    if (!missing.length) {
      alert("Every job in your Tracker already has a posting link.");
      return;
    }
    btn.disabled = true;
    // Per-job results, not just a tally — so the summary modal below can
    // list which actual jobs stayed missing under each reason, each
    // clickable straight through to its own Posting details field, instead
    // of a bare count with nowhere to go.
    const results = [];
    for (let i = 0; i < missing.length; i++) {
      btn.textContent = `Looking… (${i + 1}/${missing.length})`;
      try {
        const result = await api(`/jobs/${missing[i].id}/find-posting`, { method: "POST" });
        results.push({ job: missing[i], found: Boolean(result.found), reasonCode: result.reasonCode || "other", detail: result.detail });
      } catch (err) {
        console.error(`Find-posting failed for ${missing[i].title} @ ${missing[i].company}:`, err.message);
        results.push({ job: missing[i], found: false, reasonCode: "request_failed" });
      }
    }
    btn.disabled = false;
    btn.textContent = "🔎 Find missing postings";
    load();
    const found = results.filter((r) => r.found).length;
    if (found === missing.length) {
      alert(`Found all ${found} missing posting${found === 1 ? "" : "s"}.`);
      return;
    }
    openModal(findMissingPostingsSummaryHtml(results));
    document.getElementById("close-modal").addEventListener("click", closeModal);
    const gotoAiSetup = document.getElementById("goto-ai-setup");
    if (gotoAiSetup) {
      gotoAiSetup.addEventListener("click", (ev) => {
        ev.preventDefault();
        navigateAndFocusField("#/settings", "aiProvider", { detailsId: "advanced-settings" });
      });
    }
    document.querySelectorAll("[data-open-job]").forEach((el) => {
      el.addEventListener("click", () => {
        closeModal();
        openJobDetailAtPosting(el.dataset.openJob);
      });
    });
  });

  load();
}

// ---------- Archive ----------
// Jobs you've actively said no to — either via "Dismiss" in the Review
// Queue, or a 👎 on a job still awaiting review (see attachFeedbackHandlers,
// which now treats that the same as Dismiss) — live here instead of sitting
// in the Tracker's main working list forever. Your 👍/👎 + note stay
// attached and visible via the same feedbackRowHtml used everywhere else,
// so it's easy to see why something was passed on later; "Restore" undoes
// it by putting the job back in the Review Queue.
async function renderArchive() {
  main.innerHTML = `<h2>Review Queue</h2>${reviewSubTabsHtml("archive")}<div id="archive-body">Loading…</div>`;
  const jobs = await api("/jobs?status=dismissed");
  const body = document.getElementById("archive-body");
  if (!jobs.length) {
    body.innerHTML = emptyStateHtml("🗄️", "Nothing archived", `Jobs you pass on — via "Dismiss" or a 👎 in Review Queue — end up here instead of cluttering your Tracker.`);
    return;
  }
  const jobsById = Object.fromEntries(jobs.map((j) => [j.id, j]));
  body.innerHTML = jobs
    .map(
      (j) => `
    <div class="list-item job-row">
      ${companyLogoHtml(j.company, 44)}
      <div class="job-row-main">
        <h4>${esc(j.company)} ${j.score != null ? `<span class="score ${scoreClass(j.score)}">Score ${j.score}/100</span>` : ""}</h4>
        <div class="meta">${esc(j.title)} · ${esc(j.location || "—")} · discovered ${fmtDate(j.discoveredAt)}
          ${j.url ? `&nbsp;<a class="posting-link-btn" href="${esc(j.url)}" target="_blank" rel="noopener">View posting ↗</a>` : ""}
        </div>
        ${feedbackRowHtml(j)}
        <button class="secondary" data-restore="${j.id}">↩️ Restore to Review Queue</button>
        <button class="secondary" data-detail="${j.id}">Details</button>
      </div>
    </div>
  `
    )
    .join("");

  attachFeedbackHandlers(body, jobsById, renderArchive);

  body.querySelectorAll("[data-restore]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api(`/jobs/${btn.dataset.restore}/status`, { method: "POST", body: JSON.stringify({ status: "discovered" }) });
      renderArchive();
    })
  );
  body.querySelectorAll("[data-detail]").forEach((btn) => btn.addEventListener("click", () => openJobDetail(btn.dataset.detail)));
}

// ---------- Add job manually ----------
// For roles found outside the automated sources — e.g. something you spotted
// yourself, or an application already in flight before you started using
// this app. No score gets fabricated for these; the Tracker just shows "–".
function openAddJobModal(onSaved) {
  const statuses = ["reviewing","approved","materials_ready","submitted","interviewing","offer","rejected","withdrawn"];
  openModal(`
    <span class="close-x" id="close-modal">&times;</span>
    <h3>Add a job manually</h3>
    <label>Job title *</label>
    <input type="text" id="aj-title" />
    <label>Company *</label>
    <input type="text" id="aj-company" />
    <div class="form-row">
      <div>
        <label>Location</label>
        <input type="text" id="aj-location" />
      </div>
      <div>
        <label>Status</label>
        <select id="aj-status">${statuses.map((s) => `<option value="${s}">${s.replace(/_/g, " ")}</option>`).join("")}</select>
      </div>
    </div>
    <label>Posting URL</label>
    <input type="text" id="aj-url" placeholder="https://..." />
    <label>Notes</label>
    <textarea id="aj-notes"></textarea>
    <div style="margin-top:12px;"><button id="aj-save">Add job</button><span id="aj-msg" class="hint"></span></div>
  `);
  document.getElementById("close-modal").addEventListener("click", closeModal);
  document.getElementById("aj-save").addEventListener("click", async () => {
    const title = document.getElementById("aj-title").value.trim();
    const company = document.getElementById("aj-company").value.trim();
    const msg = document.getElementById("aj-msg");
    if (!title || !company) {
      msg.textContent = "Title and company are required.";
      return;
    }
    try {
      await api("/jobs", {
        method: "POST",
        body: JSON.stringify({
          title,
          company,
          location: document.getElementById("aj-location").value.trim(),
          status: document.getElementById("aj-status").value,
          url: document.getElementById("aj-url").value.trim(),
          notes: document.getElementById("aj-notes").value.trim(),
        }),
      });
      closeModal();
      onSaved();
    } catch (err) {
      msg.textContent = `Couldn't add job: ${err.message}`;
    }
  });
}

// ---------- Job detail modal ----------
// Opens a job's detail modal already scrolled/focused to its Posting URL
// field — used by the "Find missing postings" summary so clicking a job
// listed there lands you exactly where you'd paste a link in by hand,
// instead of the top of the modal. Safe to call right after openJobDetail's
// promise resolves: the modal HTML is set synchronously inside it before
// that promise returns, so #edit-url already exists in the DOM by then.
async function openJobDetailAtPosting(id) {
  await openJobDetail(id);
  const field = document.getElementById("edit-url");
  if (field) {
    field.scrollIntoView({ behavior: "smooth", block: "center" });
    field.focus();
  }
}

async function openJobDetail(id) {
  const job = await api(`/jobs/${id}`);
  const statuses = ["discovered","reviewing","approved","materials_ready","submitted","interviewing","offer","rejected","withdrawn","dismissed"];
  openModal(`
    <div class="job-detail-header sticky">
      <span class="close-x" id="close-modal">&times;</span>
      ${companyLogoHtml(job.company, 48)}
      <div>
        <h3>${esc(job.company)}</h3>
        <div class="meta">${esc(job.title)} · ${esc(job.location || "—")}${job.salary ? ` · ${esc(job.salary)}` : ""}${job.url ? ` · <a class="posting-link-btn" href="${esc(job.url)}" target="_blank" rel="noopener">View posting ↗</a>` : ""}</div>
        <div class="meta job-detail-quickfacts">
          <span class="badge ${job.status}">${job.status.replace(/_/g, " ")}</span>
          ${job.score != null ? `<span class="score ${scoreClass(job.score)}">Overall score ${job.score}/100</span>` : ""}
          ${job.source ? `<span class="hint">via ${esc(job.source)}${job.discoveredAt ? ` · discovered ${fmtDate(job.discoveredAt)}` : ""}</span>` : ""}
        </div>
      </div>
    </div>
    ${ratingsDetailHtml(job)}
    ${job.materials && job.materials.reviewQuestions && job.materials.reviewQuestions.length ? reviewQuestionsHtml(job.materials.reviewQuestions) : ""}
    ${reviewAnswerBoxHtml(job)}

    <label>Was this a good match?</label>
    ${feedbackRowHtml(job)}
    <p class="hint">Feeds into the AI-assisted scoring pass on future discovery runs (needs an AI provider + API key + AI preferences set in Settings).</p>

    <label>Update status</label>
    <div class="form-row">
      <select id="status-select">${statuses.map((s) => `<option value="${s}" ${s === job.status ? "selected" : ""}>${s.replace(/_/g, " ")}</option>`).join("")}</select>
      <button id="save-status">Update</button>
    </div>

    <label>Notes</label>
    <textarea id="notes">${esc(job.notes || "")}</textarea>
    <button id="save-notes" class="secondary">Save notes</button>

    <div class="section-title" id="posting-details-section">Posting details</div>
    ${
      !job.url
        ? `<button id="find-posting" class="secondary">Try to find the real posting automatically</button>
           <p class="hint">First checks the company's own Greenhouse/Lever/Ashby/Recruitee job board using the title + company name (free, always tried). If that comes back empty and your AI provider in Settings is Anthropic or Gemini, it then tries a real, grounded web search to find the actual listing — no sites for you to visit or approve either way. If both come back empty, paste the link yourself below.</p>`
        : ""
    }
    <label>Posting URL</label>
    <input type="text" id="edit-url" value="${esc(job.url || "")}" placeholder="https://..." />
    <label>Description / summary</label>
    <textarea id="edit-description" style="min-height:100px;">${esc(job.description || "")}</textarea>
    <div class="form-row">
      <div><label>Location</label><input type="text" id="edit-location" value="${esc(job.location || "")}" /></div>
      <div><label>Salary</label><input type="text" id="edit-salary" value="${esc(job.salary || "")}" /></div>
    </div>
    <button id="save-posting-details" class="secondary">Save posting details</button>
    <span id="posting-details-msg" class="hint"></span>
    <p class="hint">Saves whatever's in the four fields above, and — if you changed the URL, description, location, or salary — immediately re-scores this job against your criteria using the new information (see the "Always automatic, no rescore button" behaviour throughout this app). Editing notes/status/favourite elsewhere never triggers a rescore; only these posting fields do, since they're what scoring actually reads.</p>

    <div class="section-title">Application materials</div>
    ${
      job.materials
        ? `<p>
             <button class="link-btn" data-preview="cv" data-job="${job.id}">👁️ Preview CV</button> &nbsp;·&nbsp;
             <a href="/api/jobs/${job.id}/materials/cv" target="_blank">Download .docx</a> &nbsp;&nbsp;|&nbsp;&nbsp;
             <button class="link-btn" data-preview="cover-letter" data-job="${job.id}">👁️ Preview cover letter</button> &nbsp;·&nbsp;
             <a href="/api/jobs/${job.id}/materials/cover-letter" target="_blank">Download .docx</a>
           </p>
           <label>Feedback for regeneration (optional)</label>
           <textarea id="materials-feedback" placeholder="e.g. make the cover letter punchier, drop the internship mention, lead with the leadership experience instead">${esc(job.materialsFeedback || "")}</textarea>
           <p class="hint">Applies mainly to the cover letter's wording and any experience-bank snippets pulled into the CV — your CV's bullet order itself is picked automatically by relevance to the job, not by this. Needs an AI provider configured in Settings to actually take effect; saved either way so it's here next time.</p>
           <button id="regen-materials" class="secondary">Regenerate with this feedback</button>
           <button id="autofill-btn" class="secondary">Attempt assisted auto-fill (beta)</button>
           ${
             job.materials.tailoringSummary
               ? `<div class="tailoring-summary"><div class="rating-label">✏️ How your CV was tailored for this role</div><p>${esc(job.materials.tailoringSummary)}</p></div>`
               : ""
           }`
        : `<p class="hint">No materials generated yet.</p><button id="gen-materials">Generate CV &amp; cover letter</button>`
    }
    <div id="detail-msg" class="hint"></div>
  `);

  document.getElementById("close-modal").addEventListener("click", closeModal);
  attachFeedbackHandlers(modalRoot, { [job.id]: job }, () => openJobDetail(job.id));
  document.getElementById("save-status").addEventListener("click", async () => {
    await api(`/jobs/${job.id}/status`, { method: "POST", body: JSON.stringify({ status: document.getElementById("status-select").value }) });
    closeModal();
    route();
  });
  document.getElementById("save-notes").addEventListener("click", async () => {
    await api(`/jobs/${job.id}/status`, { method: "POST", body: JSON.stringify({ note: document.getElementById("notes").value }) });
    document.getElementById("detail-msg").textContent = "Notes saved.";
  });

  const findPostingBtn = document.getElementById("find-posting");
  if (findPostingBtn) {
    findPostingBtn.addEventListener("click", async () => {
      findPostingBtn.disabled = true;
      findPostingBtn.textContent = "Looking…";
      try {
        const result = await api(`/jobs/${job.id}/find-posting`, { method: "POST" });
        if (result.found) {
          openJobDetail(job.id);
        } else {
          document.getElementById("posting-details-msg").textContent =
            (result.reason || "Couldn't find it automatically.") + " Paste the link yourself below if you have it.";
          findPostingBtn.disabled = false;
          findPostingBtn.textContent = "Try to find the real posting automatically";
        }
      } catch (err) {
        document.getElementById("posting-details-msg").textContent = `Failed: ${err.message}`;
        findPostingBtn.disabled = false;
        findPostingBtn.textContent = "Try to find the real posting automatically";
      }
    });
  }
  document.getElementById("save-posting-details").addEventListener("click", async () => {
    const msg = document.getElementById("posting-details-msg");
    msg.textContent = "Saving…";
    try {
      await api(`/jobs/${job.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          url: document.getElementById("edit-url").value.trim(),
          description: document.getElementById("edit-description").value,
          location: document.getElementById("edit-location").value.trim(),
          salary: document.getElementById("edit-salary").value.trim(),
        }),
      });
      openJobDetail(job.id);
    } catch (err) {
      msg.textContent = `Couldn't save: ${err.message}`;
    }
  });

  const saveAnswerBtn = document.getElementById("save-review-answer");
  if (saveAnswerBtn) {
    saveAnswerBtn.addEventListener("click", async () => {
      const text = document.getElementById("review-answer").value.trim();
      const msg = document.getElementById("review-answer-msg");
      if (!text) {
        msg.textContent = "Add something first.";
        return;
      }
      saveAnswerBtn.disabled = true;
      saveAnswerBtn.textContent = "Saving…";
      try {
        const latest = (await api("/profile")) || {};
        const note = `Re: ${job.title} @ ${job.company}: ${text}`;
        const updatedBank = [latest.experienceBank, note].filter(Boolean).join("\n\n");
        await api("/profile", { method: "PUT", body: JSON.stringify({ ...latest, experienceBank: updatedBank }) });
        await api(`/jobs/${job.id}/generate-materials`, { method: "POST" });
        openJobDetail(job.id);
      } catch (err) {
        msg.textContent = `Couldn't save: ${err.message}`;
        saveAnswerBtn.disabled = false;
        saveAnswerBtn.textContent = "Save & regenerate materials";
      }
    });
  }

  const genBtn = document.getElementById("gen-materials") || document.getElementById("regen-materials");
  if (genBtn) {
    genBtn.addEventListener("click", async () => {
      const feedbackEl = document.getElementById("materials-feedback");
      const oldLabel = genBtn.textContent;
      genBtn.disabled = true;
      genBtn.textContent = "Generating…";
      try {
        // feedbackEl only exists on "Regenerate" (materials already exist) —
        // the first-time "Generate" button has nothing to give feedback on
        // yet, so it just generates plain. Sent even when empty so clearing
        // the box and regenerating actually clears the saved feedback too.
        await api(`/jobs/${job.id}/generate-materials`, {
          method: "POST",
          body: JSON.stringify(feedbackEl ? { feedback: feedbackEl.value } : {}),
        });
        openJobDetail(job.id);
      } catch (err) {
        document.getElementById("detail-msg").textContent = `Failed: ${err.message}`;
        genBtn.disabled = false;
        genBtn.textContent = oldLabel;
      }
    });
  }
  const autofillBtn = document.getElementById("autofill-btn");
  if (autofillBtn) {
    autofillBtn.addEventListener("click", async () => {
      autofillBtn.disabled = true;
      autofillBtn.textContent = "Working…";
      try {
        const result = await api(`/jobs/${job.id}/autofill`, { method: "POST" });
        document.getElementById("detail-msg").textContent = result.note || "Auto-fill attempted — review the opened browser window before submitting.";
      } catch (err) {
        document.getElementById("detail-msg").textContent = `Auto-fill unavailable: ${err.message}`;
      }
      autofillBtn.disabled = false;
      autofillBtn.textContent = "Attempt assisted auto-fill (beta)";
    });
  }
  document.querySelectorAll("[data-preview]").forEach((btn) => {
    btn.addEventListener("click", () => previewMaterial(btn.dataset.job, btn.dataset.preview));
  });
}

// Renders a generated CV/cover letter's content directly in a modal — a
// converted-to-HTML view of the same .docx bytes the "Download .docx" link
// serves (see server/routes/jobs.js's /preview endpoints), so you can check
// wording without downloading and opening a file first. Not pixel-identical
// to the real document — use "Download .docx" for the exact file you'd
// actually submit somewhere.
async function previewMaterial(jobId, kind) {
  const label = kind === "cv" ? "CV" : "Cover letter";
  openModal(`
    <span class="close-x" id="close-modal">&times;</span>
    <h3>${label} preview</h3>
    <div id="material-preview-body" class="material-preview">Loading…</div>
    <p class="hint">This is a plain-text-ish render for a quick read — the downloaded .docx has the real formatting.</p>
    <p><a href="/api/jobs/${jobId}/materials/${kind}" target="_blank">Download .docx</a></p>
  `, "modal-wide");
  document.getElementById("close-modal").addEventListener("click", closeModal);
  try {
    const { html } = await api(`/jobs/${jobId}/materials/${kind}/preview`);
    document.getElementById("material-preview-body").innerHTML = html;
  } catch (err) {
    document.getElementById("material-preview-body").innerHTML = `<p class="hint">Couldn't load preview: ${esc(err.message)}</p>`;
  }
}

// ---------- Settings ----------
async function renderSettings() {
  main.innerHTML = `<h2>Settings</h2><div id="settings-body">Loading…</div>`;
  const settings = await api("/settings");
  const isScheduled = settings.cadence && settings.cadence !== "manual";
  const frequency = isScheduled ? settings.cadence : "daily";
  const timeValue = `${String(settings.cadenceHourLocal ?? 7).padStart(2, "0")}:${String(settings.cadenceMinuteLocal ?? 0).padStart(2, "0")}`;
  const aiProvider = settings.aiProvider || "none";
  const emailInbox = settings.emailInbox || {};
  const AI_PROVIDER_INFO = {
    none: { placeholder: "", hint: "" },
    anthropic: { placeholder: "sk-ant-...", hint: "Paid — console.anthropic.com → API Keys.", model: "claude-sonnet-4-5" },
    groq: { placeholder: "gsk_...", hint: "Free, no card required — console.groq.com/keys.", model: "openai/gpt-oss-120b" },
    gemini: { placeholder: "AIza...", hint: "Free, no card required — aistudio.google.com/apikey. The web-search posting lookup specifically needs billing enabled on that Google account too (usage still lands inside Google's free daily grounding allowance at this app's volume) — everything else works on the plain free-tier key.", model: "gemini-2.5-flash" },
  };

  document.getElementById("settings-body").innerHTML = `
    <div class="card">
      <h3>Search &amp; automation</h3>
      <label>Cadence</label>
      <div class="radio-group">
        <label class="radio-option"><input type="radio" name="cadenceMode" value="manual" ${!isScheduled ? "checked" : ""} /> Manual — I'll run it myself</label>
        <label class="radio-option"><input type="radio" name="cadenceMode" value="scheduled" ${isScheduled ? "checked" : ""} /> At a set time</label>
      </div>
      <div id="cadence-scheduled-fields" style="display:${isScheduled ? "block" : "none"}; margin-top:10px;">
        <div class="form-row">
          <div>
            <label>Frequency</label>
            <select id="cadenceFrequency">
              <option value="daily" ${frequency === "daily" ? "selected" : ""}>Daily</option>
              <option value="every_2_3_days" ${frequency === "every_2_3_days" ? "selected" : ""}>Every 2-3 days</option>
              <option value="weekly" ${frequency === "weekly" ? "selected" : ""}>Weekly (Mondays)</option>
              <option value="custom" ${frequency === "custom" ? "selected" : ""}>Custom (cron)</option>
            </select>
          </div>
          <div>
            <label>Time</label>
            <input type="time" id="cadenceTime" value="${timeValue}" />
          </div>
        </div>
        <div id="custom-cron-field" style="display:${frequency === "custom" ? "block" : "none"}; margin-top:10px;">
          <label>Custom cron expression</label>
          <input type="text" id="customCron" value="${esc(settings.customCron || "")}" placeholder="0 7 * * *" />
        </div>
      </div>

      <label style="margin-top:16px;">Default submission mode</label>
      <select id="submissionMode">
        <option value="manual" ${settings.submissionMode === "manual" ? "selected" : ""}>Manual (I submit myself)</option>
        <option value="assisted" ${settings.submissionMode === "assisted" ? "selected" : ""}>Assisted auto-fill (beta, Greenhouse only)</option>
        <option value="ask_each_time" ${settings.submissionMode === "ask_each_time" ? "selected" : ""}>Ask each time</option>
      </select>

      <div style="margin-top:16px;"><button id="save-settings">Save settings</button><span id="settings-msg" class="hint"></span></div>
    </div>

    <p class="hint" style="margin: -8px 0 18px;">Your CV upload, experience bank, and job-search criteria profiles have moved to the <a href="#/me">Me</a> tab.</p>

    <details class="card advanced-settings" id="advanced-settings">
      <summary>Advanced settings</summary>

      <label>Minimum score to surface a match (0-100)</label>
      <input type="number" id="minScore" min="0" max="100" value="${settings.minScoreToSurface}" />
      <p class="hint">This is the overall score — the average of "You're a match" and "You'll like this" (each rated 0-100 internally, shown as X/10 elsewhere) — a job needs to actually get added when discovered; anything below is found but silently skipped. Each rating starts at a baseline of 30 and gains or loses points for real signals: a title/role keyword match is worth +35 (a clear mismatch is -35, so the wrong role drops fast), remote-friendly (if you're OK with remote) is +15, a location match is +15, plus smaller bonuses for sector/technology/company-size/priority matches and a big +20 for a followed company — so a job that's clearly the right title and workable location alone lands right around 55, with any additional fit signal pushing it higher, while a wrong-title job stays well below even if it's otherwise appealing (e.g. remote). A dealbreaker match zeroes both ratings outright regardless of anything else. If you're seeing too few matches, the fastest lever is lowering this number; the more precise fix is filling in more of the optional fields on your <a href="#/me">criteria profile</a> (favourite technologies, industries, followed companies) so genuinely good matches accumulate more bonus points instead of relying on title+remote alone.</p>

      <div class="form-row">
        <div>
          <label>Notifications</label>
          <select id="notifMode">
            ${["none","console","webhook"].map((m) => `<option value="${m}" ${m === settings.notifications.mode ? "selected" : ""}>${m}</option>`).join("")}
          </select>
        </div>
        <div>
          <label>Webhook URL (Slack/Discord/etc.)</label>
          <input type="text" id="webhookUrl" value="${esc(settings.notifications.webhookUrl || "")}" />
        </div>
      </div>

      <div class="section-title">Application materials</div>
      <label style="display:flex; align-items:center; gap:8px; font-weight:normal;">
        <input type="checkbox" id="autoGenerateMaterials" ${settings.autoGenerateMaterials !== false ? "checked" : ""} style="width:auto;" />
        Automatically generate a tailored CV &amp; cover letter for every match, saved against that job
      </label>
      <p class="hint">Turn this off to only generate materials when you hit "Approve" on a job instead.</p>
      <label>Max materials auto-generated per discovery run (cost guard)</label>
      <input type="number" id="maxMaterialsGeneratedPerCycle" min="0" value="${settings.maxMaterialsGeneratedPerCycle ?? 20}" />
      <p class="hint">If AI-assisted cover-letter drafting is on (see below), each generation is an API call — this caps spend per run. Anything skipped by the cap can still be generated manually from the job's detail view.</p>

      <div class="section-title">Optional: AI-assisted scoring, drafting &amp; posting lookup</div>
      <p class="hint">Powers the "AI preferences" free-text box on each criteria profile, more natural cover-letter drafting, CV auto-fill, the CV tailoring summary, email-digest job extraction, and — for Anthropic or Gemini specifically — a real web search to find a job's actual posting page when the free ATS lookup can't (see "Automatic posting resolution" in the README). This is a completely separate thing from this chat: your app runs on Railway with no connection to any Claude conversation, so it needs its own API key here to make its own calls — pasting a key below doesn't use up or relate to anything in this chat, and vice versa. Leave provider as "None" to use plain rule-based scoring and template drafting instead — everything except the web-search posting lookup still works fully without this. One provider is all you need for everything on this page, including the posting lookup — Gemini's plain free tier plus billing enabled for search (still effectively free at this app's volume) covers the same ground Anthropic's paid key does; Groq doesn't support the web-search posting lookup at all.</p>
      <label>AI provider</label>
      <select id="aiProvider">
        ${["none","groq","gemini","anthropic"].map((p) => `<option value="${p}" ${p === aiProvider ? "selected" : ""}>${p === "none" ? "None" : p === "anthropic" ? "Anthropic (Claude) — paid" : p === "groq" ? "Groq — free" : "Google Gemini — free"}</option>`).join("")}
      </select>
      <div id="ai-provider-fields" style="display:${aiProvider === "none" ? "none" : "block"};">
        <label>API key</label>
        <input type="password" id="aiApiKey" value="${settings.aiApiKey ? "••••••••" : ""}" placeholder="${AI_PROVIDER_INFO[aiProvider].placeholder}" />
        <p class="hint" id="ai-provider-hint">${AI_PROVIDER_INFO[aiProvider].hint}</p>
        <label>Model (leave blank for the default)</label>
        <input type="text" id="aiModel" value="${esc(settings.aiModel || "")}" placeholder="${AI_PROVIDER_INFO[aiProvider].model || ""}" />
        <div id="ai-provider-health" style="margin:8px 0 4px;">${aiHealthHtml(settings.aiProviderHealth)}</div>
        <div><button type="button" id="test-ai-connection" class="secondary">Test connection</button></div>
      </div>
      <label>Max AI-scored jobs per discovery run (cost guard)</label>
      <input type="number" id="maxAiScoredPerCycle" min="0" value="${settings.maxAiScoredPerCycle ?? 15}" />

      <label>Max AI web-search posting lookups per startup pass (cost guard, Anthropic or Gemini only)</label>
      <input type="number" id="maxAiPostingSearchesPerCycle" min="0" value="${settings.maxAiPostingSearchesPerCycle ?? 10}" />
      <p class="hint">When "Find posting" (automatic or the on-demand button) can't find a match on Greenhouse/Lever/Ashby/Recruitee, and your AI provider above is Anthropic or Gemini, it falls back to a real, grounded web search to find the actual posting instead of guessing — see "Automatic posting resolution" in the README. Both providers bill grounded search separately from normal usage, so this caps how many of those happen in one startup backfill pass over old jobs; the manual-add and per-job "Find posting" button aren't capped since they're one job at a time. Groq doesn't support this fallback.</p>

      <label>Cover letter instructions for the AI</label>
      <textarea id="coverLetterInstructions" placeholder="e.g. keep it under 200 words; lead with enthusiasm for the mission before the skills match; slightly more formal tone for corporate/enterprise companies">${esc(settings.coverLetterInstructions || "")}</textarea>
      <p class="hint">Free text — tone, length, structure, whatever preferences you want the AI-assisted cover letter drafter (see "Optional: AI-assisted scoring &amp; cover letter drafting" above) to keep in mind for every letter it writes. Only used when an AI provider is configured above; template mode (no provider) ignores it. This is separate from the "Experience bank" on the <a href="#/me">Me</a> tab, which is source material, not instructions.</p>

      <div class="section-title">Optional: Job-alert email import</div>
      <p class="hint">None of the big job sites (LinkedIn, Indeed, and others) offer a free public jobs API, and scraping any of them breaks their terms of service, so this app never touches any job site directly. Instead, it can read job-alert emails from an inbox you connect below — LinkedIn's, Indeed's, Welcome to the Jungle's, Wellfound's, or any other job site that emails you listings — and try to resolve each one to the employer's own posting (falling back to the original link from the email when it can't). Needs a Gmail-style <strong>App password</strong> (Google Account &rarr; Security &rarr; App passwords) — not your real password. One inbox + one app password covers every site you add below.</p>
      <label style="display:flex; align-items:center; gap:8px; font-weight:normal;">
        <input type="checkbox" id="emailInboxEnabled" ${emailInbox.enabled ? "checked" : ""} style="width:auto;" />
        Import job-alert emails from a connected inbox
      </label>
      <div id="email-inbox-health" style="margin:8px 0 4px;">${emailHealthHtml(settings.emailInboxHealth)}</div>
      <div class="form-row">
        <div>
          <label>Email address</label>
          <input type="text" id="emailInboxUser" value="${esc(emailInbox.user || "")}" placeholder="you@gmail.com" />
        </div>
        <div>
          <label>App password</label>
          <input type="password" id="emailInboxAppPassword" value="${emailInbox.appPassword ? "••••••••" : ""}" placeholder="16-character app password" />
        </div>
      </div>
      <div class="form-row">
        <div>
          <label>IMAP host</label>
          <input type="text" id="emailInboxHost" value="${esc(emailInbox.host || "imap.gmail.com")}" />
        </div>
        <div>
          <label>Job sites to watch for (comma-separated senders/domains)</label>
          <input type="text" id="emailInboxSender" value="${esc(emailInbox.senderFilter || "linkedin.com")}" placeholder="linkedin.com, indeed.com, welcometothejungle.com" />
        </div>
      </div>
      <p class="hint">Add every job site you get alert/digest emails from here, comma-separated — e.g. "linkedin.com, indeed.com, welcometothejungle.com, wellfound.com". A whole domain like "linkedin.com" is a catch-all for every kind of alert email that site sends; anything fetched that turns out not to actually contain a job listing is skipped for free, so it's safe to leave broad rather than guessing exact sender addresses. Not sure what else to add? <button type="button" id="scan-inbox-senders" class="link-btn">🔍 Scan my inbox for job sites</button> — looks through your recent mail for likely candidates and lets you confirm or dismiss each one before anything's added.</p>
      <div style="margin-top:10px;"><button type="button" id="test-email-inbox" class="secondary">Test connection</button></div>

      <div style="margin-top:16px;"><button id="save-settings-advanced">Save settings</button><span id="settings-msg-advanced" class="hint"></span></div>
    </details>
  `;

  const cadenceModeRadios = document.querySelectorAll('input[name="cadenceMode"]');
  const scheduledFields = document.getElementById("cadence-scheduled-fields");
  cadenceModeRadios.forEach((r) =>
    r.addEventListener("change", () => {
      scheduledFields.style.display = document.querySelector('input[name="cadenceMode"]:checked').value === "scheduled" ? "block" : "none";
    })
  );
  document.getElementById("cadenceFrequency").addEventListener("change", (e) => {
    document.getElementById("custom-cron-field").style.display = e.target.value === "custom" ? "block" : "none";
  });

  document.getElementById("aiProvider").addEventListener("change", (e) => {
    const p = e.target.value;
    document.getElementById("ai-provider-fields").style.display = p === "none" ? "none" : "block";
    const info = AI_PROVIDER_INFO[p];
    document.getElementById("aiApiKey").placeholder = info.placeholder;
    document.getElementById("aiModel").placeholder = info.model || "";
    document.getElementById("ai-provider-hint").textContent = info.hint;
  });

  function collectSettingsPayload() {
    const cadenceMode = document.querySelector('input[name="cadenceMode"]:checked').value;
    const [h, m] = document.getElementById("cadenceTime").value.split(":").map(Number);
    return {
      cadence: cadenceMode === "manual" ? "manual" : document.getElementById("cadenceFrequency").value,
      cadenceHourLocal: Number.isInteger(h) ? h : 7,
      cadenceMinuteLocal: Number.isInteger(m) ? m : 0,
      customCron: document.getElementById("customCron").value,
      minScoreToSurface: Number(document.getElementById("minScore").value),
      notifications: { mode: document.getElementById("notifMode").value, webhookUrl: document.getElementById("webhookUrl").value },
      submissionMode: document.getElementById("submissionMode").value,
      autoGenerateMaterials: document.getElementById("autoGenerateMaterials").checked,
      maxMaterialsGeneratedPerCycle: Number(document.getElementById("maxMaterialsGeneratedPerCycle").value),
      aiProvider: document.getElementById("aiProvider").value,
      aiApiKey: document.getElementById("aiApiKey").value,
      aiModel: document.getElementById("aiModel").value,
      maxAiScoredPerCycle: Number(document.getElementById("maxAiScoredPerCycle").value),
      maxAiPostingSearchesPerCycle: Number(document.getElementById("maxAiPostingSearchesPerCycle").value),
      coverLetterInstructions: document.getElementById("coverLetterInstructions").value,
      emailInbox: {
        enabled: document.getElementById("emailInboxEnabled").checked,
        user: document.getElementById("emailInboxUser").value.trim(),
        appPassword: document.getElementById("emailInboxAppPassword").value,
        host: document.getElementById("emailInboxHost").value.trim() || "imap.gmail.com",
        port: 993,
        secure: true,
        folder: "INBOX",
        senderFilter: document.getElementById("emailInboxSender").value.trim() || "linkedin.com",
      },
    };
  }

  async function saveSettings(msgEl) {
    await api("/settings", { method: "PUT", body: JSON.stringify(collectSettingsPayload()) });
    msgEl.textContent = "Saved.";
  }
  document.getElementById("save-settings").addEventListener("click", () => saveSettings(document.getElementById("settings-msg")));
  document.getElementById("save-settings-advanced").addEventListener("click", () => saveSettings(document.getElementById("settings-msg-advanced")));

  // Tests against whatever's currently typed in the form, not just the last
  // saved values, so you can verify credentials before hitting Save. If the
  // app-password field still shows the masked placeholder (untouched since
  // last save), the server tests with the real saved password instead.
  document.getElementById("test-email-inbox").addEventListener("click", async () => {
    const btn = document.getElementById("test-email-inbox");
    const target = document.getElementById("email-inbox-health");
    btn.disabled = true;
    btn.textContent = "Testing…";
    try {
      const result = await api("/settings/email-inbox/test", {
        method: "POST",
        body: JSON.stringify({
          emailInbox: {
            user: document.getElementById("emailInboxUser").value.trim(),
            appPassword: document.getElementById("emailInboxAppPassword").value,
            host: document.getElementById("emailInboxHost").value.trim() || "imap.gmail.com",
            senderFilter: document.getElementById("emailInboxSender").value.trim() || "linkedin.com",
          },
        }),
      });
      target.innerHTML = emailHealthHtml(
        result.ok
          ? { status: "ok", checkedAt: new Date().toISOString(), source: "manual_test" }
          : { status: "error", checkedAt: new Date().toISOString(), error: result.error }
      );
    } catch (err) {
      target.innerHTML = emailHealthHtml({ status: "error", checkedAt: new Date().toISOString(), error: err.message });
    }
    btn.disabled = false;
    btn.textContent = "Test connection";
  });

  // Same idea, for the AI provider — one small real request against
  // whatever's currently typed in (falling back to the saved key if the
  // field still shows the masked placeholder), so a bad key shows up here
  // instead of silently failing the next time scoring/drafting/posting
  // search tries to use it.
  document.getElementById("test-ai-connection").addEventListener("click", async () => {
    const btn = document.getElementById("test-ai-connection");
    const target = document.getElementById("ai-provider-health");
    btn.disabled = true;
    btn.textContent = "Testing…";
    try {
      const result = await api("/settings/ai/test", {
        method: "POST",
        body: JSON.stringify({
          aiProvider: document.getElementById("aiProvider").value,
          aiApiKey: document.getElementById("aiApiKey").value,
          aiModel: document.getElementById("aiModel").value,
        }),
      });
      target.innerHTML = aiHealthHtml(
        result.ok
          ? { status: "ok", checkedAt: new Date().toISOString() }
          : { status: "error", checkedAt: new Date().toISOString(), error: result.error }
      );
    } catch (err) {
      target.innerHTML = aiHealthHtml({ status: "error", checkedAt: new Date().toISOString(), error: err.message });
    }
    btn.disabled = false;
    btn.textContent = "Test connection";
  });

  // Scans recent inbox mail for sender domains that look like job alerts
  // you haven't added yet (see server/email/inbox.js's suggestSenderDomains
  // for the heuristic and its limits — subject-line wording only, so it's
  // a starting point to confirm/dismiss, not a guarantee). Nothing gets
  // added to the sender list without you explicitly checking it here.
  document.getElementById("scan-inbox-senders").addEventListener("click", async () => {
    const btn = document.getElementById("scan-inbox-senders");
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "🔍 Scanning your inbox…";
    try {
      const result = await api("/settings/email-inbox/suggest-domains", {
        method: "POST",
        body: JSON.stringify({
          emailInbox: {
            user: document.getElementById("emailInboxUser").value.trim(),
            appPassword: document.getElementById("emailInboxAppPassword").value,
            host: document.getElementById("emailInboxHost").value.trim() || "imap.gmail.com",
            senderFilter: document.getElementById("emailInboxSender").value.trim() || "linkedin.com",
          },
        }),
      });
      if (!result.ok) {
        showMessageModal("Couldn't scan your inbox", `
          <p>${esc(result.error)}</p>
          <p class="hint">Double-check the email address, app password, and host fields just above, then try again.</p>
        `);
      } else if (!result.candidates.length) {
        showMessageModal("Nothing new found", `
          <p>Scanned ${result.scanned} recent email(s) — nothing that looked like a new job-alert sender turned up. You're probably already watching everything relevant.</p>
        `);
      } else {
        openSenderSuggestionsModal(result.candidates, result.scanned, result.aiFiltered);
      }
    } catch (err) {
      showMessageModal("Couldn't scan your inbox", `
        <p>${esc(err.message)}</p>
        <p class="hint">Double-check the email address, app password, and host fields just above, then try again.</p>
      `);
    }
    btn.disabled = false;
    btn.textContent = originalText;
  });
}

// Lets you confirm or dismiss each domain server/email/inbox.js's
// suggestSenderDomains flagged as a likely job-alert sender you're not
// already watching. Checking boxes and hitting "Add checked domains" just
// updates the sender-filter text field on the Settings page underneath —
// you still need to hit "Save settings" there to persist it, same as any
// other field on that page.
function openSenderSuggestionsModal(candidates, scanned, aiFiltered) {
  openModal(`
    <span class="close-x" id="close-modal">&times;</span>
    <h3>Job-alert senders found in your inbox</h3>
    <p class="hint">Scanned ${scanned} recent email(s). ${
      aiFiltered
        ? "✨ AI-filtered to weed out marketing/newsletter noise — still worth a quick look before adding."
        : "Matched on subject wording only (no AI provider configured, so this list is noisier — set one up in Settings above for smarter filtering)."
    } Check the ones that are actually job alerts — anything unchecked is left alone.</p>
    <div class="sender-suggestion-list">
      ${candidates
        .map(
          (c, i) => `
        <label class="sender-suggestion-row">
          <input type="checkbox" id="sender-cand-${i}" data-domain="${esc(c.domain)}" checked />
          <div>
            <strong>${esc(c.domain)}</strong> <span class="hint">— ${c.count} email${c.count === 1 ? "" : "s"}</span>
            ${c.examples && c.examples.length ? `<div class="hint">e.g. "${esc(c.examples[0])}"</div>` : ""}
          </div>
        </label>`
        )
        .join("")}
    </div>
    <div style="margin-top:14px;"><button id="add-sender-suggestions">Add checked domains</button> <span id="sender-suggestions-msg" class="hint"></span></div>
  `, "modal-wide");
  document.getElementById("close-modal").addEventListener("click", closeModal);
  document.getElementById("add-sender-suggestions").addEventListener("click", () => {
    const chosen = candidates
      .map((c, i) => (document.getElementById(`sender-cand-${i}`).checked ? c.domain : null))
      .filter(Boolean);
    if (!chosen.length) {
      document.getElementById("sender-suggestions-msg").textContent = "Nothing checked — nothing added.";
      return;
    }
    const field = document.getElementById("emailInboxSender");
    const existing = field.value
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const merged = [...new Set([...existing, ...chosen])];
    field.value = merged.join(", ");
    closeModal();
    field.scrollIntoView({ behavior: "smooth", block: "center" });
    field.focus();
  });
}

// ---------- Me (candidate profile: CV, experience bank, criteria) ----------
// Everything that describes *you* — as opposed to Settings, which is about
// how the automation runs — lives here: your baseline CV file, the
// experience-bank scratchpad the AI draws examples from, your job-search
// criteria profiles, and the full CV data as JSON.
async function renderMe() {
  main.innerHTML = `<h2>Me</h2><div id="me-body">Loading…</div>`;
  const [settings, profile, criteria, cvUpload] = await Promise.all([
    api("/settings"),
    api("/profile"),
    api("/criteria"),
    api("/profile/cv-upload"),
  ]);
  const aiConfigured = Boolean(settings.aiProvider && settings.aiProvider !== "none" && settings.aiApiKey);

  document.getElementById("me-body").innerHTML = `
    <div class="card cv-card">
      <h3>Baseline CV file</h3>
      <p class="hint">Upload your CV (PDF or Word/.docx). This is what your profile gets auto-filled from, and what every tailored CV/cover letter is generated relative to.</p>
      ${
        cvUpload
          ? `
        <div class="cv-file-row">
          <div class="cv-file-icon">📄</div>
          <div class="cv-file-info">
            <div class="cv-file-name">${esc(cvUpload.originalFilename)}</div>
            <div class="hint">Uploaded ${fmtDate(cvUpload.uploadedAt)}</div>
          </div>
          <div class="cv-file-actions">
            ${
              cvUpload.mimetype === "application/pdf"
                ? `<a class="btn-pill" href="/api/profile/cv-upload/view" target="_blank">View</a>`
                : `<button class="btn-pill" id="preview-cv-btn">View</button>`
            }
            <a class="btn-pill" href="/api/profile/cv-upload/download" target="_blank">Download</a>
            <a class="btn-pill danger" href="#" id="remove-cv">Remove</a>
          </div>
        </div>
        ${
          cvUpload.mimetype === "application/pdf"
            ? `<iframe src="/api/profile/cv-upload/view" style="width:100%; height:420px; border:1px solid var(--border); border-radius:8px; margin-top:14px;"></iframe>`
            : ""
        }
        <div class="cv-autofill-row">
          <button id="import-from-cv" ${aiConfigured ? "" : "disabled"}>✨ Auto-fill profile from this CV (AI)</button>
          ${aiConfigured ? "" : `<span class="hint">Add an AI provider + API key under Settings → Advanced to enable this (a free one works fine).</span>`}
        </div>`
          : `<div class="cv-empty">
          <div class="cv-empty-icon">📄</div>
          <p>No CV uploaded yet — add one below to get started.</p>
        </div>`
      }
      <div class="cv-upload-row">
        <input type="file" id="cv-file-input" accept=".pdf,.docx" />
        <button id="upload-cv" class="secondary">${cvUpload ? "Replace file" : "Upload"}</button>
        <span id="cv-upload-msg" class="hint"></span>
      </div>
    </div>

    <div class="card">
      <h3>Experience bank</h3>
      <label style="margin-top:0;">A running scratchpad of extra examples</label>
      <textarea id="experience-bank" style="min-height:140px;" placeholder="A running scratchpad — paste in extra achievements, projects, stats, or stories as you think of them, even ones that aren't on your CV yet. Doesn't need to be tidy. The AI can pull specific, concrete examples from here when tailoring a CV or cover letter for a job that calls for something your structured CV entries don't cover.">${esc(
        (profile && profile.experienceBank) || ""
      )}</textarea>
      <p class="hint">Free text, keep adding to it over time — it's a pool of extra true examples for the AI to draw on (only used when an AI provider is configured in Settings → Advanced), not something that gets used word-for-word automatically. Saved separately from the JSON profile below, so you don't need to touch that to update this.</p>
      <div style="margin-top:8px;"><button id="save-experience-bank" class="secondary">Save experience bank</button><span id="experience-bank-msg" class="hint"></span></div>
    </div>

    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3>Criteria profiles</h3>
        <button id="add-criteria">+ Add profile</button>
      </div>
      <div id="criteria-list">${criteria.map(criteriaRowHtml).join("") || emptyStateHtml("🎯", "No criteria profiles yet", `Click "+ Add profile" above to start discovering jobs automatically.`)}</div>
    </div>

    <details class="card advanced-settings" id="profile-json-details">
      <summary>Candidate profile (full JSON)</summary>
      <p class="hint">The rest of your profile is edited as JSON for now — see README for the shape (name, headline, summary, skills, experience, education, additional, talkingPoints, houseRules). A friendlier form editor is on the roadmap. Use "Auto-fill profile from this CV" above to draft this from your uploaded CV instead of typing it by hand.</p>
      <textarea id="profile-json" style="min-height:260px; font-family: monospace; font-size:12px;">${esc(JSON.stringify(profile, null, 2))}</textarea>
      <div style="margin-top:8px; display:flex; justify-content:flex-end; align-items:center; gap:10px;"><span id="profile-msg" class="hint"></span><button id="save-profile">Save CV JSON</button></div>
    </details>
  `;

  document.getElementById("save-profile").addEventListener("click", async () => {
    const msg = document.getElementById("profile-msg");
    try {
      const parsed = JSON.parse(document.getElementById("profile-json").value);
      await api("/profile", { method: "PUT", body: JSON.stringify(parsed) });
      msg.textContent = "Saved.";
    } catch (e) {
      msg.textContent = `Invalid JSON: ${e.message}`;
    }
  });

  document.getElementById("save-experience-bank").addEventListener("click", async () => {
    const msg = document.getElementById("experience-bank-msg");
    try {
      // Re-fetch first rather than trusting the JSON textarea's current
      // (possibly hand-edited, unsaved) contents — this button should only
      // ever touch experienceBank, never clobber other profile fields.
      const latest = (await api("/profile")) || {};
      const updated = { ...latest, experienceBank: document.getElementById("experience-bank").value };
      await api("/profile", { method: "PUT", body: JSON.stringify(updated) });
      document.getElementById("profile-json").value = JSON.stringify(updated, null, 2);
      msg.textContent = "Saved.";
    } catch (e) {
      msg.textContent = `Couldn't save: ${e.message}`;
    }
  });

  document.getElementById("add-criteria").addEventListener("click", () => openCriteriaEditor(null));
  attachCriteriaHandlers();

  document.getElementById("upload-cv").addEventListener("click", async () => {
    const input = document.getElementById("cv-file-input");
    const msg = document.getElementById("cv-upload-msg");
    if (!input.files.length) {
      msg.textContent = "Choose a file first.";
      return;
    }
    const fd = new FormData();
    fd.append("file", input.files[0]);
    msg.textContent = "Uploading…";
    try {
      await apiUpload("/profile/cv-upload", fd);
      renderMe();
    } catch (err) {
      msg.textContent = `Upload failed: ${err.message}`;
    }
  });

  const previewCvBtn = document.getElementById("preview-cv-btn");
  if (previewCvBtn) {
    // Word files have no native in-browser viewer, so the plain "View" link
    // used for PDFs just makes the browser download the file — looked
    // exactly like "View" was broken. This renders the same bytes as HTML
    // (via server/routes/profile.js's mammoth-based /cv-upload/preview) in
    // a modal instead, same pattern as the generated CV/cover-letter
    // preview in the job detail view.
    previewCvBtn.addEventListener("click", async () => {
      openModal(`
        <span class="close-x" id="close-modal">&times;</span>
        <h3>${esc(cvUpload.originalFilename)}</h3>
        <div id="cv-preview-body" class="material-preview">Loading…</div>
        <p class="hint">This is a plain-text-ish render for a quick read — download the file for the real formatting.</p>
      `);
      document.getElementById("close-modal").addEventListener("click", closeModal);
      try {
        const { html } = await api("/profile/cv-upload/preview");
        document.getElementById("cv-preview-body").innerHTML = html;
      } catch (err) {
        document.getElementById("cv-preview-body").innerHTML = `<p class="hint">Couldn't load preview: ${esc(err.message)}</p>`;
      }
    });
  }

  const removeCvLink = document.getElementById("remove-cv");
  if (removeCvLink) {
    removeCvLink.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!confirm("Remove your uploaded CV file?")) return;
      await api("/profile/cv-upload", { method: "DELETE" });
      renderMe();
    });
  }

  const importBtn = document.getElementById("import-from-cv");
  if (importBtn) {
    importBtn.addEventListener("click", async () => {
      importBtn.disabled = true;
      importBtn.textContent = "Reading your CV…";
      const msg = document.getElementById("cv-upload-msg");
      try {
        const draft = await api("/profile/import-from-cv", { method: "POST" });
        document.getElementById("profile-json").value = JSON.stringify(draft, null, 2);
        document.getElementById("profile-json-details").open = true;
        msg.textContent = 'Draft imported into the "Candidate profile (full JSON)" section below — expand it, review the draft, then hit "Save CV JSON" to apply it.';
        document.getElementById("profile-json").scrollIntoView({ behavior: "smooth" });
      } catch (err) {
        msg.textContent = `Import failed: ${err.message}`;
      }
      importBtn.disabled = false;
      importBtn.textContent = "✨ Auto-fill profile from this CV (AI)";
    });
  }
}

// Back-compat display helper, mirrors server/scoring.js's
// getWorkArrangements — a profile saved before the multiselect existed
// only has the old boolean remoteOk, not workArrangements.
function workArrangementsOf(c) {
  if (Array.isArray(c.workArrangements)) return c.workArrangements;
  return c.remoteOk === false ? ["hybrid", "office"] : ["remote", "hybrid", "office"];
}

function criteriaRowHtml(c) {
  const isActive = c.active !== false;
  const arrangements = workArrangementsOf(c);
  const arrangementLabel =
    arrangements.length === 3 ? "remote/hybrid/office" : arrangements.length ? arrangements.join("/") : "no arrangement set";
  return `
    <div class="list-item">
      <h4>${esc(c.name || "(unnamed profile)")} ${isActive ? "" : '<span class="badge withdrawn">inactive</span>'}</h4>
      <div class="meta">Titles: ${esc((c.titleKeywords || []).join(", ") || "—")} · Locations: ${esc((c.locations || []).join(", ") || "—")} · ${esc(arrangementLabel)}</div>
      ${c.aiPreferences ? `<div class="meta">AI preferences: "${esc(c.aiPreferences.slice(0, 140))}${c.aiPreferences.length > 140 ? "…" : ""}"</div>` : ""}
      <button class="secondary" data-toggle-criteria="${c.id}" data-active="${isActive}">${isActive ? "Deactivate" : "Activate"}</button>
      <button class="secondary" data-edit-criteria="${c.id}">Edit</button>
      <button class="danger" data-delete-criteria="${c.id}">Delete</button>
    </div>
  `;
}

function attachCriteriaHandlers() {
  document.querySelectorAll("[data-edit-criteria]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const criteria = await api("/criteria");
      openCriteriaEditor(criteria.find((c) => c.id === btn.dataset.editCriteria));
    })
  );
  // Quick on/off without opening the full editor — discovery only ever
  // searches active profiles (see server/discovery.js), so this is the
  // fastest way to pause/resume one without losing its settings.
  document.querySelectorAll("[data-toggle-criteria]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const isActive = btn.dataset.active === "true";
      await api(`/criteria/${btn.dataset.toggleCriteria}`, { method: "PUT", body: JSON.stringify({ active: !isActive }) });
      renderMe();
    })
  );
  document.querySelectorAll("[data-delete-criteria]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this criteria profile?")) return;
      await api(`/criteria/${btn.dataset.deleteCriteria}`, { method: "DELETE" });
      renderMe();
    })
  );
}

function csv(arr) {
  return (arr || []).join(", ");
}
function fromCsv(str) {
  return str.split(",").map((s) => s.trim()).filter(Boolean);
}

function openCriteriaEditor(c) {
  const isNew = !c;
  c = c || {
    titleKeywords: [], excludeKeywords: [], locations: [], remoteLocations: [], languages: [],
    roleTypes: [], seniority: [], rolePriorities: [], sectorsInclude: [], sectorsExclude: [],
    favouriteTechnologies: [], hiddenTechnologies: [], companySizes: [], followedCompanies: [],
    dealbreakers: [], aiPreferences: "", sources: {}, workArrangements: ["remote", "hybrid", "office"],
  };
  const arrangements = workArrangementsOf(c);
  const gh = (c.sources && c.sources.greenhouse) || { enabled: false, companies: [] };
  const lv = (c.sources && c.sources.lever) || { enabled: false, companies: [] };
  openModal(`
    <span class="close-x" id="close-modal">&times;</span>
    <h3>${isNew ? "New" : "Edit"} criteria profile</h3>
    <label>Name</label>
    <input type="text" id="c-name" value="${esc(c.name || "")}" placeholder="e.g. Senior PM roles" />
    <label><input type="checkbox" id="c-active" ${c.active !== false ? "checked" : ""} style="width:auto; display:inline;" /> Active</label>

    <div class="section-title">Location</div>
    <div class="form-row">
      <div><label>Locations (comma-separated cities/countries you'd work in)</label><input type="text" id="c-locations" value="${esc(csv(c.locations))}" /></div>
      <div>
        <label>Work arrangement</label>
        <div class="checkbox-multiselect">
          <label><input type="checkbox" id="c-arrangement-remote" ${arrangements.includes("remote") ? "checked" : ""} style="width:auto; display:inline;" /> Remote</label>
          <label><input type="checkbox" id="c-arrangement-hybrid" ${arrangements.includes("hybrid") ? "checked" : ""} style="width:auto; display:inline;" /> Hybrid</label>
          <label><input type="checkbox" id="c-arrangement-office" ${arrangements.includes("office") ? "checked" : ""} style="width:auto; display:inline;" /> Office</label>
        </div>
        <p class="hint">Uncheck "Remote" if you'd rule out fully-remote roles; uncheck both "Hybrid" and "Office" if you only want fully-remote. Job postings don't distinguish hybrid from office-based, so those two are always scored the same way — this is just about which you're each open to.</p>
      </div>
    </div>
    <label>Remote locations (regions you can work remotely from/for, e.g. UK, EU, Worldwide)</label>
    <input type="text" id="c-remote-locations" value="${esc(csv(c.remoteLocations))}" />
    <label><input type="checkbox" id="c-visa" ${c.visaSponsorshipRequired ? "checked" : ""} style="width:auto; display:inline;" /> I require visa sponsorship</label>
    <label>Languages (comma-separated)</label>
    <input type="text" id="c-languages" value="${esc(csv(c.languages))}" />

    <div class="section-title">Role</div>
    <label>Title/role keywords (matched against posting title)</label>
    <input type="text" id="c-titles" value="${esc(csv(c.titleKeywords))}" placeholder="Senior Product Manager, Product Lead" />
    <label>Type of role (comma-separated, e.g. Full-time, Contract, Freelance)</label>
    <input type="text" id="c-role-types" value="${esc(csv(c.roleTypes))}" />
    <label>Level of role (comma-separated, e.g. Senior, Staff, Lead)</label>
    <input type="text" id="c-seniority" value="${esc(csv(c.seniority))}" />
    <label>Minimum salary (number, optional — only used as a soft signal since postings rarely list one cleanly)</label>
    <input type="number" id="c-min-salary" value="${c.minSalary ?? ""}" />
    <label>Role priorities (comma-separated things you care about, e.g. async, 4-day week, fast-growing)</label>
    <input type="text" id="c-priorities" value="${esc(csv(c.rolePriorities))}" />
    <label>Exclude keywords (soft — penalizes but doesn't hard-exclude)</label>
    <input type="text" id="c-exclude" value="${esc(csv(c.excludeKeywords))}" />
    <label>Dealbreakers (hard exclude — any match drops the job entirely)</label>
    <input type="text" id="c-dealbreakers" value="${esc(csv(c.dealbreakers))}" />

    <div class="section-title">Industries</div>
    <div class="form-row">
      <div><label>Favourite industries</label><input type="text" id="c-sector-in" value="${esc(csv(c.sectorsInclude))}" /></div>
      <div><label>Hidden industries</label><input type="text" id="c-sector-out" value="${esc(csv(c.sectorsExclude))}" /></div>
    </div>

    <div class="section-title">Technologies</div>
    <div class="form-row">
      <div><label>Favourite technologies</label><input type="text" id="c-tech-in" value="${esc(csv(c.favouriteTechnologies))}" /></div>
      <div><label>Hidden technologies</label><input type="text" id="c-tech-out" value="${esc(csv(c.hiddenTechnologies))}" /></div>
    </div>

    <div class="section-title">Company</div>
    <label>Company size (comma-separated, e.g. Startup, Scale-up, Enterprise)</label>
    <input type="text" id="c-company-size" value="${esc(csv(c.companySizes))}" />
    <label>Followed companies (comma-separated — a match here is a strong positive signal)</label>
    <input type="text" id="c-followed" value="${esc(csv(c.followedCompanies))}" />

    <div class="section-title">AI preferences</div>
    <p class="hint">Describe what you're looking for in your own words — culture, pace, red flags, anything the structured fields above can't capture. If you've set an AI provider + API key in Advanced settings, this gets sent alongside each promising match for a smarter fit judgement, blended with the rule-based score.</p>
    <textarea id="c-ai-prefs" style="min-height:90px;" placeholder="e.g. I want a fast-moving, engineering-led team, ideally Series B+. Avoid heavily bureaucratic or matrixed organisations. Bonus if the role involves AI-native products.">${esc(c.aiPreferences || "")}</textarea>

    <div class="section-title">Sources</div>
    <label><input type="checkbox" id="src-remotive" ${c.sources && c.sources.remotive !== false ? "checked" : ""} style="width:auto; display:inline;" /> Remotive</label>
    <label><input type="checkbox" id="src-arbeitnow" ${c.sources && c.sources.arbeitnow !== false ? "checked" : ""} style="width:auto; display:inline;" /> Arbeitnow</label>
    <label><input type="checkbox" id="src-remoteok" ${c.sources && c.sources.remoteok !== false ? "checked" : ""} style="width:auto; display:inline;" /> RemoteOK</label>
    <label><input type="checkbox" id="src-gh" ${gh.enabled ? "checked" : ""} style="width:auto; display:inline;" /> Greenhouse (specific companies)</label>
    <input type="text" id="src-gh-companies" value="${esc(csv(gh.companies))}" placeholder="board tokens, comma-separated e.g. airbnb, stripe" />
    <label><input type="checkbox" id="src-lever" ${lv.enabled ? "checked" : ""} style="width:auto; display:inline;" /> Lever (specific companies)</label>
    <input type="text" id="src-lever-companies" value="${esc(csv(lv.companies))}" placeholder="company slugs, comma-separated" />

    <div style="margin-top:16px;"><button id="save-criteria">Save</button></div>
  `);
  document.getElementById("close-modal").addEventListener("click", closeModal);
  document.getElementById("save-criteria").addEventListener("click", async () => {
    const minSalaryVal = document.getElementById("c-min-salary").value;
    const payload = {
      name: document.getElementById("c-name").value,
      active: document.getElementById("c-active").checked,
      locations: fromCsv(document.getElementById("c-locations").value),
      workArrangements: ["remote", "hybrid", "office"].filter(
        (a) => document.getElementById(`c-arrangement-${a}`).checked
      ),
      remoteLocations: fromCsv(document.getElementById("c-remote-locations").value),
      visaSponsorshipRequired: document.getElementById("c-visa").checked,
      languages: fromCsv(document.getElementById("c-languages").value),
      titleKeywords: fromCsv(document.getElementById("c-titles").value),
      roleTypes: fromCsv(document.getElementById("c-role-types").value),
      seniority: fromCsv(document.getElementById("c-seniority").value),
      minSalary: minSalaryVal ? Number(minSalaryVal) : null,
      rolePriorities: fromCsv(document.getElementById("c-priorities").value),
      excludeKeywords: fromCsv(document.getElementById("c-exclude").value),
      dealbreakers: fromCsv(document.getElementById("c-dealbreakers").value),
      sectorsInclude: fromCsv(document.getElementById("c-sector-in").value),
      sectorsExclude: fromCsv(document.getElementById("c-sector-out").value),
      favouriteTechnologies: fromCsv(document.getElementById("c-tech-in").value),
      hiddenTechnologies: fromCsv(document.getElementById("c-tech-out").value),
      companySizes: fromCsv(document.getElementById("c-company-size").value),
      followedCompanies: fromCsv(document.getElementById("c-followed").value),
      aiPreferences: document.getElementById("c-ai-prefs").value,
      sources: {
        remotive: document.getElementById("src-remotive").checked,
        arbeitnow: document.getElementById("src-arbeitnow").checked,
        remoteok: document.getElementById("src-remoteok").checked,
        greenhouse: { enabled: document.getElementById("src-gh").checked, companies: fromCsv(document.getElementById("src-gh-companies").value) },
        lever: { enabled: document.getElementById("src-lever").checked, companies: fromCsv(document.getElementById("src-lever-companies").value) },
      },
    };
    if (isNew) await api("/criteria", { method: "POST", body: JSON.stringify(payload) });
    else await api(`/criteria/${c.id}`, { method: "PUT", body: JSON.stringify(payload) });
    closeModal();
    renderMe();
  });
}

route();
