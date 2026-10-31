import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { StaffChecklistTask, StaffMember } from "../src/entities";
import { apiData } from "./helpers/http.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { createStaff, staffPath } from "./helpers/staff.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  })),
}));

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
});

interface RowResult {
  row: number;
  email: string;
  error: string | null;
}

const row = (index: number, overrides: Record<string, unknown> = {}) => ({
  fullName: `Person ${index}`,
  email: `person${index}@example.com`,
  jobTitle: "Analyst",
  department: "Finance",
  managerEmail: "",
  startDate: "2026-02-01",
  ...overrides,
});

const importRows = (token: string, orgId: string, rows: unknown[], commit: boolean) =>
  request(app).post(staffPath(orgId, "/import")).set(authHeader(token)).send({ rows, commit });

describe("staff import", () => {
  it("previews problems, imports the good rows and links managers from the file", async () => {
    const { owner, org } = await setupCompany();
    await createStaff(app, owner.token, org.id, { email: "taken@example.com" });
    const rows = [
      ...Array.from({ length: 10 }, (_, index) =>
        row(index, { managerEmail: index === 0 ? "" : "person0@example.com" })
      ),
      row(10, { email: "not-an-email" }),
      row(11, { email: "taken@example.com" }),
      row(12, { managerEmail: "nobody@example.com" }),
      row(13, { email: "person1@example.com" }),
    ];

    const preview = apiData<{ rows: RowResult[] }>(
      await importRows(owner.token, org.id, rows, false)
    );
    expect(
      preview.rows.filter((result) => result.error).map((result) => [result.row, result.error])
    ).toEqual([
      [11, "A valid email is required"],
      [12, "Email already added"],
      [13, "Manager email not found"],
      [14, "This email appears more than once in the file"],
    ]);
    expect(await testDataSource.getRepository(StaffMember).count()).toBe(1);

    const result = apiData<{ added: number; skipped: RowResult[] }>(
      await importRows(owner.token, org.id, rows, true)
    );
    expect(result.added).toBe(10);
    expect(result.skipped).toHaveLength(4);

    const repo = testDataSource.getRepository(StaffMember);
    const lead = await repo.findOneOrFail({ where: { email: "person0@example.com" } });
    expect(await repo.count({ where: { managerId: lead.id } })).toBe(9);
    expect(await testDataSource.getRepository(StaffChecklistTask).count()).toBe(33);

    const again = apiData<{ added: number }>(await importRows(owner.token, org.id, rows, true));
    expect(again.added).toBe(0);
    expect(await repo.count()).toBe(11);
  });

  it("refuses a reporting loop and a person managing themselves", async () => {
    const { owner, org } = await setupCompany();
    const preview = apiData<{ rows: RowResult[] }>(
      await importRows(
        owner.token,
        org.id,
        [
          row(1, { managerEmail: "person2@example.com" }),
          row(2, { managerEmail: "person1@example.com" }),
          row(3, { managerEmail: "person3@example.com" }),
        ],
        false
      )
    );
    expect(preview.rows.map((result) => result.error)).toEqual([
      "The reporting line loops back to this person",
      "The reporting line loops back to this person",
      "A person can't be their own manager",
    ]);
  });

  it("is only for people with access and exports everyone with their manager's email", async () => {
    const { owner, org } = await setupCompany();
    const plain = await addMember(org);
    expect((await importRows(plain.token, org.id, [row(1)], false)).status).toBe(403);
    expect(
      (await request(app).get(staffPath(org.id, "/export")).set(authHeader(plain.token))).status
    ).toBe(403);

    await importRows(
      owner.token,
      org.id,
      [row(1), row(2, { managerEmail: "person1@example.com" })],
      true
    ).expect(200);
    const { staff } = apiData<{ staff: Array<{ email: string; managerEmail: string | null }> }>(
      await request(app).get(staffPath(org.id, "/export")).set(authHeader(owner.token))
    );
    expect(staff).toEqual([
      expect.objectContaining({
        email: "person1@example.com",
        managerEmail: null,
        startDate: "2026-02-01",
      }),
      expect.objectContaining({
        email: "person2@example.com",
        managerEmail: "person1@example.com",
      }),
    ]);
  });
});
