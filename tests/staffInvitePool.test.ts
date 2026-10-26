/**
 * Sending an invite keeps a transaction open while it checks the company team, so a burst of
 * invites larger than the connection pool must still finish. Kept in its own file because a
 * deadlocked pool would hang every other test sharing the database.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { StaffMember } from "../src/entities";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { createStaff, staffPath } from "./helpers/staff.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => {
  const sendStaffInvite = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      sendWelcome: jest.fn().mockResolvedValue(undefined),
      sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
      sendCompanyInvite: jest.fn().mockResolvedValue(undefined),
      sendStaffInvite,
    })),
    sendStaffInvite,
  };
});

const BURST = 20;
const GIVE_UP_MS = 30_000;

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
});

describe("a burst of invites", () => {
  it("finishes even when it is larger than the connection pool", async () => {
    const { org } = await setupCompany();
    const hr = await addMember(org, { canManagePeople: true });
    const people = [];
    for (let i = 0; i < BURST; i++) {
      people.push(await createStaff(app, hr.token, org.id));
    }

    let giveUp: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      Promise.all(
        people.map((person) =>
          request(app)
            .post(staffPath(org.id, `/${person.id}/invite`))
            .set(authHeader(hr.token))
            .send({})
        )
      ),
      new Promise<"stuck">((resolve) => {
        giveUp = setTimeout(() => resolve("stuck"), GIVE_UP_MS);
      }),
    ]);
    clearTimeout(giveUp);

    expect(outcome).not.toBe("stuck");
    if (outcome === "stuck") return;
    expect(outcome.map((res) => res.status)).toEqual(Array(BURST).fill(200));
    expect(
      await testDataSource.getRepository(StaffMember).countBy({ organizationId: org.id })
    ).toBe(BURST);
  }, 60_000);
});
