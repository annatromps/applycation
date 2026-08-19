// One-off seed script: loads Anna's real CV/cover-letter data (pulled from
// the JA project's career-research-notes.md + build_cv.js) into the app as
// the first candidate profile + a starter criteria profile, so the app is
// immediately useful rather than starting from a blank slate.
//
// Run once with: node seed-anna.js

const db = require("./server/db");

const candidateProfile = {
  name: "Anna Trompetas",
  email: "anna@trompetas.co.uk",
  phone: "+44 7951 379953",
  linkedin: "linkedin.com/in/anna-trompetas-047a0b59",
  headline: "Senior Product Manager",
  summary:
    "Oxford graduate and Senior Product Manager with 7+ years' experience across fintech, banking, legal, supply chain, healthcare, education, gaming/VR and hospitality sectors, including enterprise B2B SaaS and product-led growth. Owns product delivery end-to-end for enterprise clients in regulated industries such as financial services, defence and FMCG, and is currently leading the engineering build of a self-serve, product-led growth tier for SME customers. Skilled at translating market research and stakeholder input into prioritised roadmaps, feature evaluation frameworks and quality initiatives that reduce defects and improve delivery predictability.",
  skills: [
    {
      label: "Product",
      value:
        "Product strategy & vision, product-led growth & self-serve onboarding, customer retention, AI-assisted design & prototyping, roadmap ownership, executive & board-level stakeholder management, cross-functional team leadership, enterprise & regulated-industry delivery, risk & compliance management, feature evaluation frameworks, release & QA strategy, competitive strategy, PRDs & specs, Agile/Scrum at scale",
    },
    {
      label: "Tools",
      value: "Jira, Confluence, Product Board, Trello, Figma, Moqups, Slack, Git, React, Ruby on Rails, Replit, Claude, Scribe, Loom, Google Workspace",
    },
  ],
  experience: [
    {
      title: "Senior Product Manager",
      company: "Brooklyn Solutions",
      dates: "Nov 2024 – Present",
      subtitle: "Enterprise SaaS supplier & third-party risk platform · Fintech, Banking, Legal, Supply Chain",
      bullets: [
        "Leading engineering delivery of Brooklyn Flex, the company's 2026 product-led growth initiative: a self-serve SME subscription tier built on automated, in-app onboarding, replacing the existing model of bespoke development for a small number of large enterprise accounts; manage the development team building the platform.",
        "Growing Brooklyn's product function by hiring a Junior Product Manager, who will report directly to me.",
        "Own product delivery end-to-end for enterprise SaaS clients in regulated financial services, defence and FMCG, leading cross-functional work spanning engineering, customer success and compliance stakeholders, including as named Product Owner Leader on a major utilities-sector implementation and Product/UX escalation lead on a critical account recovery plan.",
        "Authored and drove adoption of a company-wide feature evaluation framework, used to prioritise the product roadmap across supplier risk management, contract management and compliance modules serving nine enterprise clients.",
        "Led a cross-functional platform quality initiative spanning QA policy enforcement, automated testing strategy and risk-based test coverage prioritisation, cutting release defects tied to incomplete testing across multiple enterprise accounts.",
        "Designed and led a release cadence overhaul, introducing a tiered release model (Early Access, Standard, Stable) with a dedicated bug fast-track pipeline; identified a compounding backport risk from environment drift and proposed a hotfix pipeline lane and automated backport tooling.",
      ],
    },
    {
      title: "Product Manager",
      company: "Oxford Medical Simulation",
      dates: "Jul 2023 – Nov 2024",
      subtitle: "VR training solutions for healthcare professionals · Healthcare, B2C, B2B, Education, Gaming, VR",
      bullets: [
        "Led product ownership for the company's web application, overseeing development and ensuring seamless integration with VR client software and the gaming engine.",
        "Conducted market research within a growing healthcare customer base across the US and Europe to identify key trends and opportunities.",
        "Established and monitored KPIs to measure product success and guide data-driven decisions; managed risk assessments and mitigation strategies for new features and integrations.",
        "Owned and facilitated Product Refinement sessions across feature and integration teams, and ran daily stand-ups, sprint planning and retrospectives under Agile practices.",
        "Managed the product roadmap using Product Board, Jira and Confluence to align business priorities with technical capabilities, and created detailed PRDs from market research, user feedback and business objectives.",
      ],
    },
    {
      title: "Product Manager",
      company: "wi-Q",
      dates: "Mar 2023 – Jul 2023",
      subtitle: "Digital ordering solutions for the hospitality industry · Hospitality, B2B",
      bullets: [
        "Collaborated with the Head of Product to prioritise new features and integrations based on projected MRR, client requests and competitor analysis.",
      ],
    },
    {
      title: "Head of Modern Foreign Languages",
      company: "Old Palace of John Whitgift School",
      dates: "Sep 2019 – Mar 2023",
      subtitle: "High-achieving independent girls' secondary school · Education · promoted from classroom teacher after one year",
      bullets: [
        "Developed curriculum and schemes of work for the Modern Foreign Languages department.",
        "Led a large, diverse team in a fast-paced, high-stakes environment, with a focus on communication, organisation, collaboration and motivation.",
      ],
    },
    {
      title: "Product Manager",
      company: "Worldpay",
      dates: "Jul 2016 – Sep 2019",
      subtitle: "Global payment processing solutions for businesses · Fintech",
      bullets: [
        "Built the retentions product used by Worldpay's retentions team across thousands of self-serve SMB merchants, identifying and presenting tailored offers to accounts calling to cancel.",
        "Modernised and consolidated a global payment system to enhance efficiency and automation.",
        "Facilitated product delivery in an Agile environment, bridging stakeholders, developers and testers.",
        "Initiated, defined and delivered new features: gathering requirements, writing user stories, prioritising tasks and managing sprints.",
        "Partnered with business stakeholders and engineering teams to develop technical and product roadmaps.",
      ],
    },
  ],
  education: [
    { school: "UCL Institute of Education", dates: "2019 – 2020", detail: "PGCE (Secondary MFL), Secondary Education and Teaching" },
    { school: "University of Oxford", dates: "2010 – 2014", detail: "BA, Spanish and Linguistics" },
    { school: "Croydon High School", dates: "2008 – 2010", detail: "A Levels (AAAB): Maths, Further Maths, Spanish, History" },
    { school: "Croydon High School", dates: "2003 – 2008", detail: "GCSEs (10 A*s): Maths, Triple Science, Latin, French, Spanish, English Language, English Literature" },
  ],
  additional: [
    { label: "Languages", value: "English (native), Spanish" },
    { label: "Interests", value: "Free-diving, scuba-diving, travelling, cooking, cryptic crosswords, published dystopian novelist." },
  ],
  talkingPoints: [
    {
      keywords: ["growth", "plg", "self-serve", "acquisition", "retention", "onboarding"],
      text:
        "I've worked both ends of product-led growth: at Worldpay I built the retentions product used across thousands of self-serve SMB merchants, and at Brooklyn Solutions I'm currently leading the self-serve build for Brooklyn Flex, a new SME subscription tier.",
    },
    {
      keywords: ["management", "manager", "lead", "leadership", "people", "team", "mentor"],
      text:
        "I have direct people-management experience from two directions: I'm currently hiring a Junior Product Manager at Brooklyn Solutions who will report to me, and before that I led a team of teachers for four years as Head of Modern Foreign Languages, promoted from classroom teacher after just one year.",
    },
    {
      keywords: ["analytics", "data", "forecasting", "pricing", "recommendation", "decision", "insights", "dashboard"],
      text:
        "At Worldpay, the retentions product I built was fundamentally an analytics-driven decision-support tool: it surfaced account data to identify the right tailored offer at the moment a customer tried to cancel.",
    },
    {
      keywords: ["healthcare", "health", "medical", "clinical", "patient"],
      text:
        "I have genuine healthtech experience from Oxford Medical Simulation, where I led product ownership of the web application behind VR training simulations for healthcare professionals, including market research across US and European healthcare customers.",
    },
    {
      keywords: ["enterprise", "b2b", "saas", "regulated", "compliance", "risk", "financial services", "fintech"],
      text:
        "At Brooklyn Solutions I own product delivery end-to-end for enterprise clients in regulated industries including financial services, defence and FMCG, and authored a company-wide feature evaluation framework used across nine enterprise clients.",
    },
    {
      keywords: ["ai", "prototyping", "figma", "design"],
      text: "I use AI-assisted design and prototyping in my own workflow (Figma, Moqups, Replit), alongside Claude for day-to-day product work.",
    },
    {
      keywords: ["hospitality", "hotel", "travel"],
      text:
        "I have direct hospitality-sector experience from wi-Q, a hospitality ordering and payment platform, where I prioritised the roadmap against projected MRR, client requests and competitor analysis.",
    },
  ],
  houseRules: {
    bannedPhrases: ["once things get sticky"],
    notes:
      "Never use em dashes. Avoid stock AI-sounding phrasing. Plain, concise, first-person tone, short paragraphs, direct sentences. Don't fabricate experience to close a gap; name real gaps plainly if relevant rather than staying silent, and lean on genuine adjacent strengths instead.",
  },
};

const starterCriteria = {
  name: "Senior PM / Product Lead (default)",
  active: true,
  // Location
  locations: ["United Kingdom", "UK", "London", "Remote"],
  remoteOk: true,
  remoteLocations: ["UK", "EU", "Worldwide"],
  visaSponsorshipRequired: false,
  languages: [],
  // Role
  titleKeywords: ["Senior Product Manager", "Product Lead", "Group Product Manager", "Staff Product Manager"],
  excludeKeywords: ["Junior", "Associate Product Manager"],
  roleTypes: ["Full-time"],
  seniority: ["Senior", "Lead", "Staff", "Group"],
  minSalary: null,
  rolePriorities: [],
  dealbreakers: [],
  // Industries
  sectorsInclude: ["SaaS", "fintech", "healthtech", "B2B"],
  sectorsExclude: [],
  // Technologies
  favouriteTechnologies: [],
  hiddenTechnologies: [],
  // Company
  companySizes: [],
  followedCompanies: [],
  // Free text used by the optional AI-assisted scoring pass — placeholder,
  // edit in Settings to actually put this to use.
  aiPreferences: "",
  sources: {
    remotive: true,
    arbeitnow: true,
    remoteok: true,
    greenhouse: { enabled: false, companies: [] },
    lever: { enabled: false, companies: [] },
  },
};

(async () => {
  const data = await db.read();
  data.candidateProfile = candidateProfile;
  if (!data.criteriaProfiles.length) {
    starterCriteria.id = require("crypto").randomUUID();
    data.criteriaProfiles.push(starterCriteria);
  }
  await db.write(data);
  console.log("Seeded candidate profile and a starter criteria profile. Edit both in Settings.");
})();
