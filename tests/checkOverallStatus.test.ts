import { overallStatus } from "../src/services/checkStatus.js";
import type { CheckStatus } from "../src/types/checks.js";

const checks = (...statuses: CheckStatus[]) => statuses.map((status) => ({ status }));

describe("overallStatus", () => {
  it("is none when no check has been ordered", () => {
    expect(overallStatus([])).toBe("none");
  });

  it("is verified when every check passed", () => {
    expect(overallStatus(checks("passed", "passed"))).toBe("verified");
  });

  it("is pending when a check is still pending and none failed or flagged", () => {
    expect(overallStatus(checks("passed", "pending"))).toBe("pending");
  });

  it("is flagged when a check is flagged, ahead of pending", () => {
    expect(overallStatus(checks("pending", "flagged"))).toBe("flagged");
    expect(overallStatus(checks("flagged", "passed"))).toBe("flagged");
  });

  it("is failed when any check failed, ahead of flagged and pending", () => {
    expect(overallStatus(checks("failed", "flagged", "pending", "passed"))).toBe("failed");
    expect(overallStatus(checks("flagged", "failed"))).toBe("failed");
  });
});
