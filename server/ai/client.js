// Unified AI client — every AI-assisted feature (scoring, cover-letter
// drafting, CV auto-fill, tailoring summaries) calls through here instead of
// hitting a provider's API directly, so the rest of the app doesn't care
// which provider is configured. Supports:
//   - "anthropic" (Claude)      — paid, no ongoing free tier
//   - "groq"      (open models) — free tier, no card required
//   - "gemini"    (Google)      — free tier, no card required
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
// Anthropic bills web search usage separately from normal tokens.
function isWebSearchConfigured(settings) {
  return Boolean(settings && settings.aiProvider === "anthropic" && settings.aiApiKey);
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
      // isWebSearchConfigured() first rather than relying on this flag alone.
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

module.exports = { callAI, isAIConfigured, isWebSearchConfigured, DEFAULT_MODELS, PROVIDER_LABELS };
