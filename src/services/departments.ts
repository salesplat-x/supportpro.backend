import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { resultRows } from "../utils/durableJobs.js";
import { ConflictError } from "../utils/errors";
import { assertCanManagePeople } from "./peopleAccess.js";

export const MAX_DEPARTMENTS = 50;
export const MAX_DEPARTMENT_LENGTH = 60;

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const ADD_DEPARTMENT_SQL = `
  UPDATE "organizations"
  SET "departments" = "departments" || jsonb_build_array($2::text)
  WHERE "id" = $1
    AND jsonb_array_length("departments") < ${MAX_DEPARTMENTS}
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text("departments") AS d(name)
      WHERE lower(d.name) = lower($2)
    )
  RETURNING "departments"
`;

const REMOVE_DEPARTMENT_SQL = `
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

const departmentsOf = (result: unknown): string[] | null => {
  const row = resultRows(result)[0] as { departments: string[] } | undefined;
  return row ? row.departments : null;
};

export const addDepartment = async (
  userId: string,
  organizationId: string,
  name: string
): Promise<string[]> => {
  await assertCanManagePeople(userId, organizationId);

  const added = departmentsOf(
    await AppDataSource.query(ADD_DEPARTMENT_SQL, [organizationId, name])
  );
  if (added) return added;

  const { departments } = await AppDataSource.getRepository(Organization).findOneByOrFail({
    id: organizationId,
  });
  if (departments.some((existing) => sameName(existing, name))) {
    throw new ConflictError(`${name} is already a department`);
  }
  throw new ConflictError(`A company can have at most ${MAX_DEPARTMENTS} departments`);
};

export const removeDepartment = async (
  userId: string,
  organizationId: string,
  name: string
): Promise<string[]> => {
  await assertCanManagePeople(userId, organizationId);
  return (
    departmentsOf(await AppDataSource.query(REMOVE_DEPARTMENT_SQL, [organizationId, name])) ?? []
  );
};
