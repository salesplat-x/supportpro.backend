import fs from "fs";
import path from "path";
import yaml from "js-yaml";

type Operation = {
  responses?: Record<string, unknown>;
  requestBody?: unknown;
};
type Spec = { paths: Record<string, Record<string, Operation>> };

const spec = yaml.load(fs.readFileSync(path.join(__dirname, "../swagger.yaml"), "utf8")) as Spec;

describe("swagger.yaml — referee answers", () => {
  it("documents the public referee link routes", () => {
    const route = spec.paths["/references/respond/{token}"];
    expect(route).toBeDefined();
    expect(route!.get!.responses).toHaveProperty("200");
    expect(route!.get!.responses).toHaveProperty("410");
    expect(route!.post!.requestBody).toBeDefined();
    expect(route!.post!.responses).toHaveProperty("200");
    expect(route!.post!.responses).toHaveProperty("410");
  });
});
