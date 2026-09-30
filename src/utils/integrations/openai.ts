import OpenAI from "openai";
import env from "../../config/env.js";
import { withRetry } from "../retry.js";
import { createLimiter } from "../concurrencyLimiter.js";

// API key is loaded from process.env.OPENAI_API_KEY via config/env.ts
// (`env.openai_secret`). dotenv loads `.env` in app.ts (`import "dotenv/config"`).
// Personality / personalized questions are persisted in the `questions` table
// after a successful generation — reopening AI Config fetches those rows and
// does not call OpenAI again.
const openai = new OpenAI({ apiKey: env.openai_secret });

// Single choke point for all OpenAI calls: caps concurrency so bursts (batch CV
// scoring, many CV uploads) don't blow through OpenAI's rate limit, and retries
// transient failures (429/5xx/timeouts) so fire-and-forget callers don't silently
// drop work on a momentary blip.
const limiter = createLimiter(5);

const runCompletion = (params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming) =>
  limiter.run(() =>
    withRetry(() => openai.chat.completions.create(params), { label: "OpenAI chat completion" })
  );

const runEmbedding = (params: OpenAI.Embeddings.EmbeddingCreateParams) =>
  limiter.run(() =>
    withRetry(() => openai.embeddings.create(params), { label: "OpenAI embedding" })
  );

export const gradeAssessmentAnswers = async (
  questionsJSON: string
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const prompt = `You are an automated response scoring system.

  You will be given a JSON stringified array of objects. The objects are called the Assessment object. The content of each Assessment object is explained as follows:

  The Assessment object has 4 fields. Each field is described as follows:

  1. question: The question that was asked to a candidate.
  2. questionId: The question's unique id.
  3. answer: the candidates answer to the question.
  4. criteria: The criteria that is being considered for scoring the candidate's a answer to the question.

  For each assessment object, your task is to generate an appropriate score of the candidate's answer based on the criteria field. That is, based on the criteria stated in the scoring criteria field, you should score the candidate's answers  on a 1 to 5 scale. The scale is defined below:

  1 - poor
  2 - unsatisfactory
  3 - satisfactory
  4 - very satisfactory
  5 - outstanding.

  For each score, question and answer you will generate a Response object has 3 fields similar to the Assessment object. Each field is described as follows:

  1. question: The unique id of the question that was asked to a candidate.
  2. answer: the candidates answer to the question.
  3. score: The score you generated for that question.

  Your output should be a JSON array of the Response objects. For example
  '{
    "responses":[
      {"question": "665db00404f56afe4af4209d", "answer": ...,"score":3},
      {"question": "665d75ed550cfb80a8993390", "answer": ...,"score":4},
      ...
    ]
  }', the length of the array of Response objects must match the length of the array of the Assessment object`;

  const completion = await runCompletion({
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: questionsJSON },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });
  return completion.choices[0];
};

export const createEmbedding = async (text: string | string[]) => {
  const embedding = await runEmbedding({
    model: "text-embedding-3-small",
    input: text,
    encoding_format: "float",
    dimensions: 512,
  });
  return embedding.data;
};

export const generatePersonalizedQuestions = async (
  jobDescription: string,
  cv: Array<string>,
  bio: string,
  questionNo: number,
  recruiterGuide: string
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const system = `You are an expert hiring interviewer writing a thorough, role-specific screening for one candidate applying to this job.

Rules:
- Generate exactly ${questionNo} distinct open-ended questions.
- Cover as many hiring-relevant scenarios as the count allows, choosing from: claimed technical depth vs this role, past delivery under constraints, stakeholder/communication, collaboration/conflict, judgment and trade-offs, measuring impact, handling ambiguity, quality/risk, and gaps between the CV and the job.
- Ground every question in concrete details from the CV, bio, job description, or recruiter guide. Do not invent employers, skills, dates, or achievements that are not in the materials.
- Each question must make a weaker candidate struggle and a strong fit able to show evidence — not merely restate the CV.
- Prioritize the recruiter guide when it conflicts with generic interview practice.
- Do not ask generic icebreakers, illegal/discriminatory questions, or closed yes/no questions.
- Questions must differ in scenario and intent — no paraphrases.

Output JSON only:
{
  "questions": ["<question 1>", "<question 2>"]
}`;
  const prompt = `Job description:
${jobDescription}

Talent CV:
${cv.join("\n\n")}

Talent bio:
${bio || "Not provided"}

Recruiter guide:
${recruiterGuide || "Not provided"}

Generate ${questionNo} personalized interview question(s).`;
  const completion = await runCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });
  return completion.choices[0];
};

export const gradePersonalizedAnswers = async (
  questionsJSON: string,
  recruiterGuide: string
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const prompt = `You are an automated response scoring system.

  You will be given a JSON stringified array of objects. The objects are called the Assessment object. The content of each Assessment object is explained as follows:

  The Assessment object has 3 fields. Each field is described as follows:

  1. question: The questions that was asked to a candidate.
  2. questionId: The question's unique id.
  3. answer: the candidates answer to the question.

  For each assessment object, your task is to generate an appropriate score of the candidate's answer, you should score the candidate's answers  on a 1 to 5 scale. The scale is defined below:

  1 - poor
  2 - unsatisfactory
  3 - satisfactory
  4 - very satisfactory
  5 - outstanding.

  Consider this guide for grading ${recruiterGuide}

  For each score, question and answer you will generate a Response object has 3 fields similar to the Assessment object. Each field is described as follows:

  1. question: The unique id of the question that was asked to a candidate.
  2. answer: the candidates answer to the question.
  3. score: The score you generated for that question.

  Your output should be a JSON array of the Response objects. For example
  '{
    "responses":[
      {"question": "665db00404f56afe4af4209d", "answer": ...,"score":3},
      {"question": "665d75ed550cfb80a8993390", "answer": ...,"score":4},
      ...
    ]
  }', the length of the array of Response objects must match the length of the array of the Assessment object`;

  const completion = await runCompletion({
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: questionsJSON },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });
  return completion.choices[0];
};

const DICHOTOMY_LABELS: Record<string, [string, string]> = {
  EI: ["Extraversion (E)", "Introversion (I)"],
  SN: ["Sensing (S)", "Intuition (N)"],
  TF: ["Thinking (T)", "Feeling (F)"],
  JP: ["Judging (J)", "Perceiving (P)"],
};

export const getPersonalityEvaluationQuestion = async (
  jobDescription: string,
  dichotomyPair: string,
  count = 1
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const pair = DICHOTOMY_LABELS[dichotomyPair] ?? [
    dichotomyPair[0] ?? "A",
    dichotomyPair[1] ?? "B",
  ];
  const system = `You are an organizational psychologist designing workplace MBTI-style screening questions.

Rules:
- Generate exactly ${count} open-ended question${count > 1 ? "s" : ""} for the ${dichotomyPair} dichotomy (${pair[0]} vs ${pair[1]}).
- Situate questions in realistic workplace scenarios relevant to the job description.
- Each question must elicit behavioral evidence of preference toward one pole of the dichotomy, without being leading or moralizing.
- Do not mention MBTI, dichotomy letters, or the trait names in the question text.
- Do not invent company-specific facts that are not in the job description.
- Questions must be distinct in scenario and intent — no paraphrases.
- Keep each question to 1–3 sentences, clear enough for a candidate to answer in a short paragraph.

Output JSON only:
{
  "questions": ["<question text>", "..."]
}`;
  const prompt = `Job description:
${jobDescription}

Dichotomy pair: ${dichotomyPair} (${pair[0]} vs ${pair[1]})
Generate ${count} workplace question${count > 1 ? "s" : ""} that distinguish ${pair[0]} from ${pair[1]}.`;
  const completion = await runCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });
  return completion.choices[0];
};

export const evaluatePersonalityType = async (
  questionsJSON: string
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const prompt = `You are an automated MBTI personality evaluation system.

  You will be given a JSON stringified array of 4 objects, referred to as Assessment objects. Each Assessment object contains the following fields:

  1. question: The question that was asked to a candidate to determine their personality.
  2. questionId: The unique ID of the question.
  3. answer: The candidate's answer to the question.
  4. dichotomy: The dichotomy pair being tested, which can be one of the following: "EI", "SN", "TF", or "JP".
  Your task is to evaluate each Assessment object and determine the candidate's preference based on their answer and the dichotomy field. For each preference, question, and answer, you will generate a Response object containing the following fields:

  1. question: The unique ID of the question.
  2. answer: The candidate's answer to the question.
  3. dichotomyPreference: The determined preference for that question.
  Using the preferences obtained from the assessments, determine the candidate's MBTI type based on their preferences in the four dichotomies.

  Your output should be a JSON object containing the MBTI type and an array of Response objects. For example:
  '{
  "responses": [
    {"question": "665db00404f56afe4af4209d", "answer": "...", "dichotomyPreference": "E"},
    {"question": "665d75ed550cfb80a8993390", "answer": "...", "dichotomyPreference": "S"},
    {"question": "665db00404f56afe4af4230d", "answer": "...", "dichotomyPreference": "T"},
    {"question": "665d75ed550cfb80a8993690", "answer": "...", "dichotomyPreference": "J"}
  ],
  "mbtiType": "ESTJ"
}
'`;
  const completion = await runCompletion({
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: questionsJSON },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });
  return completion.choices[0];
};

export interface ScoutAssessmentContext {
  cv: string;
  jobBrief: string;
  recruiterGuide: string;
  roleName: string;
  experienceLevel?: string | null;
  mustHaveSkills?: string[] | null;
  niceToHaveSkills?: string[] | null;
  workMode?: string | null;
  location?: string | null;
  coverLetter?: string | null;
}

/**
 * Strict JSON schema for a scout assessment. Structured outputs (rather than the
 * looser `json_object` mode used elsewhere in this file) mean the model cannot
 * return a shape we don't expect, which is what makes a run's scoring reliable
 * enough to retry only on genuine failures.
 *
 * `required` must list every property and every object needs
 * `additionalProperties: false` — OpenAI rejects a strict schema otherwise.
 */
const SCOUT_ASSESSMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "overallScore",
    "skillsScore",
    "experienceScore",
    "locationFit",
    "mustHaveSkillsMet",
    "mustHaveSkillsMissing",
    "recommendation",
    "strengths",
    "concerns",
    "candidate",
  ],
  properties: {
    overallScore: { type: "number", description: "0-100 overall fit against this campaign" },
    skillsScore: { type: "number", description: "0-100 skills match" },
    experienceScore: { type: "number", description: "0-100 experience match" },
    locationFit: { type: "number", description: "0-100 how well location and work setup fit" },
    mustHaveSkillsMet: { type: "array", items: { type: "string" } },
    mustHaveSkillsMissing: { type: "array", items: { type: "string" } },
    recommendation: {
      type: "string",
      description: "Plain-English reason for this verdict, 2-4 short sentences",
    },
    strengths: { type: "array", items: { type: "string" } },
    concerns: { type: "array", items: { type: "string" } },
    candidate: {
      type: "object",
      additionalProperties: false,
      required: [
        "fullName",
        "email",
        "phone",
        "city",
        "state",
        "country",
        "headline",
        "yearsExperience",
        "skills",
      ],
      properties: {
        fullName: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
        phone: { type: ["string", "null"] },
        city: { type: ["string", "null"] },
        state: { type: ["string", "null"] },
        country: { type: ["string", "null"] },
        headline: {
          type: ["string", "null"],
          description: "One short line, e.g. 'Enterprise account executive, fintech'",
        },
        yearsExperience: { type: ["number", "null"] },
        skills: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

export const scoutAssessCandidate = async (
  context: ScoutAssessmentContext
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const prompt = `You assess one candidate's CV against a recruiter's scouting campaign.

The recruiter's own instructions are the highest authority. Follow them even when they
conflict with your general judgement about what makes a good candidate.

How to weigh the campaign:
- Must-have skills are near-disqualifying. A candidate missing one cannot score above 45
  overall, however strong they otherwise look. List exactly which ones are met and missing.
- Nice-to-have skills break ties between candidates who otherwise look alike. They never
  rescue a missing must-have.
- Judge experience against the seniority the role expects. Far below it is a real concern;
  far above it is worth flagging as a possible flight risk, not silently rewarded.
- If a location or work setup is given, judge whether this person can realistically work
  the role. If the CV says nothing about location, score locationFit 50 and say so rather
  than guessing.

Writing the recommendation — this is read by a busy hiring manager with no technical
background, so:
- 2 to 4 short sentences. No bullet points, no headings, no markdown.
- Everyday words. No jargon, no buzzwords, no "leverage", "synergy" or "utilise".
- Always name the specific evidence from the CV that led to your view, not a generic verdict.
  Say "She ran a 12-person support team at Paystack for three years" rather than
  "strong leadership experience".
- Be honest about weaknesses. A recommendation that only praises is useless.

Extract the candidate's details from the CV. Use null for anything not present — never
guess, never invent an email or phone number. Scores are numbers between 0 and 100.`;

  const completion = await runCompletion({
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: JSON.stringify(context) },
    ],
    model: "gpt-4o",
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "scout_assessment",
        strict: true,
        schema: SCOUT_ASSESSMENT_SCHEMA,
      },
    },
  });
  return completion.choices[0];
};

export interface ScoutShortlistSummaryContext {
  roleName: string;
  jobBrief: string;
  candidates: Array<{ rank: number; name: string; score: number; recommendation: string }>;
}

/**
 * One comparative paragraph over the (at most 10) shortlisted candidates. Cheap
 * enough for gpt-4o-mini and runs once per run, not once per CV.
 */
export const scoutShortlistSummary = async (
  context: ScoutShortlistSummaryContext
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const prompt = `You summarise a finished shortlist for the recruiter who ran it.

Write one short paragraph, 3 to 5 sentences, in plain everyday English. Say who came out
on top and why, note anything the whole shortlist has in common, and flag any gap the
recruiter should be aware of before interviewing. No bullet points, no markdown, no
restating each candidate one by one.

Return JSON: { "summary": "<your paragraph>" }`;

  const completion = await runCompletion({
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: JSON.stringify(context) },
    ],
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
  });
  return completion.choices[0];
};

export interface TalentFitContext {
  jobDescription: string;
  cvText: string;
}

// Lightweight evidence pass for sourcing lists (top-N cosine-similarity
// matches) — deliberately separate from scoutAssessCandidate, which does the
// full scored assessment behind a scouting run and is far more expensive.
export const assessTalentFit = async (
  context: TalentFitContext
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const system = `You are a technical recruiter sourcing candidates for a role.

  You will receive a job description and a candidate's CV text. Provide a brief, evidence-based assessment of this candidate's fit for the role, citing specific details from the CV.

  Every strength and weakness must name a concrete source (an employer, project, skill, or dated experience from the CV) — never generic praise like "strong communicator" or "good potential" without a fact behind it. If the CV lacks evidence for something the role needs, list that gap explicitly as a weakness rather than omitting it.

  Output JSON:
  {
    "strengths": ["<specific strength, citing evidence from the CV>", "..."],
    "weaknesses": ["<specific gap or concern relative to the job description, citing evidence>", "..."]
  }`;

  const completion = await runCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(context) },
    ],
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
  });
  return completion.choices[0];
};

export interface MatchVerdictContext {
  jobDescription: string;
  skills?: string[];
  requirements?: string | null;
  goals?: string[];
  recruiterGuide?: string;
  cvSimilarityScore: number | null;
  personalizedScore: number | null;
  prescreeningScore: number | null;
  mbtiType: string | null;
  cvText?: string;
  personalizedQuestionsAndAnswers?: Array<{ question: string; answer: string }>;
  personalityQuestionsAndAnswers?: Array<{ question: string; answer: string; dichotomy?: string }>;
  talentLocation?: { city?: string; state?: string; country?: string };
  workType?: string[];
  experience?: string;
  talentName?: string;
  talentBio?: string;
}

export const assessApplicationMatch = async (
  context: MatchVerdictContext
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const system = `You are a senior hiring panel member writing an evidence-based screening report a recruiter can act on.

You will receive a JSON object with pipeline scores, optional CV text, optional Q&A answers, the job description, optional skills/requirements/goals, an optional recruiter guide, optional location / work-type / experience fields, and optional talent name/bio.

Your job is to explain clearly why this candidate is a good or poor fit, using only verified information in the JSON.

Writing standard:
- Every claim must name a concrete source: a CV employer/project/skill, a quoted screening answer, a numeric score, or a stated profile field.
- reasoning, whyFit, whyHire, and hiringRationale must each open with a one-sentence verdict (e.g. "Strong fit for this role." / "Not a fit for this role.") before the supporting evidence — a recruiter reading only the first sentence should already know the call.
- Keep each of reasoning, whyFit, whyHire, and hiringRationale to 2-4 sentences total, including the opening verdict sentence. Concise and specific beats long and padded.
- whyFit, whyHire, reasoning, and hiringRationale must read like a briefing, not a template. Name tools, companies, projects, and answer details that actually appear in the input.
- Good example: "Strong fit for this role. They have five years of Kubernetes operations at Seed Co, described rolling back a failed deploy by isolating the canary, and their CV lists production on-call ownership that matches this role's reliability goal."
- Bad example: "This candidate is a good communicator with relevant experience and would be a culture fit." — never write like this: no verdict, no evidence, generic praise.
- If evidence is thin, say exactly what is missing. Never invent employers, skills, dates, metrics, answers, or achievements.
- Never use protected characteristics (race, gender, age, religion, disability, marital status, pregnancy, nationality as a proxy for identity) even if they appear in the CV.
- Do not assume soft skills, seniority, or culture fit that are not evidenced.

When skills or requirements are provided, judge fit primarily against them rather than the general job description.

Screening-question feedback (questionFeedback):
- Emit one object for every item in personalizedQuestionsAndAnswers, in the same order.
- Then emit one object for every item in personalityQuestionsAndAnswers, if present.
- Each object must explain: what the candidate actually answered (quote or close paraphrase), what that answer demonstrates, and how their CV/verified experience supports, contradicts, or does not cover it.
- Good example: "The candidate explained their approach to incident response by paging the on-call, freezing deploys, then running a blameless review. This demonstrates structured production judgment. Their work at Acme also stands out because the CV lists ownership of a payments rollback playbook, which is relevant to this SRE role."
- If there are no Q&A arrays, return an empty questionFeedback array.
- Personality/MBTI evidence belongs in assessmentInsights and in those questionFeedback items. Only weigh personality in the verdict if the recruiter guide explicitly asks for culture or personality fit.

Map the hiring recommendation as:
- high + hire → Strong Fit (hire / shortlist)
- medium + interview_further → Potential Fit (review)
- low + no_hire → Poor Fit (bounce / reject)

Output JSON:
{
  "verdict": "high" | "medium" | "low",
  "recommendation": "hire" | "interview_further" | "no_hire",
  "reasoning": "<2-4 sentences, opening with the verdict, then the evidence behind it — naming specific CV facts and answer details>",
  "strengths": ["<specific strength with cited evidence>", "..."],
  "weaknesses": ["<specific weakness or gap with cited evidence>", "..."],
  "risks": ["<specific hiring risk with cited evidence>", "..."],
  "overallFitScore": 0,
  "whyFit": "<2-4 sentences opening with the verdict, then good or poor fit because of X experience, Y demonstrated skill, and Z company/project — all from the input>",
  "whyHire": "<2-4 sentences opening with the verdict, then whether to hire/interview/reject, grounded in the same evidence>",
  "strongestQualifications": ["<qualification tied to a CV or answer fact>"],
  "relevantExperience": ["<employer, project, or achievement from the CV and why it matters for this role>"],
  "prescreeningInsights": { "strengths": ["..."], "weaknesses": ["..."] },
  "assessmentInsights": "<optional; personalized + personality only if those stages are in the payload>",
  "questionFeedback": [
    {
      "question": "<the screening question text>",
      "whatTheyAnswered": "<specific summary of their response, quoting key phrases>",
      "whatItDemonstrates": "<the skill or gap this answer shows>",
      "experienceLink": "<how their CV/verified experience supports, contradicts, or does not cover this — or state that no matching CV evidence was provided>"
    }
  ],
  "missingRequirements": ["..."],
  "conflictingRequirements": ["..."],
  "keyEvidence": ["quoted evidence from the CV or answers"],
  "hiringRationale": "<2-4 sentences for the board pack, opening with the verdict, still specific and evidence-based>"
}

overallFitScore must be an integer 0–100. Provide at least one strength when any positive evidence exists. Provide at least one weakness or risk unless the match is outstanding on all available evidence.`;

  const completion = await runCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(context) },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });
  return completion.choices[0];
};

export interface PreScreeningProfileContext {
  bio?: string;
  roles: string[];
  cvContent: string;
  experience?: string;
  workType?: string[];
  location?: { city?: string; state?: string; country?: string };
  isRetake?: boolean;
  previousQuestions?: string[];
}

export interface PreScreeningScoringContext {
  questions: Array<{
    questionId: string;
    question: string;
    category: string;
    options: string[];
    correctOption: number;
    intent: string;
    scoringHint?: string;
    selectedOption: number;
  }>;
  profileContext: PreScreeningProfileContext;
}

export const generatePreScreeningAssessment = async (
  context: PreScreeningProfileContext
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const priorQuestionsList = context.previousQuestions?.length
    ? `\n\nDo not repeat or closely rephrase any of these prior questions:\n${context.previousQuestions.map((q) => `- ${q}`).join("\n")}`
    : "";

  const retakeInstruction = context.isRetake
    ? `\n\nIMPORTANT: This is a RETAKE assessment. You MUST generate entirely different scenarios, different situations, different wording, and different answer structures from any prior assessment for this candidate.${priorQuestionsList}`
    : "";

  const system = `You are a senior hiring panel designing a rigorous pre-screening assessment.
Your job is to SCREEN and STRESS-TEST the candidate against the role(s) and experience they claim on their CV — not to confirm that they already know the basics.

The assessment must contain between 5 and 10 multiple-choice questions covering: professional_competency, practical_problem_solving, communication, behavioral, cultural, leadership, emotional_intelligence.

Question design rules:
- Ground every question in the candidate's stated roles, tools, domain, seniority, and CV achievements.
- Prefer realistic workplace scenarios, trade-offs, failure modes, prioritization, and judgment calls over definition or trivia questions.
- Do not ask questions whose correct answer is a restatement of something already written on the CV (e.g. "Have you used X?"). Probe HOW they would apply claimed skills under pressure, with incomplete information, or when two good options conflict.
- Wrong options must be plausible to a practitioner who only has surface-level knowledge of the claimed area.
- Mix categories; at least half of the items must be scenario-based.
- Spread the correct answer across options A, B, C, and D. Do not place the correct answer in the same position (especially B) for every question.
- Do not invent employers, certifications, or skills that are not in the profile or CV.${retakeInstruction}

Output a JSON object in this exact format:
{
  "questions": [
    {
      "questionId": "<uuid-v4>",
      "question": "<the question text>",
      "category": "<one of the 7 categories>",
      "options": ["<option A>", "<option B>", "<option C>", "<option D>"],
      "correctOption": <0|1|2|3>,
      "intent": "<what this question reveals about the candidate>",
      "scoringHint": "<what strong vs weak answers look like>"
    }
  ]
}`;

  const userPrompt = `Candidate Profile:
Roles: ${context.roles.join(", ")}
Experience Level: ${context.experience ?? "Not specified"}
Bio: ${context.bio ?? "Not provided"}
Work Type: ${context.workType?.join(", ") ?? "Not specified"}
Location: ${context.location ? `${context.location.city ?? ""} ${context.location.state ?? ""} ${context.location.country ?? ""}`.trim() : "Not specified"}

CV Content:
${context.cvContent}`;

  const completion = await runCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPrompt },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });
  return completion.choices[0];
};

export interface GenerateJobContentContext {
  role?: string;
  experienceLevel?: string;
  keywords?: string[];
  prompt?: string;
  sourceText?: string;
}

export const generateJobContent = async (
  context: GenerateJobContentContext
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const system = `You are an expert technical recruiter and copywriter. Turn the recruiter's input into a complete, compelling job posting.

The input may be a role name, a short free-text description of the job, or the text of an existing job description. Use every fact the input gives you. Never invent a location, salary, currency or pay period that the input does not state — use null instead.

Output a JSON object in this exact format:
{
  "role": "<the job title, short and in title case, e.g. 'Backend Engineer'>",
  "experienceLevel": <one of "1-3 years", "4-6 years", "7-10 years", "11-15 years", "16 years and above", or null>,
  "workMode": [<zero or more of "remote", "hybrid", "onSite">],
  "locationCountry": <country name or null>,
  "locationState": <state or province name or null>,
  "locationCity": <city name or null>,
  "currency": <"NGN", "USD", "GBP", "EUR" or null>,
  "minSalary": <number or null>,
  "maxSalary": <number or null>,
  "compensationPeriod": <"monthly", "yearly" or null>,
  "jobBrief": "<a well-structured job description under 600 words, written in plain text with clear section headers such as 'About the Role:', 'Responsibilities:', and 'Benefits:'>",
  "requirements": "<a well-structured requirements section, written in plain text with clear section headers such as 'Qualifications:' and 'Nice to Have:'>",
  "skills": ["<skill1>", "<skill2>", "..."],
  "goals": ["<goal1>", "<goal2>", "..."]
}

Do not use markdown symbols (no "#", "*", "-") — use plain text with line breaks and the section headers described above.`;

  const lines = [
    context.role ? `Role: ${context.role}` : null,
    context.experienceLevel ? `Experience Level: ${context.experienceLevel}` : null,
    context.keywords?.length
      ? `Key skills/keywords to emphasize: ${context.keywords.join(", ")}`
      : null,
    context.prompt ? `Recruiter's description of the job:\n${context.prompt}` : null,
    context.sourceText ? `Existing job description:\n${context.sourceText}` : null,
  ].filter(Boolean);

  const completion = await runCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: lines.join("\n\n") },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });
  return completion.choices[0];
};

export type JobTextField = "jobBrief" | "requirements" | "recruiterGuide";
export type JobListField = "skills" | "goals";
export type JobFieldAction = "regenerate" | "shorter" | "detailed" | "friendlier";

export interface GenerateJobFieldContext {
  field: JobTextField | JobListField;
  action?: JobFieldAction;
  currentText?: string;
  job: {
    role?: string;
    experienceLevel?: string;
    jobBrief?: string;
    requirements?: string;
    skills?: string[];
    goals?: string[];
  };
}

const FIELD_TASKS: Record<GenerateJobFieldContext["field"], string> = {
  jobBrief:
    "Write the job brief: what the candidate reads first. Plain text with section headers such as 'About the Role:', 'Responsibilities:' and 'Benefits:', under 600 words.",
  requirements:
    "Write the requirements section. Plain text with section headers such as 'Qualifications:' and 'Nice to Have:'.",
  recruiterGuide:
    "Write private notes for an AI grader describing what a strong hire looks like for this job: must-have skills, experience bar, and red flags. 4 to 8 short plain-text lines. Candidates never see this.",
  skills:
    "Suggest up to 8 additional skills a strong candidate needs. Each is 1 to 4 words. Do not repeat skills already listed.",
  goals:
    "Suggest up to 5 goals the new hire should achieve in their first year. Each is one short sentence. Do not repeat goals already listed.",
};

const ACTION_INSTRUCTIONS: Record<JobFieldAction, string> = {
  regenerate: "Write a fresh version.",
  shorter: "Rewrite the current text to be about half as long, keeping every key fact.",
  detailed: "Rewrite the current text with more concrete detail, keeping it under 600 words.",
  friendlier:
    "Rewrite the current text in a warmer, more inclusive tone that welcomes a diverse range of candidates.",
};

export const generateJobField = async (
  context: GenerateJobFieldContext
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const isList = context.field === "skills" || context.field === "goals";
  const outputFormat = isList
    ? '{ "items": ["<item1>", "<item2>", "..."] }'
    : '{ "text": "<the written text>" }';

  const system = `You are an expert technical recruiter and copywriter helping a recruiter fill in one field of a job posting.

Task: ${FIELD_TASKS[context.field]}
${!isList && context.action ? ACTION_INSTRUCTIONS[context.action] : ""}

Do not use markdown symbols (no "#", "*", "-"). Output a JSON object in this exact format:
${outputFormat}`;

  const { job } = context;
  const userPrompt = [
    `Role: ${job.role || "Not specified"}`,
    `Experience Level: ${job.experienceLevel || "Not specified"}`,
    job.skills?.length ? `Skills: ${job.skills.join(", ")}` : null,
    job.goals?.length ? `Goals: ${job.goals.join("; ")}` : null,
    job.jobBrief && context.field !== "jobBrief" ? `Job brief:\n${job.jobBrief}` : null,
    job.requirements && context.field !== "requirements"
      ? `Requirements:\n${job.requirements}`
      : null,
    context.currentText ? `Current text:\n${context.currentText}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const completion = await runCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPrompt },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });
  return completion.choices[0];
};

export interface ComposeOnboardingEmailContext {
  firstName: string;
  role: "talent" | "recruiter";
  stage: string;
  nextSteps: string[];
  ctaLabel: string;
  daysSinceSignup: number;
  previousEmails: Array<{ subject: string; sentAt: string }>;
}

export const composeOnboardingEmail = async (
  context: ComposeOnboardingEmailContext
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const audience =
    context.role === "recruiter"
      ? "a recruiter who signed up to hire with Auxhr, an AI-assisted hiring platform"
      : "a job seeker who signed up to find work through Auxhr, an AI-assisted hiring platform";

  const system = `You write short, warm marketing emails that bring people back to Auxhr to finish getting started.

The reader is ${audience}. They have not finished setting up yet. Write one email that:
- greets them by first name,
- reminds them in one or two sentences what they get from Auxhr,
- tells them exactly what to do next, using the next steps provided (you may reword them, but do not add or drop steps),
- is friendly and encouraging, never guilt-tripping or pushy,
- is under 150 words, in plain text with short paragraphs and no markdown symbols.
If earlier emails were sent, write it as a gentle follow-up and do not repeat their subject lines.
Do not include links, a signature block, or placeholders like [Name] — a button to the right page is added below your text.

Output a JSON object in this exact format:
{ "subject": "<under 70 characters>", "body": "<the email text>" }`;

  const user = JSON.stringify({
    firstName: context.firstName,
    nextSteps: context.nextSteps,
    buttonLabel: context.ctaLabel,
    daysSinceSignup: context.daysSinceSignup,
    previousEmails: context.previousEmails,
  });

  const completion = await runCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });
  return completion.choices[0];
};

export interface DraftApplicantMessageContext {
  talentFirstName: string;
  jobTitle: string;
  companyName?: string;
  recruiterFirstName: string;
  /** What the recruiter wants this message to do, e.g. "invite to interview", or a free-text instruction. Defaults to a general shortlist outreach. */
  intent?: string;
  verdict: string | null;
  overallFitScore: number | null;
  whyHire?: string;
  strongestQualifications?: string[];
  keyEvidence?: string[];
}

// One personalized outreach draft per shortlisted candidate — grounded in
// that candidate's own AI match evidence so it reads like the recruiter
// actually reviewed their application, not a form letter.
export const draftApplicantMessage = async (
  context: DraftApplicantMessageContext
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const system = `You draft a short, warm outreach email from a recruiter to a candidate they've shortlisted for a role, on behalf of Auxhr, an AI-assisted hiring platform.

Write one email that:
- greets the candidate by first name,
- opens by referencing 1-2 specific, concrete reasons they stood out — draw only from the evidence provided (whyHire, strongestQualifications, keyEvidence), never invent details,
- states what happens next, matching the recruiter's stated intent,
- is warm, professional, and specific — never generic ("we were impressed with your profile") without naming the actual reason,
- is under 130 words, plain text, short paragraphs, no markdown symbols.
Do not include links, a signature block, or placeholders like [Name] — a button is added below your text.

Output a JSON object in this exact format:
{ "subject": "<under 70 characters>", "body": "<the email text>" }`;

  const user = JSON.stringify({
    talentFirstName: context.talentFirstName,
    jobTitle: context.jobTitle,
    companyName: context.companyName,
    recruiterFirstName: context.recruiterFirstName,
    intent:
      context.intent || "Let them know they've been shortlisted and invite them to the next step.",
    evidence: {
      verdict: context.verdict,
      overallFitScore: context.overallFitScore,
      whyHire: context.whyHire,
      strongestQualifications: context.strongestQualifications,
      keyEvidence: context.keyEvidence,
    },
  });

  const completion = await runCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });
  return completion.choices[0];
};

export const scorePreScreeningAssessment = async (
  context: PreScreeningScoringContext
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const system = `You are a strict, objective talent evaluator. Score the candidate's pre-screening assessment.
Scoring rules: Use the full range 0–100. Per-question score: 0–10. Final score: weighted average scaled to 0–100.
Output JSON:
{
  "totalScore": <number 0-100>,
  "breakdown": [{ "questionId": "<id>", "score": <0-10>, "reasoning": "<brief reasoning>" }]
}`;

  const userPrompt = `Candidate Profile:
Roles: ${context.profileContext.roles.join(", ")}
Experience Level: ${context.profileContext.experience ?? "Not specified"}
Bio: ${context.profileContext.bio ?? "Not provided"}
CV Content: ${context.profileContext.cvContent}

Assessment Questions and Answers:
${JSON.stringify(context.questions, null, 2)}`;

  const completion = await runCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPrompt },
    ],
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
  });
  return completion.choices[0];
};
