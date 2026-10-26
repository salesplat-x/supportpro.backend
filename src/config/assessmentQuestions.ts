// Limits for the problem-solving and culture-fit question types (plan Day 3).

/** Most values a company can list; culture-fit questions are written against them. */
export const MAX_COMPANY_VALUES = 10;
/** Longest single company value, in characters, after trimming. */
export const MAX_COMPANY_VALUE_LENGTH = 200;

/** Reasoning skills a problem-solving question can test (stored as its category). */
export const PROBLEM_SOLVING_CATEGORIES = [
  "logical",
  "numerical",
  "analytical",
  "prioritisation",
  "estimation",
  "creative",
] as const;

/** Working-style areas used for culture-fit questions when a company lists no values. */
export const CULTURE_FIT_GENERAL_CATEGORIES = [
  "collaboration",
  "communication",
  "ownership",
  "adaptability",
  "feedback",
] as const;

/** Questions generated per request when the recruiter doesn't say. */
export const DEFAULT_GENERATED_QUESTIONS = 5;
/** Most questions one generate request may ask for. */
export const MAX_GENERATED_QUESTIONS_PER_REQUEST = 10;
/** Most problem-solving (or culture-fit) questions one job may hold — caps AI spend. */
export const MAX_QUESTION_POOL_PER_TYPE = 30;
/** Most problem-solving (or culture-fit) questions one candidate is asked per job. */
export const MAX_ASSESSMENT_QUESTIONS_PER_CANDIDATE = 10;
/** AI calls per generate request: the first, plus one retry for a bad or short reply. */
export const MAX_GENERATION_ATTEMPTS = 2;

/** Ceiling on the job brief text sent with a culture-fit request. */
export const MAX_CULTURE_FIT_JOB_BRIEF_CHARS = 4_000;

/**
 * Trims each value and drops duplicates (case-insensitive), keeping the first
 * spelling. Validation has already rejected non-text, empty and over-long values.
 */
export const normalizeCompanyValues = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
};
