// Rule-based match scoring. Deliberately simple and fully transparent (every
// point added/subtracted comes with a human-readable reason) so you can see
// exactly why a job was surfaced or hidden, and tune criteria accordingly.
//
// `scoreJobWithAI` below adds a second pass on top of this: a free-text
// "AI preferences" field lets you describe fit in your own words, and — if
// an Anthropic API key is configured — that gets sent to Claude alongside
// the job to produce a qualitative score+reasons, blended with the
// rule-based score in discovery.js.

function textIncludes(haystack, needle) {
  if (!haystack || !needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function anyHit(list, haystack) {
  return (list || []).filter((k) => textIncludes(haystack, k));
}

function scoreJob(job, criteria) {
  const reasons = [];
  let score = 50;
  const title = job.title || "";
  const desc = job.description || "";
  const combined = `${title} ${desc}`;

  // Dealbreakers: hard exclude, no partial credit.
  for (const term of criteria.dealbreakers || []) {
    if (textIncludes(combined, term)) {
      return { score: 0, hardFail: true, reasons: [`Dealbreaker matched: "${term}"`] };
    }
  }

  // Title keyword match (what you actually want to be called).
  const titleHits = anyHit(criteria.titleKeywords, title);
  if (titleHits.length) {
    score += 25;
    reasons.push(`Title matches: ${titleHits.join(", ")}`);
  } else {
    const descHits = anyHit(criteria.titleKeywords, desc);
    if (descHits.length) {
      score += 10;
      reasons.push(`Role keywords found in description: ${descHits.join(", ")}`);
    } else if ((criteria.titleKeywords || []).length) {
      score -= 20;
      reasons.push("No target title/role keywords found");
    }
  }

  // Exclude keywords (soft — things you'd rather not do, but not a hard dealbreaker).
  const excludeHits = anyHit(criteria.excludeKeywords, combined);
  if (excludeHits.length) {
    score -= 20;
    reasons.push(`Contains excluded terms: ${excludeHits.join(", ")}`);
  }

  // Level of role (seniority).
  if ((criteria.seniority || []).length) {
    const hit = criteria.seniority.find((s) => textIncludes(title, s));
    if (hit) {
      score += 10;
      reasons.push(`Level match: "${hit}"`);
    } else {
      const juniorSignals = ["junior", "intern", "graduate", "entry level", "entry-level"];
      if (juniorSignals.some((s) => textIncludes(title, s))) {
        score -= 25;
        reasons.push("Title suggests a more junior level than targeted");
      }
    }
  }

  // Type of role (full-time / contract / freelance / internship, etc.)
  if ((criteria.roleTypes || []).length) {
    const hit = criteria.roleTypes.find((t) => textIncludes(combined, t));
    if (hit) {
      score += 8;
      reasons.push(`Role type match: "${hit}"`);
    }
  }

  // Location / remote.
  if (criteria.remoteOk && job.remote) {
    score += 15;
    reasons.push("Remote-friendly, matches your remote preference");
    const remoteLocHit = anyHit(criteria.remoteLocations, job.location || "");
    if (remoteLocHit.length) {
      score += 5;
      reasons.push(`Remote location match: ${remoteLocHit.join(", ")}`);
    }
  } else if ((criteria.locations || []).length) {
    const locHit = criteria.locations.find((l) => textIncludes(job.location, l));
    if (locHit) {
      score += 15;
      reasons.push(`Location match: "${locHit}"`);
    } else if (!job.remote) {
      score -= 15;
      reasons.push(`Location "${job.location || "unknown"}" doesn't match your target locations`);
    }
  }

  // Languages (spoken language requirements/preferences mentioned in the posting).
  const languageHits = anyHit(criteria.languages, combined);
  if (languageHits.length) {
    score += 5;
    reasons.push(`Language match: ${languageHits.join(", ")}`);
  }

  // Minimum salary — only a soft signal since postings rarely include a clean parseable figure.
  if (criteria.minSalary && job.salary) {
    const numbers = String(job.salary).match(/\d[\d,]*/g);
    if (numbers) {
      const maxNum = Math.max(...numbers.map((n) => Number(n.replace(/,/g, ""))));
      if (maxNum && maxNum < criteria.minSalary) {
        score -= 15;
        reasons.push(`Posted salary (${job.salary}) looks below your minimum (${criteria.minSalary})`);
      }
    }
  }

  // Role priorities (free-form things you care about, e.g. "remote-first", "async", "4-day week").
  const priorityHits = anyHit(criteria.rolePriorities, combined);
  if (priorityHits.length) {
    score += 6 * priorityHits.length;
    reasons.push(`Matches role priorities: ${priorityHits.join(", ")}`);
  }

  // Favourite / hidden industries.
  const sectorHits = anyHit(criteria.sectorsInclude, combined);
  if (sectorHits.length) {
    score += 10;
    reasons.push(`Favourite industry match: ${sectorHits.join(", ")}`);
  }
  const sectorExcludeHits = anyHit(criteria.sectorsExclude, combined);
  if (sectorExcludeHits.length) {
    score -= 15;
    reasons.push(`Hidden industry signal: ${sectorExcludeHits.join(", ")}`);
  }

  // Favourite / hidden technologies.
  const techHits = anyHit(criteria.favouriteTechnologies, combined);
  if (techHits.length) {
    score += 8;
    reasons.push(`Favourite technology match: ${techHits.join(", ")}`);
  }
  const hiddenTechHits = anyHit(criteria.hiddenTechnologies, combined);
  if (hiddenTechHits.length) {
    score -= 12;
    reasons.push(`Hidden technology signal: ${hiddenTechHits.join(", ")}`);
  }

  // Company size (soft text signal — "startup", "scale-up", "enterprise" etc.)
  const sizeHits = anyHit(criteria.companySizes, combined);
  if (sizeHits.length) {
    score += 5;
    reasons.push(`Company size match: ${sizeHits.join(", ")}`);
  }

  // Followed companies — a direct hit here is a strong positive signal regardless of other criteria.
  if ((criteria.followedCompanies || []).length) {
    const hit = criteria.followedCompanies.find((c) => textIncludes(job.company, c));
    if (hit) {
      score += 20;
      reasons.push(`From a followed company: "${hit}"`);
    }
  }

  // Visa sponsorship.
  if (criteria.visaSponsorshipRequired && /no (visa )?sponsorship|unable to sponsor|must be authorized to work/i.test(desc)) {
    score -= 40;
    reasons.push("Posting indicates no visa sponsorship, but you require it");
  }

  score = Math.max(0, Math.min(100, score));
  return { score, hardFail: false, reasons };
}

/**
 * AI-assisted scoring pass. Sends the job + your structured criteria + your
 * free-text "AI preferences" to Claude and asks for a qualitative 0-100 fit
 * score with reasons — lets you express nuance ("avoid heavily bureaucratic
 * companies", "prefer teams that ship fast") that keyword rules can't
 * capture. Requires settings.anthropicApiKey; callers should treat a thrown
 * error as "skip AI scoring for this job" rather than fatal.
 */
async function scoreJobWithAI(job, criteria, settings, feedbackContext) {
  if (!settings.anthropicApiKey) {
    throw new Error("No Anthropic API key configured — AI-assisted scoring is unavailable.");
  }
  const model = settings.anthropicModel || "claude-sonnet-4-5";
  const prompt = [
    "You are screening a job posting against a candidate's search criteria for fit. Respond with ONLY a JSON object: " +
      '{"score": <0-100 integer>, "reasons": ["short reason", "..."]}. No markdown fences, no commentary.',
    "",
    `Job title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location || "unknown"}${job.remote ? " (remote)" : ""}`,
    `Job description: ${(job.description || "").slice(0, 3000)}`,
    "",
    "Structured criteria (already scored separately by rules — focus your judgement on nuance those rules can't capture):",
    JSON.stringify(
      {
        titleKeywords: criteria.titleKeywords,
        seniority: criteria.seniority,
        sectorsInclude: criteria.sectorsInclude,
        sectorsExclude: criteria.sectorsExclude,
        rolePriorities: criteria.rolePriorities,
      },
      null,
      2
    ),
    "",
    `Candidate's free-text preferences, in their own words (weight this heavily, it's the whole point of this pass): "${criteria.aiPreferences || ""}"`,
    ...(feedbackContext
      ? [
          "",
          "The candidate has previously given 👍/👎 feedback on past suggested jobs, with optional notes explaining why. " +
            "Use this as a real signal of their taste — infer patterns (industries, company types, role flavours, red flags) " +
            "rather than just matching exact titles/companies, and let it adjust your score up or down accordingly:",
          feedbackContext,
        ]
      : []),
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": settings.anthropicApiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API request failed (${res.status})`);
  const data = await res.json();
  const raw = (data.content || []).map((c) => c.text || "").join("\n").trim();
  const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(jsonText);
  return {
    score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
    reasons: (parsed.reasons || []).map((r) => `AI: ${r}`),
  };
}

/**
 * Turns stored 👍/👎 feedback on past jobs into a compact text block for the
 * AI scoring prompt above, so future matching actually learns from it rather
 * than just displaying it. Capped to the most recent N rated jobs so the
 * prompt (and cost) stays bounded as feedback accumulates over time.
 */
function buildFeedbackContext(jobs, maxEntries = 25) {
  const rated = (jobs || [])
    .filter((j) => j.feedback && j.feedback.rating)
    .sort((a, b) => new Date(b.feedback.ratedAt) - new Date(a.feedback.ratedAt))
    .slice(0, maxEntries);
  if (!rated.length) return "";
  return rated
    .map((j) => {
      const stamp = j.feedback.rating === "up" ? "👍 liked" : "👎 disliked";
      const note = j.feedback.note ? ` — note: "${j.feedback.note}"` : "";
      return `- ${stamp}: "${j.title}" at ${j.company}${j.location ? ` (${j.location})` : ""}${note}`;
    })
    .join("\n");
}

module.exports = { scoreJob, scoreJobWithAI, buildFeedbackContext };
