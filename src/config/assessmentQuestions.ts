// Limits for the problem-solving and culture-fit question types (plan Day 3).

/** Most values a company can list; culture-fit questions are written against them. */
export const MAX_COMPANY_VALUES = 10;
/** Longest single company value, in characters, after trimming. */
export const MAX_COMPANY_VALUE_LENGTH = 200;

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
