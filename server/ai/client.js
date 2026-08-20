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

async function callAnthropic({ apiKey, model, prompt, maxTokens, tools }) {
  const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
  if (tools && tools.length) body.tools = tools;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic API request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  // Non-text content blocks (server_tool_use, web_search_tool_result) have
  // no .text field, so they naturally drop out of this join — only the
  // model's actual written answer ends up in the returned string.
  return (data.content || []).map((c) => c.text || "").join("\n").trim();
}

// OpenAI-compatible chat completions endpoint — works for Groq unchanged.
async function callGroq({ apiKey, model, prompt, maxTokens }) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Groq API request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return ((data.choices || [])[0]?.message?.content || "").trim();
}

async function callGemini({ apiKey, model, prompt, maxTokens }) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } }),
  });
  if (!res.ok) throw new Error(`Gemini API request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
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
async function callGeminiWithSearch({ apiKey, model, prompt, maxTokens }) {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      model,
      input: prompt,
      tools: [{ type: "google_search" }],
      generation_config: { max_output_tokens: maxTokens },
    }),
  });
  if (!res.ok) throw new Error(`Gemini Interactions API request failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
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
  const model = settings.aiModel || DEFAULT_MODELS[settings.aiProvider];
  const apiKey = settings.aiApiKey;
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
  DEFAULT_MODELS,
  PROVIDER_LABELS,
};
