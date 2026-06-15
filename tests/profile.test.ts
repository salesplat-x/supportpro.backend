import mongoose from "mongoose";
import { Profile } from "../src/models/v1/user";
import * as profileController from "../src/logics/v1/profile";
import * as userRepository from "../src/repository/v1/user";
import * as cloudinaryService from "../src/services/v1/cloudinary";
import * as func from "../src/helpers/func";
import * as openaiService from "../src/services/v1/openai";
import * as pgRepository from "../src/repository/v1/pg";
import { requireCompletedProfile } from "../src/middlewares/v1/auth";
import { Roles, ExperienceLevel } from "../src/typings/customs";

jest.mock("../src/repository/v1/user");
jest.mock("../src/services/v1/cloudinary");
jest.mock("../src/helpers/func");
jest.mock("../src/services/v1/openai");
jest.mock("../src/repository/v1/pg");

const mockedUserRepository = jest.mocked(userRepository);
const mockedCloudinary = jest.mocked(cloudinaryService);
const mockedFunc = jest.mocked(func);
const mockedOpenai = jest.mocked(openaiService);
const mockedPg = jest.mocked(pgRepository);

const USER_ID = "507f1f77bcf86cd799439011";
const PROFILE_ID = "507f1f77bcf86cd799439022";

describe("Profile completion virtuals", () => {
  it("reports 0% completion for an empty profile and blocks platform access", () => {
    const profile = new Profile({ role: [], remote: false, onSite: false, hybrid: false });

    expect(profile.profileCompletionPercentage).toBe(0);
    expect(profile.isProfileComplete).toBe(false);
    expect(profile.canProceedToPlatform).toBe(false);
  });

  it("allows platform access once cv + role are set, even if other fields are missing", () => {
    const profile = new Profile({
      role: [new mongoose.Types.ObjectId()],
      cv: { url: "https://cdn.example.com/cv.pdf", publicId: "cvs/x", uploadedAt: new Date() },
      remote: false,
      onSite: false,
      hybrid: false,
    });

    expect(profile.canProceedToPlatform).toBe(true);
    expect(profile.isProfileComplete).toBe(false);
    expect(profile.profileCompletionPercentage).toBeGreaterThan(0);
    expect(profile.profileCompletionPercentage).toBeLessThan(100);
  });

  it("reports 100% completion when every tracked field is filled", () => {
    const profile = new Profile({
      bio: "Experienced backend engineer",
      cv: { url: "https://cdn.example.com/cv.pdf", publicId: "cvs/x", uploadedAt: new Date() },
      role: [new mongoose.Types.ObjectId()],
      location: { city: "Lagos", state: "Lagos", country: "Nigeria" },
      experience: ExperienceLevel.fourToSixYears,
      maxSalary: 100000,
      minSalary: 50000,
      remote: true,
      onSite: false,
      hybrid: false,
    });

    expect(profile.profileCompletionPercentage).toBe(100);
    expect(profile.isProfileComplete).toBe(true);
    expect(profile.canProceedToPlatform).toBe(true);
  });
});

describe("uploadProfileImage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const buildFile = (mimetype = "image/png"): Express.Multer.File =>
    ({
      buffer: Buffer.from("fake-image"),
      mimetype,
      originalname: "avatar.png",
    }) as Express.Multer.File;

  it("rejects unsupported mimetypes without touching the database or Cloudinary", async () => {
    const response = await profileController.uploadProfileImage(
      { _id: USER_ID } as any,
      buildFile("application/zip")
    );

    expect(response.status).toBe(false);
    expect(response.statusCode).toBe(400);
    expect(mockedUserRepository.findUserById).not.toHaveBeenCalled();
    expect(mockedCloudinary.replaceAsset).not.toHaveBeenCalled();
  });

  it("replaces the old profile image asset and stores the new publicId", async () => {
    mockedUserRepository.findUserById.mockResolvedValue({
      _id: USER_ID,
      profileImage: { url: "https://old", publicId: "supportpro/profilepicture/old-image" },
    } as any);
    mockedCloudinary.replaceAsset.mockResolvedValue({
      url: "https://new",
      publicId: `supportpro/profilepicture/${USER_ID}-image`,
    });
    mockedUserRepository.findUserByIdAndUpdate.mockResolvedValue({ _id: USER_ID } as any);

    const file = buildFile("image/png");
    const response = await profileController.uploadProfileImage({ _id: USER_ID } as any, file);

    expect(response.status).toBe(true);
    expect(mockedCloudinary.replaceAsset).toHaveBeenCalledWith(
      "supportpro/profilepicture/old-image",
      file.buffer,
      expect.objectContaining({
        folder: "supportpro/profilepicture",
        publicId: `${USER_ID}-image`,
        mimetype: "image/png",
        resourceType: "image",
      })
    );
    expect(mockedUserRepository.findUserByIdAndUpdate).toHaveBeenCalledWith(USER_ID, {
      profileImage: { url: "https://new", publicId: `supportpro/profilepicture/${USER_ID}-image` },
    });
  });
});

describe("uploadCv", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const buildFile = (mimetype = "application/pdf"): Express.Multer.File =>
    ({
      buffer: Buffer.from("fake-cv"),
      mimetype,
      originalname: "resume.pdf",
    }) as Express.Multer.File;

  it("rejects unsupported CV mimetypes without touching the database or Cloudinary", async () => {
    const response = await profileController.uploadCv(
      { _id: USER_ID } as any,
      buildFile("image/png")
    );

    expect(response.status).toBe(false);
    expect(response.statusCode).toBe(400);
    expect(mockedUserRepository.findUserById).not.toHaveBeenCalled();
    expect(mockedCloudinary.replaceAsset).not.toHaveBeenCalled();
  });

  it("extracts text, saves the embedding, then replaces the old CV asset", async () => {
    mockedUserRepository.findUserById.mockResolvedValue({
      _id: USER_ID,
      profile: { _id: PROFILE_ID, cv: { publicId: "supportpro/cvs/old-cv", url: "https://old-cv" } },
    } as any);
    mockedFunc.extractText.mockResolvedValue("raw cv text");
    mockedFunc.preprocessText.mockReturnValue("clean cv text");
    mockedFunc.overlapChunkText.mockReturnValue(["chunk-1"]);
    mockedOpenai.createEmbedding.mockResolvedValue([{ embedding: [0.1, 0.2] }] as any);
    mockedPg.saveTalentEmbedding.mockResolvedValue({ rowCount: 1 } as any);
    mockedCloudinary.replaceAsset.mockResolvedValue({
      url: "https://new-cv",
      publicId: `supportpro/cvs/${USER_ID}-cv`,
    });
    mockedUserRepository.findProfileByIdAndUpdate.mockResolvedValue({ _id: PROFILE_ID } as any);

    const file = buildFile("application/pdf");
    const response = await profileController.uploadCv({ _id: USER_ID } as any, file);

    expect(response.status).toBe(true);
    expect(mockedOpenai.createEmbedding).toHaveBeenCalledWith(["chunk-1"]);
    expect(mockedPg.saveTalentEmbedding).toHaveBeenCalledWith(
      USER_ID,
      ["chunk-1"],
      [{ embedding: [0.1, 0.2] }]
    );
    expect(mockedCloudinary.replaceAsset).toHaveBeenCalledWith(
      "supportpro/cvs/old-cv",
      file.buffer,
      expect.objectContaining({
        folder: "supportpro/cvs",
        publicId: `${USER_ID}-cv`,
        mimetype: "application/pdf",
        format: "pdf",
        resourceType: "auto",
      })
    );
    expect(mockedUserRepository.findProfileByIdAndUpdate).toHaveBeenCalledWith(
      PROFILE_ID,
      expect.objectContaining({
        cv: expect.objectContaining({
          url: "https://new-cv",
          publicId: `supportpro/cvs/${USER_ID}-cv`,
          uploadedAt: expect.any(Date),
        }),
      })
    );
  });

  it("does not touch Cloudinary or the old CV if embedding saving fails", async () => {
    mockedUserRepository.findUserById.mockResolvedValue({
      _id: USER_ID,
      profile: { _id: PROFILE_ID, cv: { publicId: "supportpro/cvs/old-cv", url: "https://old-cv" } },
    } as any);
    mockedFunc.extractText.mockResolvedValue("raw cv text");
    mockedFunc.preprocessText.mockReturnValue("clean cv text");
    mockedFunc.overlapChunkText.mockReturnValue(["chunk-1"]);
    mockedOpenai.createEmbedding.mockResolvedValue([{ embedding: [0.1, 0.2] }] as any);
    mockedPg.saveTalentEmbedding.mockResolvedValue(null as any);

    const file = buildFile("application/pdf");
    const response = await profileController.uploadCv({ _id: USER_ID } as any, file);

    expect(response.status).toBe(false);
    expect(response.statusCode).toBe(500);
    expect(mockedCloudinary.replaceAsset).not.toHaveBeenCalled();
    expect(mockedUserRepository.findProfileByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 and skips embedding/Cloudinary entirely if text extraction fails", async () => {
    mockedUserRepository.findUserById.mockResolvedValue({
      _id: USER_ID,
      profile: { _id: PROFILE_ID, cv: { publicId: "supportpro/cvs/old-cv", url: "https://old-cv" } },
    } as any);
    mockedFunc.extractText.mockResolvedValue("");

    const file = buildFile("application/pdf");
    const response = await profileController.uploadCv({ _id: USER_ID } as any, file);

    expect(response.status).toBe(false);
    expect(response.statusCode).toBe(400);
    expect(mockedOpenai.createEmbedding).not.toHaveBeenCalled();
    expect(mockedCloudinary.replaceAsset).not.toHaveBeenCalled();
  });
});

describe("requireCompletedProfile middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const buildMockResponse = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  it("allows non-Talent users through without looking up a profile", async () => {
    const req: any = { user: { userRole: Roles.Recruiter, profile: undefined } };
    const res = buildMockResponse();
    const next = jest.fn();

    await requireCompletedProfile(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockedUserRepository.findProfileById).not.toHaveBeenCalled();
  });

  it("blocks a Talent with no profile reference", async () => {
    const req: any = { user: { userRole: Roles.Talent, profile: undefined } };
    const res = buildMockResponse();
    const next = jest.fn();

    await requireCompletedProfile(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("blocks a Talent whose profile is incomplete (missing cv/role)", async () => {
    mockedUserRepository.findProfileById.mockResolvedValue(
      new Profile({ role: [], remote: false, onSite: false, hybrid: false })
    );
    const req: any = { user: { userRole: Roles.Talent, profile: PROFILE_ID } };
    const res = buildMockResponse();
    const next = jest.fn();

    await requireCompletedProfile(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("allows a Talent who can proceed to the platform", async () => {
    mockedUserRepository.findProfileById.mockResolvedValue(
      new Profile({
        role: [new mongoose.Types.ObjectId()],
        cv: { url: "https://cdn.example.com/cv.pdf", publicId: "cvs/x", uploadedAt: new Date() },
        remote: false,
        onSite: false,
        hybrid: false,
      })
    );
    const req: any = { user: { userRole: Roles.Talent, profile: PROFILE_ID } };
    const res = buildMockResponse();
    const next = jest.fn();

    await requireCompletedProfile(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
