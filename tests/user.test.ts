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
import {
  UserRole,
  Currency,
  WorkType,
  CompensationPeriod,
  CvEmbeddingStatus,
} from "../src/types/enums.js";
import { generateHashedPassword, signToken } from "../src/utils/crypto.js";
import { createTalent, createRecruiter, createAdmin, createRole } from "./helpers/fixtures.js";
import { uploadToSpaces, deleteFromSpaces } from "../src/utils/integrations/spaces.js";
import { extractText } from "../src/utils/text.js";

const mockUploadToSpaces = uploadToSpaces as jest.Mock;
const mockDeleteFromSpaces = deleteFromSpaces as jest.Mock;
const mockExtractText = extractText as jest.Mock;

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
}));

jest.mock("../src/utils/integrations/spaces.js", () => {
  // spacesKeyFor/ALLOWED_IMAGE_TYPES are pure (no network) — keep the real ones.
  // uploadToSpaces/deleteFromSpaces must not hit real Spaces, so those are mocked;
  // deleteSpacesObjectQuietly is reimplemented to delegate to the mocked
  // deleteFromSpaces below (the actual one closes over its own module's real
  // deleteFromSpaces, not this mock, so requireActual can't be used for it).
  const actual = jest.requireActual("../src/utils/integrations/spaces.js");
  const deleteFromSpaces = jest.fn().mockResolvedValue(undefined);
  return {
    ...actual,
    // The URL derives from the key (like the real implementation) so tests can
    // assert the stored url/key pair actually describe the same uploaded object.
    uploadToSpaces: jest.fn((_buffer: Buffer, key: string) =>
      Promise.resolve(`https://salesplat.nyc3.digitaloceanspaces.com/${key}`)
    ),
    deleteFromSpaces,
    deleteSpacesObjectQuietly: jest.fn(async (key: string | null) => {
      if (!key) return;
      await deleteFromSpaces(key).catch(() => undefined);
    }),
  };
});

jest.mock("../src/utils/text.js", () => {
  const actual = jest.requireActual("../src/utils/text.js");
  return {
    ...actual,
    extractText: jest
      .fn()
      .mockResolvedValue("Jane Doe\nSoftware engineer with 5 years experience."),
  };
});

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
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
    emailVerifiedAt: new Date(),
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

describe("POST /v1/user/me/tour", () => {
  it("new users have not finished the tour", async () => {
    const { token } = await createTalentWithToken();

    const res = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.tourCompletedAt).toBeNull();
  });

  it("marks the tour finished, and GET /me reflects it", async () => {
    const { token } = await createTalentWithToken();

    const res = await request(app).post("/v1/user/me/tour").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.tourCompletedAt).toBeTruthy();

    const me = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${token}`);
    expect(me.body.data.user.tourCompletedAt).toBe(res.body.data.tourCompletedAt);
  });

  it("keeps the first completion time when called again", async () => {
    const { token } = await createTalentWithToken();

    const first = await request(app)
      .post("/v1/user/me/tour")
      .set("Authorization", `Bearer ${token}`);
    const second = await request(app)
      .post("/v1/user/me/tour")
      .set("Authorization", `Bearer ${token}`);

    expect(second.status).toBe(200);
    expect(second.body.data.tourCompletedAt).toBe(first.body.data.tourCompletedAt);
  });

  it("works before the email is verified", async () => {
    const { user } = await createTalentWithToken();
    await testDataSource.getRepository(User).update(user.id, { emailVerifiedAt: null });

    const res = await request(app)
      .post("/v1/user/me/tour")
      .set("Authorization", `Bearer ${signToken(user)}`);

    expect(res.status).toBe(200);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).post("/v1/user/me/tour");
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

  it("persists a full profile payload (roleIds, location, experience, currency, workType, salary, compensationPeriod)", async () => {
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
      compensationPeriod: CompensationPeriod.Monthly,
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
    expect(dbUser?.compensationPeriod).toBe(CompensationPeriod.Monthly);

    const getRes = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${token}`);
    expect(getRes.body.data.user.locationCity).toBe("Lagos");
    expect(getRes.body.data.user.experience).toBe("4-6 years");
    expect(getRes.body.data.user.currency).toBe(Currency.USD);
    expect(getRes.body.data.user.workType).toEqual([WorkType.Remote]);
    expect(getRes.body.data.user.minSalary).toBe(50000);
    expect(getRes.body.data.user.maxSalary).toBe(100000);
    expect(getRes.body.data.user.compensationPeriod).toBe(CompensationPeriod.Monthly);
  });

  it("rejects an invalid currency with a 400 field validation error", async () => {
    const { token } = await createTalent();

    const res = await request(app)
      .patch("/v1/user/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ currency: "NOT_A_CURRENCY" });

    expect(res.status).toBe(400);
  });

  it("rejects an invalid compensationPeriod with a 400 field validation error", async () => {
    const { token } = await createTalent();

    const res = await request(app)
      .patch("/v1/user/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ compensationPeriod: "weekly" });

    expect(res.status).toBe(400);
  });

  it("rejects a non-UUID roleIds entry with a 400 field validation error", async () => {
    const { token } = await createTalent();

    const res = await request(app)
      .patch("/v1/user/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ roleIds: ["undefined"] });

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

  it("stores extracted CV text, file name, and the Spaces file URL", async () => {
    const { token, user } = await createTalent();

    const res = await request(app)
      .patch("/v1/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .attach("cv", Buffer.from("%PDF-1.4 fake"), "jane-doe-cv.pdf");

    expect(res.status).toBe(200);
    expect(res.body.data.user.cvFileName).toBe("jane-doe-cv.pdf");
    expect(res.body.data.user.cvUploadedAt).toBeTruthy();
    expect(res.body.data.user.cvText).toBeUndefined();

    expect(mockUploadToSpaces).toHaveBeenCalledTimes(1);
    const [, key, mimetype] = mockUploadToSpaces.mock.calls[0] as [Buffer, string, string];
    expect(key).toMatch(new RegExp(`^cvs/${user.id}/.+\\.pdf$`));
    expect(mimetype).toBe("application/pdf");
    expect(res.body.data.user.cvUrl).toBe(`https://salesplat.nyc3.digitaloceanspaces.com/${key}`);

    const dbUser = await testDataSource
      .getRepository(User)
      .createQueryBuilder("user")
      .addSelect("user.cvText")
      .where("user.id = :id", { id: user.id })
      .getOne();

    expect(dbUser?.cvText).toContain("Software engineer");
    expect(dbUser?.cvFileName).toBe("jane-doe-cv.pdf");
    expect(dbUser?.cvKey).toBe(key);
    expect(dbUser?.cvUrl).toBe(`https://salesplat.nyc3.digitaloceanspaces.com/${key}`);

    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterEmbed = await testDataSource.getRepository(User).findOne({
      where: { id: user.id },
      select: { id: true, cvEmbeddingStatus: true },
    });
    expect(afterEmbed?.cvEmbeddingStatus).toBe(CvEmbeddingStatus.Ready);
  });

  it("deletes the previous CV object in Spaces when replacing a CV", async () => {
    const { token } = await createTalent();

    await request(app)
      .patch("/v1/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .attach("cv", Buffer.from("%PDF-1.4 fake"), "first.pdf");

    const firstKey = mockUploadToSpaces.mock.calls[0]![1] as string;

    const res = await request(app)
      .patch("/v1/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .attach("cv", Buffer.from("%PDF-1.4 fake again"), "second.pdf");

    expect(res.status).toBe(200);
    expect(mockDeleteFromSpaces).toHaveBeenCalledWith(firstKey);
  });

  it("rejects an oversized CV with a clean 400, not a 500", async () => {
    const { token } = await createTalent();
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, "a");

    const res = await request(app)
      .patch("/v1/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .attach("cv", oversized, "huge.pdf");

    expect(res.status).toBe(400);
    expect(mockUploadToSpaces).not.toHaveBeenCalled();
  });

  it("accepts a CV just under the 5MB limit", async () => {
    const { token } = await createTalent();
    // multer/busboy treats fileSize as a strict upper bound (a file of exactly
    // that many bytes is rejected), so the accepted boundary is one byte under.
    const atLimit = Buffer.alloc(5 * 1024 * 1024 - 1, "a");

    const res = await request(app)
      .patch("/v1/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .attach("cv", atLimit, "at-limit.pdf");

    expect(res.status).toBe(200);
  });

  it("never calls Spaces for a rejected mimetype", async () => {
    const { token } = await createTalent();

    const res = await request(app)
      .patch("/v1/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .attach("cv", Buffer.from("plain text resume"), {
        filename: "resume.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(400);
    expect(mockUploadToSpaces).not.toHaveBeenCalled();
  });

  it("never calls Spaces when text extraction fails", async () => {
    const { token } = await createTalent();
    mockExtractText.mockRejectedValueOnce(new Error("Corrupt PDF"));

    const res = await request(app)
      .patch("/v1/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .attach("cv", Buffer.from("%PDF-1.4 fake"), "resume.pdf");

    expect(res.status).toBe(400);
    expect(mockUploadToSpaces).not.toHaveBeenCalled();
  });

  it("rejects an empty CV file without calling Spaces", async () => {
    const { token } = await createTalent();

    const res = await request(app)
      .patch("/v1/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .attach("cv", Buffer.alloc(0), "empty.pdf");

    expect(res.status).toBe(400);
    expect(mockUploadToSpaces).not.toHaveBeenCalled();
  });

  it("leaves the existing CV row untouched when the Spaces upload fails", async () => {
    const { token, user } = await createTalent({
      cvFileName: "existing.pdf",
      cvText: "Pre-existing CV text",
      cvUploadedAt: new Date("2024-01-01"),
    });
    mockUploadToSpaces.mockRejectedValueOnce(new Error("Spaces is down"));

    const res = await request(app)
      .patch("/v1/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .attach("cv", Buffer.from("%PDF-1.4 fake"), "new.pdf");

    expect(res.status).toBeGreaterThanOrEqual(400);

    const dbUser = await testDataSource
      .getRepository(User)
      .createQueryBuilder("user")
      .addSelect("user.cvText")
      .where("user.id = :id", { id: user.id })
      .getOne();
    expect(dbUser?.cvFileName).toBe("existing.pdf");
    expect(dbUser?.cvText).toBe("Pre-existing CV text");
    expect(dbUser?.cvUrl).toBeNull();
  });
});

describe("PATCH /v1/user/avatar", () => {
  const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0x02, 0x03]);

  it("uploads an avatar and stores the returned URL", async () => {
    const { token, user } = await createTalent();

    const res = await request(app)
      .patch("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", jpeg(), { filename: "me.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(mockUploadToSpaces).toHaveBeenCalledTimes(1);
    const [, key] = mockUploadToSpaces.mock.calls[0] as [Buffer, string, string];
    expect(key).toMatch(new RegExp(`^avatars/${user.id}/.+\\.jpg$`));
    expect(res.body.data.user.profileImageUrl).toBe(
      `https://salesplat.nyc3.digitaloceanspaces.com/${key}`
    );

    const dbUser = await testDataSource.getRepository(User).findOne({ where: { id: user.id } });
    expect(dbUser?.profileImageKey).toBe(key);
    expect(dbUser?.profileImageUrl).toBe(`https://salesplat.nyc3.digitaloceanspaces.com/${key}`);
  });

  it.each([
    ["talent", createTalent],
    ["recruiter", createRecruiter],
    ["admin", createAdmin],
  ])("is available to a %s caller", async (_label, createUser) => {
    const { token } = await createUser();

    const res = await request(app)
      .patch("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", jpeg(), { filename: "me.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
  });

  it("rejects requests without an auth token", async () => {
    const res = await request(app)
      .patch("/v1/user/avatar")
      .attach("avatar", jpeg(), { filename: "me.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(401);
  });

  it("rejects an unsupported mimetype without calling Spaces", async () => {
    const { token } = await createTalent();

    const res = await request(app)
      .patch("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", Buffer.from("%PDF-1.4 fake"), {
        filename: "not-an-image.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(400);
    expect(mockUploadToSpaces).not.toHaveBeenCalled();
  });

  it("rejects a request with no file attached", async () => {
    const { token } = await createTalent();

    const res = await request(app)
      .patch("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`)
      .field("noop", "1");

    expect(res.status).toBe(400);
  });

  it("rejects an empty image file without calling Spaces", async () => {
    const { token } = await createTalent();

    const res = await request(app)
      .patch("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", Buffer.alloc(0), { filename: "empty.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(400);
    expect(mockUploadToSpaces).not.toHaveBeenCalled();
  });

  it("rejects an unexpected multipart field name with a clean 400, not a 500", async () => {
    const { token } = await createTalent();
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0x02, 0x03]);

    const res = await request(app)
      .patch("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", jpegBuffer, { filename: "me.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(400);
    expect(mockUploadToSpaces).not.toHaveBeenCalled();
  });

  it("rejects an oversized image with a clean 400, not a 500", async () => {
    const { token } = await createTalent();
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, "a");

    const res = await request(app)
      .patch("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", oversized, { filename: "huge.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(400);
    expect(mockUploadToSpaces).not.toHaveBeenCalled();
  });

  it("accepts an image just under the 2MB limit", async () => {
    const { token } = await createTalent();
    // multer/busboy treats fileSize as a strict upper bound (a file of exactly
    // that many bytes is rejected), so the accepted boundary is one byte under.
    const atLimit = Buffer.alloc(2 * 1024 * 1024 - 1, "a");

    const res = await request(app)
      .patch("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", atLimit, { filename: "at-limit.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
  });

  it("deletes the previous avatar object in Spaces when replacing it", async () => {
    const { token } = await createTalent();

    await request(app)
      .patch("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", jpeg(), { filename: "first.jpg", contentType: "image/jpeg" });
    const firstKey = mockUploadToSpaces.mock.calls[0]![1] as string;

    const res = await request(app)
      .patch("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", jpeg(), { filename: "second.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(mockDeleteFromSpaces).toHaveBeenCalledWith(firstKey);
  });

  it("leaves the existing avatar untouched when the Spaces upload fails", async () => {
    const { token, user } = await createTalent();
    await request(app)
      .patch("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", jpeg(), { filename: "first.jpg", contentType: "image/jpeg" });
    const firstKey = mockUploadToSpaces.mock.calls[0]![1] as string;

    mockUploadToSpaces.mockRejectedValueOnce(new Error("Spaces is down"));
    const res = await request(app)
      .patch("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", jpeg(), { filename: "second.jpg", contentType: "image/jpeg" });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const dbUser = await testDataSource.getRepository(User).findOne({ where: { id: user.id } });
    expect(dbUser?.profileImageKey).toBe(firstKey);
    expect(dbUser?.profileImageUrl).toBe(
      `https://salesplat.nyc3.digitaloceanspaces.com/${firstKey}`
    );
  });

  it("still succeeds when cleaning up the old avatar object fails", async () => {
    const { token } = await createTalent();
    await request(app)
      .patch("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", jpeg(), { filename: "first.jpg", contentType: "image/jpeg" });

    mockDeleteFromSpaces.mockRejectedValueOnce(new Error("Object already gone"));
    const res = await request(app)
      .patch("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", jpeg(), { filename: "second.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
  });

  it("leaves a self-consistent url/key pair after two concurrent uploads", async () => {
    const { token, user } = await createTalent();

    const [res1, res2] = await Promise.all([
      request(app)
        .patch("/v1/user/avatar")
        .set("Authorization", `Bearer ${token}`)
        .attach("avatar", jpeg(), { filename: "a.jpg", contentType: "image/jpeg" }),
      request(app)
        .patch("/v1/user/avatar")
        .set("Authorization", `Bearer ${token}`)
        .attach("avatar", jpeg(), { filename: "b.jpg", contentType: "image/jpeg" }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const dbUser = await testDataSource.getRepository(User).findOne({ where: { id: user.id } });
    // Last-write-wins is an accepted limitation here — what matters is that the
    // stored key and URL still describe one consistent object, not a mismatched pair
    // from the two interleaved requests.
    expect(dbUser?.profileImageKey).toMatch(new RegExp(`^avatars/${user.id}/.+\\.jpg$`));
    expect(dbUser?.profileImageUrl).toBe(
      `https://salesplat.nyc3.digitaloceanspaces.com/${dbUser?.profileImageKey}`
    );
  });
});

describe("DELETE /v1/user/avatar", () => {
  const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0x02, 0x03]);

  it("removes an existing avatar and deletes it from Spaces", async () => {
    const { token, user } = await createTalent();
    await request(app)
      .patch("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", jpeg(), { filename: "me.jpg", contentType: "image/jpeg" });
    const key = mockUploadToSpaces.mock.calls[0]![1] as string;

    const res = await request(app)
      .delete("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.profileImageUrl).toBeNull();
    expect(mockDeleteFromSpaces).toHaveBeenCalledWith(key);

    const dbUser = await testDataSource.getRepository(User).findOne({ where: { id: user.id } });
    expect(dbUser?.profileImageUrl).toBeNull();
    expect(dbUser?.profileImageKey).toBeNull();
  });

  it("is a no-op 200 when there is no avatar to remove", async () => {
    const { token } = await createTalent();

    const res = await request(app)
      .delete("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(mockDeleteFromSpaces).not.toHaveBeenCalled();
  });

  it.each([
    ["talent", createTalent],
    ["recruiter", createRecruiter],
  ])("works for a %s caller — the endpoint is role-agnostic", async (_label, createUser) => {
    const { token } = await createUser();
    await request(app)
      .patch("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", jpeg(), { filename: "me.jpg", contentType: "image/jpeg" });

    const res = await request(app)
      .delete("/v1/user/avatar")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.profileImageUrl).toBeNull();
  });

  it("rejects requests without an auth token", async () => {
    const res = await request(app).delete("/v1/user/avatar");
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/user/profile/:_id/cv", () => {
  it("falls back to a regenerated PDF for legacy talents with no stored cvUrl", async () => {
    const { user: talent } = await createTalent({
      firstName: "Ada",
      lastName: "Lovelace",
      cvFileName: "ada-cv.pdf",
      cvText: "Ada Lovelace\nPioneer of computing.",
      cvUploadedAt: new Date(),
    });
    const { token: recruiterToken } = await createRecruiter();

    const res = await request(app)
      .get(`/v1/user/profile/${talent.id}/cv`)
      .set("Authorization", `Bearer ${recruiterToken}`)
      .buffer(true)
      .parse((incoming, callback) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect((res.body as Buffer).length).toBeGreaterThan(100);
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("redirects recruiters to the stored file when a cvUrl is present", async () => {
    const { user: talent } = await createTalent({
      cvFileName: "ada-cv.pdf",
      cvText: "Ada Lovelace\nPioneer of computing.",
      cvUrl: "https://salesplat.nyc3.digitaloceanspaces.com/cvs/talent-id/some-uuid.pdf",
      cvKey: "cvs/talent-id/some-uuid.pdf",
      cvUploadedAt: new Date(),
    });
    const { token: recruiterToken } = await createRecruiter();

    const res = await request(app)
      .get(`/v1/user/profile/${talent.id}/cv`)
      .set("Authorization", `Bearer ${recruiterToken}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      "https://salesplat.nyc3.digitaloceanspaces.com/cvs/talent-id/some-uuid.pdf"
    );
  });

  it("rejects talent callers", async () => {
    const { user: talent, token: talentToken } = await createTalent({
      cvFileName: "cv.pdf",
      cvText: "Some resume text",
      cvUploadedAt: new Date(),
    });

    const res = await request(app)
      .get(`/v1/user/profile/${talent.id}/cv`)
      .set("Authorization", `Bearer ${talentToken}`);

    expect(res.status).toBe(403);
  });
});

describe("Profile completion", () => {
  it("profile fields are nullable and start empty", async () => {
    const { user } = await createTalentWithToken();
    expect(user.bio).toBeNull();
    expect(user.cvFileName).toBeNull();
    expect(user.cvUploadedAt).toBeNull();
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
