import fs from "fs";
import path from "path";
import yaml from "js-yaml";

type Operation = { responses?: Record<string, unknown> };
type Spec = { paths: Record<string, Record<string, Operation>> };

const spec = yaml.load(fs.readFileSync(path.join(__dirname, "../swagger.yaml"), "utf8")) as Spec;

describe("swagger.yaml — company activity log", () => {
  it("documents the owner-only log", () => {
    const route = spec.paths["/organizations/{_id}/activity"];
    expect(route!.get!.responses).toHaveProperty("200");
    expect(route!.get!.responses).toHaveProperty("403");
  });
});
