import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { User } from "../src/entities/User.js";
import { Role } from "../src/entities/Role.js";
import { UserRole, Currency, WorkType } from "../src/types/enums.js";
import { generateHashedPassword, signToken } from "../src/utils/crypto.js";
import { createTalent, createRole } from "./helpers/fixtures.js";

jest.mock("../src/utils/integrations/cloudinary.js", () => ({
  uploadBuffer: jest.fn().mockResolvedValue({
    url: "https://res.cloudinary.com/test/image.jpg",
    publicId: "test/image",
  }),
  replaceAsset: jest
    .fn()
    .mockResolvedValue({ url: "https://res.cloudinary.com/test/new.jpg", publicId: "test/new" }),
  destroyAsset: jest.fn().mockResolvedValue(undefined),
  extractPublicIdFromUrl: jest.fn().mockReturnValue("test/image"),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
}));

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
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

async function createTalentWithToken(): Promise<{ user: User; token: string }> {
  const user = testDataSource.getRepository(User).create({
    email: "talent@example.com",
    password: await generateHashedPassword("Password1!"),
    firstName: "Jane",
    lastName: "Doe",
    userRole: UserRole.Talent,
    emailVerified: true,
    active: true,
    tokenVersion: 0,
    roleChangeCount: 0,
  });
  const saved = await testDataSource.getRepository(User).save(user);
  return { user: saved, token: signToken(saved) };
}

describe("GET /v1/user/me", () => {
  it("returns the authenticated user", async () => {
    const { token } = await createTalentWithToken();

    const res = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe("talent@example.com");
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/v1/user/me");
    expect(res.status).toBe(401);
  });
});

describe("PATCH /v1/user/me", () => {
  it("updates user name fields", async () => {
    const { token } = await createTalentWithToken();

    const res = await request(app)
      .patch("/v1/user/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ firstName: "Updated", lastName: "Name" });

    expect(res.status).toBe(200);
    expect(res.body.data.user.firstName).toBe("Updated");
  });

  it("persists a full profile payload (roleIds, location, experience, currency, workType, salary)", async () => {
    const { token, user } = await createTalent();
    const role = await createRole();

    const payload = {
      roleIds: [role.id],
      locationCity: "Lagos",
      locationState: "Lagos",
      locationCountry: "Nigeria",
      experience: "4-6 years",
      currency: Currency.USD,
      workType: [WorkType.Remote],
      minSalary: 50000,
      maxSalary: 100000,
    };

    const patchRes = await request(app)
      .patch("/v1/user/me")
      .set("Authorization", `Bearer ${token}`)
      .send(payload);

    expect(patchRes.status).toBe(200);

    const dbUser = await testDataSource.getRepository(User).findOne({
      where: { id: user.id },
      relations: { userRoles: true },
    });
    expect(dbUser?.userRoles.map((r) => r.id)).toEqual([role.id]);
    expect(dbUser?.locationCity).toBe("Lagos");
    expect(dbUser?.locationState).toBe("Lagos");
    expect(dbUser?.locationCountry).toBe("Nigeria");
    expect(dbUser?.experience).toBe("4-6 years");
    expect(dbUser?.currency).toBe(Currency.USD);
    expect(dbUser?.workType).toEqual([WorkType.Remote]);
    expect(dbUser?.minSalary).toBe(50000);
    expect(dbUser?.maxSalary).toBe(100000);

    const getRes = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${token}`);
    expect(getRes.body.data.user.locationCity).toBe("Lagos");
    expect(getRes.body.data.user.experience).toBe("4-6 years");
    expect(getRes.body.data.user.currency).toBe(Currency.USD);
    expect(getRes.body.data.user.workType).toEqual([WorkType.Remote]);
    expect(getRes.body.data.user.minSalary).toBe(50000);
    expect(getRes.body.data.user.maxSalary).toBe(100000);
  });

  it("rejects an invalid currency with a 400 field validation error", async () => {
    const { token } = await createTalent();

    const res = await request(app)
      .patch("/v1/user/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ currency: "NOT_A_CURRENCY" });

    expect(res.status).toBe(400);
  });
});

describe("PATCH /v1/user/profile", () => {
  it("persists a full profile payload sent as multipart fields", async () => {
    const { token, user } = await createTalent();
    const role = await createRole();

    const res = await request(app)
      .patch("/v1/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .field("roleIds[]", role.id)
      .field("locationCity", "Abuja")
      .field("locationState", "FCT")
      .field("locationCountry", "Nigeria")
      .field("experience", "1-3 years")
      .field("currency", Currency.NGN)
      .field("workType[]", WorkType.Hybrid)
      .field("minSalary", "20000")
      .field("maxSalary", "40000");

    expect(res.status).toBe(200);

    const dbUser = await testDataSource.getRepository(User).findOne({
      where: { id: user.id },
      relations: { userRoles: true },
    });
    expect(dbUser?.userRoles.map((r) => r.id)).toEqual([role.id]);
    expect(dbUser?.locationCity).toBe("Abuja");
    expect(dbUser?.locationCountry).toBe("Nigeria");
    expect(dbUser?.experience).toBe("1-3 years");
    expect(dbUser?.currency).toBe(Currency.NGN);
    expect(dbUser?.workType).toEqual([WorkType.Hybrid]);
    expect(dbUser?.minSalary).toBe(20000);
    expect(dbUser?.maxSalary).toBe(40000);
  });

  it("rejects an invalid workType with a 400 field validation error", async () => {
    const { token } = await createTalent();

    const res = await request(app)
      .patch("/v1/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .field("workType[]", "not-a-work-type");

    expect(res.status).toBe(400);
  });
});

describe("Profile completion", () => {
  it("profile fields are nullable and start empty", async () => {
    const { user } = await createTalentWithToken();
    expect(user.bio).toBeNull();
    expect(user.cvUrl).toBeNull();
    expect(user.experience).toBeNull();
  });

  it("role assignment updates userRoles", async () => {
    const { user } = await createTalentWithToken();

    const role = testDataSource.getRepository(Role).create({ name: "software-engineer" });
    const savedRole = await testDataSource.getRepository(Role).save(role);

    const updatedUser = await testDataSource.getRepository(User).save({
      ...user,
      userRoles: [savedRole],
    });

    const loaded = await testDataSource.getRepository(User).findOne({
      where: { id: updatedUser.id },
      relations: { userRoles: true },
    });

    expect(loaded?.userRoles).toHaveLength(1);
    expect(loaded?.userRoles[0]?.name).toBe("software-engineer");
  });
});
