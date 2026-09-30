import { testDataSource } from "./db.js";
import { User } from "../../src/entities/User.js";
import { Scout } from "../../src/entities/Scout.js";
import { ScoutRun } from "../../src/entities/ScoutRun.js";
import { UserRole, ScoutCvStatus } from "../../src/types/enums.js";
import { generateHashedPassword, signToken } from "../../src/utils/crypto.js";

export async function createRecruiter(
  overrides: Partial<User> = {}
): Promise<{ user: User; token: string }> {
  const repo = testDataSource.getRepository(User);
  const user = repo.create({
    email: `recruiter_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`,
    password: await generateHashedPassword("Password1!"),
    firstName: "Bob",
    lastName: "Smith",
    userRole: UserRole.Recruiter,
    emailVerifiedAt: new Date(),
    active: true,
    tokenVersion: 0,
    roleChangeCount: 0,
    ...overrides,
  });
  const saved = await repo.save(user);
  return { user: saved, token: signToken(saved) };
}

/** A well-formed assessment, with any field overridable to build the bad-response cases. */
export const assessmentPayload = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    overallScore: 80,
    skillsScore: 78,
    experienceScore: 82,
    locationFit: 60,
    mustHaveSkillsMet: ["negotiation"],
    mustHaveSkillsMissing: [],
    recommendation:
      "He closed six-figure deals at two fintechs, which is the same selling motion this role needs.",
    strengths: ["Closed six-figure fintech deals"],
    concerns: ["Has not managed a team"],
    candidate: {
      fullName: "Ada Obi",
      email: "ada@example.com",
      phone: "+2348012345678",
      city: "Lagos",
      state: "Lagos",
      country: "Nigeria",
      headline: "Enterprise account executive",
      yearsExperience: 6,
      skills: ["negotiation", "crm"],
    },
    ...overrides,
  });

export const assessmentResponse = (overrides: Record<string, unknown> = {}) => ({
  message: { content: assessmentPayload(overrides) },
});

export const scoutRepo = () => testDataSource.getRepository(Scout);
export const runRepo = () => testDataSource.getRepository(ScoutRun);

/** Rows for a run, ordered the way the worker created them. */
export const scoutsForRun = (runId: string): Promise<Scout[]> =>
  scoutRepo().find({ where: { scoutRunId: runId }, order: { createdAt: "ASC" } });

export const statusesFor = async (runId: string): Promise<ScoutCvStatus[]> =>
  (await scoutsForRun(runId)).map((scout) => scout.status);
