import { UserRole } from "../src/types/enums.js";
import {
  followUpStatus,
  MAX_BODY_LENGTH,
  nextStepsFor,
  RECRUITER_STAGES,
  RecruiterFacts,
  recruiterStageFrom,
  recruiterSteps,
  sanitizeDraft,
  TALENT_STAGES,
  TalentFacts,
  talentStageFrom,
  talentSteps,
} from "../src/services/onboardingRules.js";

const talent = (overrides: Partial<TalentFacts> = {}): TalentFacts => ({
  emailVerified: true,
  hasCv: true,
  hasRoles: true,
  hasScore: true,
  hasApplication: true,
  ...overrides,
});

const recruiter = (overrides: Partial<RecruiterFacts> = {}): RecruiterFacts => ({
  emailVerified: true,
  hasCompany: true,
  onPaidPlan: false,
  hasPaidJob: false,
  hasJob: true,
  hasScreenedJob: true,
  ...overrides,
});

describe("talentStageFrom", () => {
  it.each<[string, Partial<TalentFacts>, string]>([
    ["not verified", { emailVerified: false }, "verify_email"],
    ["verified, no CV", { hasCv: false }, "complete_profile"],
    ["CV but no roles", { hasRoles: false }, "complete_profile"],
    ["roles and CV, no score", { hasScore: false }, "take_assessment"],
    ["score, no applications", { hasApplication: false }, "apply_to_job"],
    ["has applied", {}, "active"],
  ])("%s → %s", (_label, overrides, stage) => {
    expect(talentStageFrom(talent(overrides))).toBe(stage);
  });

  it("reports the earliest unfinished step when several are missing", () => {
    expect(talentStageFrom(talent({ emailVerified: false, hasCv: false }))).toBe("verify_email");
    expect(talentStageFrom(talent({ hasCv: false, hasScore: false }))).toBe("complete_profile");
  });

  it("an unverified user who somehow applied is still asked to verify", () => {
    expect(talentStageFrom(talent({ emailVerified: false, hasApplication: true }))).toBe(
      "verify_email"
    );
  });

  it("an application without an assessment (older data) still asks for the assessment", () => {
    expect(talentStageFrom(talent({ hasScore: false, hasApplication: true }))).toBe(
      "take_assessment"
    );
  });

  it("only returns talent stages", () => {
    const combos = [true, false].flatMap((a) =>
      [true, false].flatMap((b) =>
        [true, false].map((c) => talent({ emailVerified: a, hasCv: b, hasScore: c }))
      )
    );
    for (const facts of combos) {
      expect(TALENT_STAGES).toContain(talentStageFrom(facts));
    }
  });
});

describe("recruiterStageFrom", () => {
  it.each<[string, Partial<RecruiterFacts>, string]>([
    ["not verified", { emailVerified: false }, "verify_email"],
    ["no company", { hasCompany: false }, "create_company"],
    ["no job", { hasJob: false, hasScreenedJob: false }, "post_job"],
    ["job without screening", { hasScreenedJob: false }, "set_up_screening"],
    ["screened job, not paid", {}, "publish_job"],
    ["paid for a job", { hasPaidJob: true }, "active"],
  ])("%s → %s", (_label, overrides, stage) => {
    expect(recruiterStageFrom(recruiter(overrides))).toBe(stage);
  });

  it("is active on a paid plan even before posting a job", () => {
    expect(
      recruiterStageFrom(recruiter({ onPaidPlan: true, hasJob: false, hasScreenedJob: false }))
    ).toBe("active");
  });

  it("does not count an old payment without a company", () => {
    expect(recruiterStageFrom(recruiter({ hasCompany: false, hasPaidJob: true }))).toBe(
      "create_company"
    );
  });

  it("does not count a plan or payment before email verification", () => {
    expect(
      recruiterStageFrom(recruiter({ emailVerified: false, onPaidPlan: true, hasPaidJob: true }))
    ).toBe("verify_email");
  });

  it("only returns recruiter stages", () => {
    for (const hasJob of [true, false]) {
      for (const onPaidPlan of [true, false]) {
        expect(RECRUITER_STAGES).toContain(recruiterStageFrom(recruiter({ hasJob, onPaidPlan })));
      }
    }
  });
});

describe("steps", () => {
  it("marks talent steps done from the facts", () => {
    expect(talentSteps(talent({ hasCv: false, hasApplication: false }))).toEqual([
      { key: "verify_email", label: "Verify email", done: true },
      { key: "complete_profile", label: "Add roles and upload a CV", done: false },
      { key: "take_assessment", label: "Take the pre-assessment", done: true },
      { key: "apply_to_job", label: "Apply to a job", done: false },
    ]);
  });

  it("treats a paid plan as the publish step being done", () => {
    const steps = recruiterSteps(recruiter({ onPaidPlan: true }));
    expect(steps.find((step) => step.key === "publish_job")?.done).toBe(true);
    expect(steps).toHaveLength(5);
  });
});

describe("followUpStatus", () => {
  it("is none before any email", () => {
    expect(followUpStatus("take_assessment", null)).toBe("none");
  });

  it("is emailed while still at the same stage", () => {
    expect(followUpStatus("take_assessment", { stage: "take_assessment" })).toBe("emailed");
  });

  it("is progressed once they moved on, including to active", () => {
    expect(followUpStatus("apply_to_job", { stage: "take_assessment" })).toBe("progressed");
    expect(followUpStatus("active", { stage: "publish_job" })).toBe("progressed");
  });
});

describe("nextStepsFor", () => {
  it.each(TALENT_STAGES.filter((stage) => stage !== "active"))(
    "gives talents steps and a link for %s",
    (stage) => {
      const next = nextStepsFor(UserRole.Talent, stage)!;
      expect(next.steps.length).toBeGreaterThan(0);
      expect(next.ctaLabel).toBeTruthy();
      expect(next.ctaPath.startsWith("/")).toBe(true);
    }
  );

  it.each(RECRUITER_STAGES.filter((stage) => stage !== "active"))(
    "gives recruiters steps and a link for %s",
    (stage) => {
      const next = nextStepsFor(UserRole.Recruiter, stage)!;
      expect(next.steps.length).toBeGreaterThan(0);
      expect(next.ctaPath.startsWith("/")).toBe(true);
    }
  );

  it("has nothing to do for active users", () => {
    expect(nextStepsFor(UserRole.Talent, "active")).toBeNull();
    expect(nextStepsFor(UserRole.Recruiter, "active")).toBeNull();
  });

  it("rejects a stage that belongs to the other role", () => {
    expect(() => nextStepsFor(UserRole.Talent, "post_job")).toThrow(/Unknown onboarding stage/);
    expect(() => nextStepsFor(UserRole.Recruiter, "take_assessment")).toThrow();
  });
});

describe("sanitizeDraft", () => {
  it("returns a trimmed subject and body", () => {
    expect(sanitizeDraft(JSON.stringify({ subject: "  Hi Ada ", body: " Come back \n" }))).toEqual({
      subject: "Hi Ada",
      body: "Come back",
    });
  });

  it("trims an over-long subject to 150 characters", () => {
    const result = sanitizeDraft(JSON.stringify({ subject: "s".repeat(400), body: "Hello" }));
    expect(result.subject).toHaveLength(150);
  });

  it.each([
    ["nothing", null],
    ["non-JSON", "Dear Ada,"],
    ["no subject", JSON.stringify({ body: "Hello" })],
    ["blank subject", JSON.stringify({ subject: "  ", body: "Hello" })],
    ["no body", JSON.stringify({ subject: "Hi" })],
    ["a non-string body", JSON.stringify({ subject: "Hi", body: 42 })],
    [
      "a body that is too long",
      JSON.stringify({ subject: "Hi", body: "x".repeat(MAX_BODY_LENGTH + 1) }),
    ],
  ])("rejects %s", (_label, content) => {
    expect(() => sanitizeDraft(content)).toThrow();
  });

  it("keeps HTML in the AI text as plain text for the template to escape", () => {
    const result = sanitizeDraft(
      JSON.stringify({ subject: "Hi", body: "<script>alert(1)</script>" })
    );
    expect(result.body).toBe("<script>alert(1)</script>");
  });
});
