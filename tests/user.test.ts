import request from "supertest";
import { createApp } from "../src/app.js";
import { startTestDatabase, stopTestDatabase, clearAllTables, testDataSource } from "./helpers/db.js";
import { User } from "../src/entities/User.js";
import { Role } from "../src/entities/Role.js";
import { UserRole } from "../src/types/enums.js";
import { generateHashedPassword, signToken } from "../src/utils/crypto.js";

jest.mock("../src/utils/integrations/cloudinary.js", () => ({
  uploadBuffer: jest.fn().mockResolvedValue({ url: "https://res.cloudinary.com/test/image.jpg", publicId: "test/image" }),
  replaceAsset: jest.fn().mockResolvedValue({ url: "https://res.cloudinary.com/test/new.jpg", publicId: "test/new" }),
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

    const res = await request(app)
      .get("/v1/user/me")
      .set("Authorization", `Bearer ${token}`);

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
