import { Repository } from "typeorm";
import { timingSafeEqual } from "crypto";
import { AppDataSource } from "../database/dataSource.js";
import { User } from "../entities/User.js";
import { UserRole } from "../types/enums.js";
import {
  compareHashedPassword,
  generateHashedPassword,
  generateOTP,
  signToken,
} from "../utils/crypto.js";
import EmailService from "../utils/integrations/email/index.js";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
} from "../utils/errors/index.js";
import logger from "../utils/logger.js";

function userRepo(): Repository<User> {
  return AppDataSource.getRepository(User);
}

export const createUser = async (
  payload: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    middleName?: string;
    phone?: string;
    country?: string;
    userRole?: UserRole;
  },
  ip?: string
): Promise<{ user: User; token: string }> => {
  const email = payload.email.toLowerCase();

  const existing = await userRepo().findOne({ where: { email } });
  if (existing) throw new ConflictError("Email already in use");

  if (payload.phone) {
    const phoneExists = await userRepo().findOne({ where: { phone: payload.phone } });
    if (phoneExists) throw new ConflictError("Phone Number already in use");
  }

  const hashedPassword = await generateHashedPassword(payload.password);

  const user = userRepo().create({
    ...payload,
    email,
    password: hashedPassword,
    // emailVerified defaults to true — this product has no email-confirmation flow
    emailVerified: true,
    userRole: payload.userRole ?? UserRole.Talent,
    roleChangeCount: 0,
  });

  const saved = await userRepo().save(user);

  await new EmailService().sendWelcome(saved);
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
    await compareHashedPassword(password, "$2b$10$dummyhashplaceholderXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
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

export const forgotPassword = async (
  { email }: { email: string },
  ip?: string
): Promise<void> => {
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
  const inputBuf = Buffer.from(otp.padEnd(user.recoveryCode.length, "\0").slice(0, user.recoveryCode.length), "utf8");
  const otpMatches = storedBuf.length === inputBuf.length && timingSafeEqual(
    new Uint8Array(storedBuf),
    new Uint8Array(inputBuf)
  );
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
