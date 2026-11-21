import fs from "fs";
import path from "path";
import yaml from "js-yaml";

type Operation = {
  responses?: Record<string, unknown>;
  requestBody?: unknown;
};
type Spec = { paths: Record<string, Record<string, Operation>> };

const spec = yaml.load(fs.readFileSync(path.join(__dirname, "../swagger.yaml"), "utf8")) as Spec;

describe("swagger.yaml — background checks", () => {
  it("documents ordering a check and reading the checks with their overall status", () => {
    const route = spec.paths["/checks/applications/{applicationId}"];
    expect(route).toBeDefined();
    expect(route!.post!.requestBody).toBeDefined();
    expect(route!.post!.responses).toHaveProperty("201");
    expect(route!.post!.responses).toHaveProperty("409");
    expect(route!.get!.responses).toHaveProperty("200");
  });

  it("documents entering a result, the history and the ID number", () => {
    expect(spec.paths["/checks/{checkId}/result"]!.patch!.responses).toHaveProperty("200");
    expect(spec.paths["/checks/{checkId}/history"]!.get!.responses).toHaveProperty("403");
    expect(spec.paths["/checks/{checkId}/id-number"]!.get!.responses).toHaveProperty("409");
  });
});
