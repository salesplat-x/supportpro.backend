export type QuestionFeedback = {
  question: string;
  whatTheyAnswered: string;
  whatItDemonstrates: string;
  experienceLink: string;
};

export type MatchAnalysis = {
  overallFitScore: number;
  whyFit: string;
  whyHire: string;
  strongestQualifications: string[];
  relevantExperience: string[];
  prescreeningInsights: { strengths: string[]; weaknesses: string[] };
  assessmentInsights?: string;
  questionFeedback: QuestionFeedback[];
  missingRequirements: string[];
  conflictingRequirements: string[];
  keyEvidence: string[];
  hiringRationale: string;
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const clampScore = (value: unknown, fallback: number): number => {
  // Number(null) === 0 and Number(undefined) is NaN-but-easy-to-mistreat —
  // handle both explicitly so a missing/null score falls back to the
  // verdict-derived score instead of silently reading as a literal 0 (which
  // would misreport as "no fit at all" rather than "not scored").
  if (value === null || value === undefined) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
};

export const scoreFromVerdict = (verdict: string): number => {
  if (verdict === "high") return 85;
  if (verdict === "medium") return 65;
  if (verdict === "low") return 35;
  return 50;
};

const asQuestionFeedback = (value: unknown): QuestionFeedback[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const question = typeof row.question === "string" ? row.question.trim() : "";
    if (!question) return [];
    return [
      {
        question,
        whatTheyAnswered: typeof row.whatTheyAnswered === "string" ? row.whatTheyAnswered : "",
        whatItDemonstrates:
          typeof row.whatItDemonstrates === "string" ? row.whatItDemonstrates : "",
        experienceLink: typeof row.experienceLink === "string" ? row.experienceLink : "",
      },
    ];
  });
};

export const parseMatchAnalysis = (
  parsed: Record<string, unknown>,
  verdict: string
): MatchAnalysis => {
  const insightsRaw = parsed.prescreeningInsights;
  const insights =
    insightsRaw && typeof insightsRaw === "object"
      ? {
          strengths: asStringArray((insightsRaw as { strengths?: unknown }).strengths),
          weaknesses: asStringArray((insightsRaw as { weaknesses?: unknown }).weaknesses),
        }
      : { strengths: [] as string[], weaknesses: [] as string[] };

  const assessmentInsights =
    typeof parsed.assessmentInsights === "string" ? parsed.assessmentInsights : undefined;

  return {
    overallFitScore: clampScore(parsed.overallFitScore, scoreFromVerdict(verdict)),
    whyFit: typeof parsed.whyFit === "string" ? parsed.whyFit : "",
    whyHire: typeof parsed.whyHire === "string" ? parsed.whyHire : "",
    strongestQualifications: asStringArray(parsed.strongestQualifications),
    relevantExperience: asStringArray(parsed.relevantExperience),
    prescreeningInsights: insights,
    ...(assessmentInsights ? { assessmentInsights } : {}),
    questionFeedback: asQuestionFeedback(parsed.questionFeedback),
    missingRequirements: asStringArray(parsed.missingRequirements),
    conflictingRequirements: asStringArray(parsed.conflictingRequirements),
    keyEvidence: asStringArray(parsed.keyEvidence),
    hiringRationale:
      typeof parsed.hiringRationale === "string"
        ? parsed.hiringRationale
        : typeof parsed.reasoning === "string"
          ? parsed.reasoning
          : "",
  };
};
