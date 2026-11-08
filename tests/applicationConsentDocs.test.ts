import fs from "fs";
import path from "path";
import yaml from "js-yaml";

type Operation = {
  responses?: Record<string, unknown>;
  requestBody?: unknown;
};
type Spec = { paths: Record<string, Record<string, Operation>> };

const spec = yaml.load(fs.readFileSync(path.join(__dirname, "../swagger.yaml"), "utf8")) as Spec;

describe("swagger.yaml — background check consent", () => {
  it("documents the candidate agreeing and the company reading the agreement", () => {
    const route = spec.paths["/checks/applications/{applicationId}/consent"];
    expect(route).toBeDefined();
    expect(route!.post!.requestBody).toBeDefined();
    expect(route!.post!.responses).toHaveProperty("201");
    expect(route!.post!.responses).toHaveProperty("403");
    expect(route!.get!.responses).toHaveProperty("200");
  });
});
