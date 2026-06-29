import { getProfileCompletion } from "../src/services/user.js";
import { User } from "../src/entities/User.js";
import { Role } from "../src/entities/Role.js";
import { UserRole, Currency } from "../src/types/enums.js";

function buildUser(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: "test-id",
    email: "test@example.com",
    password: "hashed",
    firstName: "Jane",
    lastName: "Doe",
    userRole: UserRole.Talent,
    emailVerified: true,
    active: true,
    tokenVersion: 0,
    roleChangeCount: 0,
    bio: null,
    cvUrl: null,
    cvPublicId: null,
    cvUploadedAt: null,
    workType: null,
    locationCity: null,
    locationState: null,
    locationCountry: null,
    experience: null,
    currency: Currency.NGN,
    maxSalary: null,
    minSalary: null,
    prescreeningScore: null,
    assessmentRetryDate: null,
    userRoles: [],
    ...overrides,
  } as User);
}

function buildRole(name: string): Role {
  return Object.assign(new Role(), { id: "role-id", name });
}

describe("getProfileCompletion", () => {
  it("returns 0% for a blank profile", () => {
    const user = buildUser();
    const result = getProfileCompletion(user);
    expect(result.percentage).toBe(0);
    expect(result.isProfileComplete).toBe(false);
    expect(result.canProceedToPlatform).toBe(false);
  });

  it("returns 100% for a fully filled profile", () => {
    const user = buildUser({
      bio: "Experienced developer",
      cvUrl: "https://res.cloudinary.com/cv.pdf",
      workType: ["remote"],
      locationCountry: "Nigeria",
      experience: "4-6 years",
      maxSalary: 100000,
      minSalary: 50000,
      userRoles: [buildRole("software-engineer")],
    });
    const result = getProfileCompletion(user);
    expect(result.percentage).toBe(100);
    expect(result.isProfileComplete).toBe(true);
  });

  it("canProceedToPlatform requires CV and at least one role", () => {
    const withCvOnly = buildUser({ cvUrl: "https://example.com/cv.pdf" });
    expect(getProfileCompletion(withCvOnly).canProceedToPlatform).toBe(false);

    const withRoleOnly = buildUser({ userRoles: [buildRole("engineer")] });
    expect(getProfileCompletion(withRoleOnly).canProceedToPlatform).toBe(false);

    const withBoth = buildUser({
      cvUrl: "https://example.com/cv.pdf",
      userRoles: [buildRole("engineer")],
    });
    expect(getProfileCompletion(withBoth).canProceedToPlatform).toBe(true);
  });
});
