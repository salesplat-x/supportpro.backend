/**
 * The timer behind the automatic emails to stuck users.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import env from "../src/config/env.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  Application,
  ApplicationFollowUpEmail,
  OnboardingEmail,
  StuckEmailTimer,
  User,
} from "../src/entities";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import {
  createAdmin,
  createApplication,
  createJob,
  createRecruiter,
  createRole,
  createTalent,
} from "./helpers/fixtures.js";
import { createStaff } from "./helpers/staff.js";
import { linkAccount } from "./helpers/team.js";
import {
  closeMovedOnTimers,
  resetStuckEmailThrottle,
  runStuckEmailSweep,
  sendDueStuckEmails,
  startStuckTimers,
  unsubscribeToken,
} from "../src/services/stuckEmails.js";
import {
  ApplicationStatus,
  ApplicationType,
  JobStatus,
  ScreeningStage,
} from "../src/types/enums.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  __esModule: true,
  createEmbedding: jest.fn(),
}));

jest.mock("../src/utils/integrations/email/emailService.js", () => {
  const sendOnboardingFollowUp = jest.fn().mockResolvedValue(undefined);
  const sendApplicationFollowUp = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    sendOnboardingFollowUp,
    sendApplicationFollowUp,
    default: jest.fn().mockImplementation(() => ({
      sendOnboardingFollowUp,
      sendApplicationFollowUp,
      sendEmail: jest.fn(),
    })),
  };
});

const email = jest.requireMock("../src/utils/integrations/email/emailService.js") as {
  sendOnboardingFollowUp: jest.Mock;
  sendApplicationFollowUp: jest.Mock;
};

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(() => {
  resetStuckEmailThrottle();
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
  email.sendOnboardingFollowUp.mockResolvedValue(undefined);
  email.sendApplicationFollowUp.mockResolvedValue(undefined);
});

const timersFor = (userId: string) =>
  testDataSource.getRepository(StuckEmailTimer).find({ where: { userId } });

const age = (userId: string, column: "stuck_since" | "first_sent_at", hours: number) =>
  testDataSource.query(
    `UPDATE stuck_email_timers SET ${column} = NOW() - make_interval(hours => $2) WHERE user_id = $1`,
    [userId, hours]
  );

let roleCounter = 0;
const uniqueRole = () => createRole(`Role ${(roleCounter += 1)}`);

const stuckTalent = async () => {
  const talent = await createTalent({ firstName: "Ada" });
  await startStuckTimers();
  return talent;
};

const sweepOnce = async () => {
  await closeMovedOnTimers();
  await startStuckTimers();
  await sendDueStuckEmails();
};

describe("starting the clock", () => {
  it("starts when the sweep first sees someone, and sends nothing yet", async () => {
    const talent = await createTalent();

    await sweepOnce();

    const [timer] = await timersFor(talent.user.id);
    expect(timer?.scopeKey).toBe("onboarding");
    expect(timer?.stage).toBe("complete_profile");
    expect(email.sendOnboardingFollowUp).not.toHaveBeenCalled();
  });

  it("doesn't start a second timer for the same step", async () => {
    const talent = await stuckTalent();

    await startStuckTimers();

    expect(await timersFor(talent.user.id)).toHaveLength(1);
  });

  it("leaves out old accounts, so turning this on doesn't email everyone", async () => {
    const talent = await createTalent();
    await testDataSource.query(
      `UPDATE users SET "createdAt" = NOW() - INTERVAL '31 days' WHERE id = $1`,
      [talent.user.id]
    );

    await startStuckTimers();

    expect(await timersFor(talent.user.id)).toHaveLength(0);
  });

  it("leaves out inactive users and people who unsubscribed", async () => {
    const inactive = await createTalent({ active: false });
    const optedOut = await createTalent({ followUpEmailsOptedOutAt: new Date() });

    await startStuckTimers();

    expect(await timersFor(inactive.user.id)).toHaveLength(0);
    expect(await timersFor(optedOut.user.id)).toHaveLength(0);
  });

  it("leaves out an employee, who'd be told to apply for jobs", async () => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id);
    const employee = await createTalent();
    await linkAccount(staff.id, employee.user.id);

    await startStuckTimers();

    expect(await timersFor(employee.user.id)).toHaveLength(0);
  });

  it("leaves out a teammate, but not the company's creator", async () => {
    const { owner, org } = await setupCompany();
    const teammate = await addMember(org);

    await startStuckTimers();

    expect(await timersFor(teammate.user.id)).toHaveLength(0);
    const [ownerTimer] = await timersFor(owner.user.id);
    expect(ownerTimer?.stage).toBe("post_job");
  });

  it("works for a recruiter with no company", async () => {
    const { user } = await createRecruiter();

    await startStuckTimers();

    const [timer] = await timersFor(user.id);
    expect(timer?.stage).toBe("create_company");
  });
});

describe("the first email", () => {
  it("doesn't go before 24 hours", async () => {
    const talent = await stuckTalent();
    await age(talent.user.id, "stuck_since", 23);

    await sendDueStuckEmails();

    expect(email.sendOnboardingFollowUp).not.toHaveBeenCalled();
  });

  it("goes after 24 hours and says where they are and what to do", async () => {
    const talent = await stuckTalent();
    await age(talent.user.id, "stuck_since", 25);

    await sendDueStuckEmails();

    expect(email.sendOnboardingFollowUp).toHaveBeenCalledTimes(1);
    const [details] = email.sendOnboardingFollowUp.mock.calls[0] as [
      {
        to: string;
        paragraphs: string[];
        ctaUrl: string;
        automatic: { idempotencyKey: string; unsubscribeUrl: string };
      },
    ];
    expect(details.to).toBe(talent.user.email);
    expect(details.paragraphs[0]).toContain("Hi Ada");
    expect(details.paragraphs[0]).toContain("Add roles and upload a CV");
    expect(details.paragraphs[1]).toContain("What to do next");
    expect(details.ctaUrl).toContain("/talentDashboard/talentProfile");
    expect(details.automatic.unsubscribeUrl).toContain("/unsubscribe?token=");
    const [timer] = await timersFor(talent.user.id);
    expect(details.automatic.idempotencyKey).toBe(`stuck-${timer!.id}-1`);
    expect(timer?.firstSentAt).not.toBeNull();
    expect(timer?.claimedAt).toBeNull();
  });

  it("is logged for the admin screens as automatic", async () => {
    const talent = await stuckTalent();
    await age(talent.user.id, "stuck_since", 25);

    await sendDueStuckEmails();

    const [row] = await testDataSource
      .getRepository(OnboardingEmail)
      .find({ where: { userId: talent.user.id } });
    expect(row?.source).toBe("auto");
    expect(row?.status).toBe("sent");
    expect(row?.sentById).toBeNull();
  });

  it("isn't sent to someone who has since moved on", async () => {
    const talent = await stuckTalent();
    await age(talent.user.id, "stuck_since", 25);
    await testDataSource.getRepository(User).update(talent.user.id, { emailVerifiedAt: null });

    await sweepOnce();

    expect(email.sendOnboardingFollowUp).not.toHaveBeenCalled();
    const timers = await timersFor(talent.user.id);
    expect(timers.find((timer) => timer.stage === "complete_profile")?.closedAt).not.toBeNull();
  });

  it("isn't sent if they unsubscribe first", async () => {
    const talent = await stuckTalent();
    await age(talent.user.id, "stuck_since", 25);
    await testDataSource
      .getRepository(User)
      .update(talent.user.id, { followUpEmailsOptedOutAt: new Date() });

    await sendDueStuckEmails();

    expect(email.sendOnboardingFollowUp).not.toHaveBeenCalled();
  });
});

describe("the follow-up", () => {
  const firstEmailSent = async () => {
    const talent = await stuckTalent();
    await age(talent.user.id, "stuck_since", 25);
    await sendDueStuckEmails();
    email.sendOnboardingFollowUp.mockClear();
    return talent;
  };

  it("doesn't go before 48 hours", async () => {
    const talent = await firstEmailSent();
    await age(talent.user.id, "first_sent_at", 47);
    await testDataSource.query(
      `UPDATE onboarding_emails SET created_at = created_at - INTERVAL '47 hours'`
    );

    await sweepOnce();

    expect(email.sendOnboardingFollowUp).not.toHaveBeenCalled();
  });

  it("goes after 48 hours if nothing changed, in different words", async () => {
    const talent = await firstEmailSent();
    await age(talent.user.id, "first_sent_at", 49);
    await testDataSource.query(
      `UPDATE onboarding_emails SET created_at = created_at - INTERVAL '49 hours'`
    );

    await sweepOnce();

    expect(email.sendOnboardingFollowUp).toHaveBeenCalledTimes(1);
    const [details] = email.sendOnboardingFollowUp.mock.calls[0] as [
      { paragraphs: string[]; automatic: { idempotencyKey: string } },
    ];
    expect(details.paragraphs[0]).toContain("it's been a couple of days");
    expect(details.automatic.idempotencyKey).toMatch(/-2$/);
  });

  it("isn't sent if they moved on", async () => {
    const talent = await firstEmailSent();
    await age(talent.user.id, "first_sent_at", 49);
    await testDataSource.query(
      `UPDATE onboarding_emails SET created_at = created_at - INTERVAL '49 hours'`
    );
    await testDataSource.query(
      `UPDATE stuck_email_timers SET stage = 'take_assessment' WHERE user_id = $1`,
      [talent.user.id]
    );

    await sweepOnce();

    const sent = email.sendOnboardingFollowUp.mock.calls as Array<
      [{ automatic: { idempotencyKey: string } }]
    >;
    expect(
      sent.filter(([details]) => details.automatic.idempotencyKey.endsWith("-2"))
    ).toHaveLength(0);
  });

  it("stops after two emails", async () => {
    const talent = await firstEmailSent();
    await age(talent.user.id, "first_sent_at", 49);
    await testDataSource.query(
      `UPDATE onboarding_emails SET created_at = created_at - INTERVAL '49 hours'`
    );
    await sweepOnce();
    email.sendOnboardingFollowUp.mockClear();
    await testDataSource.query(
      `UPDATE stuck_email_timers SET first_sent_at = NOW() - INTERVAL '30 days', second_sent_at = NOW() - INTERVAL '29 days'`
    );
    await testDataSource.query(
      `UPDATE onboarding_emails SET created_at = created_at - INTERVAL '29 days'`
    );

    await sweepOnce();

    expect(email.sendOnboardingFollowUp).not.toHaveBeenCalled();
  });
});

describe("verifying an email", () => {
  it("sends one reminder with no token, and says to ask for a new link", async () => {
    const talent = await createTalent({ emailVerifiedAt: null });
    await startStuckTimers();
    await age(talent.user.id, "stuck_since", 25);

    await sendDueStuckEmails();

    const [details] = email.sendOnboardingFollowUp.mock.calls[0] as [
      { paragraphs: string[]; ctaUrl: string },
    ];
    expect(details.ctaUrl).toContain("/login");
    expect(details.ctaUrl).not.toContain("token");
    expect(details.paragraphs.join(" ")).toContain("ask for a new one");

    email.sendOnboardingFollowUp.mockClear();
    await age(talent.user.id, "first_sent_at", 200);
    await testDataSource.query(
      `UPDATE onboarding_emails SET created_at = created_at - INTERVAL '200 hours'`
    );
    await sweepOnce();
    expect(email.sendOnboardingFollowUp).not.toHaveBeenCalled();
  });
});

describe("a stuck application", () => {
  const stuckApplication = async (overrides: Partial<Application> = {}) => {
    const talent = await createTalent({
      firstName: "Ada",
      prescreeningScore: 80,
      cvUploadedAt: new Date(),
    });
    const { user: recruiter } = await createRecruiter();
    const job = await createJob(recruiter, await uniqueRole());
    const application = await createApplication(talent.user, job, {
      currentStage: ScreeningStage.Personalized,
      status: ApplicationStatus.Pending,
      ...overrides,
    });
    return { talent, job, application };
  };

  it("names the job and the step, and logs the email against the application", async () => {
    const { talent, application, job } = await stuckApplication();
    await startStuckTimers();
    await testDataSource.query(
      `UPDATE stuck_email_timers SET stuck_since = NOW() - INTERVAL '25 hours' WHERE application_id = $1`,
      [application.id]
    );

    await sendDueStuckEmails();

    const [details] = email.sendApplicationFollowUp.mock.calls[0] as [
      { to: string; paragraphs: string[]; ctaUrl: string },
    ];
    expect(details.to).toBe(talent.user.email);
    expect(details.paragraphs[0]).toContain("Role ");
    expect(details.paragraphs[0]).toContain("Role questions");
    expect(details.ctaUrl).toContain(`/talentDashboard/applicationPipeline/${job.id}`);
    const [row] = await testDataSource
      .getRepository(ApplicationFollowUpEmail)
      .find({ where: { applicationId: application.id } });
    expect(row?.source).toBe("auto");
    expect(row?.step).toBe(1);
  });

  it("closes the timer when the stage moves on", async () => {
    const { application } = await stuckApplication();
    await startStuckTimers();
    await testDataSource
      .getRepository(Application)
      .update(application.id, { currentStage: ScreeningStage.Prescreening });

    await closeMovedOnTimers();

    const [timer] = await testDataSource
      .getRepository(StuckEmailTimer)
      .find({ where: { applicationId: application.id, stage: ScreeningStage.Personalized } });
    expect(timer?.closedAt).not.toBeNull();
  });

  it("leaves out invitations and the automatic CV stage", async () => {
    const invited = await stuckApplication({ applicationType: ApplicationType.Invitation });
    const cv = await stuckApplication({ currentStage: ScreeningStage.CvSimilarity });

    await startStuckTimers();

    expect(
      await testDataSource.getRepository(StuckEmailTimer).count({
        where: [{ applicationId: invited.application.id }, { applicationId: cv.application.id }],
      })
    ).toBe(0);
  });

  it("leaves out a closed job", async () => {
    const talent = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const job = await createJob(recruiter, await uniqueRole(), { status: JobStatus.Closed });
    const application = await createApplication(talent.user, job, {
      currentStage: ScreeningStage.Personalized,
    });

    await startStuckTimers();

    expect(
      await testDataSource.getRepository(StuckEmailTimer).count({
        where: { applicationId: application.id },
      })
    ).toBe(0);
  });

  it("only follows someone's newest application", async () => {
    const talent = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const older = await createApplication(
      talent.user,
      await createJob(recruiter, await uniqueRole()),
      { currentStage: ScreeningStage.Personalized }
    );
    await testDataSource.query(
      `UPDATE applications SET "updatedAt" = NOW() - INTERVAL '2 days' WHERE id = $1`,
      [older.id]
    );
    const newer = await createApplication(
      talent.user,
      await createJob(recruiter, await uniqueRole()),
      { currentStage: ScreeningStage.Personalized }
    );

    await startStuckTimers();

    const timers = await testDataSource
      .getRepository(StuckEmailTimer)
      .find({ where: { userId: talent.user.id, scopeKey: `application:${newer.id}` } });
    expect(timers).toHaveLength(1);
    expect(
      await testDataSource
        .getRepository(StuckEmailTimer)
        .count({ where: { applicationId: older.id } })
    ).toBe(0);
  });
});

describe("not over-emailing", () => {
  it("sends at most one email a day across everything", async () => {
    const talent = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const job = await createJob(recruiter, await uniqueRole());
    await createApplication(talent.user, job, { currentStage: ScreeningStage.Personalized });
    await startStuckTimers();
    await age(talent.user.id, "stuck_since", 25);

    await sendDueStuckEmails();

    const total =
      email.sendOnboardingFollowUp.mock.calls.length +
      email.sendApplicationFollowUp.mock.calls.length;
    expect(total).toBe(1);
  });

  it("holds back when an admin emailed them today", async () => {
    const talent = await stuckTalent();
    await age(talent.user.id, "stuck_since", 25);
    await testDataSource.getRepository(OnboardingEmail).save({
      userId: talent.user.id,
      stage: "complete_profile",
      subject: "Hello",
      body: "Body",
      status: "sent",
    });

    await sendDueStuckEmails();

    expect(email.sendOnboardingFollowUp).not.toHaveBeenCalled();
  });

  it("sends once when two sweeps overlap", async () => {
    const talent = await stuckTalent();
    await age(talent.user.id, "stuck_since", 25);

    await Promise.all([sendDueStuckEmails(), sendDueStuckEmails()]);

    expect(email.sendOnboardingFollowUp).toHaveBeenCalledTimes(1);
    const rows = await testDataSource
      .getRepository(OnboardingEmail)
      .count({ where: { userId: talent.user.id } });
    expect(rows).toBe(1);
  });

  it("retries a failed send, and stops after five tries", async () => {
    const talent = await stuckTalent();
    await age(talent.user.id, "stuck_since", 25);
    email.sendOnboardingFollowUp.mockRejectedValue(new Error("Resend is down"));

    await sendDueStuckEmails();

    const [failed] = await timersFor(talent.user.id);
    expect(failed?.firstSentAt).toBeNull();
    expect(failed?.lastError).toContain("Resend is down");
    expect(failed?.attempts).toBe(1);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await sendDueStuckEmails();
    }
    expect(email.sendOnboardingFollowUp).toHaveBeenCalledTimes(5);
  });
});

describe("the sweep switch", () => {
  const setEnabled = (enabled: boolean) => {
    (env as { stuckEmailsEnabled: boolean }).stuckEmailsEnabled = enabled;
  };

  afterEach(() => setEnabled(false));

  it("does nothing while it's turned off", async () => {
    const talent = await createTalent();
    setEnabled(false);

    await runStuckEmailSweep();

    expect(await timersFor(talent.user.id)).toHaveLength(0);
  });

  it("runs when turned on, then waits 15 minutes", async () => {
    const talent = await createTalent();
    setEnabled(true);

    await runStuckEmailSweep();
    expect(await timersFor(talent.user.id)).toHaveLength(1);

    const another = await createTalent();
    await runStuckEmailSweep();
    expect(await timersFor(another.user.id)).toHaveLength(0);
  });
});

describe("unsubscribing", () => {
  const unsubscribe = (token: string) =>
    request(app).post(`/v1/email-preferences/unsubscribe?token=${encodeURIComponent(token)}`);

  it("works from the link with no sign-in", async () => {
    const talent = await createTalent();

    await unsubscribe(unsubscribeToken(talent.user.id)).expect(200);

    const saved = await testDataSource.getRepository(User).findOneByOrFail({ id: talent.user.id });
    expect(saved.followUpEmailsOptedOutAt).not.toBeNull();
  });

  it("refuses a tampered link, and one made for someone else", async () => {
    const talent = await createTalent();
    const other = await createTalent();
    const [, signature] = unsubscribeToken(other.user.id).split(".");
    const forged = `${Buffer.from(talent.user.id).toString("base64url")}.${signature}`;

    expect((await unsubscribe(forged)).status).toBe(400);
    expect((await unsubscribe("rubbish")).status).toBe(400);
    expect((await request(app).get("/v1/email-preferences/unsubscribe?token=x")).status).toBe(404);
  });

  it("stops an admin's follow-up too", async () => {
    const admin = await createAdmin();
    const talent = await createTalent({ followUpEmailsOptedOutAt: new Date() });

    const res = await request(app)
      .post(`/v1/admin/users/${talent.user.id}/onboarding/emails`)
      .set(authHeader(admin.token))
      .send({ subject: "Hello", body: "Body", confirm: true });

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("unsubscribed");
  });
});
