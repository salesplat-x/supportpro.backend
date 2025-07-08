import OpenAI from "openai";
import env from "../../config/env";
import { TDichotomyPair } from "../../typings/question";

const openai = new OpenAI({
  apiKey: env.openai_secret,
});

// helper for voice integration
/**
 * chatGPT: Unified wrapper for text (default) or voice mode.
 * @param userInput  The user's message
 * @param mode       'text' or 'voice' (Grace persona)
 */
export async function chatGPT(
  userInput: string,
  mode: "text" | "voice" = "text"
): Promise<string> {
  const systemPrompt =
    mode === "voice"
      ? "You are Grace, a friendly and helpful voice assistant. Respond conversationally."
      : "You are a helpful assistant. Respond with clarity and precision.";

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userInput      },
    ],
  });

  return completion.choices[0]?.message?.content ?? "";
}

export const gradeAssessmentAnswers = async (
  questionsJSON: string
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const prompt = `You are an automated response scoring system.

You will be given a JSON stringified array of objects. The objects are called the Assessment object. The content of each Assessment object is explained as follows:

The Assessment object has 4 fields. Each field is described as follows:

1. question: The question that was asked to a candidate.
2. questionId: The question's unique id.
3. answer: the candidate's answer to the question.
4. criteria: The criteria that is being considered for scoring the candidate's answer to the question.

For each assessment object, your task is to generate an appropriate score of the candidate's answer based on the criteria field. That is, based on the criteria stated in the scoring criteria field, you should score the candidate's answers on a 1 to 5 scale. The scale is defined below:

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

  // Call chatGPT to get back a JSON string
  const raw = await chatGPT(`${prompt}\n${questionsJSON}`, "text");

  // Parse it
  let parsed: { responses?: OpenAI.Chat.Completions.ChatCompletion.Choice[] };
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("Failed to parse AI response for grading: " + e);
  }

  // Return the first graded choice (or undefined if none)
  return parsed.responses ? parsed.responses[0] : undefined;
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

  const raw = await chatGPT(`${system}\n${prompt}`, "text");
  const parsed = JSON.parse(raw);
  return parsed.questions ? parsed.questions : undefined;
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

  const raw = await chatGPT(`${prompt}\n${questionsJSON}`, "text");

  // Parse the JSON string into an object
  let parsed: { responses?: OpenAI.Chat.Completions.ChatCompletion.Choice[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Failed to parse AI response for grading: " + err);
  }

  // Return the full array of graded responses
  return parsed.responses && parsed.responses.length > 0
  ? parsed.responses[0]
  : undefined;
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

  const raw = await chatGPT(`${system}\n${prompt}`, "text");

  let parsed: { question?: string };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Failed to parse AI response for MBTI question: " + err);
  }

  if (!parsed.question) return undefined;

  const choice: OpenAI.Chat.Completions.ChatCompletion.Choice = {
    message: {
      role: "assistant",
      content: parsed.question,
    },
    index: 0,
    finish_reason: "stop",
    logprobs: null,
  };

  return choice;
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

  const raw = await chatGPT(`${prompt}\n${questionsJSON}`, "text");

  let parsed: { responses?: Array<{
    question: string;
    answer: string;
    dichotomyPreference: string;
  }>; mbtiType?: string };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Failed to parse AI response for personality evaluation: " + err);
  }

  if (!parsed.mbtiType || !parsed.responses) return undefined;

  const choice: OpenAI.Chat.Completions.ChatCompletion.Choice = {
    message: {
      role: "assistant",
      content: JSON.stringify({
        responses: parsed.responses,
        mbtiType: parsed.mbtiType,
      }),
    },
    index: 0,
    finish_reason: "stop",
    logprobs: null,
  };

  return choice;
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

  const raw = await chatGPT(`${prompt}\n${input}`, "text");

  let parsed: { cvScore?: number; coverLetterScore?: number };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Failed to parse AI response for CV assessment: " + err);
  }

  if (
    typeof parsed.cvScore !== "number" ||
    typeof parsed.coverLetterScore !== "number"
  ) {
    return undefined;
  }

  const choice: OpenAI.Chat.Completions.ChatCompletion.Choice = {
    message: {
      role: "assistant",
      content: JSON.stringify({
        cvScore: parsed.cvScore,
        coverLetterScore: parsed.coverLetterScore,
      }),
    },
    index: 0,
    finish_reason: "stop",
    logprobs: null,
  };

  return choice;
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

  const raw = await chatGPT(`${prompt}\n${input}`, "text");

  let parsed: { cvScore?: number };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Failed to parse AI response for CV scoring: " + err);
  }

  if (typeof parsed.cvScore !== "number") {
    return undefined;
  }

  const choice: OpenAI.Chat.Completions.ChatCompletion.Choice = {
    message: {
      role: "assistant",
      content: JSON.stringify({ cvScore: parsed.cvScore }),
    },
    index: 0,
    finish_reason: "stop",
    logprobs: null,
  };

  return choice;
};
