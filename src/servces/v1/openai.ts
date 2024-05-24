import OpenAI from "openai";
import env from "../../config/env";
import { makeResponse } from "../../helpers/response";

const openai = new OpenAI({
  apiKey: env.openai_secret,
});

export const gradeAnswers = async (
  questionsJSON: string
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined> => {
  const prompt = `You are an automated response scoring system.

  You will be given a JSON stringified array of objects. The objects are called the Assessment object. The content of each Assessment object is explained as follows:

  The Assessment object has 3 fields. Each field is described as follows:

  1. question: The questions that was asked to a candidate.
  2. answer: the candidates answer to the question.
  3. criteria: The criteria that is being considered for scoring the candidate's a answer to the question.
  
  For each assessment object, your task is to generate an appropriate score of the candidate's answer based on the criteria field. That is, based on the criteria stated in the scoring criteria field, you should score the candidate's answers  on a 1 to 5 scale. The scale is defined below:

  1 - poor
  2 - unsatisfactory
  3 - satisfactory
  4 - very satisfactory
  5 - outstanding.

  For each score, question and answer you will generate a Response object has 3 fields similar to the Assessment object. Each field is described as follows:

  1. question: The questions that was asked to a candidate.
  2. answer: the candidates answer to the question.
  3. score: The score you generated for that question. 
  
  Your output should be a JSON array of the Response objects. For example 
  '{
    "responses":[
      {"question": ..., "answer": ...,"score":3},
      {"question": ..., "answer": ...,"score":4},
      ...
    ]
  }', the length of the array of Response objects must match the length of the array of the Assessment object`;

  const completion = await openai.chat.completions.create({
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: questionsJSON },
    ],
    model: "gpt-3.5-turbo",
    response_format: { type: "json_object" },
  });

  return completion.choices[0];
};

export const createEmbedding = async (text: string | string[]) => {
  const embedding = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
    encoding_format: "float",
  });
  return embedding.data;
};
