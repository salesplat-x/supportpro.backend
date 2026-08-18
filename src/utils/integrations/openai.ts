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
  const system = `You are an expert hiring interviewer writing personalized screening questions for one candidate.

Rules:
- Generate exactly ${questionNo} distinct questions.
- Ground every question in concrete details from the CV, bio, job description, or recruiter guide. Do not invent employers, skills, dates, or achievements that are not present in the provided materials.
- Prefer probing questions about claimed experience, impact, trade-offs, and gaps relative to the role.
- Prioritize the recruiter guide when it conflicts with generic interview practice.
- Do not ask generic icebreakers, illegal/discriminatory questions, or yes/no questions unless they clearly unlock a deeper follow-up.
- Each question must be meaningfully different in focus.

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

export const assessCVandCoverLetter = async (
  input: string
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const prompt = `
  You are an automated CV evaluation system.

  Input: You will receive a JSON object with the following four fields:

  1. cv: A string containing the CV of the job applicant.
  2. coverLetter: A string containing the cover letter of the job applicant.
  3. jobDescription: A string containing the job description for the position.
  4. recruiterGuide: A string with instructions on how to assess the CV and cover letter against the job description to generate a percentage match.

  For each of the CV and the cover letter, also provide brief explanatory insights (2-4 sentences) covering: the candidate's key strengths relative to the job description, any notable gaps or concerns, and the main reasoning behind the score.

  Also extract the candidate's contact details from the CV text if present: full name, email address, phone number, and mailing/location address. Use null for any field not found — do not guess or fabricate values.

  Output: You should produce a JSON object with the following structure:

  {
    "cvScore": <cvPercentage>,
    "cvInsights": "<explanatory insights for the CV score>",
    "coverLetterScore": <coverLetterPercentage>,
    "coverLetterInsights": "<explanatory insights for the cover letter score>",
    "candidateName": "<candidate's full name as it appears on the CV, or null>",
    "candidateEmail": "<candidate's email address, or null>",
    "candidatePhone": "<candidate's phone number, or null>",
    "candidateAddress": "<candidate's mailing/location address, or null>"
  }`;
  const completion = await runCompletion({
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: input },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });
  return completion.choices[0];
};

export const assessCV = async (
  input: string
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const prompt = `
  You are an automated CV evaluation system.

  Input: You will receive a JSON object with the following three fields:

  1. cv: A string containing the CV of the job applicant.
  2. jobDescription: A string containing the job description for the position.
  3. recruiterGuide: A string with instructions on how to assess the CV against the job description to generate a percentage match.

  Also provide brief explanatory insights (2-4 sentences) covering: the candidate's key strengths relative to the job description, any notable gaps or concerns, and the main reasoning behind the score.

  Also extract the candidate's contact details from the CV text if present: full name, email address, phone number, and mailing/location address. Use null for any field not found — do not guess or fabricate values.

  Output: You should produce a JSON object with the following structure:

  {
    "cvScore": <cvPercentage>,
    "insights": "<explanatory insights for the score>",
    "candidateName": "<candidate's full name as it appears on the CV, or null>",
    "candidateEmail": "<candidate's email address, or null>",
    "candidatePhone": "<candidate's phone number, or null>",
    "candidateAddress": "<candidate's mailing/location address, or null>"
  }`;
  const completion = await runCompletion({
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: input },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });
  return completion.choices[0];
};

export interface TalentFitContext {
  jobDescription: string;
  cvText: string;
}

// Lightweight evidence pass for sourcing lists (top-N cosine-similarity
// matches) — deliberately separate from assessCV/assessCVandCoverLetter,
// which back the CV-upload scoring flow's own "insights" prose and must not
// change shape.
export const assessTalentFit = async (
  context: TalentFitContext
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const system = `You are a technical recruiter sourcing candidates for a role.

  You will receive a job description and a candidate's CV text. Provide a brief, evidence-based assessment of this candidate's fit for the role, citing specific details from the CV.

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
}

export const assessApplicationMatch = async (
  context: MatchVerdictContext
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const system = `You are a senior hiring panel member giving a recruiter a second opinion.

You will receive a JSON object with pipeline scores, optional CV text, optional Q&A answers, the job description, an optional list of required skills, optional requirements text, optional job goals, and an optional recruiter guide.

Critical anti-hallucination rules:
- Use ONLY information present in the provided JSON. Never invent employers, skills, education, metrics, or answers.
- If CV text or answers are missing, say so explicitly and base the assessment only on available scores/fields.
- Do not assume soft skills, culture fit, or experience that are not evidenced in the input.
- Cite concrete evidence (score values, CV phrases, or quoted answer fragments) in every strength, weakness, and risk.

When skills or requirements are provided, judge fit primarily against them rather than the general job description — for each strength or weakness tied to a required skill, name which skill is evidenced or missing.

Personality/MBTI evidence (mbtiType, personalityQuestionsAndAnswers), when present, is secondary — only factor it into the verdict or cite it as a strength/weakness/risk if the recruiter guide explicitly asks you to weigh culture or personality fit. Otherwise mention it only as brief supplementary color, never as grounds for the verdict.

Weigh available evidence holistically and classify the candidate as a "high", "medium", or "low" match. This is advisory — the recruiter decides.

Output JSON:
{
  "verdict": "high" | "medium" | "low",
  "reasoning": "<2-4 sentences explaining the verdict from available evidence only>",
  "strengths": ["<specific strength with cited evidence>", "..."],
  "weaknesses": ["<specific weakness or gap with cited evidence>", "..."],
  "risks": ["<specific hiring risk with cited evidence>", "..."],
  "recommendation": "hire" | "interview_further" | "no_hire"
}

Provide at least one strength when any positive evidence exists. Provide at least one weakness or risk unless the match is outstanding on all available evidence.`;

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
  const retakeInstruction = context.isRetake
    ? `\n\nIMPORTANT: This is a RETAKE assessment. You MUST generate entirely different scenarios, different situations, different wording, and different answer structures from any prior assessment for this candidate.`
    : "";

  const system = `You are a senior hiring panel and organizational psychologist with deep expertise in talent evaluation.
Your task is to generate a multiple-choice pre-screening assessment for a candidate based on their professional profile.
The assessment must contain between 5 and 10 questions covering: professional_competency, practical_problem_solving, communication, behavioral, cultural, leadership, emotional_intelligence.${retakeInstruction}

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
  role: string;
  experienceLevel?: string;
  keywords?: string[];
}

export const generateJobContent = async (
  context: GenerateJobContentContext
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const system = `You are an expert technical recruiter and copywriter. Generate compelling, well-structured job posting content for the given role.

Output a JSON object in this exact format:
{
  "jobBrief": "<a well-structured job description under 600 words, written in plain text with clear section headers such as 'About the Role:', 'Responsibilities:', and 'Benefits:'>",
  "requirements": "<a well-structured requirements section, written in plain text with clear section headers such as 'Qualifications:' and 'Nice to Have:'>",
  "skills": ["<skill1>", "<skill2>", "..."],
  "goals": ["<goal1>", "<goal2>", "..."]
}

Do not use markdown symbols (no "#", "*", "-") — use plain text with line breaks and the section headers described above.`;

  const userPrompt = `Role: ${context.role}
Experience Level: ${context.experienceLevel ?? "Not specified"}
Key skills/keywords to emphasize: ${context.keywords?.length ? context.keywords.join(", ") : "Not specified"}`;

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
