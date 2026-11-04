import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  createApplication,
  createJob,
  createRecruiter,
  createRole,
  createTalent,
} from "./helpers/fixtures.js";
import { addMember, setupCompany } from "./helpers/company.js";
import { Application } from "../src/entities/Application.js";
import { Notification } from "../src/entities/Notification.js";
import { User } from "../src/entities/User.js";
import { triggerMatchVerdict } from "../src/services/applicationStage.js";
import { assessApplicationMatch } from "../src/utils/integrations/openai.js";
import { ApplicationStatus, JobStatus, MatchVerdict, ScreeningStage } from "../src/types/enums.js";
import type { Organization } from "../src/entities/Organization.js";
import type { Job } from "../src/entities/Job.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  __esModule: true,
  assessApplicationMatch: jest.fn(),
}));

const mockAi = assessApplicationMatch as jest.MockedFunction<typeof assessApplicationMatch>;

const aiSays = (verdict: string) =>
  mockAi.mockResolvedValue({
    message: {
      content: JSON.stringify({
        verdict,
        reasoning: "Evidence from the CV.",
        strengths: [],
        weaknesses: [],
        risks: [],
        recommendation: verdict === "high" ? "hire" : "no_hire",
      }),
    },
  } as never);

const notificationsFor = (userId: string) =>
  testDataSource.getRepository(Notification).find({ where: { userId } });

const finishedApplication = async (job: Job, overrides: Partial<Application> = {}) => {
  const { user: talent } = await createTalent({ firstName: "Ada", lastName: "Obi" });
  const application = await createApplication(talent, job, {
    currentStage: ScreeningStage.Completed,
    status: ApplicationStatus.AwaitingDecision,
    ...overrides,
  });
  return { talent, application };
};

const companyJob = async (org: Organization, postedBy: User, overrides: Partial<Job> = {}) => {
  const role = await createRole("Account Executive");
  return createJob(postedBy, role, { organizationId: org.id, ...overrides });
};

beforeAll(async () => {
  await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
});

describe("AI match alerts", () => {
  it("tells every teammate and the creator about a High verdict, once each", async () => {
    aiSays("high");
    const { owner, org } = await setupCompany();
    const teammate = await addMember(org);
    const job = await companyJob(org, teammate.user);
    const { talent, application } = await finishedApplication(job);

    await triggerMatchVerdict(talent, application);

    for (const userId of [owner.user.id, teammate.user.id]) {
      const [notification, ...rest] = await notificationsFor(userId);
      expect(rest).toHaveLength(0);
      expect(notification?.title).toBe("New high match");
      expect(notification?.message).toBe("Ada Obi is a high match for Account Executive.");
      expect(notification?.organizationId).toBe(org.id);
      expect(notification?.link).toBe(
        `/recruiterDashboard/singleJobPost/${job.id}?applicationId=${application.id}`
      );
      expect(notification?.isRead).toBe(false);
    }
  });

  it("doesn't tell the talent, or another company's team", async () => {
    aiSays("high");
    const { org, owner } = await setupCompany();
    const other = await setupCompany("Other Ltd");
    const job = await companyJob(org, owner.user);
    const { talent, application } = await finishedApplication(job);

    await triggerMatchVerdict(talent, application);

    expect(await notificationsFor(talent.id)).toHaveLength(0);
    expect(await notificationsFor(other.owner.user.id)).toHaveLength(0);
  });

  it.each(["medium", "low"])("stays quiet on a %s verdict", async (verdict) => {
    aiSays(verdict);
    const { owner, org } = await setupCompany();
    const job = await companyJob(org, owner.user);
    const { talent, application } = await finishedApplication(job);

    await triggerMatchVerdict(talent, application);

    expect(await notificationsFor(owner.user.id)).toHaveLength(0);
  });

  it("doesn't notify again when the verdict is triggered a second time", async () => {
    aiSays("high");
    const { owner, org } = await setupCompany();
    const job = await companyJob(org, owner.user);
    const { talent, application } = await finishedApplication(job);

    await triggerMatchVerdict(talent, application);
    await triggerMatchVerdict(talent, application);

    expect(await notificationsFor(owner.user.id)).toHaveLength(1);
  });

  it("keeps the verdict when a duplicate alert already exists", async () => {
    aiSays("high");
    const { owner, org } = await setupCompany();
    const job = await companyJob(org, owner.user);
    const { talent, application } = await finishedApplication(job);
    await testDataSource.getRepository(Notification).save({
      userId: owner.user.id,
      message: "Earlier",
      dedupeKey: `ai_match:${application.id}`,
    });

    await triggerMatchVerdict(talent, application);

    const saved = await testDataSource
      .getRepository(Application)
      .findOneByOrFail({ id: application.id });
    expect(saved.matchVerdict).toBe(MatchVerdict.High);
    expect(await notificationsFor(owner.user.id)).toHaveLength(1);
  });

  it("stays quiet when a script asks it to", async () => {
    aiSays("high");
    const { owner, org } = await setupCompany();
    const job = await companyJob(org, owner.user);
    const { talent, application } = await finishedApplication(job);

    await triggerMatchVerdict(talent, application, { notify: false });

    const saved = await testDataSource
      .getRepository(Application)
      .findOneByOrFail({ id: application.id });
    expect(saved.matchVerdict).toBe(MatchVerdict.High);
    expect(await notificationsFor(owner.user.id)).toHaveLength(0);
  });

  it("stays quiet for a stored verdict that isn't new", async () => {
    const { owner, org } = await setupCompany();
    const job = await companyJob(org, owner.user);
    const { talent, application } = await finishedApplication(job, {
      matchVerdict: MatchVerdict.High,
    });

    await triggerMatchVerdict(talent, application);

    expect(mockAi).not.toHaveBeenCalled();
    expect(await notificationsFor(owner.user.id)).toHaveLength(0);
  });

  it("stays quiet on a job that's no longer open", async () => {
    aiSays("high");
    const { owner, org } = await setupCompany();
    const job = await companyJob(org, owner.user, { status: JobStatus.Closed });
    const { talent, application } = await finishedApplication(job);

    await triggerMatchVerdict(talent, application);

    expect(await notificationsFor(owner.user.id)).toHaveLength(0);
  });

  it("stays quiet on an application more than 30 days old", async () => {
    aiSays("high");
    const { owner, org } = await setupCompany();
    const job = await companyJob(org, owner.user);
    const { talent, application } = await finishedApplication(job);
    await testDataSource
      .getRepository(Application)
      .update(application.id, { createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) });

    await triggerMatchVerdict(talent, application);

    expect(await notificationsFor(owner.user.id)).toHaveLength(0);
  });

  it("tells only the poster about a job with no company", async () => {
    aiSays("high");
    const { user: recruiter } = await createRecruiter();
    const { user: bystander } = await createRecruiter();
    const role = await createRole("Support Lead");
    const job = await createJob(recruiter, role);
    const { talent, application } = await finishedApplication(job);

    await triggerMatchVerdict(talent, application);

    const [notification] = await notificationsFor(recruiter.id);
    expect(notification?.organizationId).toBeNull();
    expect(notification?.message).toContain("Support Lead");
    expect(await notificationsFor(bystander.id)).toHaveLength(0);
  });

  it("skips a teammate whose account is switched off", async () => {
    aiSays("high");
    const { owner, org } = await setupCompany();
    const teammate = await addMember(org);
    await testDataSource.getRepository(User).update(teammate.user.id, { active: false });
    const job = await companyJob(org, owner.user);
    const { talent, application } = await finishedApplication(job);

    await triggerMatchVerdict(talent, application);

    expect(await notificationsFor(teammate.user.id)).toHaveLength(0);
    expect(await notificationsFor(owner.user.id)).toHaveLength(1);
  });

  it("keeps the alert's text when the company is deleted, without its link's company", async () => {
    aiSays("high");
    const { owner, org } = await setupCompany();
    const job = await companyJob(org, owner.user);
    const { talent, application } = await finishedApplication(job);
    await triggerMatchVerdict(talent, application);

    await testDataSource.query(`UPDATE jobs SET organization_id = NULL WHERE id = $1`, [job.id]);
    await testDataSource.query(`UPDATE users SET active_organization_id = NULL`);
    await testDataSource.query(`DELETE FROM organizations WHERE id = $1`, [org.id]);

    const [notification] = await notificationsFor(owner.user.id);
    expect(notification?.organizationId).toBeNull();
    expect(notification?.message).toContain("Ada Obi");
  });
});
