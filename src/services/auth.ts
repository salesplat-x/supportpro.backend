import { Repository } from "typeorm";
import { createHash, timingSafeEqual } from "crypto";
import { AppDataSource } from "../database/dataSource.js";
import { User } from "../entities/User.js";
import { UserRole } from "../types/enums.js";
import {
  compareHashedPassword,
  generateHashedPassword,
  generateOTP,
  generateVerificationToken,
  signToken,
} from "../utils/crypto.js";
import EmailService from "../utils/integrations/email";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
} from "../utils/errors";
import logger from "../utils/logger.js";

const userRepo = (): Repository<User> => AppDataSource.getRepository(User);

export const createUser = async (
  payload: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    middleName?: string;
    country?: string;
  },
  role: UserRole.Talent | UserRole.Recruiter,
  ip?: string,
  redirectPath?: string
): Promise<{ user: User; token: string }> => {
  const email = payload.email.toLowerCase();

  const existing = await userRepo().findOne({ where: { email } });
  if (existing) throw new ConflictError("Email already in use");

  const hashedPassword = await generateHashedPassword(payload.password);

  const user = userRepo().create({
    ...payload,
    email,
    password: hashedPassword,
    // role is always set by the route (register vs. register/recruiter), never
    // trusted from the request body — the admin account can only be created by
    // the seedAdmin script, so no public endpoint can ever mint an admin user.
    userRole: role,
    roleChangeCount: 0,
  });

  const saved = await userRepo().save(user);

  const { token: verificationToken, tokenHash, expires } = generateVerificationToken();
  await userRepo()
    .createQueryBuilder()
    .update(User)
    .set({ emailVerificationTokenHash: tokenHash, emailVerificationTokenExpiresAt: expires })
    .where("id = :id", { id: saved.id })
    .execute();

  new EmailService()
    .sendVerificationEmail(saved, verificationToken, redirectPath)
    .catch((err: Error) =>
      logger.error(`Verification email failed for user ${saved.id}: ${err.message}`)
    );
  logger.info(`User registered: id=${saved.id} email=${saved.email} ip=${ip ?? "unknown"}`);

  const token = signToken(saved);
  return { user: saved, token };
};

export const loginUser = async (
  { email, password }: { email: string; password: string },
  ip?: string
): Promise<{ user: User; token: string }> => {
  const user = await userRepo()
    .createQueryBuilder("user")
    .addSelect("user.password")
    .where("user.email = :email", { email: email.toLowerCase() })
    .getOne();

  if (!user) {
    // Run a dummy bcrypt comparison to equalise response time and prevent
    // timing-based email enumeration (bcrypt takes ~100 ms; skipping it leaks existence).
    await compareHashedPassword(
      password,
      "$2b$10$dummyhashplaceholderXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
    );
    logger.error(`Failed login: email=${email} ip=${ip ?? "unknown"}`);
    throw new AuthorizationError("Invalid email or password");
  }

  if (!(await compareHashedPassword(password, user.password))) {
    logger.error(`Failed login: id=${user.id} email=${user.email} ip=${ip ?? "unknown"}`);
    throw new AuthorizationError("Invalid email or password");
  }

  if (!user.active) {
    logger.error(`Login on deactivated account: id=${user.id} email=${user.email}`);
    throw new AuthorizationError("This account has been deactivated");
  }

  logger.info(`User logged in: id=${user.id} email=${user.email} ip=${ip ?? "unknown"}`);
  const token = signToken(user);
  return { user, token };
};

export const forgotPassword = async ({ email }: { email: string }, ip?: string): Promise<void> => {
  logger.info(`Password reset requested: email=${email.toLowerCase()} ip=${ip ?? "unknown"}`);

  const user = await userRepo().findOne({ where: { email: email.toLowerCase() } });
  if (!user) return; // Generic response for security — don't reveal whether email exists

  const { otp, expires } = await generateOTP(5);

  await userRepo()
    .createQueryBuilder()
    .update(User)
    .set({ recoveryCode: otp, recoveryCodeExpiry: expires })
    .where("id = :id", { id: user.id })
    .execute();

  await new EmailService().sendPasswordReset(user, otp);
};

export const resetPassword = async (
  payload: { email: string; otp: string; password: string },
  ip?: string
): Promise<void> => {
  const { email, otp, password } = payload;

  // Fetch by email only; compare OTP in application code using timingSafeEqual
  // to prevent timing-based OTP enumeration attacks.
  const user = await userRepo()
    .createQueryBuilder("user")
    .addSelect(["user.recoveryCode", "user.recoveryCodeExpiry"])
    .where("user.email = :email", { email: email.toLowerCase() })
    .getOne();

  const invalidToken = () => {
    logger.error(`Password reset failed: email=${email.toLowerCase()} ip=${ip ?? "unknown"}`);
    throw new AuthenticationError("Password reset token is invalid or has expired");
  };

  if (!user || !user.recoveryCode || !user.recoveryCodeExpiry) {
    invalidToken();
    return; // unreachable — satisfies TypeScript control-flow
  }

  // Constant-time comparison to prevent timing side-channel on OTP value.
  // Buffers must be the same length for timingSafeEqual; pad to the stored code length.
  const storedBuf = Buffer.from(user.recoveryCode, "utf8");
  const inputBuf = Buffer.from(
    otp.padEnd(user.recoveryCode.length, "\0").slice(0, user.recoveryCode.length),
    "utf8"
  );
  const otpMatches =
    storedBuf.length === inputBuf.length &&
    timingSafeEqual(new Uint8Array(storedBuf), new Uint8Array(inputBuf));
  if (!otpMatches || new Date() > user.recoveryCodeExpiry) {
    invalidToken();
    return;
  }

  const hashedPassword = await generateHashedPassword(password);

  await userRepo()
    .createQueryBuilder()
    .update(User)
    .set({
      password: hashedPassword,
      recoveryCode: () => "NULL",
      recoveryCodeExpiry: () => "NULL",
      tokenVersion: () => `"tokenVersion" + 1`,
    })
    .where("id = :id", { id: user.id })
    .execute();

  logger.info(`Password reset: id=${user.id} email=${user.email} ip=${ip ?? "unknown"}`);
};

export const changePassword = async (
  userId: string,
  payload: { oldPassword: string; newPassword: string },
  ip?: string
): Promise<{ user: User; token: string }> => {
  const user = await userRepo()
    .createQueryBuilder("user")
    .addSelect("user.password")
    .where("user.id = :id", { id: userId })
    .getOne();

  if (!user) throw new NotFoundError("User not found");

  if (!(await compareHashedPassword(payload.oldPassword, user.password))) {
    logger.error(`Password change failed: id=${user.id} ip=${ip ?? "unknown"}`);
    throw new AuthorizationError("Invalid password");
  }

  const hashedPassword = await generateHashedPassword(payload.newPassword);

  await userRepo()
    .createQueryBuilder()
    .update(User)
    .set({ password: hashedPassword, tokenVersion: () => `"tokenVersion" + 1` })
    .where("id = :id", { id: userId })
    .execute();

  const updated = await userRepo().findOneOrFail({ where: { id: userId } });
  logger.info(`Password changed: id=${updated.id} ip=${ip ?? "unknown"}`);
  const token = signToken(updated);
  return { user: updated, token };
};

export const logout = async (userId: string, ip?: string): Promise<void> => {
  const user = await userRepo().findOne({ where: { id: userId } });
  if (!user) throw new NotFoundError("User not found");

  await userRepo()
    .createQueryBuilder()
    .update(User)
    .set({ tokenVersion: () => `"tokenVersion" + 1` })
    .where("id = :id", { id: userId })
    .execute();

  logger.info(`User logged out: id=${user.id} email=${user.email} ip=${ip ?? "unknown"}`);
};

export const verifyEmail = async ({ token }: { token: string }, ip?: string): Promise<void> => {
  const tokenHash = createHash("sha256").update(token).digest("hex");

  const user = await userRepo()
    .createQueryBuilder("user")
    .addSelect(["user.emailVerificationTokenHash", "user.emailVerificationTokenExpiresAt"])
    .where("user.emailVerificationTokenHash = :tokenHash", { tokenHash })
    .getOne();

  if (
    !user ||
    !user.emailVerificationTokenExpiresAt ||
    new Date() > user.emailVerificationTokenExpiresAt
  ) {
    logger.error(`Email verification failed: ip=${ip ?? "unknown"}`);
    throw new AuthenticationError("Verification link is invalid or has expired");
  }

  await userRepo()
    .createQueryBuilder()
    .update(User)
    .set({
      emailVerifiedAt: () => "now()",
      emailVerificationTokenHash: () => "NULL",
      emailVerificationTokenExpiresAt: () => "NULL",
    })
    .where('id = :id AND "emailVerificationTokenHash" = :tokenHash', { id: user.id, tokenHash })
    .execute();

  // Atomic conditional update: only the request that actually flips
  // welcomeEmailSentAt from NULL sends the welcome email, so concurrent or
  // retried verify calls can never send it more than once.
  const result = await userRepo()
    .createQueryBuilder()
    .update(User)
    .set({ welcomeEmailSentAt: () => "now()" })
    .where('id = :id AND "welcomeEmailSentAt" IS NULL', { id: user.id })
    .execute();

  if ((result.affected ?? 0) > 0) {
    await new EmailService().sendWelcome(user);
  }

  logger.info(`Email verified: id=${user.id} email=${user.email} ip=${ip ?? "unknown"}`);
};

export const resendVerification = async (
  userId: string,
  ip?: string,
  redirectPath?: string
): Promise<void> => {
  const user = await userRepo().findOne({ where: { id: userId } });
  if (!user) throw new NotFoundError("User not found");

  if (user.emailVerifiedAt) {
    logger.info(`Resend verification no-op (already verified): id=${user.id}`);
    return;
  }

  const { token, tokenHash, expires } = generateVerificationToken();

  await userRepo()
    .createQueryBuilder()
    .update(User)
    .set({ emailVerificationTokenHash: tokenHash, emailVerificationTokenExpiresAt: expires })
    .where("id = :id", { id: user.id })
    .execute();

  await new EmailService().sendVerificationEmail(user, token, redirectPath);
  logger.info(`Verification email resent: id=${user.id} ip=${ip ?? "unknown"}`);
};

export const changeEmail = async (
  userId: string,
  payload: { newEmail: string; currentPassword: string },
  ip?: string
): Promise<{ user: User; token: string }> => {
  const user = await userRepo()
    .createQueryBuilder("user")
    .addSelect(["user.password", "user.emailVerifiedAt"])
    .where("user.id = :id", { id: userId })
    .getOne();

  if (!user) throw new NotFoundError("User not found");

  if (user.emailVerifiedAt) {
    throw new ConflictError("Verified email addresses cannot be changed");
  }

  if (!(await compareHashedPassword(payload.currentPassword, user.password))) {
    logger.error(`Change email failed: id=${user.id} ip=${ip ?? "unknown"}`);
    throw new AuthorizationError("Invalid password");
  }

  const newEmail = payload.newEmail.toLowerCase();
  const existing = await userRepo().findOne({ where: { email: newEmail } });
  if (existing) throw new ConflictError("Email already in use");

  const { token, tokenHash, expires } = generateVerificationToken();

  await userRepo()
    .createQueryBuilder()
    .update(User)
    .set({
      email: newEmail,
      emailVerificationTokenHash: tokenHash,
      emailVerificationTokenExpiresAt: expires,
      tokenVersion: () => `"tokenVersion" + 1`,
    })
    .where("id = :id", { id: userId })
    .execute();

  const updated = await userRepo().findOneOrFail({ where: { id: userId } });
  await new EmailService().sendVerificationEmail(updated, token);
  logger.info(`Email changed: id=${updated.id} email=${updated.email} ip=${ip ?? "unknown"}`);

  const signedToken = signToken(updated);
  return { user: updated, token: signedToken };
};
