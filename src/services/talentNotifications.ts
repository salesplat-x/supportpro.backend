import { AppDataSource } from "../database/dataSource.js";
import { Application, Notification } from "../entities";
import { ScreeningStage } from "../types/enums.js";
import logger from "../utils/logger.js";
import { INTERVIEW_DUE_DAYS, TEST_DUE_DAYS } from "../config/candidatePipeline.js";

export const TALENT_NOTIFICATION = {
  ApplicationReceived: "application_received",
  TestSent: "test_sent",
  InterviewInvite: "interview_invite",
  ProfileViewed: "profile_viewed",
  StaffInvite: "staff_invite",
  ApplicationUpdate: "application_update",
} as const;

export type TalentNotificationType = (typeof TALENT_NOTIFICATION)[keyof typeof TALENT_NOTIFICATION];

const NOTIFICATION_TIME_ZONE = "Africa/Lagos";
const DAY_MS = 24 * 60 * 60 * 1000;

const dayLabel = (date: Date, weekday: boolean) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: NOTIFICATION_TIME_ZONE,
    ...(weekday ? { weekday: "short" as const } : {}),
    day: "numeric",
    month: "short",
  })
    .format(date)
    .replace(",", "");

export const applicationLink = (applicationId: string) =>
  `/talentDashboard/applications/${applicationId}`;

export interface TalentNotificationInput {
  userId: string;
  type: TalentNotificationType;
  title: string;
  message: string;
  link?: string | null;
  organizationId?: string | null;
  dedupeKey?: string | null;
}

/** Never throws, and a repeated dedupe key adds nothing, so callers can notify after every commit. */
export const notifyTalent = async (input: TalentNotificationInput): Promise<void> => {
  try {
    await AppDataSource.getRepository(Notification)
      .createQueryBuilder()
      .insert()
      .into(Notification)
      .values({
        userId: input.userId,
        type: input.type,
        title: input.title,
        message: input.message,
        link: input.link ?? null,
        organizationId: input.organizationId ?? null,
        dedupeKey: input.dedupeKey ?? null,
      })
      .orIgnore()
      .execute();
  } catch (error) {
    logger.error(`Notification ${input.type} for user ${input.userId} failed: ${String(error)}`);
  }
};

const TESTS: Partial<Record<ScreeningStage, { name: string; kind: string }>> = {
  [ScreeningStage.Personalized]: { name: "tailored questions", kind: "tailored" },
  [ScreeningStage.ProblemSolving]: { name: "a problem-solving test", kind: "problem-solving" },
  [ScreeningStage.CultureFit]: { name: "a culture-fit test", kind: "culture-fit" },
  [ScreeningStage.Personality]: { name: "a personality check", kind: "personality" },
};

const loadApplication = (applicationId: string) =>
  AppDataSource.getRepository(Application).findOne({
    where: { id: applicationId },
    relations: { job: { role: true, organization: true } },
  });

const companyOf = (application: Application) => application.job?.organization?.name ?? "AuxHR";

export const notifyApplicationReceived = async (applicationId: string): Promise<void> => {
  const application = await loadApplication(applicationId).catch(() => null);
  if (!application) return;
  await notifyTalent({
    userId: application.talentId,
    type: TALENT_NOTIFICATION.ApplicationReceived,
    title: `Your application to ${companyOf(application)} was received`,
    message: application.job?.role?.name ?? "Your application",
    link: applicationLink(application.id),
    dedupeKey: `application_received:${application.id}`,
  });
};

/** Tells the candidate when their application has just opened a test for them. */
export const notifyStageReached = async (applicationId: string): Promise<void> => {
  const application = await loadApplication(applicationId).catch(() => null);
  const test = application ? TESTS[application.currentStage] : undefined;
  if (!application || !test) return;
  const reachedAt = application.stageReachedAt?.[application.currentStage];
  const due = new Date(
    (reachedAt ? new Date(reachedAt).getTime() : Date.now()) + TEST_DUE_DAYS * DAY_MS
  );
  await notifyTalent({
    userId: application.talentId,
    type: TALENT_NOTIFICATION.TestSent,
    title: `${companyOf(application)} sent you ${test.name}`,
    message: `${application.job?.role?.name ?? "Your application"} · due ${dayLabel(due, true)}`,
    link: `${applicationLink(application.id)}/test/${test.kind}`,
    dedupeKey: `stage:${application.id}:${application.currentStage}`,
  });
};

export const notifyInterviewReady = async (
  applicationId: string,
  interviewId: string
): Promise<void> => {
  const application = await loadApplication(applicationId).catch(() => null);
  if (!application) return;
  const due = new Date(Date.now() + INTERVIEW_DUE_DAYS * DAY_MS);
  await notifyTalent({
    userId: application.talentId,
    type: TALENT_NOTIFICATION.InterviewInvite,
    title: `${companyOf(application)} invited you to a recorded interview`,
    message: `${application.job?.role?.name ?? "Your application"} · do it by ${dayLabel(due, false)}`,
    link: `/talentDashboard/interview/${interviewId}`,
    dedupeKey: `interview:${interviewId}`,
  });
};

export const profileViewKey = (organizationId: string, at: Date) =>
  `profile_view:${organizationId}:${new Intl.DateTimeFormat("en-CA", { timeZone: NOTIFICATION_TIME_ZONE }).format(at)}`;
