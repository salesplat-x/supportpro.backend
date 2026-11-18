import request from "supertest";
import type { createApp } from "../../src/app.js";
import { authHeader } from "./company.js";
import { apiData } from "./http.js";

export type App = ReturnType<typeof createApp>;

export interface StaffViewShape {
  id: string;
  fullName: string;
  email: string;
  jobTitle: string;
  department: string | null;
  managerId: string | null;
  managerName: string | null;
  startDate: string;
  endDate: string | null;
  status: "invited" | "active" | "ended";
  hiredThroughAuxhr: boolean;
  isExecutive: boolean;
  phone: string | null;
  homeAddress: string | null;
  hasAccount: boolean;
  invite: {
    state: "none" | "pending" | "expired" | "accepted";
    invitedByName: string | null;
    invitedAt: string | null;
    expiresAt: string | null;
    joinedAt: string | null;
  };
}

export const staffPath = (orgId: string, suffix = "") =>
  `/v1/organizations/${orgId}/staff${suffix}`;

export const today = () => new Date().toISOString().slice(0, 10);

let counter = 0;

export const staffBody = (overrides: Record<string, unknown> = {}) => ({
  fullName: "Ada Obi",
  email: `staff_${++counter}_${Date.now()}@example.com`,
  jobTitle: "Product Designer",
  department: "Design",
  startDate: "2026-01-05",
  ...overrides,
});

export function postStaff(
  app: App,
  token: string,
  orgId: string,
  overrides: Record<string, unknown> = {}
) {
  return request(app).post(staffPath(orgId)).set(authHeader(token)).send(staffBody(overrides));
}

export async function createStaff(
  app: App,
  token: string,
  orgId: string,
  overrides: Record<string, unknown> = {}
): Promise<StaffViewShape> {
  const res = await postStaff(app, token, orgId, overrides);
  expect(res.status).toBe(201);
  return apiData<{ staff: StaffViewShape }>(res).staff;
}

export function setPay(
  app: App,
  token: string,
  orgId: string,
  staffId: string,
  overrides: Record<string, unknown> = {}
) {
  return request(app)
    .put(staffPath(orgId, `/${staffId}/pay`))
    .set(authHeader(token))
    .send({
      currency: "NGN",
      period: "monthly",
      baseSalary: 400000,
      bonusPerYear: 0,
      commissionTargetPerYear: 0,
      startsOn: "2026-01-05",
      ...overrides,
    });
}
