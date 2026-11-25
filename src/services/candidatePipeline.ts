import { In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import {
  AiInterview,
  AiInterviewQuestion,
  Answer,
  Application,
  ApplicationReference,
  User,
} from "../entities";
import { ApplicationStatus, QuestionType, ScreeningStage } from "../types/enums.js";
import {
  INTERVIEW_DUE_DAYS,
  SKILLS_TEST_DUE_DAYS,
  TEST_DUE_DAYS,
} from "../config/candidatePipeline.js";
import { isPrescreeningScoreValid } from "./prescreening.js";
import { hasReachedStage, STAGE_SWITCH } from "./applicationStage.js";
import { ApplicationConsent } from "../entities/ApplicationConsent.js";
import { MAX_REFEREES } from "./applicationReferences.js";
import {
  configuredQuestionCount,
  orderedStages,
  stageMinutes,
  STEP_KEY_BY_STAGE,
  type ScreeningStepKey,
} from "./screeningPlan.js";

export type PipelineStepKey =
  "applied" | ScreeningStepKey | "references" | "checks" | "company_review";
export type PipelineStepState = "done" | "current" | "upcoming";
export type CandidateStatus =
  "interview_to_do" | "test_to_take" | "screening" | "shortlisted" | "applied" | "not_proceeding";
export type ApplicationGroup = "needs_you" | "in_progress" | "closed";

export interface PipelineStep {
  key: PipelineStepKey;
  state: PipelineStepState;
  sentAt: string | null;
  doneAt: string | null;
  dueAt: string | null;
  isNew: boolean;
  questionCount: number | null;
  minutes: number | null;
  score: number | null;
  passed: boolean | null;
  answersSent: number | null;
  retryAt: string | null;
  interviewId: string | null;
  refereeCount: number | null;
  maxReferees: number | null;
  outcome: "shortlisted" | "not_proceeding" | null;
}

export interface CandidatePipeline {
  application: {
    id: string;
    jobId: string;
    status: ApplicationStatus;
    appliedAt: string;
    candidateStatus: CandidateStatus;
    group: ApplicationGroup;
    job: {
      id: string;
      title: string;
      status: string;
      workMode: string[];
      locationCity: string | null;
      locationState: string | null;
      locationCountry: string | null;
      organization: { id: string; name: string; logoUrl: string | null } | null;
    };
  };
  steps: PipelineStep[];
  currentStep: number | null;
  totalSteps: number;
  nextStep: PipelineStep | null;
}

const TEST_STEPS: PipelineStepKey[] = [
  "skills_test",
  "tailored",
  "problem_solving",
  "culture_fit",
  "personality",
];
const DECIDED: ApplicationStatus[] = [
  ApplicationStatus.Shortlisted,
  ApplicationStatus.Rejected,
  ApplicationStatus.NotProceeding,
];
const ANSWER_TYPES = [
  QuestionType.Personalized,
  QuestionType.ProblemSolving,
  QuestionType.CultureFit,
  QuestionType.Personality,
];
const ANSWER_TYPE_BY_STAGE: Record<string, QuestionType> = {
  [ScreeningStage.Personalized]: QuestionType.Personalized,
  [ScreeningStage.ProblemSolving]: QuestionType.ProblemSolving,
  [ScreeningStage.CultureFit]: QuestionType.CultureFit,
  [ScreeningStage.Personality]: QuestionType.Personality,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;
const addDays = (value: string | null, days: number): string | null =>
  value ? new Date(new Date(value).getTime() + days * DAY_MS).toISOString() : null;

const emptyStep = (key: PipelineStepKey): PipelineStep => ({
  key,
  state: "upcoming",
  sentAt: null,
  doneAt: null,
  dueAt: null,
  isNew: false,
  questionCount: null,
  minutes: null,
  score: null,
  passed: null,
  answersSent: null,
  retryAt: null,
  interviewId: null,
  refereeCount: null,
  maxReferees: null,
  outcome: null,
});

interface InterviewState {
  id: string;
  status: AiInterview["status"];
  invitedAt: Date | null;
  total: number;
  recorded: number;
  lastRecordedAt: Date | null;
}

interface PipelineContext {
  talent: Pick<User, "prescreeningScore" | "prescreeningScoredAt"> | null;
  answers: Map<string, Answer>;
  interviews: Map<string, InterviewState>;
  referees: Map<string, number>;
  consents: Map<string, ApplicationConsent>;
  now: number;
}

const loadContext = async (
  talentId: string,
  applications: Application[]
): Promise<PipelineContext> => {
  const ids = applications.map((app) => app.id);
  const jobIds = applications.map((app) => app.jobId);
  const [talent, answers, interviews, referees, consents] = await Promise.all([
    AppDataSource.getRepository(User).findOne({
      where: { id: talentId },
      select: { id: true, prescreeningScore: true, prescreeningScoredAt: true },
    }),
    AppDataSource.getRepository(Answer).find({
      where: { userId: talentId, jobId: In(jobIds), questionType: In(ANSWER_TYPES) },
    }),
    AppDataSource.getRepository(AiInterview).find({
      where: { applicationId: In(ids) },
      select: { id: true, applicationId: true, status: true, invitedAt: true },
    }),
    AppDataSource.getRepository(ApplicationReference)
      .createQueryBuilder("r")
      .select("r.applicationId", "applicationId")
      .addSelect("COUNT(*)", "count")
      .where("r.applicationId IN (:...ids)", { ids })
      .groupBy("r.applicationId")
      .getRawMany<{ applicationId: string; count: string }>(),
    AppDataSource.getRepository(ApplicationConsent).find({
      where: { applicationId: In(ids) },
      select: {
        id: true,
        applicationId: true,
        requestedAt: true,
        agreedAt: true,
        declinedAt: true,
      },
    }),
  ]);

  const interviewIds = interviews.map((interview) => interview.id);
  const progress = interviewIds.length
    ? await AppDataSource.getRepository(AiInterviewQuestion)
        .createQueryBuilder("q")
        .select("q.interviewId", "interviewId")
        .addSelect("COUNT(*)", "total")
        .addSelect("COUNT(q.recordedAt)", "recorded")
        .addSelect("MAX(q.recordedAt)", "lastRecordedAt")
        .where("q.interviewId IN (:...interviewIds)", { interviewIds })
        .groupBy("q.interviewId")
        .getRawMany<{
          interviewId: string;
          total: string;
          recorded: string;
          lastRecordedAt: Date | null;
        }>()
    : [];
  const progressById = new Map(progress.map((row) => [row.interviewId, row]));

  return {
    talent,
    answers: new Map(answers.map((answer) => [`${answer.jobId}:${answer.questionType}`, answer])),
    interviews: new Map(
      interviews.map((interview) => {
        const row = progressById.get(interview.id);
        return [
          interview.applicationId,
          {
            id: interview.id,
            status: interview.status,
            invitedAt: interview.invitedAt,
            total: Number(row?.total ?? 0),
            recorded: Number(row?.recorded ?? 0),
            lastRecordedAt: row?.lastRecordedAt ?? null,
          },
        ];
      })
    ),
    referees: new Map(referees.map((row) => [row.applicationId, Number(row.count)])),
    consents: new Map(consents.map((row) => [row.applicationId, row])),
    now: Date.now(),
  };
};

const stageOrder = (application: Application): string[] => {
  const order = orderedStages(application.stages ?? {});
  const config = application.job?.aiConfig;
  const parallel = [
    {
      stage: ScreeningStage.ProblemSolving,
      on:
        !!config?.problemSolvingAssessment ||
        application.problemSolvingScore !== null ||
        !!application.problemSolvingQuestions?.length,
    },
    {
      stage: ScreeningStage.CultureFit,
      on:
        !!config?.cultureFitAssessment ||
        application.cultureFitScore !== null ||
        !!application.cultureFitQuestions?.length,
    },
  ];
  for (const { stage, on } of parallel) {
    if (!on || order.includes(stage)) continue;
    const anchor = [
      ScreeningStage.CultureFit,
      ScreeningStage.ProblemSolving,
      ScreeningStage.Personalized,
      ScreeningStage.CvSimilarity,
      ScreeningStage.Prescreening,
    ].find((candidate) => order.includes(candidate));
    order.splice(anchor ? order.indexOf(anchor) + 1 : 0, 0, stage);
  }
  return order;
};

const buildPipeline = (application: Application, ctx: PipelineContext): CandidatePipeline => {
  const stages = application.stages ?? {};
  const current = application.currentStage;
  const completed = current === ScreeningStage.Completed;
  const reached = (stage: string) =>
    completed ||
    (Object.prototype.hasOwnProperty.call(stages, stage) &&
      hasReachedStage(stages, current, stage as ScreeningStage));
  const passed = (stage: string) => reached(stage) && current !== stage;
  const reachedAt = (stage: string) => application.stageReachedAt?.[stage] ?? null;
  const interview = ctx.interviews.get(application.id) ?? null;
  const interviewRecorded =
    !!interview && interview.total > 0 && interview.recorded === interview.total;
  const refereeCount = ctx.referees.get(application.id) ?? 0;
  const appliedAt = iso(application.createdAt)!;
  const config = application.job?.aiConfig ?? null;

  const order = stageOrder(application);
  const steps: Array<PipelineStep & { done: boolean; started: boolean }> = [];

  const applied = emptyStep("applied");
  steps.push({ ...applied, doneAt: appliedAt, done: true, started: true });

  for (const stage of order) {
    const key = STEP_KEY_BY_STAGE[stage];
    if (!key) continue;
    const step = emptyStep(key);
    const answer = ANSWER_TYPE_BY_STAGE[stage]
      ? ctx.answers.get(`${application.jobId}:${ANSWER_TYPE_BY_STAGE[stage]}`)
      : undefined;
    let done = passed(stage);
    let started = !!answer;

    switch (stage) {
      case ScreeningStage.Prescreening: {
        const score = ctx.talent?.prescreeningScore ?? null;
        if (score !== null && isPrescreeningScoreValid(ctx.talent?.prescreeningScoredAt ?? null)) {
          step.score = score;
          step.passed = score >= (config?.minPrescreeningScore ?? 0);
        }
        step.sentAt = reachedAt(stage) ?? appliedAt;
        if (
          application.status === ApplicationStatus.RetakeAssessment &&
          application.assessmentRetryDate &&
          application.assessmentRetryDate.getTime() > ctx.now
        ) {
          step.retryAt = iso(application.assessmentRetryDate);
        }
        break;
      }
      case ScreeningStage.ProblemSolving:
      case ScreeningStage.CultureFit: {
        const isPs = stage === ScreeningStage.ProblemSolving;
        const assigned = isPs
          ? application.problemSolvingQuestions
          : application.cultureFitQuestions;
        const score = isPs ? application.problemSolvingScore : application.cultureFitScore;
        done = done || score !== null;
        started = done || !!assigned?.length;
        step.questionCount = assigned?.length || configuredQuestionCount(config, stage);
        step.isNew = !started;
        break;
      }
      case ScreeningStage.Personalized:
        step.questionCount =
          application.personalizedQuestions?.length || configuredQuestionCount(config, stage);
        started = started || !!application.personalizedQuestions?.length;
        break;
      case ScreeningStage.Personality:
        done = done || application.mbtiType !== null;
        step.questionCount =
          application.personalityQuestions?.length || configuredQuestionCount(config, stage);
        started = started || !!application.personalityQuestions?.length;
        break;
      case ScreeningStage.AiInterview:
        done = interviewRecorded;
        started = !!interview && interview.recorded > 0;
        step.questionCount = configuredQuestionCount(config, stage);
        step.sentAt = iso(interview?.invitedAt) ?? reachedAt(stage);
        step.doneAt = done ? iso(interview?.lastRecordedAt) : null;
        step.interviewId =
          interview && (interview.status === "ready" || interview.status === "invited")
            ? interview.id
            : null;
        break;
    }

    const flag = STAGE_SWITCH[stage as ScreeningStage];
    if (config && flag && !config[flag] && !done && !started) continue;

    step.minutes = stageMinutes(stage, step.questionCount);
    if (answer && done && stage !== ScreeningStage.AiInterview) {
      step.answersSent = answer.responses.length;
      step.doneAt = iso(answer.createdAt);
    }
    if (!step.sentAt && stage !== ScreeningStage.CvSimilarity) step.sentAt = reachedAt(stage);
    steps.push({ ...step, done, started });
  }

  const lastStage = order[order.length - 1];
  if (completed || refereeCount > 0 || (lastStage !== undefined && reached(lastStage))) {
    steps.push({
      ...emptyStep("references"),
      refereeCount,
      maxReferees: MAX_REFEREES,
      done: refereeCount > 0,
      started: refereeCount > 0,
    });
  }

  const consent = ctx.consents.get(application.id);
  if (consent) {
    const answeredAt = consent.agreedAt ?? consent.declinedAt;
    steps.push({
      ...emptyStep("checks"),
      sentAt: iso(consent.requestedAt),
      doneAt: iso(answeredAt),
      done: !!answeredAt,
      started: !!answeredAt,
    });
  }

  const decided = DECIDED.includes(application.status);
  steps.push({
    ...emptyStep("company_review"),
    outcome: !decided
      ? null
      : application.status === ApplicationStatus.Shortlisted
        ? "shortlisted"
        : "not_proceeding",
    done: decided,
    started: decided,
  });

  const currentIndex = decided ? -1 : steps.findIndex((step) => !step.done);
  const result: PipelineStep[] = steps.map(({ done, started: _started, ...step }, index) => {
    const state: PipelineStepState = done
      ? "done"
      : index === currentIndex
        ? "current"
        : "upcoming";
    const dueAt =
      state !== "current"
        ? null
        : step.key === "skills_test"
          ? addDays(appliedAt, SKILLS_TEST_DUE_DAYS)
          : step.key === "ai_interview"
            ? addDays(step.sentAt, INTERVIEW_DUE_DAYS)
            : TEST_STEPS.includes(step.key)
              ? addDays(step.sentAt, TEST_DUE_DAYS)
              : null;
    return { ...step, state, dueAt, isNew: step.isNew && state !== "done" };
  });

  const nextStep = currentIndex >= 0 ? result[currentIndex]! : null;
  const candidateStatus = statusFor(application.status, nextStep, result, ctx.now);
  const job = application.job;

  return {
    application: {
      id: application.id,
      jobId: application.jobId,
      status: application.status,
      appliedAt,
      candidateStatus,
      group:
        candidateStatus === "not_proceeding"
          ? "closed"
          : candidateStatus === "interview_to_do" || candidateStatus === "test_to_take"
            ? "needs_you"
            : "in_progress",
      job: {
        id: application.jobId,
        title: job?.role?.name ?? "",
        status: job?.status ?? "",
        workMode: job?.workMode ?? [],
        locationCity: job?.locationCity ?? null,
        locationState: job?.locationState ?? null,
        locationCountry: job?.locationCountry ?? null,
        organization: job?.organization
          ? {
              id: job.organization.id,
              name: job.organization.name,
              logoUrl: job.organization.logoUrl ?? null,
            }
          : null,
      },
    },
    steps: result,
    currentStep: currentIndex >= 0 ? currentIndex + 1 : null,
    totalSteps: result.length,
    nextStep,
  };
};

const statusFor = (
  status: ApplicationStatus,
  next: PipelineStep | null,
  steps: PipelineStep[],
  now: number
): CandidateStatus => {
  if (status === ApplicationStatus.Rejected || status === ApplicationStatus.NotProceeding) {
    return "not_proceeding";
  }
  if (status === ApplicationStatus.Shortlisted) return "shortlisted";
  if (next?.key === "ai_interview" && next.interviewId) return "interview_to_do";
  if (next && TEST_STEPS.includes(next.key)) {
    const waiting = next.retryAt !== null && new Date(next.retryAt).getTime() > now;
    return waiting ? "screening" : "test_to_take";
  }
  const anyDone = steps.some((step) => step.key !== "applied" && step.state === "done");
  return anyDone ? "screening" : "applied";
};

const PIPELINE_RELATIONS = {
  job: { role: true, organization: true, aiConfig: true },
} as const;

export const buildCandidatePipelines = async (
  talentId: string,
  applications: Application[]
): Promise<CandidatePipeline[]> => {
  if (applications.length === 0) return [];
  const ctx = await loadContext(talentId, applications);
  return applications.map((application) => buildPipeline(application, ctx));
};

export const loadTalentApplications = (talentId: string, ids?: string[]): Promise<Application[]> =>
  AppDataSource.getRepository(Application).find({
    where: { talentId, ...(ids ? { id: In(ids) } : {}) },
    relations: PIPELINE_RELATIONS,
    order: { createdAt: "DESC" },
  });
