export type MatchAnalysis = {
  overallFitScore: number;
  whyFit: string;
  whyHire: string;
  strongestQualifications: string[];
  relevantExperience: string[];
  prescreeningInsights: { strengths: string[]; weaknesses: string[] };
  assessmentInsights?: string;
  missingRequirements: string[];
  conflictingRequirements: string[];
  keyEvidence: string[];
  hiringRationale: string;
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const clampScore = (value: unknown, fallback: number): number => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
};

const scoreFromVerdict = (verdict: string): number => {
  if (verdict === "high") return 85;
  if (verdict === "medium") return 65;
  if (verdict === "low") return 35;
  return 50;
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
