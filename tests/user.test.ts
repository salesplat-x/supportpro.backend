import request from "supertest";
import mongoose from "mongoose";
import createApp from "../src/createApp";
import * as userRepository from "../src/repository/v1/user";
import * as roleRepository from "../src/repository/v1/role";
import * as applicationRepository from "../src/repository/v1/application";
import * as profileController from "../src/logics/v1/profile";
import * as cloudinaryService from "../src/services/v1/cloudinary";
import * as func from "../src/helpers/func";
import * as openaiService from "../src/services/v1/openai";
import * as pgRepository from "../src/repository/v1/pg";
import { signToken } from "../src/helpers/utils";
import { Roles, ExperienceLevel, WorkType } from "../src/typings/customs";
import { Profile } from "../src/models/v1/user";

jest.mock("../src/repository/v1/user");
jest.mock("../src/repository/v1/role");
jest.mock("../src/repository/v1/application");
jest.mock("../src/logics/v1/profile");
jest.mock("../src/services/v1/cloudinary");
jest.mock("../src/helpers/func");
jest.mock("../src/services/v1/openai");
jest.mock("../src/repository/v1/pg");

const mockedUserRepository = jest.mocked(userRepository);
const mockedRoleRepository = jest.mocked(roleRepository);
const mockedApplicationRepository = jest.mocked(applicationRepository);
const mockedProfileController = jest.mocked(profileController);
const mockedCloudinary = jest.mocked(cloudinaryService);
const mockedFunc = jest.mocked(func);
const mockedOpenai = jest.mocked(openaiService);
const mockedPg = jest.mocked(pgRepository);

const app = createApp();

const USER_ID = "507f1f77bcf86cd799439011";
const PROFILE_ID = "507f1f77bcf86cd799439022";
const ROLE_ID = "507f1f77bcf86cd799439033";

const buildAuthUser = (overrides: Record<string, any> = {}) => ({
  _id: USER_ID,
  email: "talent@example.com",
  userRole: Roles.Talent,
  active: true,
  emailVerified: true,
  tokenVersion: 0,
  profile: PROFILE_ID,
  ...overrides,
});

const authHeaderFor = (user: Record<string, any>) => {
  mockedUserRepository.findUserAuthById.mockResolvedValue(user as any);
  return `Bearer ${signToken({
    _id: user._id,
    email: user.email,
    tokenVersion: user.tokenVersion,
  })}`;
};

describe("/v1/user routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /v1/user/me", () => {
    it("returns the authenticated talent with their existing profile", async () => {
      const authUser = buildAuthUser();
      const token = authHeaderFor(authUser);

      const existingUser = {
        _id: USER_ID,
        userRole: Roles.Talent,
        profile: { _id: PROFILE_ID, role: [] },
        set: jest.fn(),
      };
      mockedUserRepository.findUserById.mockResolvedValue(existingUser as any);

      const res = await request(app).get("/v1/user/me").set("Authorization", token);

      expect(res.status).toBe(200);
      expect(existingUser.set).toHaveBeenCalledWith("password", undefined);
      expect(mockedUserRepository.createProfile).not.toHaveBeenCalled();
    });

    it("backfills a profile for a legacy talent with no profile reference", async () => {
      const authUser = buildAuthUser({ profile: undefined });
      const token = authHeaderFor(authUser);

      const existingUser = {
        _id: USER_ID,
        userRole: Roles.Talent,
        profile: undefined,
        set: jest.fn(),
      };
      mockedUserRepository.findUserById.mockResolvedValue(existingUser as any);
      mockedUserRepository.createProfile.mockResolvedValue({ _id: PROFILE_ID } as any);
      const backfilledUser = {
        _id: USER_ID,
        userRole: Roles.Talent,
        profile: { _id: PROFILE_ID },
        set: jest.fn(),
      };
      mockedUserRepository.findUserByIdAndUpdate.mockResolvedValue(backfilledUser as any);

      const res = await request(app).get("/v1/user/me").set("Authorization", token);

      expect(res.status).toBe(200);
      expect(mockedUserRepository.createProfile).toHaveBeenCalled();
      expect(mockedUserRepository.findUserByIdAndUpdate).toHaveBeenCalledWith(USER_ID, {
        profile: PROFILE_ID,
      });
      expect(backfilledUser.set).toHaveBeenCalledWith("password", undefined);
    });
  });

  describe("PATCH /v1/user/me", () => {
    it("updates basic profile fields", async () => {
      const authUser = buildAuthUser();
      const token = authHeaderFor(authUser);

      mockedUserRepository.findUserByIdAndUpdate.mockResolvedValue({
        _id: USER_ID,
        firstName: "New",
        lastName: "Name",
        phone: "+2348012345678",
      } as any);

      const res = await request(app)
        .patch("/v1/user/me")
        .set("Authorization", token)
        .send({ firstName: "New", lastName: "Name", phone: "+2348012345678" });

      expect(res.status).toBe(200);
      expect(mockedUserRepository.findUserByIdAndUpdate).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ firstName: "New", lastName: "Name" })
      );
      expect(res.body.data.user.password).toBeUndefined();
    });

    it("maps the picture field to profileImage.url and stores its publicId", async () => {
      const token = authHeaderFor(buildAuthUser());

      mockedUserRepository.findUserById.mockResolvedValue({
        _id: USER_ID,
        profileImage: undefined,
      } as any);
      mockedCloudinary.extractPublicIdFromUrl.mockReturnValue("salesplate/images/new-image");
      mockedUserRepository.findUserByIdAndUpdate.mockResolvedValue({
        _id: USER_ID,
        firstName: "New",
        profileImage: {
          url: "https://example.com/avatar.png",
          publicId: "salesplate/images/new-image",
        },
      } as any);

      const res = await request(app)
        .patch("/v1/user/me")
        .set("Authorization", token)
        .send({ firstName: "New", picture: "https://example.com/avatar.png" });

      expect(res.status).toBe(200);
      expect(mockedUserRepository.findUserByIdAndUpdate).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          firstName: "New",
          profileImage: {
            url: "https://example.com/avatar.png",
            publicId: "salesplate/images/new-image",
          },
        })
      );
      expect(mockedUserRepository.findUserByIdAndUpdate).toHaveBeenCalledWith(
        USER_ID,
        expect.not.objectContaining({ picture: expect.anything() })
      );
      expect(mockedCloudinary.destroyAsset).not.toHaveBeenCalled();
    });

    it("deletes the old profile image from Cloudinary when replaced", async () => {
      const token = authHeaderFor(buildAuthUser());

      mockedUserRepository.findUserById.mockResolvedValue({
        _id: USER_ID,
        profileImage: {
          url: "https://example.com/old.png",
          publicId: "salesplate/images/old-image",
        },
      } as any);
      mockedCloudinary.extractPublicIdFromUrl.mockReturnValue("salesplate/images/new-image");
      mockedUserRepository.findUserByIdAndUpdate.mockResolvedValue({
        _id: USER_ID,
        profileImage: {
          url: "https://example.com/new.png",
          publicId: "salesplate/images/new-image",
        },
      } as any);

      const res = await request(app)
        .patch("/v1/user/me")
        .set("Authorization", token)
        .send({ picture: "https://example.com/new.png" });

      expect(res.status).toBe(200);
      expect(mockedCloudinary.destroyAsset).toHaveBeenCalledWith(
        "salesplate/images/old-image",
        "image"
      );
    });

    it("maps the cv field to profile.cv and stores its publicId", async () => {
      const token = authHeaderFor(buildAuthUser());

      mockedUserRepository.findUserById.mockResolvedValue({
        _id: USER_ID,
        userRole: Roles.Talent,
        profile: { _id: PROFILE_ID, cv: undefined },
      } as any);
      mockedCloudinary.extractPublicIdFromUrl.mockReturnValue("salesplate/cv/new-cv");
      mockedUserRepository.findUserByIdAndUpdate.mockResolvedValue({ _id: USER_ID } as any);

      const res = await request(app)
        .patch("/v1/user/me")
        .set("Authorization", token)
        .send({ cv: "https://example.com/resume.pdf" });

      expect(res.status).toBe(200);
      expect(mockedUserRepository.findProfileByIdAndUpdate).toHaveBeenCalledWith(
        PROFILE_ID,
        expect.objectContaining({
          cv: expect.objectContaining({
            url: "https://example.com/resume.pdf",
            publicId: "salesplate/cv/new-cv",
          }),
        })
      );
      expect(mockedUserRepository.findUserByIdAndUpdate).toHaveBeenCalledWith(
        USER_ID,
        expect.not.objectContaining({ cv: expect.anything() })
      );
      expect(mockedCloudinary.destroyAsset).not.toHaveBeenCalled();
    });

    it("deletes the old cv from Cloudinary when replaced", async () => {
      const token = authHeaderFor(buildAuthUser());

      mockedUserRepository.findUserById.mockResolvedValue({
        _id: USER_ID,
        userRole: Roles.Talent,
        profile: {
          _id: PROFILE_ID,
          cv: { url: "https://example.com/old.pdf", publicId: "salesplate/cv/old-cv" },
        },
      } as any);
      mockedCloudinary.extractPublicIdFromUrl.mockReturnValue("salesplate/cv/new-cv");
      mockedUserRepository.findUserByIdAndUpdate.mockResolvedValue({ _id: USER_ID } as any);

      const res = await request(app)
        .patch("/v1/user/me")
        .set("Authorization", token)
        .send({ cv: "https://example.com/new.pdf" });

      expect(res.status).toBe(200);
      expect(mockedCloudinary.destroyAsset).toHaveBeenCalledWith("salesplate/cv/old-cv", "auto");
    });

    it("routes profile fields (experience, role, workType, etc.) to the profile document", async () => {
      const token = authHeaderFor(buildAuthUser());

      mockedUserRepository.findUserById.mockResolvedValue({
        _id: USER_ID,
        userRole: Roles.Talent,
        profile: { _id: PROFILE_ID, role: [] },
      } as any);
      mockedRoleRepository.findRoleById.mockResolvedValue({ _id: ROLE_ID } as any);
      mockedUserRepository.findProfileByIdAndUpdate.mockResolvedValue({ _id: PROFILE_ID } as any);
      mockedUserRepository.findUserByIdAndUpdate.mockResolvedValue({ _id: USER_ID } as any);

      const res = await request(app)
        .patch("/v1/user/me")
        .set("Authorization", token)
        .send({
          experience: ExperienceLevel.fourToSixYears,
          role: [ROLE_ID],
          workType: [WorkType.Remote, WorkType.Hybrid],
        });

      expect(res.status).toBe(200);
      expect(mockedUserRepository.findProfileByIdAndUpdate).toHaveBeenCalledWith(
        PROFILE_ID,
        expect.objectContaining({
          experience: ExperienceLevel.fourToSixYears,
          role: [ROLE_ID],
          workType: [WorkType.Remote, WorkType.Hybrid],
        })
      );
      expect(mockedUserRepository.findUserByIdAndUpdate).toHaveBeenCalledWith(USER_ID, {});
    });

    it("rejects a non-existent role id sent to /v1/user/me with 404", async () => {
      const token = authHeaderFor(buildAuthUser());

      mockedUserRepository.findUserById.mockResolvedValue({
        _id: USER_ID,
        userRole: Roles.Talent,
        profile: { _id: PROFILE_ID, role: [] },
      } as any);
      mockedRoleRepository.findRoleById.mockResolvedValue(null);

      const res = await request(app)
        .patch("/v1/user/me")
        .set("Authorization", token)
        .send({ role: [new mongoose.Types.ObjectId().toString()] });

      expect(res.status).toBe(404);
      expect(res.body.message).toBe("Role does not exist");
      expect(mockedUserRepository.findProfileByIdAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /v1/user/profile", () => {
    it("updates the profile using the user's profile id (regression for finding A)", async () => {
      const authUser = buildAuthUser({ profile: PROFILE_ID }); // unpopulated ObjectId on req.user
      const token = authHeaderFor(authUser);

      const existingUser = {
        _id: USER_ID,
        userRole: Roles.Talent,
        profile: { _id: PROFILE_ID, role: [] },
      };
      mockedUserRepository.findUserById.mockResolvedValue(existingUser as any);
      mockedRoleRepository.findRoleById.mockResolvedValue({ _id: ROLE_ID } as any);
      mockedUserRepository.findProfileByIdAndUpdate.mockResolvedValue({
        _id: PROFILE_ID,
        bio: "Updated bio",
        role: [ROLE_ID],
      } as any);

      const res = await request(app)
        .patch("/v1/user/profile")
        .set("Authorization", token)
        .send({ bio: "Updated bio", role: [ROLE_ID], location: { city: "Lagos" } });

      expect(res.status).toBe(200);
      expect(mockedUserRepository.findProfileByIdAndUpdate).toHaveBeenCalledWith(
        PROFILE_ID,
        expect.objectContaining({ bio: "Updated bio", role: [ROLE_ID] })
      );
      expect(res.body.data.profile).toBeDefined();
    });

    it("rejects a malformed role id with 400 (regression for finding B)", async () => {
      const token = authHeaderFor(buildAuthUser());

      mockedUserRepository.findUserById.mockResolvedValue({
        _id: USER_ID,
        userRole: Roles.Talent,
        profile: { _id: PROFILE_ID, role: [] },
      } as any);

      const res = await request(app)
        .patch("/v1/user/profile")
        .set("Authorization", token)
        .send({ role: ["not-a-valid-object-id"] });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Invalid role id");
      expect(mockedUserRepository.findProfileByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("rejects a well-formed but non-existent role id with 404 (regression for finding B)", async () => {
      const token = authHeaderFor(buildAuthUser());

      mockedUserRepository.findUserById.mockResolvedValue({
        _id: USER_ID,
        userRole: Roles.Talent,
        profile: { _id: PROFILE_ID, role: [] },
      } as any);
      mockedRoleRepository.findRoleById.mockResolvedValue(null);

      const res = await request(app)
        .patch("/v1/user/profile")
        .set("Authorization", token)
        .send({ role: [new mongoose.Types.ObjectId().toString()] });

      expect(res.status).toBe(404);
      expect(res.body.message).toBe("Role does not exist");
      expect(mockedUserRepository.findProfileByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("rejects non-Talent users", async () => {
      const token = authHeaderFor(buildAuthUser({ userRole: Roles.Recruiter, profile: undefined }));

      const res = await request(app)
        .patch("/v1/user/profile")
        .set("Authorization", token)
        .send({ bio: "Updated bio" });

      expect(res.status).toBe(403);
      expect(mockedUserRepository.findUserById).not.toHaveBeenCalled();
    });

    it("rejects an unsupported CV file type without touching Cloudinary or the database", async () => {
      const token = authHeaderFor(buildAuthUser());

      mockedUserRepository.findUserById.mockResolvedValue({
        _id: USER_ID,
        userRole: Roles.Talent,
        profile: { _id: PROFILE_ID, role: [] },
      } as any);

      const res = await request(app)
        .patch("/v1/user/profile")
        .set("Authorization", token)
        .attach("cv", Buffer.from("fake-cv-data"), {
          filename: "resume.png",
          contentType: "image/png",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Unsupported CV file type");
      expect(mockedCloudinary.replaceAsset).not.toHaveBeenCalled();
      expect(mockedUserRepository.findProfileByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("extracts text, saves the embedding, and replaces the old CV asset alongside other profile fields", async () => {
      const token = authHeaderFor(buildAuthUser());

      mockedUserRepository.findUserById.mockResolvedValue({
        _id: USER_ID,
        userRole: Roles.Talent,
        profile: {
          _id: PROFILE_ID,
          role: [],
          cv: { publicId: "salesplate/cv/old-cv", url: "https://old-cv" },
        },
      } as any);
      mockedFunc.extractText.mockResolvedValue("raw cv text");
      mockedFunc.preprocessText.mockReturnValue("clean cv text");
      mockedFunc.overlapChunkText.mockReturnValue(["chunk-1"]);
      mockedOpenai.createEmbedding.mockResolvedValue([{ embedding: [0.1, 0.2] }] as any);
      mockedPg.saveTalentEmbedding.mockResolvedValue({ rowCount: 1 } as any);
      mockedCloudinary.replaceAsset.mockResolvedValue({
        url: "https://new-cv",
        publicId: `salesplate/cv/${USER_ID}-cv`,
      });
      mockedUserRepository.findProfileByIdAndUpdate.mockResolvedValue({ _id: PROFILE_ID } as any);

      const res = await request(app)
        .patch("/v1/user/profile")
        .set("Authorization", token)
        .field("bio", "Updated bio")
        .attach("cv", Buffer.from("fake-cv-data"), {
          filename: "resume.pdf",
          contentType: "application/pdf",
        });

      expect(res.status).toBe(200);
      expect(mockedOpenai.createEmbedding).toHaveBeenCalledWith(["chunk-1"]);
      expect(mockedPg.saveTalentEmbedding).toHaveBeenCalledWith(
        USER_ID,
        ["chunk-1"],
        [{ embedding: [0.1, 0.2] }]
      );
      expect(mockedCloudinary.replaceAsset).toHaveBeenCalledWith(
        "salesplate/cv/old-cv",
        expect.any(Buffer),
        expect.objectContaining({
          folder: "salesplate/cv",
          publicId: `${USER_ID}-cv`,
          mimetype: "application/pdf",
          format: "pdf",
          resourceType: "auto",
        })
      );
      expect(mockedUserRepository.findProfileByIdAndUpdate).toHaveBeenCalledWith(
        PROFILE_ID,
        expect.objectContaining({
          bio: "Updated bio",
          cv: expect.objectContaining({
            url: "https://new-cv",
            publicId: `salesplate/cv/${USER_ID}-cv`,
            uploadedAt: expect.any(Date),
          }),
        })
      );
    });

    it("returns 400 and skips embedding/Cloudinary entirely if text extraction fails", async () => {
      const token = authHeaderFor(buildAuthUser());

      mockedUserRepository.findUserById.mockResolvedValue({
        _id: USER_ID,
        userRole: Roles.Talent,
        profile: {
          _id: PROFILE_ID,
          role: [],
          cv: { publicId: "salesplate/cv/old-cv", url: "https://old-cv" },
        },
      } as any);
      mockedFunc.extractText.mockResolvedValue("");

      const res = await request(app)
        .patch("/v1/user/profile")
        .set("Authorization", token)
        .attach("cv", Buffer.from("fake-cv-data"), {
          filename: "resume.pdf",
          contentType: "application/pdf",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Unable to extract text from CV");
      expect(mockedOpenai.createEmbedding).not.toHaveBeenCalled();
      expect(mockedCloudinary.replaceAsset).not.toHaveBeenCalled();
    });

    it("does not touch Cloudinary or update the profile if embedding saving fails", async () => {
      const token = authHeaderFor(buildAuthUser());

      mockedUserRepository.findUserById.mockResolvedValue({
        _id: USER_ID,
        userRole: Roles.Talent,
        profile: {
          _id: PROFILE_ID,
          role: [],
          cv: { publicId: "salesplate/cv/old-cv", url: "https://old-cv" },
        },
      } as any);
      mockedFunc.extractText.mockResolvedValue("raw cv text");
      mockedFunc.preprocessText.mockReturnValue("clean cv text");
      mockedFunc.overlapChunkText.mockReturnValue(["chunk-1"]);
      mockedOpenai.createEmbedding.mockResolvedValue([{ embedding: [0.1, 0.2] }] as any);
      mockedPg.saveTalentEmbedding.mockResolvedValue(null as any);

      const res = await request(app)
        .patch("/v1/user/profile")
        .set("Authorization", token)
        .attach("cv", Buffer.from("fake-cv-data"), {
          filename: "resume.pdf",
          contentType: "application/pdf",
        });

      expect(res.status).toBe(500);
      expect(mockedCloudinary.replaceAsset).not.toHaveBeenCalled();
      expect(mockedUserRepository.findProfileByIdAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe("GET /v1/user/profile/ (viewProfiles)", () => {
    it("rejects Talent users", async () => {
      const token = authHeaderFor(buildAuthUser({ userRole: Roles.Talent }));

      const res = await request(app).get("/v1/user/profile/").set("Authorization", token);

      expect(res.status).toBe(403);
      expect(mockedUserRepository.userAggregate).not.toHaveBeenCalled();
    });

    it("includes the prescreeningScore filter by default (incomplete not set)", async () => {
      const token = authHeaderFor(buildAuthUser({ userRole: Roles.Admin, profile: undefined }));
      mockedUserRepository.userAggregate.mockResolvedValue([]);

      const res = await request(app).get("/v1/user/profile/").set("Authorization", token);

      expect(res.status).toBe(200);
      const pipeline = mockedUserRepository.userAggregate.mock.calls[0]![0];
      expect(pipeline).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            $match: { "profile.prescreeningScore": { $exists: true } },
          }),
        ])
      );
    });

    it("omits the prescreeningScore filter when incomplete=true (regression for finding E)", async () => {
      const token = authHeaderFor(buildAuthUser({ userRole: Roles.Admin, profile: undefined }));
      mockedUserRepository.userAggregate.mockResolvedValue([]);

      const res = await request(app)
        .get("/v1/user/profile/")
        .query({ incomplete: "true" })
        .set("Authorization", token);

      expect(res.status).toBe(200);
      const pipeline = mockedUserRepository.userAggregate.mock.calls[0]![0];
      expect(pipeline).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            $match: { "profile.prescreeningScore": { $exists: true } },
          }),
        ])
      );
    });
  });

  describe("GET /v1/user/profile/:_id (viewProfile)", () => {
    it("returns 404 for a non-Talent target user", async () => {
      const token = authHeaderFor(buildAuthUser({ userRole: Roles.Admin, profile: undefined }));

      mockedUserRepository.findUserAndScoreById.mockResolvedValue({
        _id: USER_ID,
        userRole: Roles.Recruiter,
        set: jest.fn(),
      } as any);

      const res = await request(app).get(`/v1/user/profile/${USER_ID}`).set("Authorization", token);

      expect(res.status).toBe(404);
    });

    it("returns the completion virtuals for a talent (regression for finding D)", async () => {
      const token = authHeaderFor(buildAuthUser({ userRole: Roles.Admin, profile: undefined }));

      const profileDoc = new Profile({
        _id: PROFILE_ID,
        bio: "Experienced backend engineer",
        cv: { url: "https://cdn.example.com/cv.pdf", publicId: "cvs/x", uploadedAt: new Date() },
        role: [new mongoose.Types.ObjectId()],
        location: { city: "Lagos", state: "Lagos", country: "Nigeria" },
        experience: ExperienceLevel.fourToSixYears,
        maxSalary: 100000,
        minSalary: 50000,
        workType: [WorkType.Remote],
      });

      mockedUserRepository.findUserAndScoreById.mockResolvedValue({
        _id: USER_ID,
        userRole: Roles.Talent,
        set: jest.fn(),
        toJSON: () => ({
          _id: USER_ID,
          userRole: Roles.Talent,
          profile: profileDoc.toJSON(),
        }),
      } as any);

      const res = await request(app).get(`/v1/user/profile/${USER_ID}`).set("Authorization", token);

      expect(res.status).toBe(200);
      expect(res.body.data.user.profile.profileCompletionPercentage).toBe(100);
      expect(res.body.data.user.profile.isProfileComplete).toBe(true);
      expect(res.body.data.user.profile.canProceedToPlatform).toBe(true);
    });

    it("returns 400 for an invalid user id", async () => {
      const token = authHeaderFor(buildAuthUser({ userRole: Roles.Admin, profile: undefined }));

      const res = await request(app)
        .get("/v1/user/profile/not-a-valid-id")
        .set("Authorization", token);

      expect(res.status).toBe(400);
    });
  });

  describe("GET /v1/user/applications", () => {
    it("rejects non-Talent users", async () => {
      const token = authHeaderFor(buildAuthUser({ userRole: Roles.Recruiter, profile: undefined }));

      const res = await request(app).get("/v1/user/applications").set("Authorization", token);

      expect(res.status).toBe(403);
    });

    it("returns the talent's aggregated applications", async () => {
      const token = authHeaderFor(buildAuthUser());
      mockedApplicationRepository.applicationAggregate.mockResolvedValue([{ _id: "app-1" }] as any);

      const res = await request(app).get("/v1/user/applications").set("Authorization", token);

      expect(res.status).toBe(200);
      expect(res.body.data.applications).toEqual([{ _id: "app-1" }]);
    });
  });

  describe("POST /v1/user/me/image", () => {
    it("forwards the uploaded image to the profile upload logic", async () => {
      const token = authHeaderFor(buildAuthUser());
      mockedProfileController.uploadProfileImage.mockResolvedValue({
        status: true,
        message: "Profile image updated successfully",
        data: { user: { _id: USER_ID } },
        statusCode: 200,
      });

      const res = await request(app)
        .post("/v1/user/me/image")
        .set("Authorization", token)
        .attach("image", Buffer.from("fake-image-data"), {
          filename: "avatar.png",
          contentType: "image/png",
        });

      expect(res.status).toBe(200);
      expect(mockedProfileController.uploadProfileImage).toHaveBeenCalledTimes(1);
      const [, file] = mockedProfileController.uploadProfileImage.mock.calls[0]!;
      expect(file?.mimetype).toBe("image/png");
      expect(file?.originalname).toBe("avatar.png");
    });
  });
});
