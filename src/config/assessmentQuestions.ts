export const MAX_COMPANY_VALUES = 10;
export const MAX_COMPANY_VALUE_LENGTH = 200;

export const PROBLEM_SOLVING_CATEGORIES = [
  "logical",
  "numerical",
  "analytical",
  "prioritisation",
  "estimation",
  "creative",
] as const;

export const CULTURE_FIT_GENERAL_CATEGORIES = [
  "collaboration",
  "communication",
  "ownership",
  "adaptability",
  "feedback",
] as const;

export const DEFAULT_GENERATED_QUESTIONS = 5;
export const MAX_GENERATED_QUESTIONS_PER_REQUEST = 10;
export const MAX_QUESTION_POOL_PER_TYPE = 30;
export const MAX_ASSESSMENT_QUESTIONS_PER_CANDIDATE = 10;
export const MAX_GENERATION_ATTEMPTS = 2;
export const ASSESSMENT_OPTION_COUNT = 4;
export const MAX_ASSESSMENT_OPTION_LENGTH = 300;

export const MAX_CULTURE_FIT_JOB_BRIEF_CHARS = 4_000;

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
