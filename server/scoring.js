// Rule-based match scoring. Deliberately simple and fully transparent (every
// point added/subtracted comes with a human-readable reason) so you can see
// exactly why a job was surfaced or hidden, and tune criteria accordingly.
//
// `scoreJobWithAI` below adds a second pass on top of this: a free-text
// "AI preferences" field lets you describe fit in your own words, and — if
// an Anthropic API key is configured — that gets sent to Claude alongside
// the job to produce a qualitative score+reasons, blended with the
// rule-based score in discovery.js.

const { callAI, isAIConfigured } = require("./ai/client");

function textIncludes(haystack, needle) {
  if (!haystack || !needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function anyHit(list, haystack) {
  return (list || []).filter((k) => textIncludes(haystack, k));
}

// Which work arrangements (remote / hybrid / office) a criteria profile is
// open to — a multiselect (public/app.js's three checkboxes), stored as
// criteria.workArrangements. Falls back to the older boolean `remoteOk`
// field for any profile saved before this existed, so nothing already
// saved silently breaks: remoteOk:false used to only ever mean "don't
// specially favour remote roles" (see below), never "refuse in-person
// roles outright", so it maps to being open to hybrid+office but not
// remote; remoteOk:true (or the field missing entirely) maps to being
// open to everything, matching the old effectively-unrestricted default.
function getWorkArrangements(criteria) {
  if (Array.isArray(criteria.workArrangements)) return criteria.workArrangements;
  return criteria.remoteOk === false ? ["hybrid", "office"] : ["remote", "hybrid", "office"];
}

// Every rule-based signal is assigned to one of two categories, matching the
// two ratings shown in the UI:
//   candidateFit  — am I a good match for what THIS JOB requires (title,
//                   seniority, role type, language/visa requirements)?
//   roleAppeal    — is this a good opportunity FOR ME (location/remote,
//                   salary, sectors, technologies, company, priorities)?
// Each starts at a baseline and is clamped to 0-100 independently, so the
// overall "score" (their average, see bottom of this function) reflects how
// many real signals actually fired rather than starting near-neutral.
//
// Baseline + bonus sizes were recalibrated 2026-08-20 after live data showed
// two problems at once: (1) a genuinely good match — title keyword hit +
// remote-friendly, with none of the optional soft-fit fields (sectors/tech/
// company size/followed companies) filled in, the common case for a profile
// that's mostly a title/location search — was only reaching ~45, short of
// the 55 default "minimum score to surface"; and (2) a job with the WRONG
// title but still remote could independently reach ~30 purely off
// roleAppeal, not clearly reading as "irrelevant". Old weights: baseline 25,
// title-match +25, title-mismatch -20, remote +15 → a matching job averaged
// (25+25 + 25+15)/2 = 45; a wrong-title-but-remote job averaged
// (25-20 + 25+15)/2 = 30 — too close together. New weights: baseline 30,
// title-match +35, title-mismatch -35, remote +15 → a matching job now
// averages (30+35 + 30+15)/2 = 55 (right at the default threshold, with any
// extra signal — location, sector, tech, a followed company — pushing it
// further above), while a wrong-title-but-remote job averages
// (0 [30-35, clamped] + 30+15)/2 = 22.5 — clearly separated from a genuine
// match instead of both landing in the same mediocre middle.
function scoreJob(job, criteria) {
  const cf = { score: 30, reasons: [] }; // candidateFit
  const ra = { score: 30, reasons: [] }; // roleAppeal
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
    bump(cf, 35, `Title matches: ${titleHits.join(", ")}`);
  } else {
    const descHits = anyHit(criteria.titleKeywords, desc);
    if (descHits.length) {
      bump(cf, 10, `Role keywords found in description: ${descHits.join(", ")}`);
    } else if ((criteria.titleKeywords || []).length) {
      // Steeper than the old -20: a title that isn't even close to what
      // you're looking for should tank candidateFit toward the floor, not
      // just dent it — otherwise a purely appealing-but-wrong-role job (e.g.
      // remote + a favourite technology) can still average out to a
      // deceptively middling overall score. See the recalibration note
      // above scoreJob() for the worked example.
      bump(cf, -35, "No target title/role keywords found");
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

  // Location / work arrangement (remote / hybrid / office). Job boards
  // mostly only give us a boolean job.remote — there's no separate
  // structured signal for "hybrid" vs "fully in-office" — so "not remote"
  // covers both here; a profile that's open to either one is scored the
  // same way against a non-remote job, since the job data itself can't
  // distinguish them. What the multiselect DOES let you express precisely
  // (that a plain remoteOk boolean couldn't) is a genuine exclusion in
  // either direction: "only remote, no in-person roles at all" or "no
  // fully-remote roles, I want hybrid/office" — both now score as a real
  // mismatch instead of being silently ignored.
  const arrangements = getWorkArrangements(criteria);
  const wantsRemote = arrangements.includes("remote");
  const wantsInPerson = arrangements.includes("hybrid") || arrangements.includes("office");

  if (job.remote) {
    if (wantsRemote) {
      bump(ra, 15, "Remote-friendly, matches your work-arrangement preference");
      const remoteLocHit = anyHit(criteria.remoteLocations, job.location || "");
      if (remoteLocHit.length) {
        bump(ra, 5, `Remote location match: ${remoteLocHit.join(", ")}`);
      }
    } else if (arrangements.length) {
      bump(ra, -15, "This role is remote, but you've said you only want hybrid/office roles");
    }
  } else if (wantsInPerson || !arrangements.length) {
    if ((criteria.locations || []).length) {
      const locHit = criteria.locations.find((l) => textIncludes(job.location, l));
      if (locHit) {
        bump(ra, 15, `Location match: "${locHit}"`);
      } else {
        bump(ra, -15, `Location "${job.location || "unknown"}" doesn't match your target locations`);
      }
    }
  } else if (wantsRemote) {
    bump(ra, -20, "This role isn't remote, and you've said you only want remote work");
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

// ---------- Submission ease ("how quick/easy is this actually to apply to")
// ---------- Independent of your criteria profiles — this is purely about
// the posting and process itself (how much you could fill out from a saved
// CV/profile vs. custom writing, and how long/involved the process looks),
// not about whether you're a good fit. Computed for every job that has a
// description or URL, regardless of whether it also matches a profile.
const EASE_HARD_SIGNALS = [
  {
    re: /cover letter/i,
    unless: /no cover letter|without a cover letter|cover letter is not required|cover letter not required|don't need a cover letter|do not need a cover letter/i,
    delta: -10,
    reason: "Asks for a cover letter",
  },
  { re: /(writing sample|work sample|portfolio)/i, delta: -12, reason: "Asks for a work sample/portfolio" },
  {
    re: /(take[- ]home|case stud(y|ies)|assignment|assessment|coding challenge|skills test|technical test)/i,
    delta: -20,
    reason: "Includes a take-home task or assessment",
  },
  {
    re: /(multiple (interview )?rounds|several rounds|[3-9] rounds of interviews)/i,
    delta: -8,
    reason: "Mentions multiple interview rounds",
  },
  { re: /(references required|provide references|list of references)/i, delta: -6, reason: "Asks for references upfront" },
  {
    re: /(why do you want to work|tell us about yourself|answer the following questions?|short answer|screening questions?)/i,
    delta: -12,
    reason: "Includes open-ended screening questions",
  },
];
const EASE_ATS_HINTS = [
  { re: /greenhouse\.io/i, delta: 12, reason: "Hosted on Greenhouse — usually a quick, standard application form" },
  { re: /lever\.co/i, delta: 12, reason: "Hosted on Lever — usually a quick, standard application form" },
  { re: /ashbyhq\.com/i, delta: 10, reason: "Hosted on Ashby — usually a quick, standard application form" },
  { re: /workable\.com/i, delta: 10, reason: "Hosted on Workable — usually a quick, standard application form" },
  { re: /recruitee\.com/i, delta: 10, reason: "Hosted on Recruitee — usually a quick, standard application form" },
];

function scoreSubmissionEase(job) {
  const desc = job.description || "";
  const url = job.url || "";
  if (!desc.trim() && !url.trim()) {
    return { submissionEaseScore: null, easeReasons: [] };
  }

  let score = 65; // baseline: assume a fairly standard "CV + a few fields" application
  const reasons = [];
  for (const { re, unless, delta, reason } of EASE_HARD_SIGNALS) {
    if (re.test(desc) && !(unless && unless.test(desc))) {
      score += delta;
      reasons.push(reason);
    }
  }
  for (const { re, delta, reason } of EASE_ATS_HINTS) {
    if (re.test(url)) {
      score += delta;
      reasons.push(reason);
    }
  }
  const words = desc.split(/\s+/).filter(Boolean).length;
  if (words > 1200) {
    score -= 15;
    reasons.push("Very long posting — the process is likely more involved");
  } else if (words > 700) {
    score -= 8;
    reasons.push("Long posting");
  } else if (words && words < 250) {
    score += 8;
    reasons.push("Short, focused posting");
  }

  return { submissionEaseScore: Math.max(0, Math.min(100, Math.round(score))), easeReasons: reasons };
}

async function scoreSubmissionEaseWithAI(job, settings) {
  const prompt = [
    "You are estimating how EASY and QUICK a job application would be to actually submit — NOT whether the candidate is a good fit. Respond with ONLY a JSON object, no markdown fences, no commentary:",
    '{"submissionEaseScore": <0-100 integer>, "easeReasons": ["short reason", "..."]}',
    "",
    "submissionEaseScore = 100 means: a short, standard application (upload CV, basic contact fields, maybe 1-click apply) that could be filled out almost entirely from a saved CV/profile in a couple of minutes.",
    "submissionEaseScore = 0 means: a long, custom application requiring a cover letter, multiple open-ended written answers, a take-home assignment/case study/portfolio, or several interview rounds described up front.",
    "Base this ONLY on what the posting says about the application/hiring process, plus how long and detailed the posting itself is (a very long, dense posting usually signals a more involved process). Do not consider whether the candidate is qualified for the role.",
    "",
    `Job title: ${job.title}`,
    `Company: ${job.company}`,
    `Posting URL: ${job.url || "not stated"}`,
    `Job description: ${(job.description || "").slice(0, 3000)}`,
  ].join("\n");

  const raw = await callAI(settings, { prompt, maxTokens: 400 });
  const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(jsonText);
  const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));
  return {
    submissionEaseScore: clamp(parsed.submissionEaseScore),
    easeReasons: (parsed.easeReasons || []).map((r) => `AI: ${r}`),
  };
}

/**
 * Combines the rule-based and (if configured) AI-assisted submission-ease
 * passes, same blending pattern as the fit/appeal scores above. Always
 * computed automatically wherever a job is scored (manual add, edited via
 * PATCH, discovered, or backfilled at startup) — there's no separate button
 * for this, it just happens alongside the rest of scoring.
 */
async function scoreSubmissionEaseFull(job, settings) {
  let result = scoreSubmissionEase(job);
  if (isAIConfigured(settings) && job.description && job.description.trim()) {
    try {
      const ai = await scoreSubmissionEaseWithAI(job, settings);
      result =
        result.submissionEaseScore == null
          ? ai
          : {
              submissionEaseScore: Math.round((result.submissionEaseScore + ai.submissionEaseScore) / 2),
              easeReasons: [...result.easeReasons, ...ai.easeReasons],
            };
    } catch (e) {
      console.error(`[scoring] AI ease scoring failed for "${job.title}":`, e.message);
    }
  }
  return result;
}

/**
 * AI-assisted scoring pass. Sends the job + your structured criteria + your
 * free-text "AI preferences" to Claude and asks for two qualitative 0-100
 * ratings — how well you match what the job requires, and how good the job
 * looks for you (comp, perks, holiday, culture, growth) — with reasons for
 * each. Lets you express nuance ("avoid heavily bureaucratic companies",
 * "prefer teams that ship fast", "I need at least 30 days holiday") that
 * keyword rules can't capture, especially for the second rating since it can
 * read perks/benefits straight out of the posting text. Requires an AI
 * provider configured in settings (see server/ai/client.js — works with a
 * free provider like Groq or Gemini, not just Anthropic); callers should
 * treat a thrown error as "skip AI scoring for this job" rather than fatal.
 */
async function scoreJobWithAI(job, criteria, settings, feedbackContext) {
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

  const raw = await callAI(settings, { prompt, maxTokens: 600 });
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

module.exports = { scoreJob, scoreJobWithAI, buildFeedbackContext, scoreSubmissionEaseFull };
