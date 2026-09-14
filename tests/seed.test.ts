import {
  computeScale,
  orgDomain,
  recruiterEmail,
  SEED_PASSWORD,
  talentEmail,
} from "../src/seed/config.js";
import { assertNotProduction, isProductionEnv, parseSeedArgs } from "../src/seed/guard.js";

describe("seed scale", () => {
  it("computes N=50 counts from the documented formula", () => {
    expect(computeScale(50)).toEqual({
      n: 50,
      talents: 200,
      jobs: 500,
      companies: 25,
      recruitersPerCompany: 5,
      recruiters: 125,
    });
  });

  it("uses at least one company when N=1", () => {
    expect(computeScale(1)).toEqual({
      n: 1,
      talents: 4,
      jobs: 10,
      companies: 1,
      recruitersPerCompany: 5,
      recruiters: 5,
    });
  });

  it("rejects non-positive scale factors", () => {
    expect(() => computeScale(0)).toThrow(/positive integer/);
    expect(() => computeScale(-2)).toThrow(/positive integer/);
  });
});

describe("seed login identifiers", () => {
  it("uses the shared seeded password and predictable emails", () => {
    expect(SEED_PASSWORD).toBe("qaz!1234");
    expect(talentEmail(1)).toBe("talent-001@seed.test");
    expect(orgDomain(1)).toBe("seedco-01.test");
    expect(recruiterEmail(1, 1)).toBe("r01@seedco-01.test");
  });
});

describe("parseSeedArgs", () => {
  it("parses N and --reset", () => {
    expect(parseSeedArgs(["node", "seed.ts", "50", "--reset"])).toEqual({ n: 50, reset: true });
  });

  it("parses N without reset", () => {
    expect(parseSeedArgs(["node", "seed.ts", "3"])).toEqual({ n: 3, reset: false });
  });

  it("requires a positive integer N", () => {
    expect(() => parseSeedArgs(["node", "seed.ts"])).toThrow(/Usage/);
    expect(() => parseSeedArgs(["node", "seed.ts", "0"])).toThrow(/positive integer/);
  });
});

describe("production guard", () => {
  it("detects production from NODE_ENV or app env", () => {
    expect(isProductionEnv("production", "dev")).toBe(true);
    expect(isProductionEnv("dev", "production")).toBe(true);
    expect(isProductionEnv("staging", "staging")).toBe(false);
    expect(isProductionEnv("test", "test")).toBe(false);
  });

  it("throws when the app environment is production", () => {
    expect(() => assertNotProduction("production")).toThrow(/production/);
  });

  it("throws when NODE_ENV is production even if app env is not", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => assertNotProduction("dev")).toThrow(/production/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("allows non-production app environments when NODE_ENV is not production", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "dev";
    try {
      expect(() => assertNotProduction("dev")).not.toThrow();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
