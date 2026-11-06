export interface GeneratedQuestion {
  question: string;
  category: string;
  criteria: string | null;
}

export interface ParseGeneratedQuestionsOptions {
  max: number;
  categories?: readonly string[];
  fallbackCategory?: string;
}

export class GeneratedQuestionsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneratedQuestionsParseError";
  }
}

export const MIN_GENERATED_QUESTION_LENGTH = 10;
export const MAX_GENERATED_QUESTION_LENGTH = 1000;
export const MAX_GENERATED_CRITERIA_LENGTH = 1000;
const MAX_FREE_CATEGORY_LENGTH = 100;

const stripCodeFence = (text: string): string => {
  const match = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(text);
  return match ? match[1]! : text;
};

const asTrimmedString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const normalizeKey = (text: string): string => text.toLowerCase().replace(/\s+/g, " ");

export const parseGeneratedQuestions = (
  content: string | null | undefined,
  options: ParseGeneratedQuestionsOptions
): GeneratedQuestion[] => {
  const { max, categories, fallbackCategory = "general" } = options;

  const text = content?.trim();
  if (!text) {
    throw new GeneratedQuestionsParseError("The AI reply was empty");
  }

  let data: unknown;
  try {
    data = JSON.parse(stripCodeFence(text));
  } catch {
    throw new GeneratedQuestionsParseError("The AI reply was not valid JSON");
  }

  const items: unknown = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? (data as { questions?: unknown }).questions
      : undefined;
  if (!Array.isArray(items)) {
    throw new GeneratedQuestionsParseError("The AI reply had no list of questions");
  }

  const allowed = new Map((categories ?? []).map((c) => [normalizeKey(c.trim()), c]));
  const resolveCategory = (raw: unknown): string => {
    const value = asTrimmedString(raw);
    if (!value) return fallbackCategory;
    if (categories) return allowed.get(normalizeKey(value)) ?? fallbackCategory;
    return value.length <= MAX_FREE_CATEGORY_LENGTH ? value : fallbackCategory;
  };

  const seen = new Set<string>();
  const result: GeneratedQuestion[] = [];
  for (const item of items) {
    if (result.length >= max) break;

    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
    const question = asTrimmedString(record ? record["question"] : item);
    if (
      !question ||
      question.length < MIN_GENERATED_QUESTION_LENGTH ||
      question.length > MAX_GENERATED_QUESTION_LENGTH
    ) {
      continue;
    }

    const key = normalizeKey(question);
    if (seen.has(key)) continue;
    seen.add(key);

    const criteria = asTrimmedString(record?.["criteria"]);
    result.push({
      question,
      category: resolveCategory(record?.["category"]),
      criteria: criteria ? criteria.slice(0, MAX_GENERATED_CRITERIA_LENGTH) : null,
    });
  }

  if (result.length === 0) {
    throw new GeneratedQuestionsParseError("The AI reply had no usable questions");
  }
  return result;
};
