import { EntityManager } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { StaffChecklistTask, TASK_OWNERS, type TaskOwner } from "../entities/StaffChecklistTask.js";
import { StaffMember } from "../entities/StaffMember.js";
import type { User } from "../entities/User.js";
import { NotFoundError } from "../utils/errors";
import { deleteEvidenceQuietly, evidenceKeysFor } from "./completionRequests.js";
import { assertCanManagePeople, assertCanViewStaff } from "./peopleAccess.js";
import { findStaff } from "./staffRecord.js";

export interface ChecklistItem {
  title: string;
  dueInDays: number;
  description?: string | null;
  owner?: TaskOwner | null;
}

export type TaskStatus = "done" | "late" | "not_done";

export interface TaskView extends StaffChecklistTask {
  status: TaskStatus;
  ownerName: string | null;
}

const OWNER_LABEL: Record<TaskOwner, string> = {
  it: "IT",
  new_hire: "The new hire",
  manager: "The manager",
  hr: "HR",
};

const DAY_MS = 86_400_000;

export const DEFAULT_CHECKLIST: ChecklistItem[] = [
  {
    title: "Set up IT accounts and laptop",
    dueInDays: 0,
    description: "IT hands it over",
    owner: "it",
  },
  {
    title: "Hand over the welcome pack",
    dueInDays: 0,
    description: "Welcome pack PDF",
    owner: "hr",
  },
  {
    title: "Share the first-week schedule",
    dueInDays: 0,
    description: "30 minute intro call",
    owner: "manager",
  },
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
      description: item.description ?? null,
      owner: item.owner ?? null,
      dueOn: addDays(staff.startDate, item.dueInDays),
      createdAt: new Date(now + index),
    }))
  );
};

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

export const taskStatusOf = (task: Pick<StaffChecklistTask, "doneAt" | "dueOn">): TaskStatus => {
  if (task.doneAt) return "done";
  return task.dueOn && task.dueOn < todayUtc() ? "late" : "not_done";
};

const ownerNameOf = (
  task: StaffChecklistTask,
  staff: Pick<StaffMember, "fullName">,
  managerName: string | null
): string | null => {
  if (!task.owner) return null;
  if (task.owner === "new_hire") return staff.fullName;
  if (task.owner === "manager") return managerName ?? OWNER_LABEL.manager;
  return OWNER_LABEL[task.owner];
};

export const toTaskViews = async (
  tasks: StaffChecklistTask[],
  staff: Pick<StaffMember, "fullName" | "managerId">
): Promise<TaskView[]> => {
  const manager = staff.managerId
    ? await AppDataSource.getRepository(StaffMember).findOne({
        where: { id: staff.managerId },
        select: { id: true, fullName: true },
      })
    : null;
  return tasks.map((task) =>
    Object.assign(task, {
      status: taskStatusOf(task),
      ownerName: ownerNameOf(task, staff, manager?.fullName ?? null),
    })
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
): Promise<TaskView[]> => {
  await assertCanViewStaff(actor.id, organizationId, staffId);
  const staff = await findStaff(organizationId, staffId);
  return toTaskViews(await listTasksFor(staffId), staff);
};

export const addTask = async (
  actor: User,
  organizationId: string,
  staffId: string,
  input: {
    title: string;
    dueOn: string | null;
    description?: string | null;
    owner?: TaskOwner | null;
  }
): Promise<TaskView> => {
  await assertCanManagePeople(actor.id, organizationId);
  const staff = await findStaff(organizationId, staffId);
  const saved = await tasksRepo().save(
    tasksRepo().create({
      staffId,
      title: input.title,
      dueOn: input.dueOn,
      description: input.description ?? null,
      owner: input.owner ?? null,
    })
  );
  const [view] = await toTaskViews([saved], staff);
  return view!;
};

export const isTaskOwner = (value: unknown): value is TaskOwner =>
  typeof value === "string" && (TASK_OWNERS as readonly string[]).includes(value);

export const deleteTask = async (
  actor: User,
  organizationId: string,
  staffId: string,
  taskId: string
): Promise<void> => {
  await assertCanManagePeople(actor.id, organizationId);
  const evidence = await AppDataSource.transaction(async (em) => {
    await findStaff(organizationId, staffId, { em, lock: true });
    const keys = await evidenceKeysFor({ taskId }, em);
    const result = await em.getRepository(StaffChecklistTask).delete({ id: taskId, staffId });
    if (!result.affected) {
      throw new NotFoundError("Task not found");
    }
    return keys;
  });
  await deleteEvidenceQuietly(evidence);
};
