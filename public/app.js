const main = document.getElementById("main");
const modalRoot = document.getElementById("modal-root");

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
  return `<span class="rating-badge" title="How good a match you are for this job's requirements">🎯 ${cf ?? "–"}/10</span><span class="rating-badge" title="How good this role looks for you — perks, salary, fit to your preferences">✨ ${ra ?? "–"}/10</span>`;
}

function ratingsDetailHtml(j) {
  const cf = toTen(j.candidateFitScore);
  const ra = toTen(j.roleAppealScore);
  const byCat = j.reasonsByCategory || {};
  const list = (arr) =>
    arr && arr.length ? arr.map((r) => `<li>${esc(r)}</li>`).join("") : `<li class="hint">No breakdown available for this job.</li>`;
  return `
    <div class="ratings-grid">
      <div class="rating-block">
        <div class="rating-label">🎯 Match for requirements</div>
        <div class="rating-value">${cf ?? "–"}/10</div>
        <ul class="reasons">${list(byCat.candidateFit || (j.candidateFitScore == null ? null : []))}</ul>
      </div>
      <div class="rating-block">
        <div class="rating-label">✨ Good for you</div>
        <div class="rating-value">${ra ?? "–"}/10</div>
        <ul class="reasons">${list(byCat.roleAppeal || (j.roleAppealScore == null ? null : []))}</ul>
      </div>
    </div>
  `;
}

function closeModal() {
  modalRoot.innerHTML = "";
}

function openModal(html) {
  modalRoot.innerHTML = `<div class="modal-backdrop" id="modal-backdrop"><div class="modal">${html}</div></div>`;
  document.getElementById("modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") closeModal();
  });
}

// ---------- Job feedback (👍/👎 + optional note) ----------
// Shared between the Review Queue and the job detail modal. Feedback is
// stored per-job and, if you've set an Anthropic API key, gets fed into the
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
  return `<p class="hint">📄 CV &amp; cover letter ready (${fmtDate(j.materials.generatedAt)}) — <a href="/api/jobs/${j.id}/materials/cv" target="_blank">CV</a> &nbsp;·&nbsp; <a href="/api/jobs/${j.id}/materials/cover-letter" target="_blank">Cover letter</a></p>
    ${j.materials.tailoringSummary ? `<p class="hint">✏️ ${esc(j.materials.tailoringSummary)}</p>` : ""}`;
}

function attachFeedbackHandlers(root, jobsById, onChange) {
  root.querySelectorAll(".feedback-row").forEach((row) => {
    const id = row.dataset.feedbackId;
    const job = jobsById[id] || {};
    row.querySelectorAll("[data-fb]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const rating = btn.classList.contains("active") ? null : btn.dataset.fb;
        await api(`/jobs/${id}/feedback`, { method: "POST", body: JSON.stringify({ rating }) });
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
  settings: renderSettings,
};

function route() {
  const hash = (location.hash || "#/dashboard").replace("#/", "");
  const [view] = hash.split("/");
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === view));
  (routes[view] || renderDashboard)();
}
window.addEventListener("hashchange", route);

// ---------- Dashboard ----------
async function renderDashboard() {
  main.innerHTML = `<h2>Dashboard</h2><div id="dash-body">Loading…</div>`;
  const [stats, jobs] = await Promise.all([api("/stats"), api("/jobs")]);
  const recent = jobs.slice(0, 8);
  document.getElementById("dash-body").innerHTML = `
    <div class="stats-row">
      <div class="stat-card"><div class="value">${stats.totalDiscovered}</div><div class="label">Jobs discovered</div></div>
      <div class="stat-card"><div class="value">${stats.counts.discovered || 0}</div><div class="label">Awaiting review</div></div>
      <div class="stat-card"><div class="value">${stats.submitted}</div><div class="label">Applied</div></div>
      <div class="stat-card"><div class="value">${stats.interviewed}</div><div class="label">Interviewing</div></div>
      <div class="stat-card"><div class="value">${stats.offers}</div><div class="label">Offers</div></div>
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
    ${recent.length ? recent.map(jobRowHtml).join("") : `<div class="empty">No jobs yet — configure a criteria profile in Settings, then run discovery.</div>`}
  `;
  document.getElementById("run-discovery").addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Running…";
    try {
      const result = await api("/jobs/discover", { method: "POST" });
      alert(`Discovery complete: ${result.added} new match(es) found.`);
      renderDashboard();
    } catch (err) {
      alert(`Discovery failed: ${err.message}`);
      e.target.disabled = false;
      e.target.textContent = "Run discovery now";
    }
  });
  attachRowHandlers();
}

function jobRowHtml(j) {
  return `
    <div class="list-item" data-job-id="${j.id}">
      <h4>${esc(j.title)} <span class="badge ${j.status}">${j.status.replace(/_/g, " ")}</span></h4>
      <div class="meta">${esc(j.company)} · ${esc(j.location || "—")} · ${ratingsBadgesHtml(j)} · discovered ${fmtDate(j.discoveredAt)}</div>
    </div>
  `;
}

function attachRowHandlers() {
  document.querySelectorAll("[data-job-id]").forEach((el) => {
    el.addEventListener("click", () => openJobDetail(el.dataset.jobId));
  });
}

// ---------- Review Queue ----------
async function renderReview() {
  main.innerHTML = `<h2>Review Queue</h2><div id="review-body">Loading…</div>`;
  const jobs = await api("/jobs?status=discovered");
  const body = document.getElementById("review-body");
  if (!jobs.length) {
    body.innerHTML = `<div class="empty">No new matches waiting for review.</div>`;
    return;
  }
  body.innerHTML = jobs
    .sort((a, b) => b.score - a.score)
    .map(
      (j) => `
    <div class="list-item">
      <h4>${esc(j.title)} <span class="score ${scoreClass(j.score)}">Score ${j.score}</span></h4>
      <div class="meta">${esc(j.company)} · ${esc(j.location || "—")} · via ${esc(j.source)} · discovered ${fmtDate(j.discoveredAt)}
        &nbsp;<a href="${esc(j.url)}" target="_blank" rel="noopener">View posting ↗</a>
      </div>
      ${ratingsDetailHtml(j)}
      ${feedbackRowHtml(j)}
      ${materialsLineHtml(j)}
      <button data-approve="${j.id}">${j.materials ? "Approve" : "Approve & prepare materials"}</button>
      <button class="secondary" data-detail="${j.id}">Details</button>
      <button class="secondary" data-dismiss="${j.id}">Dismiss</button>
    </div>
  `
    )
    .join("");

  attachFeedbackHandlers(body, Object.fromEntries(jobs.map((j) => [j.id, j])), renderReview);

  body.querySelectorAll("[data-approve]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const id = btn.dataset.approve;
      const job = jobs.find((j) => j.id === id);
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
        alert(`Couldn't prepare materials: ${err.message}`);
        btn.disabled = false;
        btn.textContent = alreadyHasMaterials ? "Approve" : "Approve & prepare materials";
      }
    })
  );
  body.querySelectorAll("[data-dismiss]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api(`/jobs/${btn.dataset.dismiss}/status`, { method: "POST", body: JSON.stringify({ status: "dismissed" }) });
      renderReview();
    })
  );
  body.querySelectorAll("[data-detail]").forEach((btn) => btn.addEventListener("click", () => openJobDetail(btn.dataset.detail)));
}

// ---------- Tracker ----------
async function renderTracker() {
  main.innerHTML = `
    <h2>Tracker</h2>
    <div class="filters">
      <label style="margin:0;">Status:</label>
      <select id="status-filter" style="width:220px;">
        <option value="">All</option>
        ${["discovered","reviewing","approved","materials_ready","submitted","interviewing","offer","rejected","withdrawn","dismissed"]
          .map((s) => `<option value="${s}">${s.replace(/_/g, " ")}</option>`)
          .join("")}
      </select>
    </div>
    <div class="card"><table id="tracker-table">
      <thead><tr><th>Role</th><th>Company</th><th>Status</th><th>Score</th><th>Discovered</th><th>Applied</th></tr></thead>
      <tbody id="tracker-body"><tr><td colspan="6">Loading…</td></tr></tbody>
    </table></div>
  `;
  const load = async () => {
    const status = document.getElementById("status-filter").value;
    const jobs = await api(`/jobs${status ? `?status=${status}` : ""}`);
    const tbody = document.getElementById("tracker-body");
    if (!jobs.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">No jobs in this view.</td></tr>`;
      return;
    }
    tbody.innerHTML = jobs
      .map(
        (j) => `
      <tr data-job-id="${j.id}">
        <td>${esc(j.title)}</td>
        <td>${esc(j.company)}</td>
        <td><span class="badge ${j.status}">${j.status.replace(/_/g, " ")}</span></td>
        <td class="score ${scoreClass(j.score)}">${j.score}<div class="rating-mini">${ratingsBadgesHtml(j)}</div></td>
        <td>${fmtDate(j.discoveredAt)}</td>
        <td>${fmtDate(j.appliedAt)}</td>
      </tr>`
      )
      .join("");
    attachRowHandlers();
  };
  document.getElementById("status-filter").addEventListener("change", load);
  load();
}

// ---------- Job detail modal ----------
async function openJobDetail(id) {
  const job = await api(`/jobs/${id}`);
  const statuses = ["discovered","reviewing","approved","materials_ready","submitted","interviewing","offer","rejected","withdrawn","dismissed"];
  openModal(`
    <span class="close-x" id="close-modal">&times;</span>
    <h3>${esc(job.title)}</h3>
    <div class="meta">${esc(job.company)} · ${esc(job.location || "—")} · <a href="${esc(job.url)}" target="_blank" rel="noopener">View posting ↗</a></div>
    <p><span class="badge ${job.status}">${job.status.replace(/_/g, " ")}</span> &nbsp; <span class="score ${scoreClass(job.score)}">Overall score ${job.score}</span></p>
    ${ratingsDetailHtml(job)}

    <label>Was this a good match?</label>
    ${feedbackRowHtml(job)}
    <p class="hint">Feeds into the AI-assisted scoring pass on future discovery runs (needs an Anthropic API key + AI preferences set in Settings).</p>

    <label>Update status</label>
    <div class="form-row">
      <select id="status-select">${statuses.map((s) => `<option value="${s}" ${s === job.status ? "selected" : ""}>${s.replace(/_/g, " ")}</option>`).join("")}</select>
      <button id="save-status">Update</button>
    </div>

    <label>Notes</label>
    <textarea id="notes">${esc(job.notes || "")}</textarea>
    <button id="save-notes" class="secondary">Save notes</button>

    <div class="section-title">Application materials</div>
    ${
      job.materials
        ? `<p><a href="/api/jobs/${job.id}/materials/cv" target="_blank">Download CV</a> &nbsp;·&nbsp; <a href="/api/jobs/${job.id}/materials/cover-letter" target="_blank">Download cover letter</a></p>
           <button id="regen-materials" class="secondary">Regenerate</button>
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
  const genBtn = document.getElementById("gen-materials") || document.getElementById("regen-materials");
  if (genBtn) {
    genBtn.addEventListener("click", async () => {
      genBtn.disabled = true;
      genBtn.textContent = "Generating…";
      try {
        await api(`/jobs/${job.id}/generate-materials`, { method: "POST" });
        openJobDetail(job.id);
      } catch (err) {
        document.getElementById("detail-msg").textContent = `Failed: ${err.message}`;
        genBtn.disabled = false;
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
}

// ---------- Settings ----------
async function renderSettings() {
  main.innerHTML = `<h2>Settings</h2><div id="settings-body">Loading…</div>`;
  const [settings, profile, criteria, cvUpload] = await Promise.all([api("/settings"), api("/profile"), api("/criteria"), api("/profile/cv-upload")]);
  const isScheduled = settings.cadence && settings.cadence !== "manual";
  const frequency = isScheduled ? settings.cadence : "daily";
  const timeValue = `${String(settings.cadenceHourLocal ?? 7).padStart(2, "0")}:${String(settings.cadenceMinuteLocal ?? 0).padStart(2, "0")}`;

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

    <div class="card">
      <h3>Baseline CV file</h3>
      <p class="hint">Upload your CV (PDF or Word/.docx). This is what your profile gets auto-filled from, and what every tailored CV/cover letter is generated relative to.</p>
      ${
        cvUpload
          ? `<p><strong>${esc(cvUpload.originalFilename)}</strong> · uploaded ${fmtDate(cvUpload.uploadedAt)}
             &nbsp; <a href="/api/profile/cv-upload/view" target="_blank">View</a>
             &nbsp;·&nbsp; <a href="/api/profile/cv-upload/download" target="_blank">Download</a>
             &nbsp;·&nbsp; <a href="#" id="remove-cv">Remove</a></p>
             ${
               cvUpload.mimetype === "application/pdf"
                 ? `<iframe src="/api/profile/cv-upload/view" style="width:100%; height:420px; border:1px solid var(--border); border-radius:8px;"></iframe>`
                 : `<p class="hint">Inline preview isn't available for Word files in-browser — use View/Download above (View will prompt your system's Word viewer).</p>`
             }
             <div style="margin-top:12px;">
               <button id="import-from-cv" ${settings.anthropicApiKey ? "" : "disabled"}>Auto-fill profile from this CV (AI)</button>
               ${settings.anthropicApiKey ? "" : `<span class="hint">Add an Anthropic API key under Advanced settings to enable this.</span>`}
             </div>`
          : `<p class="empty">No CV uploaded yet.</p>`
      }
      <div style="margin-top:12px;">
        <input type="file" id="cv-file-input" accept=".pdf,.docx" />
        <button id="upload-cv" class="secondary">Upload</button>
        <span id="cv-upload-msg" class="hint"></span>
      </div>
    </div>

    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3>Criteria profiles</h3>
        <button id="add-criteria">+ Add profile</button>
      </div>
      <div id="criteria-list">${criteria.map(criteriaRowHtml).join("") || `<p class="empty">No criteria profiles yet — add one to start discovering jobs.</p>`}</div>
    </div>

    <details class="card advanced-settings" id="advanced-settings">
      <summary>Advanced settings</summary>

      <label>Minimum score to surface a match (0-100)</label>
      <input type="number" id="minScore" min="0" max="100" value="${settings.minScoreToSurface}" />

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

      <div class="section-title">Optional: AI-assisted scoring &amp; cover letter drafting</div>
      <p class="hint">Powers the "AI preferences" free-text box on each criteria profile, and more natural cover-letter drafting. Leave blank to use plain rule-based scoring and template drafting instead — both work fully without a key.</p>
      <label>Anthropic API key</label>
      <input type="password" id="anthropicApiKey" value="${settings.anthropicApiKey ? "••••••••" : ""}" placeholder="sk-ant-..." />
      <label>Model</label>
      <input type="text" id="anthropicModel" value="${esc(settings.anthropicModel || "claude-sonnet-4-5")}" />
      <label>Max AI-scored jobs per discovery run (cost guard)</label>
      <input type="number" id="maxAiScoredPerCycle" min="0" value="${settings.maxAiScoredPerCycle ?? 15}" />

      <div class="section-title">Candidate profile (CV data)</div>
      <p class="hint">Edited as JSON for now, see README for the shape (name, headline, summary, skills, experience, education, additional, talkingPoints, houseRules). A friendlier form editor is on the roadmap. Use "Auto-fill profile from this CV" above to draft this from your uploaded CV instead of typing it by hand.</p>
      <textarea id="profile-json" style="min-height:260px; font-family: monospace; font-size:12px;">${esc(JSON.stringify(profile, null, 2))}</textarea>
      <div style="margin-top:8px;"><button id="save-profile">Save profile</button><span id="profile-msg" class="hint"></span></div>

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
      anthropicApiKey: document.getElementById("anthropicApiKey").value,
      anthropicModel: document.getElementById("anthropicModel").value,
      maxAiScoredPerCycle: Number(document.getElementById("maxAiScoredPerCycle").value),
    };
  }

  async function saveSettings(msgEl) {
    await api("/settings", { method: "PUT", body: JSON.stringify(collectSettingsPayload()) });
    msgEl.textContent = "Saved.";
  }
  document.getElementById("save-settings").addEventListener("click", () => saveSettings(document.getElementById("settings-msg")));
  document.getElementById("save-settings-advanced").addEventListener("click", () => saveSettings(document.getElementById("settings-msg-advanced")));

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
      renderSettings();
    } catch (err) {
      msg.textContent = `Upload failed: ${err.message}`;
    }
  });

  const removeCvLink = document.getElementById("remove-cv");
  if (removeCvLink) {
    removeCvLink.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!confirm("Remove your uploaded CV file?")) return;
      await api("/profile/cv-upload", { method: "DELETE" });
      renderSettings();
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
        document.getElementById("advanced-settings").open = true;
        document.getElementById("profile-json").value = JSON.stringify(draft, null, 2);
        msg.textContent = "Draft imported under Advanced settings → Candidate profile — review it, then hit \"Save profile\" to apply it.";
        document.getElementById("profile-json").scrollIntoView({ behavior: "smooth" });
      } catch (err) {
        msg.textContent = `Import failed: ${err.message}`;
      }
      importBtn.disabled = false;
      importBtn.textContent = "Auto-fill profile from this CV (AI)";
    });
  }
}

function criteriaRowHtml(c) {
  return `
    <div class="list-item">
      <h4>${esc(c.name || "(unnamed profile)")} ${c.active ? "" : '<span class="badge withdrawn">inactive</span>'}</h4>
      <div class="meta">Titles: ${esc((c.titleKeywords || []).join(", ") || "—")} · Locations: ${esc((c.locations || []).join(", ") || (c.remoteOk ? "remote ok" : "—"))}</div>
      ${c.aiPreferences ? `<div class="meta">AI preferences: "${esc(c.aiPreferences.slice(0, 140))}${c.aiPreferences.length > 140 ? "…" : ""}"</div>` : ""}
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
  document.querySelectorAll("[data-delete-criteria]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this criteria profile?")) return;
      await api(`/criteria/${btn.dataset.deleteCriteria}`, { method: "DELETE" });
      renderSettings();
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
    dealbreakers: [], aiPreferences: "", sources: {},
  };
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
      <div><label><input type="checkbox" id="c-remote" ${c.remoteOk ? "checked" : ""} style="width:auto; display:inline;" /> Remote OK</label></div>
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
    <p class="hint">Describe what you're looking for in your own words — culture, pace, red flags, anything the structured fields above can't capture. If you've added an Anthropic API key in the section above, this gets sent to Claude alongside each promising match for a smarter fit judgement, blended with the rule-based score.</p>
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
      remoteOk: document.getElementById("c-remote").checked,
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
    renderSettings();
  });
}

route();
