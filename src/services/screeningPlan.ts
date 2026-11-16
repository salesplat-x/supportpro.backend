import type { AIConfig } from "../entities/AIConfig.js";
import { ScreeningStage } from "../types/enums.js";
import { createStages } from "./aiConfig.js";
import { AI_INTERVIEW_QUESTION_COUNT } from "./aiInterview.js";

export const SKILLS_TEST_MINUTES = 10;
export const AI_INTERVIEW_MINUTES = 15;

const MINUTES_PER_QUESTION: Partial<Record<ScreeningStage, number>> = {
  [ScreeningStage.Personalized]: 1.5,
  [ScreeningStage.ProblemSolving]: 1.3,
  [ScreeningStage.CultureFit]: 1.2,
  [ScreeningStage.Personality]: 0.75,
};

export type ScreeningStepKey =
  | "skills_test"
  | "cv_match"
  | "tailored"
  | "problem_solving"
  | "culture_fit"
  | "personality"
  | "ai_interview";

export const STEP_KEY_BY_STAGE: Record<string, ScreeningStepKey> = {
  [ScreeningStage.Prescreening]: "skills_test",
  [ScreeningStage.CvSimilarity]: "cv_match",
  [ScreeningStage.Personalized]: "tailored",
  [ScreeningStage.ProblemSolving]: "problem_solving",
  [ScreeningStage.CultureFit]: "culture_fit",
  [ScreeningStage.Personality]: "personality",
  [ScreeningStage.AiInterview]: "ai_interview",
};

export interface ScreeningPlanStep {
  key: ScreeningStepKey;
  questionCount: number | null;
  minutes: number;
}

type CountFields = Pick<
  AIConfig,
  | "noPersonalizedQuestions"
  | "noOfProblemSolvingQuestions"
  | "noOfCultureFitQuestions"
  | "noOfEIQuestions"
  | "noOfSNQuestions"
  | "noOfTFQuestions"
  | "noOfJPQuestions"
  | "uploadedQuestions"
>;

const positive = (value: number | null | undefined) =>
  typeof value === "number" && value > 0 ? Math.floor(value) : 0;

export const configuredQuestionCount = (
  config: Partial<CountFields> | null,
  stage: string
): number | null => {
  if (!config) return stage === ScreeningStage.AiInterview ? AI_INTERVIEW_QUESTION_COUNT : null;
  switch (stage) {
    case ScreeningStage.Personalized:
      return positive(config.noPersonalizedQuestions);
    case ScreeningStage.ProblemSolving:
      return positive(config.noOfProblemSolvingQuestions);
    case ScreeningStage.CultureFit:
      return positive(config.noOfCultureFitQuestions);
    case ScreeningStage.Personality:
      return (
        positive(config.noOfEIQuestions) +
        positive(config.noOfSNQuestions) +
        positive(config.noOfTFQuestions) +
        positive(config.noOfJPQuestions) +
        (config.uploadedQuestions ?? []).filter((q) => q.trim()).length
      );
    case ScreeningStage.AiInterview:
      return AI_INTERVIEW_QUESTION_COUNT;
    default:
      return null;
  }
};

export const stageMinutes = (stage: string, questionCount: number | null): number | null => {
  if (stage === ScreeningStage.Prescreening) return SKILLS_TEST_MINUTES;
  if (stage === ScreeningStage.AiInterview) return AI_INTERVIEW_MINUTES;
  const rate = MINUTES_PER_QUESTION[stage as ScreeningStage];
  return rate && questionCount ? Math.ceil(questionCount * rate) : null;
};

/** Ordered stage keys of a linked stages map, from its entry stage to completion. */
export const orderedStages = (stages: Record<string, string>): string[] => {
  const targets = new Set(Object.values(stages));
  let cursor = Object.keys(stages).find((key) => !targets.has(key));
  const ordered: string[] = [];
  while (cursor && cursor !== ScreeningStage.Completed && !ordered.includes(cursor)) {
    ordered.push(cursor);
    cursor = stages[cursor];
  }
  return ordered;
};

/** The timed steps a candidate goes through for this job, in order. Never exposes thresholds. */
export const screeningPlan = (config: AIConfig | null | undefined): ScreeningPlanStep[] => {
  if (!config) return [];
  const steps: ScreeningPlanStep[] = [];
  for (const stage of orderedStages(createStages(config).stages)) {
    const questionCount = configuredQuestionCount(config, stage);
    const minutes = stageMinutes(stage, questionCount);
    if (minutes === null) continue;
    steps.push({ key: STEP_KEY_BY_STAGE[stage]!, questionCount, minutes });
  }
  return steps;
};
