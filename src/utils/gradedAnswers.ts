// Reads the AI's grades for problem-solving and culture-fit answers (plan Day 4).
// Anything unusable is dropped, never guessed, so the caller can ask again for
// just the answers that are still missing a grade.

export interface GradedAnswer {
  questionId: string;
  /** Whole number from 0 (no evidence of the criteria) to MAX_ANSWER_SCORE (fully meets them). */
  score: number;
  feedback: string;
}

export const MAX_ANSWER_SCORE = 5;
const MAX_FEEDBACK_LENGTH = 1000;

export class GradedAnswersParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GradedAnswersParseError";
  }
}

const stripCodeFence = (text: string): string => {
  const match = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return match ? match[1]! : text;
};

/**
 * Parses `{ "grades": [{ "questionId", "score", "feedback" }] }`. Keeps only
 * grades for `expectedIds`, with a whole-number score from 0 to 5; the first
 * grade wins if a question is graded twice. Throws GradedAnswersParseError
 * when the reply isn't JSON or has no grades list.
 */
export const parseGradedAnswers = (
  content: string | null | undefined,
  expectedIds: string[]
): GradedAnswer[] => {
  if (!content || !content.trim()) {
    throw new GradedAnswersParseError("The AI reply was empty");
  }
  let data: unknown;
  try {
    data = JSON.parse(stripCodeFence(content));
  } catch {
    throw new GradedAnswersParseError("The AI reply was not valid JSON");
  }
  const grades = (data as { grades?: unknown } | null)?.grades;
  if (!Array.isArray(grades)) {
    throw new GradedAnswersParseError("The AI reply had no grades list");
  }

  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  const result: GradedAnswer[] = [];
  for (const entry of grades) {
    if (!entry || typeof entry !== "object") continue;
    const { questionId, score, feedback } = entry as Record<string, unknown>;
    if (typeof questionId !== "string" || !expected.has(questionId) || seen.has(questionId)) {
      continue;
    }
    if (
      typeof score !== "number" ||
      !Number.isInteger(score) ||
      score < 0 ||
      score > MAX_ANSWER_SCORE
    ) {
      continue;
    }
    seen.add(questionId);
    result.push({
      questionId,
      score,
      feedback: typeof feedback === "string" ? feedback.trim().slice(0, MAX_FEEDBACK_LENGTH) : "",
    });
  }
  return result;
};

/** The scoring rule: total of the 0-5 grades over the most possible, as a percentage (2 decimals). */
export const scorePercent = (scores: number[]): number | null => {
  if (scores.length === 0) return null;
  const total = scores.reduce((sum, s) => sum + s, 0);
  return Number(((total / (MAX_ANSWER_SCORE * scores.length)) * 100).toFixed(2));
};
