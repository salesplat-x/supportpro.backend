import type { User } from "../entities/User.js";

/**
 * User columns that must never leave the API: the bcrypt password hash, the
 * email-verification token hash and the password-reset code, plus their expiry
 * times. They are `select: false` on the entity, but an entity that was just
 * created (register) or loaded with `addSelect` (login) still carries them, so
 * every response that returns a user goes through toPublicUser.
 */
export const SECRET_USER_FIELDS = [
  "password",
  "emailVerificationTokenHash",
  "emailVerificationTokenExpiresAt",
  "recoveryCode",
  "recoveryCodeExpiry",
] as const satisfies ReadonlyArray<keyof User>;

export type SecretUserField = (typeof SECRET_USER_FIELDS)[number];

/** A shallow copy of the user without any secret field. */
export const toPublicUser = <T extends object>(user: T): Omit<T, SecretUserField> => {
  const copy = { ...user } as Record<string, unknown>;
  for (const field of SECRET_USER_FIELDS) delete copy[field];
  return copy as Omit<T, SecretUserField>;
};
