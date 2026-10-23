import { spawnSync } from "child_process";
import path from "path";

// The Day 2 demo: "a broken version is replaced by the last good one".
const REPO = path.resolve(__dirname, "..");

describe("scripts/demo-rollback.sh", () => {
  it("shows a broken release being rolled back to the last good one", () => {
    const res = spawnSync("bash", [path.join(REPO, "scripts/demo-rollback.sh")], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const output = `${res.stdout}${res.stderr}`;

    expect(res.status).toBe(0);
    expect(output).toMatch(/release v2 .* deployed and serving/i);
    expect(output).toMatch(/release v3 .* broken.*rolled back to v2/i);
    expect(output).toContain("DEMO OK");
  });
});
