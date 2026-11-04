import request from "supertest";
import { StaffMember } from "../../src/entities";
import { StaffStatus } from "../../src/entities/StaffMember.js";
import { authHeader, setupCompany } from "./company.js";
import { testDataSource } from "./db.js";
import { createTalent } from "./fixtures.js";
import { type App, createStaff, staffPath } from "./staff.js";

export const linkAccount = (staffId: string, userId: string) =>
  testDataSource.getRepository(StaffMember).update(staffId, { userId, status: StaffStatus.Active });

export async function employee(
  app: App,
  ownerToken: string,
  orgId: string,
  fullName: string,
  overrides: Record<string, unknown> = {}
) {
  const talent = await createTalent();
  const staff = await createStaff(app, ownerToken, orgId, {
    fullName,
    startDate: "2026-01-05",
    ...overrides,
  });
  await linkAccount(staff.id, talent.user.id);
  return { ...talent, staff };
}

/** Owner, a manager with an account, their direct report, a skip-level boss, and an unrelated colleague. */
export async function companyWithTeam() {
  const { owner, org } = await setupCompany();
  return {
    owner,
    org,
    build: async (app: App) => {
      const boss = await employee(app, owner.token, org.id, "Bola Boss");
      const manager = await employee(app, owner.token, org.id, "Mo Manager", {
        managerId: boss.staff.id,
      });
      const report = await employee(app, owner.token, org.id, "Ada Obi", {
        managerId: manager.staff.id,
      });
      const colleague = await employee(app, owner.token, org.id, "Bayo Lawal");
      return { boss, manager, report, colleague };
    },
  };
}

export const endStaff = (
  app: App,
  token: string,
  orgId: string,
  staffId: string,
  endDate: string
) =>
  request(app)
    .post(staffPath(orgId, `/${staffId}/end`))
    .set(authHeader(token))
    .send({ endDate })
    .expect(200);
