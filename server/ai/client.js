// Unified AI client — every AI-assisted feature (scoring, cover-letter
// drafting, CV auto-fill, tailoring summaries) calls through here instead of
// hitting a provider's API directly, so the rest of the app doesn't care
// which provider is configured. Supports:
//   - "anthropic" (Claude)      — paid, no ongoing free tier
//   - "groq"      (open models) — free tier, no card required
//   - "gemini"    (Google)      — free tier, no card required (grounded web
//                  search specifically needs a billing-enabled key though —
//                  see isGeminiSearchConfigured below)
// settings.aiProvider: "none" | "anthropic" | "groq" | "gemini"
// settings.aiApiKey:   the key for whichever provider is selected
// settings.aiModel:    model name for that provider (falls back to a
//                       sensible default per provider if left blank)

const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-4-5",
  groq: "openai/gpt-oss-120b",
  gemini: "gemini-2.5-flash",
};

const PROVIDER_LABELS = {
  none: "None (rule-based / template only)",
  anthropic: "Anthropic (Claude) — paid",
  groq: "Groq — free tier, no card required",
  gemini: "Google Gemini — free tier, no card required",
};

function isAIConfigured(settings) {
  return Boolean(settings && settings.aiProvider && settings.aiProvider !== "none" && settings.aiApiKey);
}

// ---------- Daily usage cap (settings.aiDailyUsageLimit) ----------
// Every real outbound call to a provider — scoring, cover-letter drafting,
// CV auto-fill, posting search, connection tests, anything that reaches
// callAI() or callGeminiWithSearch() below — increments one running total
// for the day and refuses to make the call at all once a configured limit
// is hit, so a free-tier daily quota can't be blown through by the sum of
// everything this app does, not just any one feature's own per-cycle cap
// (maxAiScoredPerCycle etc., which only bound a single code path and reset
// every discovery run). Deliberately checked+incremented via a fresh
// db.read()/db.write() right here rather than threaded through every
// caller's function signature — every AI-assisted feature already funnels
// through these two functions, so this is the one place that's guaranteed
// to see every call without touching a dozen other files.
//
// Uses the UTC calendar date as "today", not settings.timezone: no other
// scheduling logic in this app is timezone-aware either (see
// server/scheduler.js's own "local server time" comment), and getting the
// exact reset instant right matters far less here than just having *a*
// boundary that reliably resets once a day — being a few hours off from
// whichever timezone your provider resets in doesn't change whether you
// stay under quota. Requiring db.js here (rather than the reverse) is safe:
// db.js/db-file.js/db-postgres.js never require this module back.
const db = require("./../db");

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

async function checkAndRecordAIUsage(settings) {
  const limit = settings && settings.aiDailyUsageLimit;
  const data = await db.read();
  const today = todayUTC();
  if (!data.meta.aiUsage || data.meta.aiUsage.date !== today) {
    data.meta.aiUsage = { date: today, count: 0 };
  }
  // The provider itself already told us today's quota is used up (see
  // recordQuotaExceeded below) — don't even attempt the call, so this is a
  // free, instant "no" rather than another wasted request against an
  // already-exhausted quota. This is what actually answers "how do I know
  // my real limit without looking it up" — the provider's own 429 IS the
  // real limit, discovered live, no manual number needed at all.
  if (data.meta.aiUsage.quotaExceededAt) {
    throw new Error(
      `${data.meta.aiUsage.quotaExceededProvider || settings.aiProvider} reported its free-tier quota exhausted today at ${data.meta.aiUsage.quotaExceededAt} — AI-assisted features are paused until this resets tomorrow (UTC).${data.meta.aiUsage.quotaExceededDetail ? ` (${data.meta.aiUsage.quotaExceededDetail})` : ""}`
    );
  }
  if (limit && data.meta.aiUsage.count >= limit) {
    throw new Error(
      `AI usage limit reached for today (${data.meta.aiUsage.count}/${limit} calls) — raise the limit in Settings, or wait for it to reset (midnight UTC).`
    );
  }
  data.meta.aiUsage.count += 1;
  await db.write(data);
  return data.meta.aiUsage;
}

// Called when a provider call comes back with a genuine quota/rate-limit
// error (see isQuotaError below) — records it so checkAndRecordAIUsage
// short-circuits every subsequent call today, no manual number required.
// This is the real answer to "how do I find my limit without looking it
// up": rather than guessing a number in advance, the app just reacts the
// first time the provider itself says "no more today", and self-pauses.
// The trade-off is that the FIRST call after quota is actually exhausted
// still gets made (and fails) before this kicks in — there's no way around
// that without the provider exposing remaining-quota up front, which
// Gemini's plain API doesn't for free-tier keys (see the note on
// aiDailyUsageLimit in defaultData.js for the manual, preventive
// alternative: a number set a bit under your real quota stops calls
// *before* that first failure, if you want to look it up once).
async function recordQuotaExceeded(settings, detail) {
  const data = await db.read();
  const today = todayUTC();
  if (!data.meta.aiUsage || data.meta.aiUsage.date !== today) {
    data.meta.aiUsage = { date: today, count: 0 };
  }
  data.meta.aiUsage.quotaExceededAt = new Date().toISOString();
  data.meta.aiUsage.quotaExceededProvider = settings.aiProvider;
  data.meta.aiUsage.quotaExceededDetail = String(detail || "").slice(0, 300);
  await db.write(data);
}

// Best-effort detection of "this failure was the provider's quota/rate
// limit, not some other error" — a plain HTTP 429 is the standard signal
// across all three providers here, backed up by a text match on the
// response body for the cases (seen in some of Google's APIs) where a
// quota rejection comes back with a different status code. Not verified
// against a live 429 from any of these providers (this sandbox has no
// outbound access to test it) — if usage tracking doesn't seem to be
// catching a real quota error, check the Railway logs for the actual
// status/body of the failing call and adjust this.
function isQuotaError(status, bodyText) {
  if (status === 429) return true;
  return typeof bodyText === "string" && /RESOURCE_EXHAUSTED|quota exceeded|rate.?limit exceeded/i.test(bodyText);
}

// Thin wrapper every actual provider call goes through: runs it, and if it
// fails with the quota/rate-limit signal (err.isQuotaError, set by
// throwForBadResponse above), records that centrally before rethrowing so
// checkAndRecordAIUsage can short-circuit every later call today. The
// original error still propagates unchanged either way — this only adds a
// side effect on the quota-specific case, callers see the same thrown
// error/message as before.
async function runProviderCall(settings, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.isQuotaError) {
      await recordQuotaExceeded(settings, e.message);
    }
    throw e;
  }
}

// Read-only view for the Settings page — doesn't touch the stored counter
// (that only ever advances lazily, inside checkAndRecordAIUsage above), so
// a day with zero calls so far correctly shows 0 instead of yesterday's
// leftover count.
function getAIUsageStatus(settings, meta) {
  const today = todayUTC();
  const stored = meta && meta.aiUsage && meta.aiUsage.date === today ? meta.aiUsage : null;
  return {
    count: stored ? stored.count : 0,
    limit: (settings && settings.aiDailyUsageLimit) || null,
    date: today,
    quotaExceededAt: stored ? stored.quotaExceededAt || null : null,
    quotaExceededProvider: stored ? stored.quotaExceededProvider || null : null,
    quotaExceededDetail: stored ? stored.quotaExceededDetail || null : null,
  };
}

// Anthropic's hosted, server-executed web search tool — the request/response
// round-trip (searching, reading results) all happens on Anthropic's side in
// this one API call, so no separate search API key or client-side tool loop
// is needed here. Only used by server/aiPostingSearch.js, and only ever to
// ground a real search result, never to let a model free-guess a URL from
// training data (this app never fabricates links anywhere else either).
// Anthropic charges per search (no free quota); see PROVIDER_LABELS.
function isAnthropicSearchConfigured(settings) {
  return Boolean(settings && settings.aiProvider === "anthropic" && settings.aiApiKey);
}

// Google's equivalent grounded-search capability, reached through Gemini's
// newer Interactions API (a different endpoint/shape than the plain
// generateContent calls callGemini() below makes) rather than
// generateContent, per Google's own current docs. Requires a
// billing-enabled Gemini API key (unlike the rest of this app's Gemini
// usage, which works on the plain no-card free tier) — but usage this app
// generates stays well inside Google's free daily grounding allowance in
// practice, since lookups are capped per cycle. Wired up so a single Gemini
// key can cover every AI-assisted feature in this app, including posting
// search, without also needing an Anthropic key. See
// server/aiPostingSearch.js.
function isGeminiSearchConfigured(settings) {
  return Boolean(settings && settings.aiProvider === "gemini" && settings.aiApiKey);
}

// True if *some* provider capable of grounded web search is configured —
// the only thing server/postingResolver.js needs to know to decide whether
// tier 2 is worth attempting at all.
function isPostingSearchConfigured(settings) {
  return isAnthropicSearchConfigured(settings) || isGeminiSearchConfigured(settings);
}

// Every provider call below goes through this instead of a bare fetch().
// None of the raw fetch() calls had a timeout — if a provider's API ever
// hangs (slow response, network stall, a routing issue) rather than
// cleanly erroring, the request would just hang forever with no way for
// anything upstream to notice. That's a real bug, not a hypothetical one:
// PATCH /jobs/:id chains straight through scoreJobFully() into one of
// these calls whenever you edit a job's posting details (see routes/jobs.js)
// — a hung AI call there meant the whole save silently never completed, url
// included, even though url is otherwise set unconditionally before the
// AI step runs. Callers already treat a thrown error from these functions
// as "skip the AI-assisted step, don't fail the whole operation" (see the
// try/catches in scoring.js/jobScoring.js), so timing out and throwing here
// is exactly as safe as any other failure mode already handled — it just
// bounds how long that failure takes to surface.
const AI_REQUEST_TIMEOUT_MS = 25000;

async function fetchWithTimeout(url, opts, providerLabel) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`${providerLabel} request timed out after ${AI_REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Throws with `.isQuotaError` set when the failure looks like the
// provider's own rate/quota limit (see isQuotaError above) — callAI/
// callGeminiWithSearch check this flag to auto-pause further calls today
// without needing any manually-entered limit. Every provider call function
// below follows this same shape.
async function throwForBadResponse(res, providerLabel, snippetLen = 300) {
  const bodyText = (await res.text()).slice(0, snippetLen);
  const err = new Error(`${providerLabel} API request failed (${res.status}): ${bodyText}`);
  err.isQuotaError = isQuotaError(res.status, bodyText);
  throw err;
}

async function callAnthropic({ apiKey, model, prompt, maxTokens, tools }) {
  const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
  if (tools && tools.length) body.tools = tools;
  const res = await fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    },
    "Anthropic"
  );
  if (!res.ok) await throwForBadResponse(res, "Anthropic");
  const data = await res.json();
  // Non-text content blocks (server_tool_use, web_search_tool_result) have
  // no .text field, so they naturally drop out of this join — only the
  // model's actual written answer ends up in the returned string.
  return (data.content || []).map((c) => c.text || "").join("\n").trim();
}

// OpenAI-compatible chat completions endpoint — works for Groq unchanged.
async function callGroq({ apiKey, model, prompt, maxTokens }) {
  const res = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    },
    "Groq"
  );
  if (!res.ok) await throwForBadResponse(res, "Groq");
  const data = await res.json();
  return ((data.choices || [])[0]?.message?.content || "").trim();
}

async function callGemini({ apiKey, model, prompt, maxTokens }) {
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } }),
    },
    "Gemini"
  );
  if (!res.ok) await throwForBadResponse(res, "Gemini");
  const data = await res.json();
  const parts = (data.candidates || [])[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("\n").trim();
}

// Grounded web search via Gemini's Interactions API — a different endpoint
// and response shape than callGemini() above, per Google's current docs
// (the older generateContent-based grounding tool is being retired in
// favour of this one). Built from Google's published API reference rather
// than tested against a live key (this environment has no outbound network
// access to verify it) — see server/aiPostingSearch.js's header comment for
// what to check if this needs a fix once it's actually used against a real
// Gemini key.
//
// Returns { text, citationUrls } — citationUrls comes from the response's
// own url_citation annotations (URLs Google's grounding actually found),
// kept separate from the model's own written text so callers can
// cross-check a claimed URL against what was really found rather than
// trusting the model's prose alone.
async function callGeminiWithSearch(settings, { model, prompt, maxTokens }) {
  await checkAndRecordAIUsage(settings);
  return runProviderCall(settings, async () => {
    const apiKey = settings.aiApiKey;
    const res = await fetchWithTimeout(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          model,
          input: prompt,
          tools: [{ type: "google_search" }],
          generation_config: { max_output_tokens: maxTokens },
        }),
      },
      "Gemini"
    );
    if (!res.ok) await throwForBadResponse(res, "Gemini Interactions API", 500);
    const data = await res.json();
    const steps = data.steps || [];
    let text = "";
    const citationUrls = [];
    for (const step of steps) {
      for (const block of step.content || []) {
        if (block.type === "text" && block.text) text += block.text + "\n";
        for (const ann of block.annotations || []) {
          if (ann.type === "url_citation" && ann.url) citationUrls.push(ann.url);
        }
      }
    }
    return { text: text.trim(), citationUrls };
  });
}

/**
 * Sends `prompt` to whichever provider is configured in settings and
 * returns the raw text response. Throws if no provider is configured, or if
 * the provider's API call fails — callers should treat that as "skip this
 * AI-assisted step" rather than fatal, same as before this abstraction existed.
 */
async function callAI(settings, { prompt, maxTokens = 600, allowWebSearch = false }) {
  if (!isAIConfigured(settings)) {
    throw new Error("No AI provider configured — set one under Advanced settings.");
  }
  await checkAndRecordAIUsage(settings);
  const model = settings.aiModel || DEFAULT_MODELS[settings.aiProvider];
  const apiKey = settings.aiApiKey;
  return runProviderCall(settings, () => {
    switch (settings.aiProvider) {
      case "anthropic": {
        // allowWebSearch is silently a no-op for the other providers below —
        // callers that actually need grounded search results should check
        // isPostingSearchConfigured() first rather than relying on this flag
        // alone (and for Gemini, call callGeminiWithSearch() directly instead
        // of callAI() — different endpoint/response shape, see above).
        const tools = allowWebSearch ? [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] : undefined;
        return callAnthropic({ apiKey, model, prompt, maxTokens, tools });
      }
      case "groq":
        return callGroq({ apiKey, model, prompt, maxTokens });
      case "gemini":
        return callGemini({ apiKey, model, prompt, maxTokens });
      default:
        throw new Error(`Unknown AI provider: ${settings.aiProvider}`);
    }
  });
}

// On-demand connectivity check for the Settings health indicator — same
// idea as email/inbox.js's testConnection(), just for whichever AI
// provider + key is configured. Sends the smallest possible real request
// (a few tokens) so it actually proves the key/provider/model combination
// works end to end, rather than just checking the key is non-empty.
// Deliberately never sets allowWebSearch — this only verifies basic
// connectivity, not the separately-billed posting-search capability.
async function testAIConnection(settings) {
  if (!isAIConfigured(settings)) {
    return { ok: false, error: "No AI provider configured." };
  }
  try {
    const reply = await callAI(settings, { prompt: "Reply with exactly the single word OK and nothing else.", maxTokens: 10 });
    return { ok: true, reply: reply.trim().slice(0, 60) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  callAI,
  callGeminiWithSearch,
  testAIConnection,
  isAIConfigured,
  isAnthropicSearchConfigured,
  isGeminiSearchConfigured,
  isPostingSearchConfigured,
  getAIUsageStatus,
  checkAndRecordAIUsage,
  recordQuotaExceeded,
  DEFAULT_MODELS,
  PROVIDER_LABELS,
};
