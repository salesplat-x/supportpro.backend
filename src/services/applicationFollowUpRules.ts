import { ApplicationStatus, ScreeningStage } from "../types/enums.js";

/** An application with no activity for this long is "stuck", not just mid-pipeline. */
export const STUCK_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface StuckFacts {
  status: ApplicationStatus;
  currentStage: ScreeningStage;
  updatedAt: Date;
}

/**
 * Still actively mid-pipeline (not an expected wait like a retake cooldown, and not
 * already decided) with no activity for STUCK_THRESHOLD_MS.
 * Mirrored in SQL by stuckApplicationSql() in applicationFollowUps.ts.
 */
export const isApplicationStuck = (facts: StuckFacts, now: Date = new Date()): boolean =>
  facts.status === ApplicationStatus.Pending &&
  facts.currentStage !== ScreeningStage.Completed &&
  now.getTime() - facts.updatedAt.getTime() >= STUCK_THRESHOLD_MS;

export const FOLLOW_UP_STATUSES = ["none", "emailed", "progressed"] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

/**
 * Whether a follow-up worked: "emailed" while the application hasn't moved since
 * that email was sent, "progressed" once it has. Only sent emails count.
 */
export const followUpStatus = (
  currentUpdatedAt: Date,
  lastSentEmail: { applicationUpdatedAtSnapshot: Date } | null
): FollowUpStatus => {
  if (!lastSentEmail) return "none";
  return currentUpdatedAt.getTime() > lastSentEmail.applicationUpdatedAtSnapshot.getTime()
    ? "progressed"
    : "emailed";
};

export const STUCK_STAGES: ScreeningStage[] = [
  ScreeningStage.Personality,
  ScreeningStage.Personalized,
  ScreeningStage.Prescreening,
  ScreeningStage.CvSimilarity,
];

export const STAGE_LABEL: Record<ScreeningStage, string> = {
  [ScreeningStage.Personality]: "Personality assessment",
  [ScreeningStage.Personalized]: "Role questions",
  [ScreeningStage.Prescreening]: "Pre-screening assessment",
  [ScreeningStage.CvSimilarity]: "CV review",
  [ScreeningStage.Completed]: "Completed",
};

export interface ApplicationStep {
  key: ScreeningStage;
  label: string;
  done: boolean;
  current: boolean;
}

/** Ordered checklist for the drawer, walking the application's own stages linked-list. */
export const applicationSteps = (
  orderedStageKeys: ScreeningStage[],
  currentStage: ScreeningStage
): ApplicationStep[] => {
  const currentIndex = orderedStageKeys.indexOf(currentStage);
  return orderedStageKeys.map((key, index) => ({
    key,
    label: STAGE_LABEL[key],
    done: currentIndex >= 0 && index < currentIndex,
    current: index === currentIndex,
  }));
};

export interface NextStep {
  steps: string[];
  ctaLabel: string;
}

export const NEXT_STEP_COPY: Record<ScreeningStage, NextStep> = {
  [ScreeningStage.Personality]: {
    steps: ["Answer the short personality questions for this role."],
    ctaLabel: "Finish personality questions",
  },
  [ScreeningStage.Personalized]: {
    steps: ["Answer the role-specific questions the recruiter set up."],
    ctaLabel: "Answer role questions",
  },
  [ScreeningStage.Prescreening]: {
    steps: ["Take the pre-assessment — it's reused for every job, so this is a one-time step."],
    ctaLabel: "Take the pre-assessment",
  },
  [ScreeningStage.CvSimilarity]: {
    steps: ["No action needed from the talent — we're finishing an automatic CV check."],
    ctaLabel: "View application",
  },
  [ScreeningStage.Completed]: { steps: [], ctaLabel: "View application" },
};

export const nextStepFor = (stage: ScreeningStage): NextStep => NEXT_STEP_COPY[stage];

export const MAX_SUBJECT_LENGTH = 150;
export const MAX_BODY_LENGTH = 5000;

/** Validates the AI's email draft; throws with a readable message when it is unusable. */
export const sanitizeDraft = (content: string | null | undefined) => {
  if (!content) {
    throw new Error("The AI returned nothing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("The AI returned an unreadable draft");
  }
  const { subject, body } = (parsed ?? {}) as { subject?: unknown; body?: unknown };
  if (typeof subject !== "string" || !subject.trim()) {
    throw new Error("The AI draft has no subject");
  }
  if (typeof body !== "string" || !body.trim()) {
    throw new Error("The AI draft has no body");
  }
  if (body.trim().length > MAX_BODY_LENGTH) {
    throw new Error("The AI draft is too long");
  }
  return {
    subject: subject.trim().slice(0, MAX_SUBJECT_LENGTH),
    body: body.trim(),
  };
};
