import request from "supertest";
import { createApp } from "../src/app.js";
import { startTestDatabase, stopTestDatabase, clearAllTables } from "./helpers/db.js";
import { apiData } from "./helpers/http.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { staffPath } from "./helpers/staff.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  extractCompanyProfile: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        mission: " Payroll that just works for African SMEs. ",
        vision: null,
        yearlyGoals: ["Reach 500 customers", "", "Launch in Ghana"],
      }),
    },
  }),
}));

jest.mock("../src/utils/text.js", () => ({
  ...jest.requireActual("../src/utils/text.js"),
  extractText: jest.fn().mockResolvedValue("Acme Ltd builds payroll software."),
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

const upload = (token: string, orgId: string, contentType: string) =>
  request(app)
    .post(staffPath(orgId, "/company-profile/extract"))
    .set(authHeader(token))
    .attach("file", Buffer.from("document"), { filename: "profile.pdf", contentType });

describe("company profile", () => {
  it("fills the fields from a document without saving them, then saves what HR checked", async () => {
    const { owner, org } = await setupCompany();

    const filled = apiData<{ profile: unknown }>(
      await upload(owner.token, org.id, "application/pdf").expect(200)
    ).profile;
    expect(filled).toEqual({
      mission: "Payroll that just works for African SMEs.",
      vision: null,
      yearlyGoals: ["Reach 500 customers", "Launch in Ghana"],
    });
    const stored = () =>
      request(app).get(staffPath(org.id, "/company-profile")).set(authHeader(owner.token));
    expect(
      apiData<{ profile: { mission: string | null } }>(await stored()).profile.mission
    ).toBeNull();

    await request(app)
      .put(staffPath(org.id, "/company-profile"))
      .set(authHeader(owner.token))
      .send({
        mission: "Payroll for SMEs",
        vision: "Every SME paid on time",
        yearlyGoals: ["Grow"],
      })
      .expect(200);
    expect(apiData<{ profile: unknown }>(await stored()).profile).toEqual({
      mission: "Payroll for SMEs",
      vision: "Every SME paid on time",
      yearlyGoals: ["Grow"],
    });
  });

  it("refuses other file types and people without access", async () => {
    const { org, owner } = await setupCompany();
    const plain = await addMember(org);

    expect((await upload(owner.token, org.id, "text/plain")).status).toBe(400);
    expect((await upload(plain.token, org.id, "application/pdf")).status).toBe(403);
  });
});
