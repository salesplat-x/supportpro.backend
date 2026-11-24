import { EntityManager } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Department } from "../entities/Department.js";
import { resultRows } from "../utils/durableJobs.js";
import { ConflictError } from "../utils/errors";
import { assertCanManagePeople } from "./peopleAccess.js";

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
