/**
 * API docs (swagger.yaml) for Day 10: salary comparison.
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

type Op = { parameters?: { name: string; in: string; required?: boolean }[] };
const spec = yaml.load(fs.readFileSync(path.join(__dirname, "../swagger.yaml"), "utf8")) as {
  paths: Record<string, Record<string, Op>>;
};

describe("swagger.yaml — Day 10 salary comparison", () => {
  it("documents GET /jobs/salary-comparison and its query", () => {
    const op = spec.paths["/jobs/salary-comparison"]?.["get"];
    expect(op).toBeDefined();
    const names = (op!.parameters ?? []).map((p) => p.name).sort();
    expect(names).toEqual(
      [
        "compensationPeriod",
        "currency",
        "excludeJobId",
        "experienceLevel",
        "locationCity",
        "locationCountry",
        "locationState",
        "roleId",
      ].sort()
    );
    const required = (op!.parameters ?? [])
      .filter((p) => p.required)
      .map((p) => p.name)
      .sort();
    expect(required).toEqual(["compensationPeriod", "currency", "experienceLevel", "roleId"]);
  });
});
