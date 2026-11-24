import { EntityManager, IsNull } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Department } from "../entities/Department.js";
import { Notification } from "../entities/Notification.js";
import { StaffActivityType } from "../entities/StaffActivity.js";
import { StaffMember } from "../entities/StaffMember.js";
import type { User } from "../entities/User.js";
import { resultRows } from "../utils/durableJobs.js";
import { ConflictError, NotFoundError } from "../utils/errors";
import { assertCanManagePeople, assertCompanyMember, assertOwner } from "./peopleAccess.js";
import { activityEntry, recordActivities } from "./staffAudit.js";

export const NOTIFICATION_TYPE_DEPARTMENT_HEAD = "department_head";
const MY_TEAM_LINK = "/talentDashboard/my-work";

export const MAX_DEPARTMENTS = 50;
export const MAX_DEPARTMENT_LENGTH = 60;

const APPEND_NAME_SQL = `
  UPDATE "organizations"
  SET "departments" = "departments" || jsonb_build_array($2::text)
  WHERE "id" = $1
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text("departments") AS d(name)
      WHERE lower(d.name) = lower($2)
    )
`;

const REMOVE_NAME_SQL = `
  UPDATE "organizations"
  SET "departments" = COALESCE(
    (
      SELECT jsonb_agg(d.name ORDER BY d.i)
      FROM jsonb_array_elements_text("departments") WITH ORDINALITY AS d(name, i)
      WHERE lower(d.name) <> lower($2)
    ),
    '[]'::jsonb
  )
  WHERE "id" = $1
  RETURNING "departments"
`;

const CLEAR_STAFF_SQL = `
  UPDATE "staff_members"
  SET "department_id" = NULL, "department" = NULL
  WHERE "organization_id" = $1
    AND ("department_id" = $2 OR ("department_id" IS NULL AND lower("department") = lower($3)))
`;

const fullError = () =>
  new ConflictError(`A company can have at most ${MAX_DEPARTMENTS} departments`);

const findByName = (em: EntityManager, organizationId: string, name: string) =>
  em
    .getRepository(Department)
    .createQueryBuilder("department")
    .where("department.organizationId = :organizationId", { organizationId })
    .andWhere("lower(department.name) = lower(:name)", { name })
    .getOne();

const listNames = async (em: EntityManager, organizationId: string): Promise<string[]> => {
  const rows: Array<{ departments: string[] }> = await em.query(
    `SELECT "departments" FROM "organizations" WHERE "id" = $1`,
    [organizationId]
  );
  return rows[0]?.departments ?? [];
};

/**
 * Finds the department in any letter case, or creates it. The company row is locked first, so
 * two people adding "Sales" and "sales" at once end up with one department. The company's name
 * list is kept in step because `/organizations/me` and older clients still read it.
 */
const findOrCreate = async (
  em: EntityManager,
  organizationId: string,
  name: string
): Promise<{ department: Department; created: boolean }> => {
  await em.query(`SELECT 1 FROM "organizations" WHERE "id" = $1 FOR UPDATE`, [organizationId]);
  const existing = await findByName(em, organizationId, name);
  if (existing) return { department: existing, created: false };
  if ((await em.getRepository(Department).countBy({ organizationId })) >= MAX_DEPARTMENTS) {
    throw fullError();
  }
  const department = await em.getRepository(Department).save({ organizationId, name });
  await em.query(APPEND_NAME_SQL, [organizationId, name]);
  return { department, created: true };
};

/** The department a staff write names, created if it's new. Blank means no department. */
export const resolveDepartment = async (
  em: EntityManager,
  organizationId: string,
  name: string | null | undefined
): Promise<Department | null> => {
  const clean = name?.trim();
  if (!clean) return null;
  return (
    (await findByName(em, organizationId, clean)) ??
    (await findOrCreate(em, organizationId, clean)).department
  );
};

export const addDepartment = async (
  userId: string,
  organizationId: string,
  name: string
): Promise<{ departments: string[]; department: Department }> => {
  await assertCanManagePeople(userId, organizationId);
  return AppDataSource.transaction(async (em) => {
    const { department, created } = await findOrCreate(em, organizationId, name);
    if (!created) throw new ConflictError(`${name} is already a department`);
    return { departments: await listNames(em, organizationId), department };
  });
};

/**
 * Removing a department leaves its people with none. Staff rows are updated before the company
 * row is locked, the same order staff updates take, so the two can't deadlock.
 */
export const removeDepartment = async (
  userId: string,
  organizationId: string,
  name: string
): Promise<string[]> => {
  await assertCanManagePeople(userId, organizationId);
  return AppDataSource.transaction(async (em) => {
    const department = await findByName(em, organizationId, name);
    await em.query(CLEAR_STAFF_SQL, [organizationId, department?.id ?? null, name]);
    const rows = resultRows(await em.query(REMOVE_NAME_SQL, [organizationId, name])) as Array<{
      departments: string[];
    }>;
    if (department) await em.getRepository(Department).delete({ id: department.id });
    return rows[0]?.departments ?? [];
  });
};

export interface DepartmentView {
  id: string;
  name: string;
  head: { staffId: string; fullName: string } | null;
  staffCount: number;
}

/** Every department with its head and how many current people are in it. */
export const listDepartments = async (
  userId: string,
  organizationId: string
): Promise<DepartmentView[]> => {
  await assertCompanyMember(userId, organizationId);
  const rows: Array<{
    id: string;
    name: string;
    head_staff_id: string | null;
    head_name: string | null;
    staff_count: number;
  }> = await AppDataSource.query(
    `SELECT d.id, d.name, d.head_staff_id, h.full_name AS head_name,
            (SELECT COUNT(*)::int FROM staff_members s
             WHERE s.department_id = d.id AND s.end_date IS NULL) AS staff_count
     FROM departments d
     LEFT JOIN staff_members h ON h.id = d.head_staff_id
     WHERE d.organization_id = $1
     ORDER BY d.created_at, d.name`,
    [organizationId]
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    head:
      row.head_staff_id && row.head_name
        ? { staffId: row.head_staff_id, fullName: row.head_name }
        : null,
    staffCount: row.staff_count,
  }));
};

/**
 * Makes an employee the head of a department, or clears it. Heads get the same tools a manager
 * has for everyone in the department, so only the company's creator can choose them. The
 * person's row is locked before the department's, the order `endStaff` uses.
 */
export const setDepartmentHead = async (
  actor: User,
  organizationId: string,
  departmentId: string,
  staffId: string | null
): Promise<Department> => {
  await assertOwner(actor.id, organizationId);
  return AppDataSource.transaction(async (em) => {
    const head = staffId
      ? await em.getRepository(StaffMember).findOne({
          where: { id: staffId, organizationId, endDate: IsNull() },
          lock: { mode: "pessimistic_write" },
        })
      : null;
    if (staffId && !head) {
      throw new NotFoundError("Staff member not found");
    }
    const department = await em.getRepository(Department).findOne({
      where: { id: departmentId, organizationId },
      lock: { mode: "pessimistic_write" },
    });
    if (!department) {
      throw new NotFoundError("Department not found");
    }
    if (department.headStaffId === (head?.id ?? null)) {
      return department;
    }

    const previous = department.headStaffId
      ? await em.getRepository(StaffMember).findOneBy({ id: department.headStaffId })
      : null;
    department.headStaffId = head?.id ?? null;
    const saved = await em.getRepository(Department).save(department);

    if (previous) {
      await recordActivities(em, previous, [
        activityEntry(StaffActivityType.DepartmentHeadRemoved, actor, {
          department: department.name,
        }),
      ]);
    }
    if (head) {
      await recordActivities(em, head, [
        activityEntry(StaffActivityType.DepartmentHeadAssigned, actor, {
          department: department.name,
        }),
      ]);
      if (head.userId) {
        await em.getRepository(Notification).save(
          em.getRepository(Notification).create({
            userId: head.userId,
            title: `You now head ${department.name}`,
            message: `You can see everyone in ${department.name} and manage their goals and reports from My team.`,
            type: NOTIFICATION_TYPE_DEPARTMENT_HEAD,
            link: MY_TEAM_LINK,
            organizationId: null,
          })
        );
      }
    }
    return saved;
  });
};

/** Run inside `endStaff`'s transaction, after the person's row is locked. */
export const clearHeadships = (em: EntityManager, staffId: string) =>
  em.getRepository(Department).update({ headStaffId: staffId }, { headStaffId: null });
