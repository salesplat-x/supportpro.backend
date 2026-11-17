export interface GeneratedQuestion {
  question: string;
  category: string;
  criteria: string | null;
  options: string[];
  correctOption: number;
}

export interface ParseGeneratedQuestionsOptions {
  max: number;
  categories?: readonly string[];
  fallbackCategory?: string;
  optionCount: number;
  maxOptionLength: number;
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

const shuffleInPlace = <T>(items: T[]): T[] => {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const current = items[i]!;
    items[i] = items[j]!;
    items[j] = current;
  }
  return items;
};

/** Shuffle options so the correct answer is not stuck on one letter for every item. */
export const redistributeCorrectOptions = <T extends { options: string[]; correctOption: number }>(
  questions: T[]
): T[] =>
  questions.map((question, index) => {
    const correctIndex = question.correctOption;
    const indexed = question.options.map((text, optionIndex) => ({ text, optionIndex }));
    shuffleInPlace(indexed);
    const preferredSlot = index % Math.max(question.options.length, 1);
    const correctEntry = indexed.find((item) => item.optionIndex === correctIndex);
    if (correctEntry && indexed[preferredSlot] && indexed[preferredSlot] !== correctEntry) {
      const preferredIndex = indexed.indexOf(correctEntry);
      const swap = indexed[preferredSlot]!;
      indexed[preferredSlot] = correctEntry;
      indexed[preferredIndex] = swap;
    }
    return {
      ...question,
      options: indexed.map((item) => item.text),
      correctOption: indexed.findIndex((item) => item.optionIndex === correctIndex),
    };
  });

const parseOptions = (
  record: Record<string, unknown> | undefined,
  count: number,
  maxLength: number
): { options: string[]; correctOption: number } | null => {
  const raw = record?.["options"];
  if (!Array.isArray(raw) || raw.length !== count) return null;
  const options = raw.map(asTrimmedString);
  if (options.some((option) => !option || option.length > maxLength)) return null;
  if (new Set(options.map((option) => normalizeKey(option!))).size !== count) return null;
  const correctOption = record?.["correctOption"];
  if (
    typeof correctOption !== "number" ||
    !Number.isInteger(correctOption) ||
    correctOption < 0 ||
    correctOption >= count
  ) {
    return null;
  }
  return { options: options as string[], correctOption };
};

export const parseGeneratedQuestions = (
  content: string | null | undefined,
  options: ParseGeneratedQuestionsOptions
): GeneratedQuestion[] => {
  const { max, categories, fallbackCategory = "general", optionCount, maxOptionLength } = options;

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
    const question = asTrimmedString(record?.["question"]);
    if (
      !question ||
      question.length < MIN_GENERATED_QUESTION_LENGTH ||
      question.length > MAX_GENERATED_QUESTION_LENGTH
    ) {
      continue;
    }

    const choice = parseOptions(record, optionCount, maxOptionLength);
    if (!choice) continue;

    const key = normalizeKey(question);
    if (seen.has(key)) continue;
    seen.add(key);

    const criteria = asTrimmedString(record?.["criteria"]);
    result.push({
      question,
      category: resolveCategory(record?.["category"]),
      criteria: criteria ? criteria.slice(0, MAX_GENERATED_CRITERIA_LENGTH) : null,
      options: choice.options,
      correctOption: choice.correctOption,
    });
  }

  if (result.length === 0) {
    throw new GeneratedQuestionsParseError("The AI reply had no usable questions");
  }
  return redistributeCorrectOptions(result);
};
