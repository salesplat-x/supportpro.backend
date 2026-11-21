import { EntityManager, Not } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { StaffActivityType } from "../entities/StaffActivity.js";
import { GoalSource, GoalStatus, StaffGoal } from "../entities/StaffGoal.js";
import { StaffGoalProgressEvent } from "../entities/StaffGoalProgressEvent.js";
import { StaffJobDescription } from "../entities/StaffJobDescription.js";
import type { StaffMember } from "../entities/StaffMember.js";
import type { User } from "../entities/User.js";
import { ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import {
  generateJobField as generateJobFieldAI,
  suggestGoals as suggestGoalsAI,
} from "../utils/integrations/openai.js";
import { addDays, workToday } from "../utils/workCalendar.js";
import { assertCanManagePeople } from "./peopleAccess.js";
import { aiFailure, askAi, cleanAiText, withAiClaim } from "./peopleAi.js";
import {
  type PerformanceScope,
  assertScope,
  assertWritable,
  lockOwnStaff,
  lockScopedStaff,
  openPerformance,
} from "./performanceAccess.js";
import { deleteEvidenceQuietly, evidenceKeysFor } from "./completionRequests.js";
import { activityEntry, recordActivities } from "./staffAudit.js";
import { findStaff, fullNameOf } from "./staffRecord.js";

export const MAX_OPEN_GOALS = 50;
export const MAX_JOB_DESCRIPTION = 20_000;
const MIN_SUGGESTIONS = 3;
const MAX_SUGGESTIONS = 5;
const MAX_KEY_RESULTS = 5;
const MIN_DUE_DAYS = 7;
const MAX_DUE_DAYS = 365;
const MAX_ORG_LEVELS = 100;

export interface GoalInput {
  title: string;
  keyResults: string[];
  target: string | null;
  dueOn: string;
}

export interface GoalView extends GoalInput {
  id: string;
  progress: number;
  status: GoalStatus;
  source: GoalSource;
  version: number;
  approvedByName: string | null;
  approvedAt: Date | null;
  completedAt: Date | null;
  completedByName: string | null;
}

export interface JobDescriptionView {
  body: string;
  version: number;
  updatedByName: string;
  updatedAt: Date;
}

const goalsRepo = (em: EntityManager = AppDataSource.manager) => em.getRepository(StaffGoal);

const staleGoal = () =>
  new ConflictError("Someone changed this goal after you opened it. Reload and try again.");

export const toGoalView = (goal: StaffGoal): GoalView => ({
  id: goal.id,
  title: goal.title,
  keyResults: goal.keyResults,
  target: goal.target,
  dueOn: goal.dueOn,
  progress: goal.progress,
  status: goal.status,
  source: goal.source,
  version: goal.version,
  approvedByName: goal.approvedByName,
  approvedAt: goal.approvedAt,
  completedAt: goal.completedAt,
  completedByName: goal.completedByName,
});

export const listGoals = (staffId: string, onlyApproved = false): Promise<StaffGoal[]> =>
  goalsRepo().find({
    where: { staffId, ...(onlyApproved ? { status: GoalStatus.Approved } : {}) },
    order: { dueOn: "ASC", createdAt: "ASC", id: "ASC" },
  });

export const toJobDescriptionView = (row: StaffJobDescription): JobDescriptionView => ({
  body: row.body,
  version: row.version,
  updatedByName: row.updatedByName,
  updatedAt: row.updatedAt,
});

export const loadJobDescription = (staffId: string): Promise<StaffJobDescription | null> =>
  AppDataSource.getRepository(StaffJobDescription).findOne({ where: { staffId } });

const openGoalCount = (em: EntityManager, staffId: string): Promise<number> =>
  goalsRepo(em)
    .createQueryBuilder("goal")
    .where("goal.staffId = :staffId", { staffId })
    .andWhere("(goal.status = :draft OR goal.progress < 100)", { draft: GoalStatus.Draft })
    .andWhere(
      `NOT EXISTS (
        SELECT 1 FROM staff_completion_requests request
        WHERE request.goal_id = goal.id AND request.status = 'pending'
      )`
    )
    .getCount();

const assertRoomForGoals = async (
  em: EntityManager,
  staffId: string,
  adding: number
): Promise<void> => {
  if ((await openGoalCount(em, staffId)) + adding > MAX_OPEN_GOALS) {
    throw new ConflictError(
      `This person has reached the limit of ${MAX_OPEN_GOALS} open goals. Finish or remove some first.`
    );
  }
};

const findLockedGoal = async (
  em: EntityManager,
  staffId: string,
  goalId: string
): Promise<StaffGoal> => {
  const goal = await goalsRepo(em).findOne({
    where: { id: goalId, staffId },
    lock: { mode: "pessimistic_write" },
  });
  if (!goal) {
    throw new NotFoundError("Goal not found");
  }
  return goal;
};

export const addGoal = async (scope: PerformanceScope, input: GoalInput): Promise<GoalView> => {
  await assertScope(scope);
  return AppDataSource.transaction(async (em) => {
    const staff = await lockScopedStaff(scope, em);
    if (input.dueOn < workToday()) {
      throw new ValidationError("The due date can't be in the past");
    }
    await assertRoomForGoals(em, staff.id, 1);
    const goal = await goalsRepo(em).save(
      goalsRepo(em).create({
        ...input,
        organizationId: staff.organizationId,
        staffId: staff.id,
      })
    );
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.GoalAdded, scope.actor, { title: goal.title }),
    ]);
    return toGoalView(goal);
  });
};

export const editGoal = async (
  scope: PerformanceScope,
  goalId: string,
  input: GoalInput,
  version: number
): Promise<GoalView> => {
  await assertScope(scope);
  return AppDataSource.transaction(async (em) => {
    const staff = await lockScopedStaff(scope, em);
    const goal = await findLockedGoal(em, staff.id, goalId);
    if (goal.version !== version) {
      throw staleGoal();
    }
    if (input.dueOn !== goal.dueOn && input.dueOn < workToday()) {
      throw new ValidationError("The due date can't be in the past");
    }
    const nextVersion = goal.version + 1;
    await goalsRepo(em).update(goal.id, { ...input, version: nextVersion });
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.GoalChanged, scope.actor, { title: input.title }),
    ]);
    return toGoalView(Object.assign(goal, input, { version: nextVersion }));
  });
};

/** Sends the version the approver read, so nobody approves wording they never saw. Repeats are harmless. */
export const approveGoal = async (
  scope: PerformanceScope,
  goalId: string,
  version: number
): Promise<GoalView> => {
  await assertScope(scope);
  return AppDataSource.transaction(async (em) => {
    const staff = await lockScopedStaff(scope, em);
    const goal = await findLockedGoal(em, staff.id, goalId);
    if (goal.version !== version) {
      throw staleGoal();
    }
    if (goal.status === GoalStatus.Approved) {
      return toGoalView(goal);
    }
    const approval = {
      status: GoalStatus.Approved,
      approvedAt: new Date(),
      approvedByName: fullNameOf(scope.actor),
    };
    await goalsRepo(em).update(goal.id, approval);
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.GoalApproved, scope.actor, { title: goal.title }),
    ]);
    return toGoalView(Object.assign(goal, approval));
  });
};

/** All or nothing: one stale version, or one missing goal, approves none of them. */
export const approveGoals = async (
  scope: PerformanceScope,
  items: { goalId: string; version: number }[]
): Promise<GoalView[]> => {
  await assertScope(scope);
  return AppDataSource.transaction(async (em) => {
    const staff = await lockScopedStaff(scope, em);
    const approved: GoalView[] = [];
    const entries: ReturnType<typeof activityEntry>[] = [];
    for (const { goalId, version } of items) {
      const goal = await findLockedGoal(em, staff.id, goalId);
      if (goal.version !== version) {
        throw staleGoal();
      }
      if (goal.status !== GoalStatus.Approved) {
        const approval = {
          status: GoalStatus.Approved,
          approvedAt: new Date(),
          approvedByName: fullNameOf(scope.actor),
        };
        await goalsRepo(em).update(goal.id, approval);
        Object.assign(goal, approval);
        entries.push(
          activityEntry(StaffActivityType.GoalApproved, scope.actor, { title: goal.title })
        );
      }
      approved.push(toGoalView(goal));
    }
    if (entries.length > 0) {
      await recordActivities(em, staff, entries);
    }
    return approved;
  });
};

export const removeGoal = async (scope: PerformanceScope, goalId: string): Promise<void> => {
  await assertScope(scope);
  const evidence = await AppDataSource.transaction(async (em) => {
    const staff = await lockScopedStaff(scope, em);
    const goal = await findLockedGoal(em, staff.id, goalId);
    const keys = await evidenceKeysFor({ goalId: goal.id }, em);
    await goalsRepo(em).delete(goal.id);
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.GoalRemoved, scope.actor, { title: goal.title }),
    ]);
    return keys;
  });
  await deleteEvidenceQuietly(evidence);
};

/**
 * Only the employee moves progress, and only on approved goals and up to 99. A goal reaches 100
 * when a reviewer marks it complete, and then it's locked. It leaves `version` alone.
 */
export const setGoalProgress = async (
  actor: User,
  staffId: string,
  goalId: string,
  progress: number
): Promise<GoalView> =>
  AppDataSource.transaction(async (em) => {
    const staff = await lockOwnStaff(actor.id, staffId, em);
    const goal = await findLockedGoal(em, staff.id, goalId);
    if (goal.status !== GoalStatus.Approved) {
      throw new NotFoundError("Goal not found");
    }
    if (goal.completedAt) {
      throw new ConflictError("This goal is complete, so its progress can't change");
    }
    if (goal.progress === progress) {
      return toGoalView(goal);
    }
    await em.getRepository(StaffGoalProgressEvent).insert({
      goalId: goal.id,
      fromProgress: goal.progress,
      toProgress: progress,
    });
    await goalsRepo(em).update(goal.id, { progress });
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.GoalProgressUpdated, actor, {
        title: goal.title,
        progress,
      }),
    ]);
    return toGoalView(Object.assign(goal, { progress }));
  });

const levelInOrgChart = async (staff: StaffMember): Promise<number> => {
  const rows: Array<{ level: number }> = await AppDataSource.query(
    `WITH RECURSIVE chain AS (
       SELECT id, manager_id, 1 AS level FROM staff_members WHERE id = $1
       UNION ALL
       SELECT m.id, m.manager_id, chain.level + 1
       FROM staff_members m JOIN chain ON m.id = chain.manager_id
       WHERE chain.level < $2
     )
     SELECT MAX(level)::int AS level FROM chain`,
    [staff.id, MAX_ORG_LEVELS]
  );
  return rows[0]?.level ?? 1;
};

const companyOf = (staff: StaffMember): Promise<Organization> =>
  AppDataSource.getRepository(Organization).findOneOrFail({
    where: { id: staff.organizationId },
  });

/** Fills the editor only. Nothing is saved until someone presses Save, so it can't overwrite their edits. */
export const writeJobDescription = async (
  actor: User,
  organizationId: string,
  staffId: string
): Promise<{ body: string }> => {
  await assertCanManagePeople(actor.id, organizationId);
  const staff = await findStaff(organizationId, staffId);
  assertWritable(staff);
  return withAiClaim(`job-description:${staff.id}`, async () => {
    const [company, level] = await Promise.all([companyOf(staff), levelInOrgChart(staff)]);
    const reply = await askAi(() =>
      generateJobFieldAI({
        field: "jobBrief",
        people: true,
        job: { role: staff.jobTitle, experienceLevel: `Level ${level} in the company's org chart` },
        companyProfile: {
          mission: company.mission,
          vision: company.vision,
          yearlyGoals: company.yearlyGoals,
        },
      })
    );
    const body = cleanAiText(reply["text"], MAX_JOB_DESCRIPTION);
    if (!body) {
      throw aiFailure();
    }
    return { body };
  });
};

export const saveJobDescription = async (
  actor: User,
  organizationId: string,
  staffId: string,
  body: string,
  version: number | null
): Promise<JobDescriptionView> => {
  await assertCanManagePeople(actor.id, organizationId);
  return AppDataSource.transaction(async (em) => {
    const staff = await findStaff(organizationId, staffId, { em, lock: true });
    assertWritable(staff);
    const repo = em.getRepository(StaffJobDescription);
    const current = await repo.findOne({ where: { staffId } });
    if ((current?.version ?? null) !== version) {
      throw new ConflictError(
        "Someone changed this job description after you opened it. Reload and try again."
      );
    }
    const saved = await repo.save(
      repo.create({
        staffId,
        body,
        version: (current?.version ?? 0) + 1,
        updatedByName: fullNameOf(actor),
      })
    );
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.JobDescriptionSaved, actor),
    ]);
    return toJobDescriptionView(saved);
  });
};

const aiDrafts = (em: EntityManager, staffId: string): Promise<StaffGoal[]> =>
  goalsRepo(em).find({
    where: { staffId, status: GoalStatus.Draft, source: GoalSource.Ai },
    order: { createdAt: "ASC", id: "ASC" },
  });

const cleanSuggestions = (reply: Record<string, unknown>): Array<GoalInput> => {
  const raw = Array.isArray(reply["goals"]) ? (reply["goals"] as Record<string, unknown>[]) : [];
  const today = workToday();
  const goals = raw
    .map((goal) => {
      const days = Number(goal["dueInDays"]);
      return {
        title: cleanAiText(goal["title"], 200),
        keyResults: (Array.isArray(goal["keyResults"]) ? (goal["keyResults"] as unknown[]) : [])
          .map((result) => cleanAiText(result, 300))
          .filter(Boolean)
          .slice(0, MAX_KEY_RESULTS),
        target: cleanAiText(goal["target"], 200) || null,
        dueOn: addDays(
          today,
          Math.min(MAX_DUE_DAYS, Math.max(MIN_DUE_DAYS, Number.isFinite(days) ? days : 90))
        ),
      };
    })
    .filter((goal) => goal.title)
    .slice(0, MAX_SUGGESTIONS);
  if (goals.length < MIN_SUGGESTIONS) {
    throw aiFailure();
  }
  return goals;
};

/** Saved as drafts for approval. A double click or retry returns the drafts already there and costs nothing. */
export const suggestGoals = async (scope: PerformanceScope, ip: string): Promise<GoalView[]> => {
  await assertScope(scope);
  const staff = await openPerformance(scope, ip);
  assertWritable(staff);
  const jobDescription = await loadJobDescription(staff.id);
  if (!jobDescription) {
    throw new ConflictError("Write this person's job description first");
  }
  const existing = await aiDrafts(AppDataSource.manager, staff.id);
  if (existing.length > 0) {
    return existing.map(toGoalView);
  }

  return withAiClaim(`goals:${staff.id}`, async () => {
    const finished = await aiDrafts(AppDataSource.manager, staff.id);
    if (finished.length > 0) {
      return finished.map(toGoalView);
    }
    const [company, currentGoals] = await Promise.all([
      companyOf(staff),
      goalsRepo().find({ where: { staffId: staff.id, status: Not(GoalStatus.Draft) } }),
    ]);
    const suggestions = cleanSuggestions(
      await askAi(() =>
        suggestGoalsAI({
          jobTitle: staff.jobTitle,
          jobDescription: jobDescription.body,
          companyGoals: company.yearlyGoals,
          existingGoals: currentGoals.map((goal) => goal.title),
        })
      )
    );
    await assertScope(scope);
    return AppDataSource.transaction(async (em) => {
      const locked = await lockScopedStaff(scope, em);
      const already = await aiDrafts(em, locked.id);
      if (already.length > 0) {
        return already.map(toGoalView);
      }
      await assertRoomForGoals(em, locked.id, suggestions.length);
      const now = Date.now();
      const saved = await goalsRepo(em).save(
        suggestions.map((goal, index) =>
          goalsRepo(em).create({
            ...goal,
            organizationId: locked.organizationId,
            staffId: locked.id,
            source: GoalSource.Ai,
            createdAt: new Date(now + index),
          })
        )
      );
      await recordActivities(em, locked, [
        activityEntry(StaffActivityType.GoalsSuggested, scope.actor, { count: saved.length }),
      ]);
      return saved.map(toGoalView);
    });
  });
};
