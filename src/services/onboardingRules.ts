import { UserRole } from "../types/enums.js";

export const TALENT_STAGES = [
  "verify_email",
  "complete_profile",
  "take_assessment",
  "apply_to_job",
  "active",
] as const;

export const RECRUITER_STAGES = [
  "verify_email",
  "create_company",
  "post_job",
  "set_up_screening",
  "publish_job",
  "active",
] as const;

export type TalentStage = (typeof TALENT_STAGES)[number];
export type RecruiterStage = (typeof RECRUITER_STAGES)[number];
export type OnboardingStage = TalentStage | RecruiterStage;

export const ONBOARDING_STAGES: OnboardingStage[] = [
  ...new Set<OnboardingStage>([...TALENT_STAGES, ...RECRUITER_STAGES]),
];

export const FOLLOW_UP_STATUSES = ["none", "emailed", "progressed"] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export type OnboardingRole = UserRole.Talent | UserRole.Recruiter;

export interface TalentFacts {
  emailVerified: boolean;
  hasCv: boolean;
  hasRoles: boolean;
  hasScore: boolean;
  hasApplication: boolean;
}

export interface RecruiterFacts {
  emailVerified: boolean;
  hasCompany: boolean;
  onPaidPlan: boolean;
  hasPaidJob: boolean;
  hasJob: boolean;
  hasScreenedJob: boolean;
}

/** The first unfinished step; mirrored in SQL by talentStageSql() in onboarding.ts. */
export const talentStageFrom = (facts: TalentFacts): TalentStage => {
  if (!facts.emailVerified) return "verify_email";
  if (!facts.hasCv || !facts.hasRoles) return "complete_profile";
  if (!facts.hasScore) return "take_assessment";
  if (!facts.hasApplication) return "apply_to_job";
  return "active";
};

/**
 * A recruiter is active once their company is on a paid plan or they have paid to post a
 * job; mirrored in SQL by recruiterStageSql() in onboarding.ts.
 */
export const recruiterStageFrom = (facts: RecruiterFacts): RecruiterStage => {
  if (!facts.emailVerified) return "verify_email";
  if (!facts.hasCompany) return "create_company";
  if (facts.onPaidPlan || facts.hasPaidJob) return "active";
  if (!facts.hasJob) return "post_job";
  if (!facts.hasScreenedJob) return "set_up_screening";
  return "publish_job";
};

export interface OnboardingStep {
  key: string;
  label: string;
  done: boolean;
}

export const talentSteps = (facts: TalentFacts): OnboardingStep[] => [
  { key: "verify_email", label: "Verify email", done: facts.emailVerified },
  {
    key: "complete_profile",
    label: "Add roles and upload a CV",
    done: facts.hasCv && facts.hasRoles,
  },
  { key: "take_assessment", label: "Take the pre-assessment", done: facts.hasScore },
  { key: "apply_to_job", label: "Apply to a job", done: facts.hasApplication },
];

export const recruiterSteps = (facts: RecruiterFacts): OnboardingStep[] => [
  { key: "verify_email", label: "Verify email", done: facts.emailVerified },
  { key: "create_company", label: "Create or join a company", done: facts.hasCompany },
  { key: "post_job", label: "Post a job", done: facts.hasJob },
  { key: "set_up_screening", label: "Set up screening", done: facts.hasScreenedJob },
  {
    key: "publish_job",
    label: "Pay to publish a job, or join a plan",
    done: facts.onPaidPlan || facts.hasPaidJob,
  },
];

/**
 * Whether a follow-up worked: "emailed" while they are still where they were when last
 * emailed, "progressed" once they moved on. Only emails that were actually sent count.
 */
export const followUpStatus = (
  currentStage: OnboardingStage,
  lastSentEmail: { stage: string } | null
): FollowUpStatus => {
  if (!lastSentEmail) return "none";
  return lastSentEmail.stage === currentStage ? "emailed" : "progressed";
};

export interface NextSteps {
  steps: string[];
  ctaLabel: string;
  /** App path for the call-to-action button; the caller makes it absolute. */
  ctaPath: string;
}

const NEXT_STEPS: Record<`${OnboardingRole}:${OnboardingStage}`, NextSteps | null> = {
  "talent:verify_email": {
    steps: ["Open the verification email we sent and click the link.", "Sign in to Auxhr."],
    ctaLabel: "Sign in to Auxhr",
    ctaPath: "/login",
  },
  "talent:complete_profile": {
    steps: [
      "Add the roles you want to work in.",
      "Upload your CV so employers and our AI can match you to jobs.",
    ],
    ctaLabel: "Finish your profile",
    ctaPath: "/talentDashboard/talentProfile",
  },
  "talent:take_assessment": {
    steps: [
      "Take the pre-assessment once. Your score is reused for every job you apply to.",
      "Set aside about 20 quiet minutes.",
    ],
    ctaLabel: "Take the pre-assessment",
    ctaPath: "/talentDashboard/talentQuiz",
  },
  "talent:apply_to_job": {
    steps: ["Browse open jobs that match your roles.", "Apply to the ones that fit you best."],
    ctaLabel: "Browse jobs",
    ctaPath: "/talentDashboard/job",
  },
  "talent:active": null,
  "talent:create_company": null,
  "talent:post_job": null,
  "talent:set_up_screening": null,
  "talent:publish_job": null,
  "recruiter:verify_email": {
    steps: ["Open the verification email we sent and click the link.", "Sign in to Auxhr."],
    ctaLabel: "Sign in to Auxhr",
    ctaPath: "/login",
  },
  "recruiter:create_company": {
    steps: ["Set up your company, or join one you were invited to.", "Then post your first job."],
    ctaLabel: "Set up your company",
    ctaPath: "/recruiterDashboard/company/new",
  },
  "recruiter:post_job": {
    steps: [
      "Post a job — describe it in a sentence and AI writes the first draft.",
      "Choose how applicants are screened.",
    ],
    ctaLabel: "Post a job",
    ctaPath: "/recruiterDashboard/postjob",
  },
  "recruiter:set_up_screening": {
    steps: [
      "Pick a screening preset for your draft job — Balanced suits most roles.",
      "Review it and publish.",
    ],
    ctaLabel: "Finish your job",
    ctaPath: "/recruiterDashboard/myJobPosts",
  },
  "recruiter:publish_job": {
    steps: [
      "Publish your job so talents can apply.",
      "Pay once for this job, or choose a plan to post more.",
    ],
    ctaLabel: "Publish your job",
    ctaPath: "/recruiterDashboard/myJobPosts",
  },
  "recruiter:active": null,
  "recruiter:complete_profile": null,
  "recruiter:take_assessment": null,
  "recruiter:apply_to_job": null,
};

export const isStageForRole = (role: OnboardingRole, stage: string): boolean =>
  (role === UserRole.Talent ? TALENT_STAGES : RECRUITER_STAGES).includes(stage as never);

/** Fixed next steps and link for a stuck user; null once they are active. */
export const nextStepsFor = (role: OnboardingRole, stage: OnboardingStage): NextSteps | null => {
  if (!isStageForRole(role, stage)) {
    throw new Error(`Unknown onboarding stage "${stage}" for ${role}`);
  }
  return NEXT_STEPS[`${role}:${stage}`];
};

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
