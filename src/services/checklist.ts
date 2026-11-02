import { EntityManager } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { StaffChecklistTask } from "../entities/StaffChecklistTask.js";
import type { StaffMember } from "../entities/StaffMember.js";
import type { User } from "../entities/User.js";
import { NotFoundError } from "../utils/errors";
import { assertCanManagePeople } from "./peopleAccess.js";
import { findStaff } from "./staffRecord.js";

export interface ChecklistItem {
  title: string;
  dueInDays: number;
}

const DAY_MS = 86_400_000;

export const DEFAULT_CHECKLIST: ChecklistItem[] = [
  { title: "Set up IT accounts and laptop", dueInDays: 0 },
  { title: "Hand over the welcome pack", dueInDays: 0 },
  { title: "Share the first-week schedule", dueInDays: 0 },
];

const checklistOf = (org: Organization): ChecklistItem[] =>
  org.defaultChecklist ?? DEFAULT_CHECKLIST;

const addDays = (dateOnly: string, days: number): string =>
  new Date(Date.parse(`${dateOnly}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const tasksRepo = (em: EntityManager = AppDataSource.manager) =>
  em.getRepository(StaffChecklistTask);

export const CHECKLIST_ORDER = { dueOn: "ASC", createdAt: "ASC", id: "ASC" } as const;

export const copyDefaultChecklist = async (
  em: EntityManager,
  org: Organization,
  staff: Pick<StaffMember, "id" | "startDate">
): Promise<void> => {
  const items = checklistOf(org);
  if (items.length === 0) return;
  const now = Date.now();
  await tasksRepo(em).insert(
    items.map((item, index) => ({
      staffId: staff.id,
      title: item.title,
      dueOn: addDays(staff.startDate, item.dueInDays),
      createdAt: new Date(now + index),
    }))
  );
};

export const listTasksFor = (staffId: string): Promise<StaffChecklistTask[]> =>
  tasksRepo().find({ where: { staffId }, order: CHECKLIST_ORDER });

export const getChecklistDefaults = async (
  userId: string,
  organizationId: string
): Promise<ChecklistItem[]> => checklistOf(await assertCanManagePeople(userId, organizationId));

export const setChecklistDefaults = async (
  userId: string,
  organizationId: string,
  items: ChecklistItem[]
): Promise<ChecklistItem[]> => {
  await assertCanManagePeople(userId, organizationId);
  await AppDataSource.getRepository(Organization).update(organizationId, {
    defaultChecklist: items,
  });
  return items;
};

export const listTasks = async (
  actor: User,
  organizationId: string,
  staffId: string
): Promise<StaffChecklistTask[]> => {
  await assertCanManagePeople(actor.id, organizationId);
  await findStaff(organizationId, staffId);
  return listTasksFor(staffId);
};

export const addTask = async (
  actor: User,
  organizationId: string,
  staffId: string,
  input: { title: string; dueOn: string | null }
): Promise<StaffChecklistTask> => {
  await assertCanManagePeople(actor.id, organizationId);
  await findStaff(organizationId, staffId);
  return tasksRepo().save(tasksRepo().create({ staffId, ...input }));
};

export const deleteTask = async (
  actor: User,
  organizationId: string,
  staffId: string,
  taskId: string
): Promise<void> => {
  await assertCanManagePeople(actor.id, organizationId);
  await findStaff(organizationId, staffId);
  const result = await tasksRepo().delete({ id: taskId, staffId });
  if (!result.affected) {
    throw new NotFoundError("Task not found");
  }
};
