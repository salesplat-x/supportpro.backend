import { EntityManager, In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { StaffActivityType } from "../entities/StaffActivity.js";
import {
  DevelopmentSource,
  DevelopmentStatus,
  StaffDevelopmentItem,
} from "../entities/StaffDevelopmentItem.js";
import { GoalStatus, StaffGoal } from "../entities/StaffGoal.js";
import { StaffWeeklyReport } from "../entities/StaffWeeklyReport.js";
import type { User } from "../entities/User.js";
import { ConflictError, NotFoundError } from "../utils/errors";
import { suggestDevelopmentItems as suggestItemsAI } from "../utils/integrations/openai.js";
import { addDays, workToday } from "../utils/workCalendar.js";
import { aiFailure, askAi, cleanAiText, withAiClaim } from "./peopleAi.js";
import {
  type PerformanceScope,
  assertScope,
  assertWritable,
  lockOwnStaff,
  lockScopedStaff,
  openPerformance,
} from "./performanceAccess.js";
import { activityEntry, recordActivities } from "./staffAudit.js";
import { findStaff } from "./staffRecord.js";

export const MAX_OPEN_ITEMS = 50;
const MIN_SUGGESTIONS = 1;
const MAX_SUGGESTIONS = 5;
const REPORTS_READ = 4;
const MIN_DUE_DAYS = 7;
const MAX_DUE_DAYS = 365;

export interface DevelopmentInput {
  weakArea: string;
  action: string;
  dueOn: string | null;
}

export interface DevelopmentView extends DevelopmentInput {
  id: string;
  status: DevelopmentStatus;
  source: DevelopmentSource;
  version: number;
}

const itemsRepo = (em: EntityManager = AppDataSource.manager) =>
  em.getRepository(StaffDevelopmentItem);

export const toDevelopmentView = (item: StaffDevelopmentItem): DevelopmentView => ({
  id: item.id,
  weakArea: item.weakArea,
  action: item.action,
  dueOn: item.dueOn,
  status: item.status,
  source: item.source,
  version: item.version,
});

/** Proposed items are for the manager to accept or remove. The employee never sees them. */
export const listDevelopment = (
  staffId: string,
  ownView: boolean
): Promise<StaffDevelopmentItem[]> =>
  itemsRepo().find({
    where: {
      staffId,
      ...(ownView ? { status: In([DevelopmentStatus.Open, DevelopmentStatus.Done]) } : {}),
    },
    order: { createdAt: "ASC", id: "ASC" },
  });

const assertRoomForItems = async (
  em: EntityManager,
  staffId: string,
  adding: number
): Promise<void> => {
  const open = await itemsRepo(em).count({
    where: { staffId, status: In([DevelopmentStatus.Proposed, DevelopmentStatus.Open]) },
  });
  if (open + adding > MAX_OPEN_ITEMS) {
    throw new ConflictError(
      `This person has reached the limit of ${MAX_OPEN_ITEMS} open plan items. Finish or remove some first.`
    );
  }
};

const findLockedItem = async (
  em: EntityManager,
  staffId: string,
  itemId: string
): Promise<StaffDevelopmentItem> => {
  const item = await itemsRepo(em).findOne({
    where: { id: itemId, staffId },
    lock: { mode: "pessimistic_write" },
  });
  if (!item) {
    throw new NotFoundError("Plan item not found");
  }
  return item;
};

export const addDevelopmentItem = async (
  scope: PerformanceScope,
  input: DevelopmentInput
): Promise<DevelopmentView> => {
  await assertScope(scope);
  return AppDataSource.transaction(async (em) => {
    const staff = await lockScopedStaff(scope, em);
    await assertRoomForItems(em, staff.id, 1);
    const item = await itemsRepo(em).save(
      itemsRepo(em).create({
        ...input,
        organizationId: staff.organizationId,
        staffId: staff.id,
      })
    );
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.DevelopmentItemAdded, scope.actor, {
        weakArea: item.weakArea,
      }),
    ]);
    return toDevelopmentView(item);
  });
};

/** `status` only accepts a proposal. After that "done" is the employee's, so an open form can't undo it. */
export const editDevelopmentItem = async (
  scope: PerformanceScope,
  itemId: string,
  input: DevelopmentInput & { status: DevelopmentStatus },
  version: number
): Promise<DevelopmentView> => {
  await assertScope(scope);
  return AppDataSource.transaction(async (em) => {
    const staff = await lockScopedStaff(scope, em);
    const item = await findLockedItem(em, staff.id, itemId);
    if (item.version !== version) {
      throw new ConflictError("This plan item changed after you opened it. Reload and try again.");
    }
    const changes = {
      ...input,
      status: item.status === DevelopmentStatus.Proposed ? input.status : item.status,
      version: item.version + 1,
    };
    await itemsRepo(em).update(item.id, changes);
    return toDevelopmentView(Object.assign(item, changes));
  });
};

export const removeDevelopmentItem = async (
  scope: PerformanceScope,
  itemId: string
): Promise<void> => {
  await assertScope(scope);
  await AppDataSource.transaction(async (em) => {
    const staff = await lockScopedStaff(scope, em);
    const item = await findLockedItem(em, staff.id, itemId);
    await itemsRepo(em).delete(item.id);
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.DevelopmentItemRemoved, scope.actor, {
        weakArea: item.weakArea,
      }),
    ]);
  });
};

export const setDevelopmentDone = async (
  actor: User,
  staffId: string,
  itemId: string,
  done: boolean
): Promise<DevelopmentView> =>
  AppDataSource.transaction(async (em) => {
    const staff = await lockOwnStaff(actor.id, staffId, em);
    const item = await findLockedItem(em, staff.id, itemId);
    if (item.status === DevelopmentStatus.Proposed) {
      throw new NotFoundError("Plan item not found");
    }
    const status = done ? DevelopmentStatus.Done : DevelopmentStatus.Open;
    await itemsRepo(em).update(item.id, { status });
    return toDevelopmentView(Object.assign(item, { status }));
  });

const proposals = (em: EntityManager, staffId: string): Promise<StaffDevelopmentItem[]> =>
  itemsRepo(em).find({
    where: { staffId, status: DevelopmentStatus.Proposed },
    order: { createdAt: "ASC", id: "ASC" },
  });

const cleanSuggestions = (reply: Record<string, unknown>): DevelopmentInput[] => {
  const raw = Array.isArray(reply["items"]) ? (reply["items"] as Record<string, unknown>[]) : [];
  const today = workToday();
  const items = raw
    .map((item) => {
      const days = Number(item["dueInDays"]);
      return {
        weakArea: cleanAiText(item["weakArea"], 200),
        action: cleanAiText(item["action"], 1000),
        dueOn: addDays(
          today,
          Math.min(MAX_DUE_DAYS, Math.max(MIN_DUE_DAYS, Number.isFinite(days) ? days : 90))
        ),
      };
    })
    .filter((item) => item.weakArea && item.action)
    .slice(0, MAX_SUGGESTIONS);
  if (items.length < MIN_SUGGESTIONS) {
    throw aiFailure();
  }
  return items;
};

export const suggestDevelopmentItems = async (
  scope: PerformanceScope,
  ip: string
): Promise<DevelopmentView[]> => {
  await assertScope(scope);
  const staff = await openPerformance(scope, ip);
  assertWritable(staff);
  const existing = await proposals(AppDataSource.manager, staff.id);
  if (existing.length > 0) {
    return existing.map(toDevelopmentView);
  }

  return withAiClaim(`development:${staff.id}`, async () => {
    const finished = await proposals(AppDataSource.manager, staff.id);
    if (finished.length > 0) {
      return finished.map(toDevelopmentView);
    }
    const [goals, reports] = await Promise.all([
      AppDataSource.getRepository(StaffGoal).find({
        where: { staffId: staff.id, status: GoalStatus.Approved },
        select: { id: true, title: true, progress: true, dueOn: true },
      }),
      AppDataSource.getRepository(StaffWeeklyReport).find({
        where: { staffId: staff.id },
        select: { id: true, did: true, blocked: true },
        order: { weekStart: "DESC" },
        take: REPORTS_READ,
      }),
    ]);
    if (goals.length === 0 && reports.length === 0) {
      throw new ConflictError("Add goals or weekly reports first, so there is something to go on");
    }
    const suggestions = cleanSuggestions(
      await askAi(() =>
        suggestItemsAI({
          jobTitle: staff.jobTitle,
          goals: goals.map(({ title, progress, dueOn }) => ({ title, progress, dueOn })),
          reports: reports.map(({ did, blocked }) => ({ did, blocked })),
        })
      )
    );
    await assertScope(scope);
    return AppDataSource.transaction(async (em) => {
      const locked = await lockScopedStaff(scope, em);
      const already = await proposals(em, locked.id);
      if (already.length > 0) {
        return already.map(toDevelopmentView);
      }
      await assertRoomForItems(em, locked.id, suggestions.length);
      const now = Date.now();
      const saved = await itemsRepo(em).save(
        suggestions.map((item, index) =>
          itemsRepo(em).create({
            ...item,
            organizationId: locked.organizationId,
            staffId: locked.id,
            status: DevelopmentStatus.Proposed,
            source: DevelopmentSource.Ai,
            createdAt: new Date(now + index),
          })
        )
      );
      return saved.map(toDevelopmentView);
    });
  });
};

/**
 * The way in for a result from another product, such as a skill test. It has no route yet
 * because that product's API doesn't exist. Sending the same result twice adds it once.
 */
export const addExternalDevelopmentItem = async (input: {
  organizationId: string;
  staffId: string;
  source: DevelopmentSource;
  sourceRef: string;
  weakArea: string;
  action: string;
}): Promise<{ created: boolean }> =>
  AppDataSource.transaction(async (em) => {
    const staff = await findStaff(input.organizationId, input.staffId, { em, lock: true });
    assertWritable(staff);
    const existing = await itemsRepo(em).findOne({
      where: { staffId: staff.id, source: input.source, sourceRef: input.sourceRef },
    });
    if (existing) {
      return { created: false };
    }
    await assertRoomForItems(em, staff.id, 1);
    await itemsRepo(em).insert({
      organizationId: staff.organizationId,
      staffId: staff.id,
      source: input.source,
      sourceRef: input.sourceRef,
      weakArea: input.weakArea,
      action: input.action,
      status: DevelopmentStatus.Open,
    });
    return { created: true };
  });
