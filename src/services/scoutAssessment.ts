import { ValidationError } from "../utils/errors";

export interface ScoutCandidateDetails {
  fullName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  headline: string | null;
  yearsExperience: number | null;
  skills: string[];
}

export interface ScoutAssessment {
  overallScore: number;
  skillsScore: number;
  experienceScore: number;
  locationFit: number;
  mustHaveSkillsMet: string[];
  mustHaveSkillsMissing: string[];
  recommendation: string;
  strengths: string[];
  concerns: string[];
  candidate: ScoutCandidateDetails;
}

/**
 * A score of 0 is a legitimate verdict, so every numeric check here tests the type
 * and range rather than truthiness. The previous implementation used
 * `if (!parsed.cvScore)`, which treated 0 as a malformed response and retried a
 * perfectly good assessment until the attempt budget ran out.
 */
const isScore = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const nullableString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const nullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const MIN_RECOMMENDATION_LENGTH = 20;

/**
 * Validates and normalises a raw LLM assessment. Throws `ValidationError` so the
 * caller's retry loop treats it as a transient bad response (see
 * `isDurableRetryable`), which is the right call for a model that usually gets it
 * right on the next attempt.
 */
export const parseScoutAssessment = (content: string, fileLabel: string): ScoutAssessment => {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new ValidationError(`AI response for ${fileLabel} was not valid JSON`);
  }

  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError(`AI response for ${fileLabel} was not an object`);
  }
  const parsed = raw as Record<string, unknown>;

  for (const key of ["overallScore", "skillsScore", "experienceScore", "locationFit"]) {
    if (!isScore(parsed[key])) {
      throw new ValidationError(
        `AI response for ${fileLabel} has an invalid ${key} (expected a number between 0 and 100)`
      );
    }
  }

  const recommendation = nullableString(parsed["recommendation"]);
  if (!recommendation || recommendation.length < MIN_RECOMMENDATION_LENGTH) {
    throw new ValidationError(
      `AI response for ${fileLabel} did not explain why this candidate was scored`
    );
  }

  const candidateRaw = parsed["candidate"];
  if (typeof candidateRaw !== "object" || candidateRaw === null) {
    throw new ValidationError(`AI response for ${fileLabel} is missing candidate details`);
  }
  const candidate = candidateRaw as Record<string, unknown>;

  return {
    overallScore: parsed["overallScore"] as number,
    skillsScore: parsed["skillsScore"] as number,
    experienceScore: parsed["experienceScore"] as number,
    locationFit: parsed["locationFit"] as number,
    mustHaveSkillsMet: isStringArray(parsed["mustHaveSkillsMet"])
      ? parsed["mustHaveSkillsMet"]
      : [],
    mustHaveSkillsMissing: isStringArray(parsed["mustHaveSkillsMissing"])
      ? parsed["mustHaveSkillsMissing"]
      : [],
    recommendation,
    strengths: isStringArray(parsed["strengths"]) ? parsed["strengths"] : [],
    concerns: isStringArray(parsed["concerns"]) ? parsed["concerns"] : [],
    candidate: {
      fullName: nullableString(candidate["fullName"]),
      email: nullableString(candidate["email"])?.toLowerCase() ?? null,
      phone: nullableString(candidate["phone"]),
      city: nullableString(candidate["city"]),
      state: nullableString(candidate["state"]),
      country: nullableString(candidate["country"]),
      headline: nullableString(candidate["headline"]),
      yearsExperience: nullableNumber(candidate["yearsExperience"]),
      skills: isStringArray(candidate["skills"]) ? candidate["skills"] : [],
    },
  };
};

/**
 * Human-readable summary of the assessment, stored on `scouts.insights` alongside
 * the plain-English `recommendation` so the drawer has both the verdict and the
 * evidence behind it.
 */
export const formatAssessmentInsights = (assessment: ScoutAssessment): string => {
  const sections: string[] = [];
  if (assessment.strengths.length > 0) {
    sections.push(`Strengths: ${assessment.strengths.join("; ")}`);
  }
  if (assessment.concerns.length > 0) {
    sections.push(`Concerns: ${assessment.concerns.join("; ")}`);
  }
  if (assessment.mustHaveSkillsMet.length > 0) {
    sections.push(`Met must-haves: ${assessment.mustHaveSkillsMet.join("; ")}`);
  }
  if (assessment.mustHaveSkillsMissing.length > 0) {
    sections.push(`Missing must-haves: ${assessment.mustHaveSkillsMissing.join("; ")}`);
  }
  return sections.join("\n");
};
