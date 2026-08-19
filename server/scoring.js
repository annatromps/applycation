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

// Every rule-based signal is assigned to one of two categories, matching the
// two ratings shown in the UI:
//   candidateFit  — am I a good match for what THIS JOB requires (title,
//                   seniority, role type, language/visa requirements)?
//   roleAppeal    — is this a good opportunity FOR ME (location/remote,
//                   salary, sectors, technologies, company, priorities)?
// Each starts at 25 (half the old single-score baseline of 50) and is
// clamped to 0-100 independently, so the overall "score" (their average,
// see bottom of this function) behaves like the old single score did.
function scoreJob(job, criteria) {
  const cf = { score: 25, reasons: [] }; // candidateFit
  const ra = { score: 25, reasons: [] }; // roleAppeal
  const title = job.title || "";
  const desc = job.description || "";
  const combined = `${title} ${desc}`;

  const bump = (bucket, delta, reason) => {
    bucket.score += delta;
    bucket.reasons.push(reason);
  };

  // Dealbreakers: hard exclude, no partial credit. Never surfaced regardless
  // of category, so both scores are zeroed together.
  for (const term of criteria.dealbreakers || []) {
    if (textIncludes(combined, term)) {
      return {
        score: 0,
        candidateFitScore: 0,
        roleAppealScore: 0,
        hardFail: true,
        reasons: [`Dealbreaker matched: "${term}"`],
        reasonsByCategory: { candidateFit: [], roleAppeal: [`Dealbreaker matched: "${term}"`] },
      };
    }
  }

  // Title keyword match (what you actually want to be called) — are you the
  // kind of candidate this role is looking for?
  const titleHits = anyHit(criteria.titleKeywords, title);
  if (titleHits.length) {
    bump(cf, 25, `Title matches: ${titleHits.join(", ")}`);
  } else {
    const descHits = anyHit(criteria.titleKeywords, desc);
    if (descHits.length) {
      bump(cf, 10, `Role keywords found in description: ${descHits.join(", ")}`);
    } else if ((criteria.titleKeywords || []).length) {
      bump(cf, -20, "No target title/role keywords found");
    }
  }

  // Exclude keywords (soft — things you'd rather not do, but not a hard dealbreaker).
  const excludeHits = anyHit(criteria.excludeKeywords, combined);
  if (excludeHits.length) {
    bump(cf, -20, `Contains excluded terms: ${excludeHits.join(", ")}`);
  }

  // Level of role (seniority).
  if ((criteria.seniority || []).length) {
    const hit = criteria.seniority.find((s) => textIncludes(title, s));
    if (hit) {
      bump(cf, 10, `Level match: "${hit}"`);
    } else {
      const juniorSignals = ["junior", "intern", "graduate", "entry level", "entry-level"];
      if (juniorSignals.some((s) => textIncludes(title, s))) {
        bump(cf, -25, "Title suggests a more junior level than targeted");
      }
    }
  }

  // Type of role (full-time / contract / freelance / internship, etc.)
  if ((criteria.roleTypes || []).length) {
    const hit = criteria.roleTypes.find((t) => textIncludes(combined, t));
    if (hit) {
      bump(cf, 8, `Role type match: "${hit}"`);
    }
  }

  // Languages (spoken language requirements mentioned in the posting) — a
  // requirement the candidate must meet.
  const languageHits = anyHit(criteria.languages, combined);
  if (languageHits.length) {
    bump(cf, 5, `Language match: ${languageHits.join(", ")}`);
  }

  // Visa sponsorship — a hard requirement mismatch if you need it and the posting rules it out.
  if (criteria.visaSponsorshipRequired && /no (visa )?sponsorship|unable to sponsor|must be authorized to work/i.test(desc)) {
    bump(cf, -40, "Posting indicates no visa sponsorship, but you require it");
  }

  // ---- Everything below is about whether the role is good FOR YOU ----

  // Location / remote.
  if (criteria.remoteOk && job.remote) {
    bump(ra, 15, "Remote-friendly, matches your remote preference");
    const remoteLocHit = anyHit(criteria.remoteLocations, job.location || "");
    if (remoteLocHit.length) {
      bump(ra, 5, `Remote location match: ${remoteLocHit.join(", ")}`);
    }
  } else if ((criteria.locations || []).length) {
    const locHit = criteria.locations.find((l) => textIncludes(job.location, l));
    if (locHit) {
      bump(ra, 15, `Location match: "${locHit}"`);
    } else if (!job.remote) {
      bump(ra, -15, `Location "${job.location || "unknown"}" doesn't match your target locations`);
    }
  }

  // Minimum salary — only a soft signal since postings rarely include a clean parseable figure.
  if (criteria.minSalary && job.salary) {
    const numbers = String(job.salary).match(/\d[\d,]*/g);
    if (numbers) {
      const maxNum = Math.max(...numbers.map((n) => Number(n.replace(/,/g, ""))));
      if (maxNum && maxNum < criteria.minSalary) {
        bump(ra, -15, `Posted salary (${job.salary}) looks below your minimum (${criteria.minSalary})`);
      }
    }
  }

  // Role priorities (free-form things you care about, e.g. "remote-first", "async", "4-day week").
  const priorityHits = anyHit(criteria.rolePriorities, combined);
  if (priorityHits.length) {
    bump(ra, 6 * priorityHits.length, `Matches role priorities: ${priorityHits.join(", ")}`);
  }

  // Favourite / hidden industries.
  const sectorHits = anyHit(criteria.sectorsInclude, combined);
  if (sectorHits.length) {
    bump(ra, 10, `Favourite industry match: ${sectorHits.join(", ")}`);
  }
  const sectorExcludeHits = anyHit(criteria.sectorsExclude, combined);
  if (sectorExcludeHits.length) {
    bump(ra, -15, `Hidden industry signal: ${sectorExcludeHits.join(", ")}`);
  }

  // Favourite / hidden technologies.
  const techHits = anyHit(criteria.favouriteTechnologies, combined);
  if (techHits.length) {
    bump(ra, 8, `Favourite technology match: ${techHits.join(", ")}`);
  }
  const hiddenTechHits = anyHit(criteria.hiddenTechnologies, combined);
  if (hiddenTechHits.length) {
    bump(ra, -12, `Hidden technology signal: ${hiddenTechHits.join(", ")}`);
  }

  // Company size (soft text signal — "startup", "scale-up", "enterprise" etc.)
  const sizeHits = anyHit(criteria.companySizes, combined);
  if (sizeHits.length) {
    bump(ra, 5, `Company size match: ${sizeHits.join(", ")}`);
  }

  // Followed companies — a direct hit here is a strong positive signal regardless of other criteria.
  if ((criteria.followedCompanies || []).length) {
    const hit = criteria.followedCompanies.find((c) => textIncludes(job.company, c));
    if (hit) {
      bump(ra, 20, `From a followed company: "${hit}"`);
    }
  }

  const candidateFitScore = Math.max(0, Math.min(100, cf.score));
  const roleAppealScore = Math.max(0, Math.min(100, ra.score));
  return {
    score: Math.round((candidateFitScore + roleAppealScore) / 2),
    candidateFitScore,
    roleAppealScore,
    hardFail: false,
    reasons: [...cf.reasons, ...ra.reasons],
    reasonsByCategory: { candidateFit: cf.reasons, roleAppeal: ra.reasons },
  };
}

/**
 * AI-assisted scoring pass. Sends the job + your structured criteria + your
 * free-text "AI preferences" to Claude and asks for two qualitative 0-100
 * ratings — how well you match what the job requires, and how good the job
 * looks for you (comp, perks, holiday, culture, growth) — with reasons for
 * each. Lets you express nuance ("avoid heavily bureaucratic companies",
 * "prefer teams that ship fast", "I need at least 30 days holiday") that
 * keyword rules can't capture, especially for the second rating since it can
 * read perks/benefits straight out of the posting text. Requires
 * settings.anthropicApiKey; callers should treat a thrown error as "skip AI
 * scoring for this job" rather than fatal.
 */
async function scoreJobWithAI(job, criteria, settings, feedbackContext) {
  if (!settings.anthropicApiKey) {
    throw new Error("No Anthropic API key configured — AI-assisted scoring is unavailable.");
  }
  const model = settings.anthropicModel || "claude-sonnet-4-5";
  const prompt = [
    "You are screening a job posting for a candidate, on two SEPARATE dimensions. Respond with ONLY a JSON object, no markdown fences, no commentary:",
    '{"candidateFitScore": <0-100 integer>, "candidateFitReasons": ["short reason", "..."], "roleAppealScore": <0-100 integer>, "roleAppealReasons": ["short reason", "..."]}',
    "",
    "candidateFitScore = how well the CANDIDATE matches what THIS JOB is asking for (seniority, required skills/experience, must-haves in the posting). This is about whether they'd get hired, not whether they'd want it.",
    "roleAppealScore = how good this opportunity looks FOR THE CANDIDATE — compensation, benefits/perks, holiday/PTO, culture, growth, work-life balance, anything in the posting (or reasonably inferable) that bears on desirability. This is about whether they'd want it, not whether they'd get it.",
    "",
    `Job title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location || "unknown"}${job.remote ? " (remote)" : ""}`,
    `Salary (as posted, may be blank): ${job.salary || "not stated"}`,
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
        minSalary: criteria.minSalary,
      },
      null,
      2
    ),
    "",
    `Candidate's free-text preferences, in their own words (weight this heavily, it's the whole point of this pass — especially for roleAppealScore): "${criteria.aiPreferences || ""}"`,
    ...(feedbackContext
      ? [
          "",
          "The candidate has previously given 👍/👎 feedback on past suggested jobs, with optional notes explaining why. " +
            "Use this as a real signal of their taste — infer patterns (industries, company types, role flavours, red flags) " +
            "rather than just matching exact titles/companies, and let it adjust roleAppealScore especially:",
          feedbackContext,
        ]
      : []),
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": settings.anthropicApiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 600, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API request failed (${res.status})`);
  const data = await res.json();
  const raw = (data.content || []).map((c) => c.text || "").join("\n").trim();
  const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(jsonText);
  const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));
  return {
    candidateFitScore: clamp(parsed.candidateFitScore),
    candidateFitReasons: (parsed.candidateFitReasons || []).map((r) => `AI: ${r}`),
    roleAppealScore: clamp(parsed.roleAppealScore),
    roleAppealReasons: (parsed.roleAppealReasons || []).map((r) => `AI: ${r}`),
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
