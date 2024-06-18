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
    model: "gpt-3.5-turbo-16k",
    // response_format: { type: "json_object" },
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
  recruiterGuide: Array<string>
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const system = `
  You are an automated system for generating personalized questions tailor made for job applicants/talents in order to get a wholesome idea of job applicants.
  You will be given the job description,the talent's bio, the talent's CV and the recruiter's guide use them to generate 15 tailor-made personalized questions to ask the talent,  
  
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
  
  Here is the recruiter's guide below.
  ${recruiterGuide}
  Make sure the generated personalized questions lays emphasis on the recruiter's guide especially, also factor in the talent's cv and bio
`;

  const completion = await openai.chat.completions.create({
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    // model: "gpt-3.5-turbo",
    model: "gpt-3.5-turbo-16k",
    // response_format: { type: "json_object" },
  });

  return completion.choices[0];
};

// Function to grade personalized questions
export const gradePersonalizedAnswers = async (
  questionsJSON: string
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const prompt = `You are an automated response scoring system.

  You will be given a JSON stringified array of objects. The objects are called the Assessment object. The content of each Assessment object is explained as follows:

  The Assessment object has 2 fields. Each field is described as follows:

  1. question: The questions that was asked to a candidate.
  2. questionId: The question's unique id.
  3. answer: the candidates answer to the question.
  
  For each assessment object, your task is to generate an appropriate score of the candidate's answer, you should score the candidate's answers  on a 1 to 5 scale. The scale is defined below:

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
    model: "gpt-3.5-turbo-16k",
    // response_format: { type: "json_object" },
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
    // model: "gpt-3.5-turbo",
    model: "gpt-3.5-turbo-16k",
    // response_format: { type: "json_object" },
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
    model: "gpt-3.5-turbo-16k",
    // response_format: { type: "json_object" },
  });

  return completion.choices[0];
};
