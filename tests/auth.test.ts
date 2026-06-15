import request from "supertest";
import jwt from "jsonwebtoken";
import createApp from "../src/createApp";
import * as userRepository from "../src/repository/v1/user";
import EmailService from "../src/services/v1/email";
import { generateHashedPassword, signToken } from "../src/helpers/utils";
import { validateAccess } from "../src/middlewares/v1/auth";
import { Roles } from "../src/typings/customs";
import env from "../src/config/env";

jest.mock("../src/repository/v1/user");
jest.mock("../src/services/v1/email");

const mockedUserRepository = jest.mocked(userRepository);
const MockedEmailService = jest.mocked(EmailService);

const app = createApp();

const PLAIN_PASSWORD = "Password1!";
const USER_ID = "507f1f77bcf86cd799439011";

describe("Auth flows", () => {
  let hashedPassword: string;

  beforeAll(async () => {
    hashedPassword = await generateHashedPassword(PLAIN_PASSWORD);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const buildUser = (overrides: Record<string, any> = {}): any => ({
    _id: USER_ID,
    email: "talent@example.com",
    firstName: "Jane",
    lastName: "Doe",
    password: hashedPassword,
    userRole: Roles.Talent,
    active: true,
    emailVerified: true,
    tokenVersion: 0,
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  describe("POST /v1/auth/register", () => {
    it("registers a new user successfully and sends a welcome email", async () => {
      mockedUserRepository.findUserByEmail.mockResolvedValue(null);
      const createdUser = buildUser({ email: "new@example.com" });
      mockedUserRepository.createTalentUserWithProfile.mockResolvedValue(createdUser as any);

      const res = await request(app).post("/v1/auth/register").send({
        email: "new@example.com",
        firstName: "New",
        lastName: "User",
        password: PLAIN_PASSWORD,
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe(true);
      expect(res.body.data.token).toBeDefined();
      expect(res.body.data.user.emailVerified).toBe(true);
      expect(MockedEmailService.prototype.sendWelcome).toHaveBeenCalledWith(createdUser);
    });

    it("creates a profile reference for a newly registered talent", async () => {
      mockedUserRepository.findUserByEmail.mockResolvedValue(null);
      const createdUser = buildUser({
        email: "new-talent@example.com",
        profile: "507f1f77bcf86cd799439099",
      });
      mockedUserRepository.createTalentUserWithProfile.mockResolvedValue(createdUser as any);

      const res = await request(app).post("/v1/auth/register").send({
        email: "new-talent@example.com",
        firstName: "New",
        lastName: "Talent",
        password: PLAIN_PASSWORD,
      });

      expect(res.status).toBe(201);
      expect(mockedUserRepository.createTalentUserWithProfile).toHaveBeenCalledWith(
        expect.objectContaining({ email: "new-talent@example.com" })
      );
      expect(res.body.data.user.profile).toBe("507f1f77bcf86cd799439099");
    });

    it("rejects registration with an email already in use", async () => {
      mockedUserRepository.findUserByEmail.mockResolvedValue(buildUser() as any);

      const res = await request(app).post("/v1/auth/register").send({
        email: "talent@example.com",
        firstName: "New",
        lastName: "User",
        password: PLAIN_PASSWORD,
      });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Email already in use");
    });

    it("rejects registration with an invalid email", async () => {
      const res = await request(app).post("/v1/auth/register").send({
        email: "not-an-email",
        firstName: "New",
        lastName: "User",
        password: PLAIN_PASSWORD,
      });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe(false);
    });

    it("rejects registration with a password longer than 72 characters", async () => {
      const res = await request(app)
        .post("/v1/auth/register")
        .send({
          email: "new@example.com",
          firstName: "New",
          lastName: "User",
          password: `Aa1!${"a".repeat(70)}`,
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("72 characters");
    });

    it("accepts a registration payload that includes a country", async () => {
      mockedUserRepository.findUserByEmail.mockResolvedValue(null);
      const createdUser = buildUser({ email: "new@example.com", country: "Nigeria" });
      mockedUserRepository.createTalentUserWithProfile.mockResolvedValue(createdUser as any);

      const res = await request(app).post("/v1/auth/register").send({
        email: "new@example.com",
        firstName: "New",
        lastName: "User",
        password: PLAIN_PASSWORD,
        country: "Nigeria",
      });

      expect(res.status).toBe(201);
      expect(mockedUserRepository.createTalentUserWithProfile).toHaveBeenCalledWith(
        expect.objectContaining({ country: "Nigeria" })
      );
    });
  });

  describe("POST /v1/auth/login", () => {
    it("logs in successfully and issues a JWT with a tokenVersion claim", async () => {
      const user = buildUser({ tokenVersion: 2 });
      mockedUserRepository.findUserByEmail.mockResolvedValue(user as any);

      const res = await request(app)
        .post("/v1/auth/login")
        .send({ email: user.email, password: PLAIN_PASSWORD });

      expect(res.status).toBe(200);
      const decoded = jwt.decode(res.body.data.token) as { tokenVersion?: number };
      expect(decoded?.tokenVersion).toBe(2);
    });

    it("rejects login with the wrong password", async () => {
      const user = buildUser();
      mockedUserRepository.findUserByEmail.mockResolvedValue(user as any);

      const res = await request(app)
        .post("/v1/auth/login")
        .send({ email: user.email, password: "WrongPassword1!" });

      expect(res.status).toBe(403);
    });

    it("rejects login for an unknown user", async () => {
      mockedUserRepository.findUserByEmail.mockResolvedValue(null);

      const res = await request(app)
        .post("/v1/auth/login")
        .send({ email: "missing@example.com", password: PLAIN_PASSWORD });

      expect(res.status).toBe(403);
    });

    it("rejects login for a deactivated account", async () => {
      const user = buildUser({ active: false });
      mockedUserRepository.findUserByEmail.mockResolvedValue(user as any);

      const res = await request(app)
        .post("/v1/auth/login")
        .send({ email: user.email, password: PLAIN_PASSWORD });

      expect(res.status).toBe(403);
      expect(res.body.message).toBe("This account has been deactivated!");
    });
  });

  describe("POST /v1/auth/forgot-password", () => {
    it("returns the same generic response for existing and non-existing emails", async () => {
      mockedUserRepository.findUserByMatch.mockResolvedValueOnce(buildUser() as any);
      const existingRes = await request(app)
        .post("/v1/auth/forgot-password")
        .send({ email: "talent@example.com" });

      mockedUserRepository.findUserByMatch.mockResolvedValueOnce(null);
      const missingRes = await request(app)
        .post("/v1/auth/forgot-password")
        .send({ email: "missing@example.com" });

      expect(existingRes.status).toBe(200);
      expect(missingRes.status).toBe(200);
      expect(existingRes.body).toEqual(missingRes.body);
    });

    it("lowercases the email before looking up the user", async () => {
      mockedUserRepository.findUserByMatch.mockResolvedValueOnce(null);

      await request(app).post("/v1/auth/forgot-password").send({ email: "MixedCase@Example.COM" });

      expect(mockedUserRepository.findUserByMatch).toHaveBeenCalledWith({
        email: "mixedcase@example.com",
      });
    });
  });

  describe("POST /v1/auth/reset-password", () => {
    it("resets the password and bumps tokenVersion for a valid OTP", async () => {
      const user = buildUser({
        recoveryCode: "123456",
        recoveryCodeExpiry: new Date(Date.now() + 60_000),
        tokenVersion: 0,
      });
      mockedUserRepository.findUserByMatch.mockResolvedValue(user as any);

      const res = await request(app).post("/v1/auth/reset-password").send({
        email: user.email,
        otp: "123456",
        password: "NewPassword1!",
      });

      expect(res.status).toBe(200);
      expect(user.tokenVersion).toBe(1);
      expect(user.recoveryCode).toBeUndefined();
      expect(user.recoveryCodeExpiry).toBeUndefined();
      expect(user.save).toHaveBeenCalled();
    });

    it("rejects an invalid or expired OTP", async () => {
      mockedUserRepository.findUserByMatch.mockResolvedValue(null);

      const res = await request(app).post("/v1/auth/reset-password").send({
        email: "talent@example.com",
        otp: "000000",
        password: "NewPassword1!",
      });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /v1/auth/logout (token validation)", () => {
    it("rejects requests without an Authorization header", async () => {
      const res = await request(app).post("/v1/auth/logout");
      expect(res.status).toBe(401);
    });

    it("rejects requests with a malformed Authorization header", async () => {
      const res = await request(app)
        .post("/v1/auth/logout")
        .set("Authorization", "NotBearerFormat");

      expect(res.status).toBe(401);
    });

    it("accepts a valid token with a matching tokenVersion", async () => {
      const user = buildUser({ tokenVersion: 0 });
      mockedUserRepository.findUserAuthById.mockResolvedValue(user as any);
      const token = signToken({ _id: USER_ID as any, email: user.email, tokenVersion: 0 });

      const res = await request(app)
        .post("/v1/auth/logout")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(user.tokenVersion).toBe(1);
    });

    it("rejects an expired token", async () => {
      const token = jwt.sign({ _id: USER_ID, tokenVersion: 0 }, env.jwt_secret!, {
        algorithm: "HS256",
        expiresIn: -10,
      });

      const res = await request(app)
        .post("/v1/auth/logout")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(401);
    });

    it("rejects a token with a mismatched tokenVersion", async () => {
      const user = buildUser({ tokenVersion: 5 });
      mockedUserRepository.findUserAuthById.mockResolvedValue(user as any);
      const token = signToken({ _id: USER_ID as any, email: user.email, tokenVersion: 0 });

      const res = await request(app)
        .post("/v1/auth/logout")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(401);
    });

    it("rejects a token signed with the wrong secret", async () => {
      const token = jwt.sign({ _id: USER_ID, tokenVersion: 0 }, "an-entirely-different-secret", {
        algorithm: "HS256",
        expiresIn: "1d",
      });

      const res = await request(app)
        .post("/v1/auth/logout")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(401);
    });
  });

  describe("validateAccess role check", () => {
    const buildMockResponse = () => {
      const res: any = {};
      res.status = jest.fn().mockReturnValue(res);
      res.json = jest.fn().mockReturnValue(res);
      return res;
    };

    it("rejects users whose role is not permitted", async () => {
      const user = buildUser({ userRole: Roles.Talent });
      mockedUserRepository.findUserAuthById.mockResolvedValue(user as any);
      const token = signToken({ _id: USER_ID as any, email: user.email, tokenVersion: 0 });

      const req: any = { headers: { authorization: `Bearer ${token}` } };
      const res = buildMockResponse();
      const next = jest.fn();

      await validateAccess([Roles.Admin])(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("allows users whose role is permitted", async () => {
      const user = buildUser({ userRole: Roles.Admin });
      mockedUserRepository.findUserAuthById.mockResolvedValue(user as any);
      const token = signToken({ _id: USER_ID as any, email: user.email, tokenVersion: 0 });

      const req: any = { headers: { authorization: `Bearer ${token}` } };
      const res = buildMockResponse();
      const next = jest.fn();

      await validateAccess([Roles.Admin])(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
