import OpenAI from "openai";
import env from "../../config/env";
import { TDichotomyPair } from "../../typings/question";

const openai = new OpenAI({
  apiKey: env.openai_secret,
});

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

  const completion = await openai.chat.completions.create({
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: questionsJSON },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });

  return completion.choices[0];
};

// Function to create embeddings
export const createEmbedding = async (text: string | string[]) => {
  const embedding = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
    encoding_format: "float",
    dimensions: 512,
  });
  return embedding.data;
};

// Function to generate personalized questions
export const generatePersonalizedQuestions = async (
  jobDescription: string,
  cv: Array<string>,
  bio: string,
  questionNo: number,
  recruiterGuide: string
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const system = `
  You are an automated system for generating personalized questions tailor made for job applicants/talents in order to get a wholesome idea of job applicants.
  You will be given the job description,the talent's bio, the talent's CV and the recruiter's guide use them to generate ${questionNo} tailor-made personalized questions to ask the talent,  
  
  Your output should be a JSON array of the Questions. For example 
  '{
    "questions":[
      "Tell me about your work at SalesPlat",
      "You said you were laid off at your previous job, was that due to a performance deficit?"
    ]
  }'`;
  const prompt = `
  Here is the job description below, 
  ${jobDescription}

  Here is the talent's CV below,
  ${cv}

  Here is the talent's bio below,
  ${bio}
  
  Here is the recruiter's guide below.
  ${recruiterGuide}
  Make sure the generated personalized questions lays emphasis on the recruiter's guide especially, also factor in the talent's cv and bio
`;

  const completion = await openai.chat.completions.create({
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });

  return completion.choices[0];
};

// Function to grade personalized questions
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

  const completion = await openai.chat.completions.create({
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: questionsJSON },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });

  return completion.choices[0];
};

// Function to generate questions to determine MBTI/personality type
export const getPersonalityEvaluationQuestion = async (
  jobDescription: string,
  dichotomyPair: TDichotomyPair
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const system = `
  You are an automated system for generating questions to determine the personality type of a job applicant based on the MBTI model.
  You will be provided with the job description and the MBTI dichotomy pair,
  use them to generate a tailor-made question to assess the applicant's personality trait in the given dichotomy pair.
  `;
  const prompt = `
  Job Description below: ${jobDescription},
  Dichotomy Pair: ${dichotomyPair}
  Generate a question to determine if a person is more inclined towards ${dichotomyPair[0]} or ${dichotomyPair[1]} in the MBTI personality assessment.
  Your output should be a JSON object with the question. For example:
  {
    "question": "..."
  }
`;

  const completion = await openai.chat.completions.create({
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

  const completion = await openai.chat.completions.create({
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
  Output: You should produce a JSON object with the following structure:

  {
    "cvScore": <cvPercentage>
    "coverLetterScore": <coverLetterPercentage>
  }
  Where <cvPercentage> is the calculated match percentage of the applicant's CV against the job description based on the recruiter guide, and <coverLetterPercentage> is the calculated match percentage of the applicant's coverLetter against the job description based on the recruiter guide.

  Example Output:
  {
    "cvScore": 60
    "coverLetterScore": 73
  } `;

  const completion = await openai.chat.completions.create({
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: input },
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
    ? `\n\nIMPORTANT: This is a RETAKE assessment. You MUST generate entirely different scenarios, different situations, different wording, and different answer structures from any prior assessment for this candidate. The purpose is to reassess the same competencies from completely fresh angles.`
    : "";

  const system = `You are a senior hiring panel and organizational psychologist with deep expertise in talent evaluation.

Your task is to generate a multiple-choice pre-screening assessment for a candidate based on their professional profile.

The assessment must:
- Contain between 5 and 10 questions — you decide the exact number based on the profile depth
- Cover a mix of these categories: professional_competency, practical_problem_solving, communication, behavioral, cultural, leadership, emotional_intelligence
- Be tailored specifically to this candidate's background — not generic
- Reveal meaningful insight about the candidate's actual capability, maturity, and readiness
- Each question must have exactly 4 options
- Questions must feel like they were crafted by an experienced recruiter, not a quiz generator

STRICT RULES:
- Infer aggressively from the candidate's profile
- Fabricate NEVER — do not invent credentials, employers, technologies, or experiences not supported by the profile
- Do not repeat facts from the profile verbatim — reason about implications
- Avoid trivially easy questions
- Questions must range across: role-specific knowledge, real-world tradeoffs, stakeholder communication, professional judgment, workplace behavior, leadership indicators, and emotional maturity

After generating all questions, perform a quality self-review. For every question, silently verify:
1. Does this reveal meaningful information about the candidate?
2. Is it genuinely personalized to this profile?
3. Is it distinct from the other questions?
4. Would a recruiter gain useful insight from the answer?
5. Is it professionally worded and concise?

Only include questions that pass all 5 checks. Regenerate any that fail.${retakeInstruction}

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
      "scoringHint": "<what strong vs weak answers look like for someone at this experience level>"
    }
  ]
}`;

  const userPrompt = `Candidate Profile:

Roles: ${context.roles.join(", ")}
Experience Level: ${context.experience ?? "Not specified"}
Bio: ${context.bio ?? "Not provided"}
Work Type Preference: ${context.workType?.join(", ") ?? "Not specified"}
Location: ${context.location ? `${context.location.city ?? ""} ${context.location.state ?? ""} ${context.location.country ?? ""}`.trim() : "Not specified"}

CV Content:
${context.cvContent}

Generate the pre-screening assessment now.`;

  const completion = await openai.chat.completions.create({
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
  const system = `You are a strict, objective talent evaluator. You do not encourage, motivate, or give benefit-of-the-doubt.

Your role is to score a candidate's pre-screening assessment answers against their stated professional profile.

Evaluation criteria:
- Accuracy: Did the candidate select the professionally correct answer?
- Decision quality: Does the answer reflect sound professional judgment?
- Consistency: Are the answers consistent with the candidate's claimed background and experience level?
- Reasoning quality: Do the answers suggest genuine understanding or guessing?
- Professional maturity: Do behavioral and leadership answers reflect appropriate maturity for the claimed experience?

Scoring rules:
- Use the FULL range from 0 to 100
- Do NOT inflate scores
- Penalise contradictions between selected answers and claimed experience
- Penalise patterns that suggest random guessing (e.g. always selecting option A or C)
- A candidate who selects wrong answers on professional competency questions MUST receive a noticeably lower score
- Correct answers alone do not guarantee a high score — context and consistency matter

Per-question score: 0–10
Final score: weighted average scaled to 0–100

Output a JSON object in this exact format:
{
  "totalScore": <number 0-100>,
  "breakdown": [
    {
      "questionId": "<id>",
      "score": <0-10>,
      "reasoning": "<brief objective reasoning for this score>"
    }
  ]
}`;

  const userPrompt = `Candidate Profile:
Roles: ${context.profileContext.roles.join(", ")}
Experience Level: ${context.profileContext.experience ?? "Not specified"}
Bio: ${context.profileContext.bio ?? "Not provided"}

CV Content:
${context.profileContext.cvContent}

Assessment Questions and Answers:
${JSON.stringify(context.questions, null, 2)}

Score this assessment now.`;

  const completion = await openai.chat.completions.create({
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPrompt },
    ],
    model: "gpt-4o-mini",
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
  Output: You should produce a JSON object with the following structure:

  {
    "cvScore": <cvPercentage>
  }
  Where <cvPercentage> is the calculated match percentage of the applicant's CV against the job description based on the recruiter guide.

  Example Output:
  {
    "cvScore": 60
  } `;

  const completion = await openai.chat.completions.create({
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: input },
    ],
    model: "gpt-4o",
    response_format: { type: "json_object" },
  });

  return completion.choices[0];
};
