import crypto from "crypto";
import type { DataSource, ObjectLiteral, Repository } from "typeorm";
import { AIConfig } from "../entities/AIConfig.js";
import { AiRecommendation } from "../entities/AiRecommendation.js";
import { Answer } from "../entities/Answer.js";
import { Application } from "../entities/Application.js";
import { Conversation } from "../entities/Conversation.js";
import { Feedback } from "../entities/Feedback.js";
import { Job } from "../entities/Job.js";
import { Message } from "../entities/Message.js";
import { Notification } from "../entities/Notification.js";
import { Organization } from "../entities/Organization.js";
import { OrganizationInvite, OrganizationInviteStatus } from "../entities/OrganizationInvite.js";
import {
  OrganizationJoinRequest,
  OrganizationJoinRequestStatus,
} from "../entities/OrganizationJoinRequest.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";
import { Payment } from "../entities/Payment.js";
import { Plan } from "../entities/Plan.js";
import { PreScreening } from "../entities/PreScreening.js";
import { Question } from "../entities/Question.js";
import { Role } from "../entities/Role.js";
import { Scout } from "../entities/Scout.js";
import { ScoutJob } from "../entities/ScoutJob.js";
import { Subscription } from "../entities/Subscription.js";
import { TalentEmbedding } from "../entities/TalentEmbedding.js";
import { User } from "../entities/User.js";
import {
  ApplicationStatus,
  ApplicationType,
  BillingInterval,
  BillingStatus,
  CompensationPeriod,
  Currency,
  CvEmbeddingStatus,
  ExperienceLevel,
  DEFAULT_BILLING_PLAN_KEY,
  GenerationStatus,
  JobStatus,
  MatchRecommendation,
  MatchVerdict,
  MatchVerdictStatus,
  OrganizationStatus,
  PaymentStatus,
  PreScreeningStatus,
  QuestionType,
  ScreeningStage,
  SubscriptionStatus,
  UserRole,
  WorkMode,
  WorkType,
} from "../types/enums.js";
import { computeBillingPeriodEnd } from "../services/billingState.js";
import { syncPlansFromCatalog } from "../services/planSync.js";
import { generateHashedPassword } from "../utils/crypto.js";
import logger from "../utils/logger.js";
import { decisionNotificationTitle } from "../services/applicationNotifications.js";
import type { MatchAnalysis } from "../utils/matchAnalysis.js";
import {
  APPLICATIONS_PER_TALENT,
  CITIES,
  DEFAULT_SCREENING_STAGES,
  FIRST_NAMES,
  GOALS,
  INDUSTRIES,
  LAST_NAMES,
  MBTI_TYPES,
  RECRUITERS_PER_COMPANY,
  ROLE_CATALOG,
  SEED_PASSWORD,
  SKILLS,
  STUB_EMBEDDING,
  catalogItem,
  computeScale,
  orgDomain,
  padNumber,
  pendingInviteEmail,
  recruiterEmail,
  talentEmail,
} from "./config.js";
import type { SeedCliOptions } from "./guard.js";
import { resetSeedData, seedDataExists } from "./reset.js";

export type SeedSummary = {
  n: number;
  talents: number;
  recruiters: number;
  companies: number;
  jobs: number;
  applications: number;
  password: string;
  sampleTalentEmail: string;
  sampleRecruiterEmail: string;
};

const EXPERIENCE_LEVELS = Object.values(ExperienceLevel);
const WORK_TYPES = Object.values(WorkType);

function must<T>(value: T | undefined, label: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Seed invariant failed: missing ${label}`);
  }
  return value;
}

async function chunkedSave<T extends ObjectLiteral>(
  repo: Repository<T>,
  rows: T[],
  size = 75
): Promise<T[]> {
  if (rows.length === 0) return [];
  const saved: T[] = [];
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const result = await repo.save(chunk);
    saved.push(...(Array.isArray(result) ? result : [result]));
  }
  return saved;
}

function jobStatusForIndex(index: number): JobStatus {
  const bucket = index % 20;
  if (bucket === 17) return JobStatus.Closed;
  if (bucket === 18) return JobStatus.Draft;
  if (bucket === 19) return JobStatus.Suspended;
  return JobStatus.Active;
}

function workModeForIndex(index: number): string[] {
  const bucket = index % 4;
  if (bucket === 0) return [WorkMode.Remote];
  if (bucket === 1) return [WorkMode.Hybrid];
  if (bucket === 2) return [WorkMode.OnSite];
  return [WorkMode.Remote, WorkMode.Hybrid];
}

function skillsForIndex(index: number): string[] {
  return [0, 1, 2, 3].map((offset) => catalogItem(SKILLS, index + offset));
}

function fullName(user: Pick<User, "firstName" | "lastName">): string {
  return `${user.firstName} ${user.lastName}`;
}

function matchBundle(index: number): {
  verdict: MatchVerdict;
  recommendation: MatchRecommendation;
  analysis: MatchAnalysis;
} {
  const verdict = catalogItem(
    [MatchVerdict.High, MatchVerdict.Medium, MatchVerdict.Low] as const,
    index
  );
  const recommendation =
    verdict === MatchVerdict.High
      ? MatchRecommendation.Hire
      : verdict === MatchVerdict.Medium
        ? MatchRecommendation.InterviewFurther
        : MatchRecommendation.NoHire;
  const score = verdict === MatchVerdict.High ? 88 : verdict === MatchVerdict.Medium ? 67 : 41;
  return {
    verdict,
    recommendation,
    analysis: {
      overallFitScore: score,
      whyFit: "Background and assessment scores align with the role requirements.",
      whyHire: "Demonstrated relevant experience and a consistent screening performance.",
      strongestQualifications: ["Role-relevant experience", "Clear written communication"],
      relevantExperience: ["Prior work in a similar function", "Cross-functional collaboration"],
      prescreeningInsights: {
        strengths: ["Structured problem solving"],
        weaknesses: ["Limited industry-specific tooling depth"],
      },
      assessmentInsights: "Completed screening with a consistent score profile.",
      missingRequirements: [],
      conflictingRequirements: [],
      keyEvidence: ["CV overlap with the job brief", "Assessment completion"],
      hiringRationale: "Seeded match summary for local development.",
      questionFeedback: [],
    },
  };
}

async function upsertRoles(ds: DataSource): Promise<Role[]> {
  const repo = ds.getRepository(Role);
  const existing = await repo.find();
  const byName = new Map(existing.map((role) => [role.name.toLowerCase(), role]));
  const toInsert = ROLE_CATALOG.filter((spec) => !byName.has(spec.name.toLowerCase())).map((spec) =>
    repo.create({ name: spec.name, description: spec.description })
  );
  const inserted = await chunkedSave(repo, toInsert);
  const insertedByName = new Map(inserted.map((role) => [role.name.toLowerCase(), role]));
  return ROLE_CATALOG.map((spec) =>
    must(
      byName.get(spec.name.toLowerCase()) ?? insertedByName.get(spec.name.toLowerCase()),
      `role ${spec.name}`
    )
  );
}

export async function runSeed(ds: DataSource, options: SeedCliOptions): Promise<SeedSummary> {
  const scale = computeScale(options.n);
  logger.info(
    `Seeding scale N=${scale.n}: ${scale.talents} talents, ${scale.recruiters} recruiters, ${scale.companies} companies, ${scale.jobs} jobs`
  );

  if (options.reset) {
    await resetSeedData(ds);
    logger.info("Previous seed data removed.");
  } else if (await seedDataExists(ds)) {
    throw new Error("Seed data already exists. Re-run with --reset to replace it.");
  }

  const passwordHash = await generateHashedPassword(SEED_PASSWORD);
  const now = new Date();
  const roles = await upsertRoles(ds);
  const plans = await syncPlansFromCatalog();
  const admin = await ds.getRepository(User).findOne({ where: { userRole: UserRole.Admin } });

  const userRepo = ds.getRepository(User);
  const talentRows: User[] = [];
  for (let i = 0; i < scale.talents; i++) {
    const location = catalogItem(CITIES, i);
    const experience = catalogItem(EXPERIENCE_LEVELS, i);
    const role = catalogItem(roles, i);
    const firstName = catalogItem(FIRST_NAMES, i);
    const lastName = catalogItem(LAST_NAMES, i);
    talentRows.push(
      userRepo.create({
        email: talentEmail(i + 1),
        password: passwordHash,
        firstName,
        lastName,
        middleName: i % 5 === 0 ? catalogItem(FIRST_NAMES, i + 3) : null,
        userRole: UserRole.Talent,
        country: location.country,
        emailVerifiedAt: now,
        welcomeEmailSentAt: now,
        active: true,
        tokenVersion: 0,
        bio: `${firstName} is a ${experience} ${role.name} open to new roles.`,
        cvFileName: `${firstName.toLowerCase()}-${lastName.toLowerCase()}-cv.pdf`,
        cvText: `${firstName} ${lastName}\n${role.name}\n${experience} of experience in ${location.city}. Skills: ${skillsForIndex(i).join(", ")}.`,
        cvUploadedAt: now,
        cvEmbeddingStatus: CvEmbeddingStatus.Ready,
        cvEmbeddingAttempts: 1,
        cvEmbeddingNextRetryAt: null,
        cvEmbeddingLockedAt: null,
        cvEmbeddingLastError: null,
        workType: [catalogItem(WORK_TYPES, i)],
        locationCity: location.city,
        locationState: location.state,
        locationCountry: location.country,
        experience,
        currency: i % 4 === 0 ? Currency.USD : Currency.NGN,
        minSalary: 250000 + (i % 10) * 25000,
        maxSalary: 450000 + (i % 10) * 25000,
        compensationPeriod: i % 3 === 0 ? CompensationPeriod.Monthly : CompensationPeriod.Yearly,
        prescreeningScore: 58 + (i % 38),
        prescreeningScoredAt: now,
        assessmentRetryDate: null,
        roleChangeCount: 0,
        recoveryCode: null,
        recoveryCodeExpiry: null,
        emailVerificationTokenHash: null,
        emailVerificationTokenExpiresAt: null,
      })
    );
  }
  const talents = await chunkedSave(userRepo, talentRows);
  logger.info(`Created ${talents.length} talents`);

  const recruiterRows: User[] = [];
  for (let companyIndex = 0; companyIndex < scale.companies; companyIndex++) {
    for (let recruiterIndex = 0; recruiterIndex < RECRUITERS_PER_COMPANY; recruiterIndex++) {
      const i = companyIndex * RECRUITERS_PER_COMPANY + recruiterIndex;
      const location = catalogItem(CITIES, i + 2);
      recruiterRows.push(
        userRepo.create({
          email: recruiterEmail(companyIndex + 1, recruiterIndex + 1),
          password: passwordHash,
          firstName: catalogItem(FIRST_NAMES, i + 4),
          lastName: catalogItem(LAST_NAMES, i + 1),
          middleName: recruiterIndex === 0 ? catalogItem(FIRST_NAMES, i + 8) : null,
          userRole: UserRole.Recruiter,
          country: location.country,
          emailVerifiedAt: now,
          welcomeEmailSentAt: now,
          active: true,
          tokenVersion: 0,
          bio: `Recruiter at ${orgDomain(companyIndex + 1)} hiring for ${catalogItem(INDUSTRIES, companyIndex)}.`,
          locationCity: location.city,
          locationState: location.state,
          locationCountry: location.country,
          currency: Currency.NGN,
          roleChangeCount: 0,
        })
      );
    }
  }
  const recruiters = await chunkedSave(userRepo, recruiterRows);
  logger.info(`Created ${recruiters.length} recruiters`);

  const orgRepo = ds.getRepository(Organization);
  const orgRows: Organization[] = [];
  for (let companyIndex = 0; companyIndex < scale.companies; companyIndex++) {
    const owner = must(recruiters[companyIndex * RECRUITERS_PER_COMPANY], `owner ${companyIndex}`);
    const domain = orgDomain(companyIndex + 1);
    const location = catalogItem(CITIES, companyIndex);
    const paid = companyIndex % 2 === 0;
    orgRows.push(
      orgRepo.create({
        ownerId: owner.id,
        name: `Seed Co ${padCompanyName(companyIndex + 1)}`,
        email: `hello@${domain}`,
        domain,
        phone: `+23480${padNumber(10000000 + companyIndex, 8)}`.slice(0, 14),
        address: `${20 + companyIndex} Seed Avenue, ${location.city}`,
        industry: catalogItem(INDUSTRIES, companyIndex),
        website: `https://${domain}`,
        facebook: `https://facebook.com/seedco${companyIndex + 1}`,
        linkedin: `https://linkedin.com/company/seedco${companyIndex + 1}`,
        twitter: `https://x.com/seedco${companyIndex + 1}`,
        logoUrl: `https://${domain}/logo.png`,
        status: OrganizationStatus.Verified,
        verifiedAt: now,
        verifiedById: admin?.id ?? null,
        billingPlan: paid ? "advance" : DEFAULT_BILLING_PLAN_KEY,
        billingInterval: paid ? BillingInterval.Monthly : null,
        billingStatus: BillingStatus.Active,
        billingPeriodEnd: paid ? computeBillingPeriodEnd(now, BillingInterval.Monthly) : null,
      })
    );
  }
  const organizations = await chunkedSave(orgRepo, orgRows);

  for (let companyIndex = 0; companyIndex < scale.companies; companyIndex++) {
    const org = must(organizations[companyIndex], `org ${companyIndex}`);
    const start = companyIndex * RECRUITERS_PER_COMPANY;
    const ids = recruiters.slice(start, start + RECRUITERS_PER_COMPANY).map((user) => user.id);
    if (ids.length > 0) {
      await userRepo
        .createQueryBuilder()
        .update(User)
        .set({ activeOrganizationId: org.id })
        .whereInIds(ids)
        .execute();
    }
    for (const recruiter of recruiters.slice(start, start + RECRUITERS_PER_COMPANY)) {
      recruiter.activeOrganizationId = org.id;
    }
  }

  const memberRepo = ds.getRepository(OrganizationMember);
  const memberRows: OrganizationMember[] = [];
  for (let companyIndex = 0; companyIndex < scale.companies; companyIndex++) {
    const org = must(organizations[companyIndex], `org ${companyIndex}`);
    for (let recruiterIndex = 0; recruiterIndex < RECRUITERS_PER_COMPANY; recruiterIndex++) {
      const recruiter = must(
        recruiters[companyIndex * RECRUITERS_PER_COMPANY + recruiterIndex],
        `recruiter ${companyIndex}:${recruiterIndex}`
      );
      memberRows.push(
        memberRepo.create({
          userId: recruiter.id,
          organizationId: org.id,
          workEmail: recruiter.email,
          role: recruiterIndex === 0 ? "owner" : "member",
          verifiedAt: now,
        })
      );
    }
  }
  await chunkedSave(memberRepo, memberRows);

  const rolePairs: Array<{ user_id: string; role_id: string }> = [];
  for (let i = 0; i < talents.length; i++) {
    const talent = must(talents[i], `talent ${i}`);
    const primary = must(catalogItem(roles, i), "primary role");
    rolePairs.push({ user_id: talent.id, role_id: primary.id });
    if (i % 2 === 0) {
      const secondary = must(catalogItem(roles, i + 1), "secondary role");
      if (secondary.id !== primary.id) {
        rolePairs.push({ user_id: talent.id, role_id: secondary.id });
      }
    }
  }
  for (let i = 0; i < rolePairs.length; i += 200) {
    const chunk = rolePairs.slice(i, i + 200);
    await ds.createQueryBuilder().insert().into("user_roles").values(chunk).execute();
  }

  const prescreeningRepo = ds.getRepository(PreScreening);
  const prescreeningRows: PreScreening[] = [];
  for (let i = 0; i < talents.length; i++) {
    const talent = must(talents[i], `talent ${i}`);
    const role = catalogItem(roles, i);
    const score = talent.prescreeningScore ?? 70;
    prescreeningRows.push(
      prescreeningRepo.create({
        userId: talent.id,
        roles: [role.name],
        questions: [
          {
            questionId: `seed-ps-${i}-1`,
            question: `Which statement best describes your ${role.name} experience?`,
            category: "experience",
            options: ["Less than 1 year", "1-3 years", "4-6 years", "7+ years"],
            correctOption: 2,
            intent: "Gauge experience depth",
            scoringHint: "Award more points for deeper experience",
          },
          {
            questionId: `seed-ps-${i}-2`,
            question: "How do you usually collaborate with hiring stakeholders?",
            category: "collaboration",
            options: ["Async updates", "Live reviews", "Written briefs", "Mixed"],
            correctOption: 3,
            intent: "Understand working style",
          },
        ],
        score,
        status: PreScreeningStatus.Completed,
        attemptCount: 1,
        maxAttempts: 2,
        generatedAt: now,
        generationStatus: GenerationStatus.Succeeded,
        generationAttempts: 1,
        completedAt: now,
        metadata: { seeded: true },
      })
    );
  }
  await chunkedSave(prescreeningRepo, prescreeningRows);
  const talentIds = talents.map((talent) => talent.id);
  if (talentIds.length > 0) {
    await ds.query(
      `UPDATE users AS u
       SET active_prescreening_id = p.id
       FROM pre_screenings p
       WHERE p.user_id = u.id AND u.id = ANY($1::uuid[])`,
      [talentIds]
    );
  }

  const embeddingRepo = ds.getRepository(TalentEmbedding);
  const embeddingRows = talents.map((talent) =>
    embeddingRepo.create({
      userId: talent.id,
      cvText: talent.cvText ?? `${fullName(talent)} seeded CV.`,
      cvEmbedding: STUB_EMBEDDING,
      generatedAt: now,
    })
  );
  await chunkedSave(embeddingRepo, embeddingRows);

  const aiConfigRepo = ds.getRepository(AIConfig);
  const aiConfigRows: AIConfig[] = [];
  for (let companyIndex = 0; companyIndex < organizations.length; companyIndex++) {
    const org = must(organizations[companyIndex], `org ${companyIndex}`);
    const owner = must(recruiters[companyIndex * RECRUITERS_PER_COMPANY], `owner ${companyIndex}`);
    aiConfigRows.push(
      aiConfigRepo.create({
        name: `${org.name} Default Screening`,
        recruiterId: owner.id,
        organizationId: org.id,
        prescreeningAssessment: true,
        minPrescreeningScore: 60,
        cvSimilarity: true,
        minCvSimilarityScore: 50,
        personalizedAssessment: true,
        noPersonalizedQuestions: 2,
        recruiterGuide: "Score for role-relevant evidence, communication, and ownership.",
        uploadedQuestions: [
          "Walk through a recent project you owned end to end.",
          "How do you handle incomplete requirements?",
        ],
        personalityEvaluation: true,
        noOfEIQuestions: 3,
        noOfSNQuestions: 3,
        noOfTFQuestions: 3,
        noOfJPQuestions: 3,
        stages: { ...DEFAULT_SCREENING_STAGES },
      })
    );
  }
  const aiConfigs = await chunkedSave(aiConfigRepo, aiConfigRows);

  const jobRepo = ds.getRepository(Job);
  const jobRows: Job[] = [];
  for (let i = 0; i < scale.jobs; i++) {
    const companyIndex = i % scale.companies;
    const org = must(organizations[companyIndex], `org ${companyIndex}`);
    const localIndex = Math.floor(i / scale.companies);
    const recruiter = must(
      recruiters[companyIndex * RECRUITERS_PER_COMPANY + (localIndex % RECRUITERS_PER_COMPANY)],
      `job recruiter ${i}`
    );
    const role = catalogItem(roles, i);
    const location = catalogItem(CITIES, i + 1);
    const experienceLevel = catalogItem(EXPERIENCE_LEVELS, i);
    const minSalary = 800000 + (i % 12) * 75000;
    const workMode = workModeForIndex(i);
    jobRows.push(
      jobRepo.create({
        roleId: role.id,
        postedById: recruiter.id,
        organizationId: org.id,
        aiConfigId: must(aiConfigs[companyIndex], `ai config ${companyIndex}`).id,
        jobBrief: `${org.name} is hiring a ${role.name} to ${catalogItem(GOALS, i).toLowerCase()}. The role is ${experienceLevel} and ${workMode.join("/")}.`,
        status: jobStatusForIndex(i),
        maxSalary: minSalary + 400000,
        minSalary,
        compensationPeriod: i % 5 === 0 ? CompensationPeriod.Monthly : CompensationPeriod.Yearly,
        experienceLevel,
        locationCity: location.city,
        locationState: location.state,
        locationCountry: location.country,
        workMode,
        currency: "NGN",
        requirements: `Strong ${role.name} craft, written communication, and comfort working with recruiters and hiring managers.`,
        skills: skillsForIndex(i),
        goals: [catalogItem(GOALS, i), catalogItem(GOALS, i + 1)],
        noOfApplicants: 0,
        jobEmbedding: STUB_EMBEDDING,
      })
    );
  }
  const jobs = await chunkedSave(jobRepo, jobRows);
  logger.info(`Created ${jobs.length} jobs`);

  const questionRepo = ds.getRepository(Question);
  const questionRows: Question[] = [];
  for (const role of roles) {
    questionRows.push(
      questionRepo.create({
        roleId: role.id,
        jobId: null,
        type: QuestionType.Prescreening,
        question: `What evidence shows you can succeed as a ${role.name}?`,
        criteria: "Look for concrete outcomes and ownership",
        category: "experience",
      }),
      questionRepo.create({
        roleId: role.id,
        jobId: null,
        type: QuestionType.Prescreening,
        question: `Which tools are core to a ${role.name} workflow?`,
        criteria: "Match tools to the role catalog",
        category: "tools",
      })
    );
  }
  const personalityCategories = ["EI", "SN", "TF", "JP"] as const;
  for (const job of jobs) {
    questionRows.push(
      questionRepo.create({
        roleId: job.roleId,
        jobId: job.id,
        type: QuestionType.Personalized,
        question: "Describe a project where you had to change approach after new information.",
        criteria: "Adaptability and judgment",
        category: "adaptability",
      }),
      questionRepo.create({
        roleId: job.roleId,
        jobId: job.id,
        type: QuestionType.Personalized,
        question: "How do you decide what to communicate to a hiring manager versus a recruiter?",
        criteria: "Stakeholder communication",
        category: "communication",
      })
    );
    for (let p = 0; p < 3; p++) {
      const category = catalogItem(personalityCategories, p);
      questionRows.push(
        questionRepo.create({
          roleId: job.roleId,
          jobId: job.id,
          type: QuestionType.Personality,
          question: `Personality prompt (${category}): how do you prefer to make decisions at work?`,
          criteria: `Dichotomy ${category}`,
          category,
        })
      );
    }
  }
  const questions = await chunkedSave(questionRepo, questionRows, 100);
  const personalizedByJob = new Map<string, Question[]>();
  const personalityByJob = new Map<string, Question[]>();
  for (const question of questions) {
    if (!question.jobId) continue;
    if (question.type === QuestionType.Personalized) {
      const list = personalizedByJob.get(question.jobId) ?? [];
      list.push(question);
      personalizedByJob.set(question.jobId, list);
    } else if (question.type === QuestionType.Personality) {
      const list = personalityByJob.get(question.jobId) ?? [];
      list.push(question);
      personalityByJob.set(question.jobId, list);
    }
  }

  const activeJobs = jobs.filter((job) => job.status === JobStatus.Active);
  const applicationsPerTalent = Math.min(APPLICATIONS_PER_TALENT, activeJobs.length);
  const applicationRepo = ds.getRepository(Application);
  const applicationRows: Application[] = [];
  const applicationMeta: Array<{
    talent: User;
    job: Job;
    slot: number;
  }> = [];

  for (let talentIndex = 0; talentIndex < talents.length; talentIndex++) {
    const talent = must(talents[talentIndex], `talent ${talentIndex}`);
    for (let slot = 0; slot < applicationsPerTalent; slot++) {
      const job = must(
        activeJobs[(talentIndex * APPLICATIONS_PER_TALENT + slot) % activeJobs.length],
        `active job for talent ${talentIndex} slot ${slot}`
      );
      const personalized = personalizedByJob.get(job.id) ?? [];
      const personality = personalityByJob.get(job.id) ?? [];
      const profile = applicationProfile(slot, talentIndex + slot);
      applicationRows.push(
        applicationRepo.create({
          jobId: job.id,
          talentId: talent.id,
          recruiterId: job.postedById,
          roleId: job.roleId,
          applicationType:
            slot % 2 === 0 ? ApplicationType.Application : ApplicationType.Invitation,
          status: profile.status,
          currentStage: profile.currentStage,
          personalizedQuestions: personalized.map((question) => question.id),
          personalityQuestions: personality.map((question) => question.id),
          personalizedScore: profile.personalizedScore,
          cvSimilarityScore: profile.cvSimilarityScore,
          cvSimilarityAttempts: profile.cvSimilarityScore == null ? 0 : 1,
          personalizedAttempts: profile.personalizedScore == null ? 0 : 1,
          rank: profile.rank,
          averageScore: profile.averageScore,
          mbtiType: profile.mbtiType,
          stages: { ...DEFAULT_SCREENING_STAGES },
          matchVerdict: profile.matchVerdict,
          matchVerdictStatus: profile.matchVerdictStatus,
          matchVerdictAttempts: profile.matchVerdict ? 1 : 0,
          matchVerdictReasoning: profile.matchReasoning,
          matchRecommendation: profile.matchRecommendation,
          matchStrengths: profile.matchStrengths,
          matchWeaknesses: profile.matchWeaknesses,
          matchRisks: profile.matchRisks,
          assessmentRetryDate: profile.assessmentRetryDate,
        })
      );
      applicationMeta.push({ talent, job, slot });
    }
  }
  const applications = await chunkedSave(applicationRepo, applicationRows);
  logger.info(`Created ${applications.length} applications`);

  const applicantJobIds = [...new Set(applications.map((application) => application.jobId))];
  if (applicantJobIds.length > 0) {
    await ds.query(
      `UPDATE jobs AS j
       SET "noOfApplicants" = sub.cnt
       FROM (
         SELECT job_id AS id, COUNT(*)::int AS cnt
         FROM applications
         WHERE job_id = ANY($1::uuid[])
         GROUP BY job_id
       ) sub
       WHERE j.id = sub.id`,
      [applicantJobIds]
    );
  }

  const recommendationRepo = ds.getRepository(AiRecommendation);
  const recommendationRows: AiRecommendation[] = [];
  for (let i = 0; i < applications.length; i++) {
    const application = must(applications[i], `application ${i}`);
    if (
      application.status !== ApplicationStatus.AwaitingDecision &&
      application.status !== ApplicationStatus.Shortlisted &&
      application.status !== ApplicationStatus.Rejected
    ) {
      continue;
    }
    const bundle = matchBundle(i);
    recommendationRows.push(
      recommendationRepo.create({
        applicationId: application.id,
        verdict: application.matchVerdict ?? bundle.verdict,
        reasoning: application.matchVerdictReasoning ?? bundle.analysis.hiringRationale,
        recommendation: application.matchRecommendation ?? bundle.recommendation,
        strengths: application.matchStrengths,
        weaknesses: application.matchWeaknesses,
        risks: application.matchRisks,
        analysis: bundle.analysis,
      })
    );
  }
  await chunkedSave(recommendationRepo, recommendationRows);

  const answerRepo = ds.getRepository(Answer);
  const answerRows: Answer[] = [];
  for (let i = 0; i < applications.length; i++) {
    const application = must(applications[i], `application ${i}`);
    const meta = must(applicationMeta[i], `application meta ${i}`);
    const includePrescreening =
      application.status !== ApplicationStatus.Pending ||
      application.currentStage !== ScreeningStage.Prescreening;
    const includePersonalized =
      application.currentStage === ScreeningStage.Personality ||
      application.currentStage === ScreeningStage.Completed ||
      application.status === ApplicationStatus.AwaitingDecision ||
      application.status === ApplicationStatus.Shortlisted ||
      application.status === ApplicationStatus.Rejected;
    const includePersonality = includePersonalized;

    if (includePrescreening) {
      answerRows.push(
        answerRepo.create({
          roleId: application.roleId,
          jobId: application.jobId,
          userId: application.talentId,
          questionType: QuestionType.Prescreening,
          responses: [
            {
              questionId: `seed-ps-app-${i}`,
              answer: "I have delivered similar work in a previous role.",
              score: application.status === ApplicationStatus.RetakeAssessment ? 40 : 78,
            },
          ],
        })
      );
    }
    if (includePersonalized) {
      const personalized = personalizedByJob.get(application.jobId) ?? [];
      answerRows.push(
        answerRepo.create({
          roleId: application.roleId,
          jobId: application.jobId,
          userId: application.talentId,
          questionType: QuestionType.Personalized,
          responses: personalized.map((question, index) => ({
            questionId: question.id,
            answer: `Seeded personalized answer ${index + 1} from ${fullName(meta.talent)}.`,
            score: 70 + ((i + index) % 20),
          })),
        })
      );
    }
    if (includePersonality) {
      const personality = personalityByJob.get(application.jobId) ?? [];
      answerRows.push(
        answerRepo.create({
          roleId: application.roleId,
          jobId: application.jobId,
          userId: application.talentId,
          questionType: QuestionType.Personality,
          responses: personality.map((question, index) => ({
            questionId: question.id,
            answer: index % 2 === 0 ? "A" : "B",
            dichotomyPreference: question.category ?? "EI",
          })),
        })
      );
    }
  }
  await chunkedSave(answerRepo, answerRows, 100);

  const notificationRepo = ds.getRepository(Notification);
  const notificationRows: Notification[] = [];
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const orgById = new Map(organizations.map((org) => [org.id, org]));
  const talentById = new Map(talents.map((talent) => [talent.id, talent]));
  for (let i = 0; i < applications.length; i++) {
    const application = must(applications[i], `application ${i}`);
    const job = must(jobById.get(application.jobId), "job for notification");
    const role = must(roleById.get(job.roleId), "role for notification");
    const org = job.organizationId ? orgById.get(job.organizationId) : undefined;
    const talent = must(talentById.get(application.talentId), "talent for notification");
    const companyName = org?.name ?? "the company";
    notificationRows.push(
      notificationRepo.create({
        userId: application.recruiterId,
        title: "New application",
        message: `${fullName(talent)} applied for ${role.name} at ${companyName}.`,
        isRead: i % 3 === 0,
        deleted: false,
      }),
      notificationRepo.create({
        userId: application.talentId,
        title: "Application submitted",
        message: `You applied for ${role.name} at ${companyName}.`,
        isRead: i % 4 === 0,
        deleted: false,
      })
    );
    if (
      application.status === ApplicationStatus.Shortlisted ||
      application.status === ApplicationStatus.Rejected
    ) {
      notificationRows.push(
        notificationRepo.create({
          userId: application.talentId,
          title: decisionNotificationTitle(application.status, role.name, companyName),
          message: decisionNotificationTitle(application.status, role.name, companyName),
          isRead: false,
          deleted: false,
        })
      );
    }
  }
  await chunkedSave(notificationRepo, notificationRows, 100);

  const shortlisted = applications
    .map((application, index) => ({ application, index }))
    .filter(({ application }) => application.status === ApplicationStatus.Shortlisted);
  const conversationRepo = ds.getRepository(Conversation);
  const messageRepo = ds.getRepository(Message);
  const conversationRows: Conversation[] = [];
  const messagedShortlists = shortlisted.filter((_, index) => index % 2 === 0);
  for (let i = 0; i < messagedShortlists.length; i++) {
    conversationRows.push(conversationRepo.create());
  }
  const conversations = await chunkedSave(conversationRepo, conversationRows);
  const participantRows: Array<{ conversation_id: string; user_id: string }> = [];
  const messageRows: Message[] = [];
  for (let i = 0; i < messagedShortlists.length; i++) {
    const item = must(messagedShortlists[i], `shortlist ${i}`);
    const conversation = must(conversations[i], `conversation ${i}`);
    const talent = must(talentById.get(item.application.talentId), "message talent");
    participantRows.push(
      { conversation_id: conversation.id, user_id: item.application.talentId },
      { conversation_id: conversation.id, user_id: item.application.recruiterId }
    );
    const recruiterMessage = messageRepo.create({
      conversationId: conversation.id,
      applicationId: item.application.id,
      senderId: item.application.recruiterId,
      recipientId: item.application.talentId,
      content: `Hi ${talent.firstName}, you have been shortlisted. When are you free for a conversation?`,
      acknowledged: true,
      isRead: i % 2 === 0,
      deleted: false,
    });
    const talentMessage = messageRepo.create({
      conversationId: conversation.id,
      applicationId: item.application.id,
      senderId: item.application.talentId,
      recipientId: item.application.recruiterId,
      content: `Thanks — I can speak this week and am excited about the role.`,
      acknowledged: null,
      isRead: false,
      deleted: false,
    });
    messageRows.push(recruiterMessage, talentMessage);
  }
  for (let i = 0; i < participantRows.length; i += 200) {
    await ds
      .createQueryBuilder()
      .insert()
      .into("conversation_participants")
      .values(participantRows.slice(i, i + 200))
      .execute();
  }
  const savedMessages = await chunkedSave(messageRepo, messageRows);
  for (let i = 0; i < conversations.length; i++) {
    const conversation = must(conversations[i], `conversation ${i}`);
    const last = savedMessages[i * 2 + 1];
    if (last) {
      conversation.lastMessageId = last.id;
    }
  }
  await chunkedSave(conversationRepo, conversations);

  const inviteRepo = ds.getRepository(OrganizationInvite);
  const inviteRows: OrganizationInvite[] = [];
  for (let companyIndex = 0; companyIndex < organizations.length; companyIndex++) {
    const org = must(organizations[companyIndex], `org ${companyIndex}`);
    const owner = must(recruiters[companyIndex * RECRUITERS_PER_COMPANY], `owner ${companyIndex}`);
    inviteRows.push(
      inviteRepo.create({
        organizationId: org.id,
        email: pendingInviteEmail(companyIndex + 1),
        token: crypto.randomBytes(32).toString("hex"),
        invitedById: owner.id,
        status: OrganizationInviteStatus.Pending,
        expiresAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
      })
    );
  }
  await chunkedSave(inviteRepo, inviteRows);

  const joinRepo = ds.getRepository(OrganizationJoinRequest);
  const joinRows: OrganizationJoinRequest[] = [];
  const joinCount = Math.min(8, Math.max(0, organizations.length - 1));
  for (let i = 0; i < joinCount; i++) {
    const fromCompany = i;
    const toCompany = i + 1;
    const requester = must(
      recruiters[fromCompany * RECRUITERS_PER_COMPANY + 1],
      `join requester ${i}`
    );
    const target = must(organizations[toCompany], `join target ${i}`);
    joinRows.push(
      joinRepo.create({
        userId: requester.id,
        organizationId: target.id,
        workEmail: `joining-c${padNumber(fromCompany + 1, 2)}@${must(target.domain, "target domain")}`,
        status: OrganizationJoinRequestStatus.Pending,
      })
    );
  }
  await chunkedSave(joinRepo, joinRows);

  const scoutJobRepo = ds.getRepository(ScoutJob);
  const scoutJobRows: ScoutJob[] = [];
  for (let companyIndex = 0; companyIndex < organizations.length; companyIndex++) {
    const org = must(organizations[companyIndex], `org ${companyIndex}`);
    const owner = must(recruiters[companyIndex * RECRUITERS_PER_COMPANY], `owner ${companyIndex}`);
    for (let s = 0; s < 2; s++) {
      const role = catalogItem(roles, companyIndex + s);
      scoutJobRows.push(
        scoutJobRepo.create({
          roleId: role.id,
          postedById: owner.id,
          organizationId: org.id,
          jobBrief: `Scout pipeline for ${role.name} at ${org.name}.`,
          name: `${org.name} ${role.name} Scout ${s + 1}`,
          recruiterGuide: "Prioritize relevant experience, clarity, and communication.",
          jobEmbedding: STUB_EMBEDDING,
        })
      );
    }
  }
  const scoutJobs = await chunkedSave(scoutJobRepo, scoutJobRows);
  const scoutRepo = ds.getRepository(Scout);
  const scoutRows: Scout[] = [];
  for (let i = 0; i < scoutJobs.length; i++) {
    const scoutJob = must(scoutJobs[i], `scout job ${i}`);
    for (let c = 0; c < 3; c++) {
      const cvText = `Scout candidate ${i}-${c} CV for ${scoutJob.name}.`;
      scoutRows.push(
        scoutRepo.create({
          batchId: `seed-batch-${scoutJob.id}`,
          cvName: `scout-candidate-${i}-${c}.pdf`,
          cvText,
          coverLetterName: `cover-${i}-${c}.pdf`,
          coverLetterText: "I am interested in this scouted role.",
          cvScore: 60 + ((i + c) % 35),
          insights: "Seeded scout insight: relevant keywords present.",
          coverLetterScore: 55 + ((i + c) % 30),
          coverLetterInsights: "Clear interest and motivation.",
          evaluationScore: 62 + ((i + c) % 25),
          candidateName: `${catalogItem(FIRST_NAMES, i + c)} ${catalogItem(LAST_NAMES, i + c + 2)}`,
          candidateEmail: `scout-candidate-${i}-${c}@example.test`,
          candidatePhone: `+234809${padNumber(100000 + i * 3 + c, 6)}`,
          candidateAddress: catalogItem(CITIES, i + c).city,
          recruiterId: scoutJob.postedById,
          scoutJobId: scoutJob.id,
          cvTextHash: crypto.createHash("sha256").update(cvText).digest("hex"),
        })
      );
    }
  }
  await chunkedSave(scoutRepo, scoutRows);

  const paymentRepo = ds.getRepository(Payment);
  const subscriptionRepo = ds.getRepository(Subscription);
  const paymentRows: Payment[] = [];
  const subscriptionRows: Subscription[] = [];
  const advanceMonthly = must(plans.get("advance:monthly"), "advance:monthly plan");
  for (let companyIndex = 0; companyIndex < scale.companies; companyIndex++) {
    if (companyIndex % 2 !== 0) continue;
    const owner = must(
      recruiters[companyIndex * RECRUITERS_PER_COMPANY],
      `paid owner ${companyIndex}`
    );
    const org = must(organizations[companyIndex], `paid org ${companyIndex}`);
    paymentRows.push(
      paymentRepo.create({
        userId: owner.id,
        organizationId: org.id,
        planId: advanceMonthly.id,
        amount: advanceMonthly.amount,
        amountKobo: Math.round(advanceMonthly.paystackAmount),
        currency: "NGN",
        billingInterval: BillingInterval.Monthly,
        reference: `seed-pay-${owner.id.replace(/-/g, "").slice(0, 16)}`,
        paystackRef: `seed-psk-${owner.id.replace(/-/g, "").slice(0, 16)}`,
        paymentLink: "https://paystack.com/pay/seed",
        status: PaymentStatus.Completed,
        history: [{ description: "Seeded payment completed", author: "seed", date: now }],
        initialConfig: { seeded: true },
        finalConfig: { seeded: true, status: "completed" },
        paidAt: now,
      })
    );
    subscriptionRows.push(
      subscriptionRepo.create({
        userId: owner.id,
        organizationId: org.id,
        planId: advanceMonthly.id,
        paystackSubscriptionCode: `seed-sub-${owner.id.replace(/-/g, "").slice(0, 16)}`,
        authorizationCode: `AUTH_seed_${companyIndex}`,
        email_token: `seed-email-token-${companyIndex}`,
        status: SubscriptionStatus.Active,
        startDate: now,
        nextPaymentDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        expiryDate: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
        cron_expression: "0 0 1 * *",
        usage: {
          jobListingsUsed: 4,
          candidatesAccessed: 12,
          aiTestsUsed: 3,
          lastResetDate: now,
        },
        history: [{ description: "Seeded subscription activated", author: "seed", date: now }],
      })
    );
  }
  await chunkedSave(paymentRepo, paymentRows);
  await chunkedSave(subscriptionRepo, subscriptionRows);

  const feedbackRepo = ds.getRepository(Feedback);
  const feedbackRows: Feedback[] = [];
  const feedbackUsers = [...talents.slice(0, 8), ...recruiters.slice(0, 4)];
  for (let i = 0; i < feedbackUsers.length; i++) {
    const user = must(feedbackUsers[i], `feedback user ${i}`);
    feedbackRows.push(
      feedbackRepo.create({
        userId: user.id,
        subject: i % 2 === 0 ? "Seeded product feedback" : "Seeded hiring workflow note",
        message: `${fullName(user)} left seeded feedback for local development.`,
        isRead: i % 3 === 0,
      })
    );
  }
  await chunkedSave(feedbackRepo, feedbackRows);

  const sampleTalentEmail = must(talents[0], "first talent").email;
  const sampleRecruiterEmail = must(recruiters[0], "first recruiter").email;
  const summary: SeedSummary = {
    n: scale.n,
    talents: talents.length,
    recruiters: recruiters.length,
    companies: organizations.length,
    jobs: jobs.length,
    applications: applications.length,
    password: SEED_PASSWORD,
    sampleTalentEmail,
    sampleRecruiterEmail,
  };

  logger.info(
    [
      "Seed complete.",
      `  talents=${summary.talents} recruiters=${summary.recruiters} companies=${summary.companies}`,
      `  jobs=${summary.jobs} applications=${summary.applications}`,
      `  password=${summary.password}`,
      `  sample talent=${summary.sampleTalentEmail}`,
      `  sample recruiter=${summary.sampleRecruiterEmail}`,
    ].join("\n")
  );

  return summary;
}

function padCompanyName(value: number): string {
  return padNumber(value, 2);
}

function applicationProfile(
  slot: number,
  salt: number
): {
  status: ApplicationStatus;
  currentStage: ScreeningStage;
  personalizedScore: number | null;
  cvSimilarityScore: number | null;
  rank: number | null;
  averageScore: number | null;
  mbtiType: string | null;
  matchVerdict: MatchVerdict | null;
  matchVerdictStatus: MatchVerdictStatus | null;
  matchReasoning: string | null;
  matchRecommendation: MatchRecommendation | null;
  matchStrengths: string[] | null;
  matchWeaknesses: string[] | null;
  matchRisks: string[] | null;
  assessmentRetryDate: Date | null;
} {
  const bundle = matchBundle(salt);
  const cvSimilarityScore = 55 + (salt % 40);
  const personalizedScore = 60 + (salt % 35);
  const averageScore = Math.round((cvSimilarityScore + personalizedScore) / 2);
  const completed = {
    personalizedScore,
    cvSimilarityScore,
    rank: 1 + (salt % 12),
    averageScore,
    mbtiType: catalogItem(MBTI_TYPES, salt),
    matchVerdict: bundle.verdict,
    matchVerdictStatus: MatchVerdictStatus.Succeeded,
    matchReasoning: bundle.analysis.hiringRationale,
    matchRecommendation: bundle.recommendation,
    matchStrengths: bundle.analysis.strongestQualifications,
    matchWeaknesses: bundle.analysis.prescreeningInsights.weaknesses,
    matchRisks: ["Seeded residual risk: limited domain tenure"],
    assessmentRetryDate: null as Date | null,
  };

  switch (slot % APPLICATIONS_PER_TALENT) {
    case 1:
      return {
        status: ApplicationStatus.RetakeAssessment,
        currentStage: ScreeningStage.Prescreening,
        personalizedScore: null,
        cvSimilarityScore: null,
        rank: null,
        averageScore: 40,
        mbtiType: null,
        matchVerdict: null,
        matchVerdictStatus: null,
        matchReasoning: null,
        matchRecommendation: null,
        matchStrengths: null,
        matchWeaknesses: null,
        matchRisks: null,
        assessmentRetryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      };
    case 2:
      return {
        status: ApplicationStatus.Pending,
        currentStage: ScreeningStage.Personalized,
        personalizedScore: null,
        cvSimilarityScore,
        rank: null,
        averageScore: cvSimilarityScore,
        mbtiType: null,
        matchVerdict: null,
        matchVerdictStatus: MatchVerdictStatus.Pending,
        matchReasoning: null,
        matchRecommendation: null,
        matchStrengths: null,
        matchWeaknesses: null,
        matchRisks: null,
        assessmentRetryDate: null,
      };
    case 3:
      return {
        status: ApplicationStatus.AwaitingDecision,
        currentStage: ScreeningStage.Completed,
        ...completed,
      };
    case 4:
      return {
        status: ApplicationStatus.Shortlisted,
        currentStage: ScreeningStage.Completed,
        ...completed,
      };
    case 5:
      return {
        status: ApplicationStatus.Rejected,
        currentStage: ScreeningStage.Completed,
        ...completed,
      };
    default:
      return {
        status: ApplicationStatus.Pending,
        currentStage: ScreeningStage.Prescreening,
        personalizedScore: null,
        cvSimilarityScore: null,
        rank: null,
        averageScore: null,
        mbtiType: null,
        matchVerdict: null,
        matchVerdictStatus: null,
        matchReasoning: null,
        matchRecommendation: null,
        matchStrengths: null,
        matchWeaknesses: null,
        matchRisks: null,
        assessmentRetryDate: null,
      };
  }
}
