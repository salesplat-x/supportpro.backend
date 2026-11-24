import { EntityManager, In, IsNull } from "typeorm";
import { validationResult } from "express-validator";
import { AppDataSource } from "../database/dataSource.js";
import type { Department } from "../entities/Department.js";
import { StaffActivityType } from "../entities/StaffActivity.js";
import { StaffMember, StaffStatus } from "../entities/StaffMember.js";
import type { User } from "../entities/User.js";
import { importRowValidator } from "../validators/staff.js";
import { ConflictError } from "../utils/errors";
import { copyDefaultChecklist } from "./checklist.js";
import { resolveDepartment } from "./departments.js";
import { assertCanManagePeople } from "./peopleAccess.js";
import { lockHierarchy } from "./staff.js";
import { activityEntry, recordActivities } from "./staffAudit.js";

interface ImportRow {
  fullName: string;
  email: string;
  jobTitle: string;
  department: string | null;
  managerEmail: string | null;
  startDate: string;
}

interface CheckedRow {
  row: number;
  value: ImportRow;
  error: string | null;
}

export interface ImportRowResult {
  row: number;
  fullName: string;
  email: string;
  error: string | null;
}

export interface StaffExportRow {
  fullName: string;
  email: string;
  jobTitle: string;
  department: string | null;
  managerEmail: string | null;
  startDate: string;
  status: StaffStatus;
  hiredThroughAuxhr: boolean;
}

const ALREADY_ADDED = "Email already added";

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

const checkFields = async (raw: unknown, index: number): Promise<CheckedRow> => {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const req = {
    body: {
      fullName: source["fullName"],
      email: source["email"],
      jobTitle: source["jobTitle"],
      department: source["department"] ?? null,
      managerEmail: source["managerEmail"] || null,
      startDate: source["startDate"],
    },
  };
  for (const chain of importRowValidator) {
    await chain.run(req);
  }
  const errors = validationResult(req).array();
  return {
    row: index + 1,
    value: {
      fullName: asText(req.body.fullName),
      email: asText(req.body.email),
      jobTitle: asText(req.body.jobTitle),
      department: asText(req.body.department).trim() || null,
      managerEmail: asText(req.body.managerEmail) || null,
      startDate: asText(req.body.startDate),
    },
    error: errors.length > 0 ? (errors[0]!.msg as string) : null,
  };
};

const reportsLoop = (email: string, managerOf: Map<string, string | null>): boolean => {
  const seen = new Set<string>([email]);
  let next = managerOf.get(email) ?? null;
  while (next && managerOf.has(next)) {
    if (seen.has(next)) return true;
    seen.add(next);
    next = managerOf.get(next) ?? null;
  }
  return false;
};

const checkRows = async (
  em: EntityManager,
  organizationId: string,
  rawRows: unknown[]
): Promise<{ checked: CheckedRow[]; openStaffByEmail: Map<string, string> }> => {
  const checked = await Promise.all(rawRows.map(checkFields));
  const emails = checked.flatMap(({ value }) =>
    [value.email, value.managerEmail].filter((email): email is string => !!email)
  );
  const openStaff = emails.length
    ? await em.getRepository(StaffMember).find({
        where: { organizationId, email: In(emails), endDate: IsNull() },
        select: { id: true, email: true },
      })
    : [];
  const openStaffByEmail = new Map(openStaff.map((staff) => [staff.email, staff.id]));

  const seenEmails = new Set<string>();
  for (const row of checked) {
    if (row.error) continue;
    if (seenEmails.has(row.value.email)) {
      row.error = "This email appears more than once in the file";
    } else if (openStaffByEmail.has(row.value.email)) {
      row.error = ALREADY_ADDED;
    } else if (row.value.managerEmail === row.value.email) {
      row.error = "A person can't be their own manager";
    }
    seenEmails.add(row.value.email);
  }

  let changed = true;
  while (changed) {
    changed = false;
    const ready = checked.filter((row) => !row.error);
    const managerOf = new Map(ready.map((row) => [row.value.email, row.value.managerEmail]));
    for (const row of ready) {
      const manager = row.value.managerEmail;
      const problem = !manager
        ? null
        : !managerOf.has(manager) && !openStaffByEmail.has(manager)
          ? "Manager email not found"
          : reportsLoop(row.value.email, managerOf)
            ? "The reporting line loops back to this person"
            : null;
      if (problem) {
        row.error = problem;
        changed = true;
      }
    }
  }
  return { checked, openStaffByEmail };
};

const toResult = ({ row, value, error }: CheckedRow): ImportRowResult => ({
  row,
  fullName: value.fullName,
  email: value.email,
  error,
});

export const previewImport = async (
  actor: User,
  organizationId: string,
  rows: unknown[]
): Promise<{ rows: ImportRowResult[] }> => {
  await assertCanManagePeople(actor.id, organizationId);
  const { checked } = await checkRows(AppDataSource.manager, organizationId, rows);
  return { rows: checked.map(toResult) };
};

const departmentFor = (departments: Map<string, Department>, name: string | null) =>
  name?.trim() ? departments.get(name.trim().toLowerCase()) : undefined;

/** Each department named in the file, matched in any letter case or created; rows naming one past the limit fail. */
const resolveImportDepartments = async (
  em: EntityManager,
  organizationId: string,
  rows: CheckedRow[]
): Promise<Map<string, Department>> => {
  const departments = new Map<string, Department>();
  for (const row of rows) {
    const name = row.value.department?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (departments.has(key)) continue;
    try {
      const department = await resolveDepartment(em, organizationId, name);
      if (department) departments.set(key, department);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      row.error = error.message;
    }
  }
  return departments;
};

export const commitImport = async (
  actor: User,
  organizationId: string,
  rows: unknown[]
): Promise<{ added: number; skipped: ImportRowResult[] }> => {
  const org = await assertCanManagePeople(actor.id, organizationId);
  return AppDataSource.transaction(async (em) => {
    await lockHierarchy(em, organizationId);
    const { checked, openStaffByEmail } = await checkRows(em, organizationId, rows);
    const departments = await resolveImportDepartments(
      em,
      organizationId,
      checked.filter((row) => !row.error)
    );
    const ready = checked.filter((row) => !row.error);

    const inserted: Array<{ id: string; email: string }> = ready.length
      ? (
          await em
            .createQueryBuilder()
            .insert()
            .into(StaffMember)
            .values(
              ready.map(({ value }) => ({
                organizationId,
                fullName: value.fullName,
                email: value.email,
                jobTitle: value.jobTitle,
                department: departmentFor(departments, value.department)?.name ?? null,
                departmentId: departmentFor(departments, value.department)?.id ?? null,
                startDate: value.startDate,
                status: StaffStatus.Active,
                hiredThroughAuxhr: false,
                isExecutive: false,
                createdById: actor.id,
              }))
            )
            .orIgnore()
            .returning(["id", "email"])
            .execute()
        ).raw
      : [];

    const idByEmail = new Map([
      ...openStaffByEmail,
      ...inserted.map((row): [string, string] => [row.email, row.id]),
    ]);
    const insertedEmails = new Set(inserted.map((row) => row.email));
    const managed = ready.filter(
      (row) => insertedEmails.has(row.value.email) && row.value.managerEmail
    );
    if (managed.length > 0) {
      await em.query(
        `UPDATE staff_members AS s SET manager_id = v.manager_id
         FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::uuid[]) AS manager_id) AS v
         WHERE s.id = v.id`,
        [
          managed.map((row) => idByEmail.get(row.value.email)),
          managed.map((row) => idByEmail.get(row.value.managerEmail!)),
        ]
      );
    }

    const startDateByEmail = new Map(ready.map(({ value }) => [value.email, value.startDate]));
    for (const row of inserted) {
      const staff = { id: row.id, organizationId, startDate: startDateByEmail.get(row.email)! };
      await copyDefaultChecklist(em, org, staff);
      await recordActivities(em, staff, [
        activityEntry(StaffActivityType.Created, actor, { source: "import" }),
      ]);
    }

    const skipped = checked
      .map((row) =>
        !row.error && !insertedEmails.has(row.value.email) ? { ...row, error: ALREADY_ADDED } : row
      )
      .filter((row) => row.error)
      .map(toResult);
    return { added: inserted.length, skipped };
  });
};

export const exportStaff = async (
  userId: string,
  organizationId: string
): Promise<StaffExportRow[]> => {
  await assertCanManagePeople(userId, organizationId);
  const rows: Array<Record<string, string | boolean | null>> = await AppDataSource.query(
    `SELECT s.full_name, s.email, s.job_title, s.department, m.email AS manager_email,
            to_char(s.start_date, 'YYYY-MM-DD') AS start_date, s.status, s.hired_through_auxhr
     FROM staff_members s
     LEFT JOIN staff_members m ON m.id = s.manager_id
     WHERE s.organization_id = $1
     ORDER BY s.full_name, s.created_at`,
    [organizationId]
  );
  return rows.map((row) => ({
    fullName: row["full_name"] as string,
    email: row["email"] as string,
    jobTitle: row["job_title"] as string,
    department: row["department"] as string | null,
    managerEmail: row["manager_email"] as string | null,
    startDate: row["start_date"] as string,
    status: row["status"] as StaffStatus,
    hiredThroughAuxhr: row["hired_through_auxhr"] as boolean,
  }));
};
