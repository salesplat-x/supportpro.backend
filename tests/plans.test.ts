/**
 * Plan CRUD tests — Admin-only management, public read access.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import { startTestDatabase, stopTestDatabase, clearAllTables, testDataSource } from "./helpers/db.js";
import { createTalent, createRecruiter, createAdmin, createPlan } from "./helpers/fixtures.js";
import { Plan } from "../src/entities/Plan.js";
import { BillingInterval, Currency } from "../src/types/enums.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/utils/integrations/paystack.js", () => ({
  createPlan: jest.fn().mockResolvedValue({ status: true, data: { plan_code: "PLN_test123" } }),
  updatePlan: jest.fn().mockResolvedValue({ status: true }),
  generatePlanObject: jest.fn().mockImplementation((plan: { name: string; amount: number; interval: string; currency: string; description: string }) => ({
    name: plan.name,
    interval: plan.interval,
    amount: Math.round(plan.amount * 100), // paystackAmount in kobo
    monthlyAmount: plan.amount,            // human-readable amount
    currency: plan.currency,
    description: plan.description,
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
  jest.clearAllMocks();
});

const validPlanBody = {
  name: "Basic Plan",
  amount: 5000,
  interval: BillingInterval.Monthly,
  currency: Currency.NGN,
  description: "Access to basic features",
  features: ["Feature A", "Feature B"],
};

// ---------------------------------------------------------------------------
// POST /v1/plans/
// ---------------------------------------------------------------------------

describe("POST /v1/plans/ — create plan (Admin only)", () => {
  it("Admin creates a monthly NGN plan → 201", async () => {
    const { token } = await createAdmin();

    const res = await request(app)
      .post("/v1/plans/")
      .set("Authorization", `Bearer ${token}`)
      .send(validPlanBody);

    expect(res.status).toBe(201);
    expect(res.body.data.plan.name).toBe("Basic Plan");
  });

  it("Admin creates an annual plan → 201", async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .post("/v1/plans/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...validPlanBody, name: "Annual Plan", interval: BillingInterval.Annually });
    expect(res.status).toBe(201);
  });

  it("Recruiter cannot create plan → 403", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/plans/")
      .set("Authorization", `Bearer ${token}`)
      .send(validPlanBody);
    expect(res.status).toBe(403);
  });

  it("Talent cannot create plan → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/plans/")
      .set("Authorization", `Bearer ${token}`)
      .send(validPlanBody);
    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).post("/v1/plans/").send(validPlanBody);
    expect(res.status).toBe(401);
  });

  it("Missing required fields → 400", async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .post("/v1/plans/")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Incomplete" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/plans/ — list plans (public)
// ---------------------------------------------------------------------------

describe("GET /v1/plans/ — list plans (public)", () => {
  it("Returns non-deleted plans → 200", async () => {
    await createPlan({ name: "Active Plan" });
    await createPlan({ name: "Deleted Plan", isDeleted: true });

    const res = await request(app).get("/v1/plans/");

    expect(res.status).toBe(200);
    const plans = res.body.data.plans ?? res.body.data ?? [];
    const names = plans.map((p: Plan) => p.name);
    expect(names).toContain("Active Plan");
  });

  it("Unauthenticated can access (public endpoint)", async () => {
    const res = await request(app).get("/v1/plans/");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/plans/:id — single plan (public)
// ---------------------------------------------------------------------------

describe("GET /v1/plans/:id — single plan", () => {
  it("Returns plan by ID → 200", async () => {
    const plan = await createPlan({ name: "My Plan" });
    const res = await request(app).get(`/v1/plans/${plan.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.plan.name).toBe("My Plan");
  });

  it("Non-existent ID → 404", async () => {
    const res = await request(app).get("/v1/plans/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/plans/:_id — update plan (Admin only)
// ---------------------------------------------------------------------------

describe("PATCH /v1/plans/:_id — update plan (Admin only)", () => {
  it("Admin updates plan description → 200", async () => {
    const { token } = await createAdmin();
    const plan = await createPlan({ name: "UpdateMe" });

    const res = await request(app)
      .patch(`/v1/plans/${plan.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ description: "Updated description" });

    expect(res.status).toBe(200);
  });

  it("Non-existent plan → 404", async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .patch("/v1/plans/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`)
      .send({ description: "Updated" });
    expect(res.status).toBe(404);
  });

  it("Recruiter cannot update → 403", async () => {
    const { token } = await createRecruiter();
    const plan = await createPlan();
    const res = await request(app)
      .patch(`/v1/plans/${plan.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ description: "Hack" });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/plans/:id — soft-delete plan (Admin only)
// ---------------------------------------------------------------------------

describe("DELETE /v1/plans/:id — soft-delete (Admin only)", () => {
  it("Admin soft-deletes plan → 200, isDeleted=true", async () => {
    const { token } = await createAdmin();
    const plan = await createPlan({ name: "ToDelete" });

    const res = await request(app)
      .delete(`/v1/plans/${plan.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);

    const updated = await testDataSource.getRepository(Plan).findOne({ where: { id: plan.id } });
    expect(updated!.isDeleted).toBe(true);
  });

  it("Non-existent plan → 404", async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .delete("/v1/plans/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("Recruiter cannot delete → 403", async () => {
    const { token } = await createRecruiter();
    const plan = await createPlan();
    const res = await request(app)
      .delete(`/v1/plans/${plan.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
