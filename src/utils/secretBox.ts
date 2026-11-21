import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import env from "../config/env.js";
import { AppError } from "./errors";

const keyBytes = (): Buffer => {
  if (!env.checksEncryptionKey) {
    throw new AppError(
      503,
      "CHECKS_ENCRYPTION_NOT_CONFIGURED",
      "Background checks are not available right now. Please try again later."
    );
  }
  return createHash("sha256").update(env.checksEncryptionKey).digest();
};

export const encryptSecret = (plain: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64")).join(".");
};

export const decryptSecret = (stored: string): string => {
  const [iv, tag, body] = stored.split(".").map((part) => Buffer.from(part, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(), iv!, { authTagLength: 16 });
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(body!), decipher.final()]).toString("utf8");
};
