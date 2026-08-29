import { testDataSource } from "./db.js";
import {
  UserRole,
  ApplicationType,
  ApplicationStatus,
  ScreeningStage,
  PaymentStatus,
  BillingInterval,
  Currency,
  SubscriptionStatus,
  QuestionType,
  PreScreeningStatus,
  ErrorLogLevel,
  JobStatus,
} from "../../src/types/enums.js";
import { User } from "../../src/entities/User.js";
import { Role } from "../../src/entities/Role.js";
import { Job } from "../../src/entities/Job.js";
import { AIConfig } from "../../src/entities/AIConfig.js";
import { Application } from "../../src/entities/Application.js";
import { Plan } from "../../src/entities/Plan.js";
import { Payment } from "../../src/entities/Payment.js";
import { Subscription } from "../../src/entities/Subscription.js";
import { Question } from "../../src/entities/Question.js";
import { PreScreening } from "../../src/entities/PreScreening.js";
import { Organization } from "../../src/entities/Organization.js";
import { ScoutJob } from "../../src/entities/ScoutJob.js";
import { Scout } from "../../src/entities/Scout.js";
import { Notification } from "../../src/entities/Notification.js";
import { Conversation } from "../../src/entities/Conversation.js";
import { Message } from "../../src/entities/Message.js";
import { ErrorLog } from "../../src/entities/ErrorLog.js";
import { generateHashedPassword, signToken } from "../../src/utils/crypto.js";

const PLAIN_PASSWORD = "Password1!";

let _userCounter = 0;
function uniqueEmail(prefix: string): string {
  return `${prefix}_${++_userCounter}_${Date.now()}@example.com`;
}

async function baseUser(overrides: Partial<User> = {}): Promise<User> {
  const repo = testDataSource.getRepository(User);
  const user = repo.create({
    email: uniqueEmail("user"),
    password: await generateHashedPassword(PLAIN_PASSWORD),
    firstName: "Test",
    lastName: "User",
    userRole: UserRole.Talent,
    emailVerifiedAt: new Date(),
    active: true,
    tokenVersion: 0,
    roleChangeCount: 0,
    ...overrides,
  });
  return repo.save(user);
}

export async function createTalent(
  overrides: Partial<User> = {}
): Promise<{ user: User; token: string }> {
  const user = await baseUser({ ...overrides, userRole: UserRole.Talent });
  return { user, token: signToken(user) };
}

export async function createRecruiter(
  overrides: Partial<User> = {}
): Promise<{ user: User; token: string }> {
  const user = await baseUser({ ...overrides, userRole: UserRole.Recruiter });
  return { user, token: signToken(user) };
}

export async function createAdmin(
  overrides: Partial<User> = {}
): Promise<{ user: User; token: string }> {
  const user = await baseUser({ ...overrides, userRole: UserRole.Admin });
  return { user, token: signToken(user) };
}

// A talent with all required profile fields set — passes requireCompletedProfile
export async function createCompleteTalent(
  role?: Role,
  overrides: Partial<User> = {}
): Promise<{ user: User; token: string }> {
  const repo = testDataSource.getRepository(User);
  let user = await baseUser({
    userRole: UserRole.Talent,
    cvFileName: "test-cv.pdf",
    cvText: "Experienced developer resume content",
    cvUploadedAt: new Date(),
    bio: "Experienced developer",
    locationCity: "Lagos",
    locationState: "Lagos",
    locationCountry: "Nigeria",
    experience: "4-6 years",
    minSalary: 50000,
    maxSalary: 100000,
    workType: ["remote"],
    ...overrides,
  });

  if (role) {
    user.userRoles = [role];
    user = await repo.save(user);
  }

  return { user, token: signToken(user) };
}

export async function createRole(name?: string): Promise<Role> {
  const repo = testDataSource.getRepository(Role);
  const role = repo.create({ name: name ?? `role_${Date.now()}` });
  return repo.save(role);
}

export async function createJob(
  recruiter: User,
  role: Role,
  overrides: Partial<Job> = {}
): Promise<Job> {
  const repo = testDataSource.getRepository(Job);
  const job = repo.create({
    roleId: role.id,
    postedById: recruiter.id,
    jobBrief: "We are looking for a talented engineer to join our team.",
    status: JobStatus.Active,
    maxSalary: 100000,
    minSalary: 50000,
    experienceLevel: "4-6 years",
    locationState: "Lagos",
    locationCountry: "Nigeria",
    workMode: ["remote"],
    ...overrides,
  });
  return repo.save(job);
}

export async function createAIConfig(
  recruiter: User,
  overrides: Partial<AIConfig> = {}
): Promise<AIConfig> {
  const repo = testDataSource.getRepository(AIConfig);
  const config = repo.create({
    recruiterId: recruiter.id,
    name: `Config_${Date.now()}`,
    prescreeningAssessment: true,
    minPrescreeningScore: 60,
    cvSimilarity: true,
    minCvSimilarityScore: 50,
    personalizedAssessment: true,
    noPersonalizedQuestions: 2,
    personalityEvaluation: true,
    noOfEIQuestions: 3,
    noOfSNQuestions: 3,
    noOfTFQuestions: 3,
    noOfJPQuestions: 3,
    stages: {
      prescreening: "cv_similarity",
      cv_similarity: "personalized",
      personalized: "personality",
      personality: "completed",
    },
    ...overrides,
  });
  return repo.save(config);
}

export async function createApplication(
  talent: User,
  job: Job,
  overrides: Partial<Application> = {}
): Promise<Application> {
  const repo = testDataSource.getRepository(Application);
  const app = repo.create({
    talentId: talent.id,
    jobId: job.id,
    recruiterId: job.postedById,
    applicationType: ApplicationType.Application,
    status: ApplicationStatus.Pending,
    currentStage: ScreeningStage.Prescreening,
    ...overrides,
  });
  return repo.save(app);
}

export async function createPlan(overrides: Partial<Plan> = {}): Promise<Plan> {
  const repo = testDataSource.getRepository(Plan);
  const plan = repo.create({
    name: `Plan_${Date.now()}`,
    amount: 5000,
    paystackAmount: 500000,
    interval: BillingInterval.Monthly,
    currency: Currency.NGN,
    description: "Test plan description",
    isDeleted: false,
    ...overrides,
  });
  return repo.save(plan);
}

export async function createPayment(
  user: User,
  plan?: Plan,
  overrides: Partial<Payment> = {}
): Promise<Payment> {
  const repo = testDataSource.getRepository(Payment);
  const payment = repo.create({
    userId: user.id,
    planId: plan?.id ?? null,
    amount: plan ? plan.amount : 5000,
    currency: "NGN",
    reference: `REF_${Date.now()}`,
    paystackRef: `PSK_${Date.now()}`,
    status: PaymentStatus.Pending,
    paymentLink: "https://paystack.com/pay/test",
    ...overrides,
  });
  return repo.save(payment);
}

export async function createSubscription(
  user: User,
  plan: Plan,
  overrides: Partial<Subscription> = {}
): Promise<Subscription> {
  const repo = testDataSource.getRepository(Subscription);
  const sub = repo.create({
    userId: user.id,
    planId: plan.id,
    paystackSubscriptionCode: `SUB_${Date.now()}`,
    status: SubscriptionStatus.Active,
    ...overrides,
  });
  return repo.save(sub);
}

export async function createQuestion(
  type: QuestionType,
  refs: { roleId?: string; jobId?: string },
  overrides: Partial<Question> = {}
): Promise<Question> {
  const repo = testDataSource.getRepository(Question);
  const q = repo.create({
    type,
    question: "What is your experience with TypeScript?",
    roleId: refs.roleId ?? null,
    jobId: refs.jobId ?? null,
    criteria: "Assess depth of TypeScript knowledge",
    category: "technical",
    ...overrides,
  });
  return repo.save(q);
}

export async function createPreScreening(
  user: User,
  roles: string[],
  overrides: Partial<PreScreening> = {}
): Promise<PreScreening> {
  const repo = testDataSource.getRepository(PreScreening);
  const ps = repo.create({
    userId: user.id,
    roles,
    questions: [
      {
        questionId: "q1",
        question: "Describe your experience",
        category: "general",
        options: ["A", "B", "C"],
        correctOption: 0,
        intent: "gauge experience",
        scoringHint: "Award 1 point for A",
      },
    ],
    status: PreScreeningStatus.Pending,
    attemptCount: 1,
    maxAttempts: 2,
    generatedAt: new Date(),
    ...overrides,
  });
  const saved = await repo.save(ps);

  // Link to user
  await testDataSource.getRepository(User).update(user.id, { activePreScreeningId: saved.id });
  return saved;
}

// Mirrors services/organization.ts createOrganization: the owner is
// switched onto the new company as their active one.
export async function createOrganization(
  owner: User,
  overrides: Partial<Organization> = {}
): Promise<Organization> {
  const repo = testDataSource.getRepository(Organization);
  const org = repo.create({
    name: `Org_${Date.now()}`,
    email: uniqueEmail("org"),
    phone: `+234${Math.floor(7000000000 + Math.random() * 999999999)}`,
    address: "123 Test Street",
    industry: "Technology",
    ownerId: owner.id,
    ...overrides,
  });
  const saved = await repo.save(org);
  await testDataSource.getRepository(User).update(owner.id, { activeOrganizationId: saved.id });
  return saved;
}

export async function createScoutJob(
  recruiter: User,
  role?: Role,
  overrides: Partial<ScoutJob> = {}
): Promise<ScoutJob> {
  const resolvedRole = role ?? (await createRole());
  const repo = testDataSource.getRepository(ScoutJob);
  const sj = repo.create({
    roleId: resolvedRole.id,
    postedById: recruiter.id,
    name: `ScoutJob_${Date.now()}`,
    jobBrief: "Looking for talent via scouting",
    recruiterGuide: "Focus on problem-solving skills",
    ...overrides,
  });
  return repo.save(sj);
}

export async function createScout(
  recruiter: User,
  scoutJob?: ScoutJob,
  overrides: Partial<Scout> = {}
): Promise<Scout> {
  const repo = testDataSource.getRepository(Scout);
  const scout = repo.create({
    recruiterId: recruiter.id,
    scoutJobId: scoutJob?.id ?? null,
    cvName: "candidate_cv.pdf",
    cvScore: 75,
    evaluationScore: 70,
    ...overrides,
  });
  return repo.save(scout);
}

export async function createNotification(
  user: User,
  overrides: Partial<Notification> = {}
): Promise<Notification> {
  const repo = testDataSource.getRepository(Notification);
  const n = repo.create({
    userId: user.id,
    message: "Test notification message",
    isRead: false,
    deleted: false,
    ...overrides,
  });
  return repo.save(n);
}

export async function createConversationWithMessage(
  sender: User,
  recipient: User
): Promise<{ conversation: Conversation; message: Message }> {
  const convRepo = testDataSource.getRepository(Conversation);
  const msgRepo = testDataSource.getRepository(Message);

  const conversation = await convRepo.save(convRepo.create({ participants: [sender, recipient] }));

  const message = await msgRepo.save(
    msgRepo.create({
      conversationId: conversation.id,
      senderId: sender.id,
      recipientId: recipient.id,
      content: "Hello there",
      isRead: false,
      deleted: false,
    })
  );

  await convRepo.save({ ...conversation, lastMessageId: message.id });

  return { conversation, message };
}

export async function createErrorLog(overrides: Partial<ErrorLog> = {}): Promise<ErrorLog> {
  const repo = testDataSource.getRepository(ErrorLog);
  const log = repo.create({
    timestamp: new Date(),
    level: ErrorLogLevel.Error,
    message: "Test error occurred",
    errorType: "TestError",
    userAgent: "Jest/1.0",
    requestBody: {},
    requestQuery: {},
    requestParams: {},
    environment: "test",
    resolved: false,
    ...overrides,
  });
  return repo.save(log);
}

export { PLAIN_PASSWORD };
