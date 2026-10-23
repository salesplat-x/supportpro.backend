/**
 * Defence for future routes: a User entity must serialise to JSON without its
 * secrets, even if a new endpoint forgets toPublicUser or returns a user nested
 * inside another object (application.talent, member.user, ...).
 */
import { User } from "../src/entities/User.js";
import { SECRET_USER_FIELDS, toPublicUser } from "../src/utils/publicUser.js";

const makeUser = (): User =>
  Object.assign(new User(), {
    id: "8a0c6a1e-0000-4000-8000-000000000001",
    email: "ada@acmehiring.com",
    firstName: "Ada",
    lastName: "Okafor",
    // nosemgrep: generic.secrets.security.detected-bcrypt-hash.detected-bcrypt-hash
    password: "$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234",
    emailVerificationTokenHash: "f".repeat(64),
    emailVerificationTokenExpiresAt: new Date("2026-10-24T09:00:00Z"),
    recoveryCode: "e".repeat(64),
    recoveryCodeExpiry: new Date("2026-10-23T11:00:00Z"),
  });

describe("User JSON serialisation", () => {
  it("JSON.stringify(user) leaves out every secret field and keeps the profile", () => {
    const json = JSON.parse(JSON.stringify(makeUser())) as Record<string, unknown>;
    for (const field of SECRET_USER_FIELDS) expect(json).not.toHaveProperty(field);
    expect(json).toMatchObject({ email: "ada@acmehiring.com", firstName: "Ada" });
  });

  it("a user nested inside another object or array is protected too", () => {
    const text = JSON.stringify({ application: { talent: makeUser() }, members: [makeUser()] });
    expect(text).not.toContain("$2b$10$");
    for (const field of SECRET_USER_FIELDS) expect(text).not.toContain(`"${field}"`);
  });

  it("the secrets are still readable in code (login compares the hash)", () => {
    const user = makeUser();
    expect(user.password.startsWith("$2b$10$")).toBe(true);
    expect(user.recoveryCode).toBe("e".repeat(64));
  });

  it("toPublicUser returns a copy without secrets and leaves the original intact", () => {
    const user = makeUser();
    const pub = toPublicUser(user);
    for (const field of SECRET_USER_FIELDS) expect(pub).not.toHaveProperty(field);
    expect(pub.email).toBe("ada@acmehiring.com");
    expect(user.password).toBeDefined();
  });
});
