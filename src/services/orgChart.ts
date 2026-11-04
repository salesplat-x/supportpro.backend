import { AppDataSource } from "../database/dataSource.js";
import { assertCanManagePeople } from "./peopleAccess.js";

const MAX_PEOPLE = 5000;

export interface OrgChartPerson {
  id: string;
  fullName: string;
  jobTitle: string;
  department: string | null;
  managerId: string | null;
  managerLeft: boolean;
}

/** Holds no private data, so like the staff list it is not written to the access log. */
export const getOrgChart = async (
  userId: string,
  organizationId: string
): Promise<{ people: OrgChartPerson[]; truncated: boolean }> => {
  await assertCanManagePeople(userId, organizationId);
  const rows: Array<{
    id: string;
    full_name: string;
    job_title: string;
    department: string | null;
    manager_id: string | null;
    manager_end_date: string | null;
  }> = await AppDataSource.query(
    `SELECT s.id, s.full_name, s.job_title, s.department, s.manager_id,
            m.end_date AS manager_end_date
     FROM staff_members s
     LEFT JOIN staff_members m ON m.id = s.manager_id
     WHERE s.organization_id = $1 AND s.end_date IS NULL
     ORDER BY s.full_name, s.id
     LIMIT $2`,
    [organizationId, MAX_PEOPLE + 1]
  );
  return {
    truncated: rows.length > MAX_PEOPLE,
    people: rows.slice(0, MAX_PEOPLE).map((row) => {
      const managerLeft = !!row.manager_id && !!row.manager_end_date;
      return {
        id: row.id,
        fullName: row.full_name,
        jobTitle: row.job_title,
        department: row.department,
        managerId: managerLeft ? null : row.manager_id,
        managerLeft,
      };
    }),
  };
};
