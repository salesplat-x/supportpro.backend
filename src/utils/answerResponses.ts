export type StoredResponse = {
  questionId?: string;
  question?: string;
  answer?: string;
  score?: number;
  dichotomyPreference?: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** LLM graders often echo the id in `question` instead of `questionId`. */
export const storedResponseQuestionId = (response: StoredResponse): string | undefined => {
  if (response.questionId) return response.questionId;
  if (response.question && UUID_RE.test(response.question)) return response.question;
  return undefined;
};

export const answerTextForQuestion = (
  responses: StoredResponse[],
  questionId: string,
  questionText?: string | null,
  index?: number
): string | null => {
  const byId = responses.find((response) => storedResponseQuestionId(response) === questionId);
  if (byId?.answer?.trim()) return byId.answer;

  if (questionText) {
    const byText = responses.find((response) => response.question === questionText);
    if (byText?.answer?.trim()) return byText.answer;
  }

  if (index != null && responses[index]?.answer?.trim()) {
    return responses[index]!.answer!;
  }

  return null;
};

/**
 * Persist the candidate's own answers under the real question ids.
 * Overlay score / dichotomy from the LLM by id, then by order.
 */
export const mergeSubmittedAnswers = (
  submitted: Record<string, string>,
  llmResponses: StoredResponse[] | undefined
): Array<{
  questionId: string;
  answer: string;
  score?: number;
  dichotomyPreference?: string;
}> => {
  const list = llmResponses ?? [];
  const byId = new Map<string, StoredResponse>();
  for (const response of list) {
    const id = storedResponseQuestionId(response);
    if (id) byId.set(id, response);
  }

  return Object.entries(submitted).map(([questionId, answer], index) => {
    const llm = byId.get(questionId) ?? list[index];
    return {
      questionId,
      answer,
      ...(llm?.score != null ? { score: llm.score } : {}),
      ...(llm?.dichotomyPreference ? { dichotomyPreference: llm.dichotomyPreference } : {}),
    };
  });
};
