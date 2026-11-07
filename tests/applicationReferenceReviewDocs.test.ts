import fs from "fs";
import path from "path";
import yaml from "js-yaml";

type Operation = {
  responses?: Record<string, unknown>;
  requestBody?: unknown;
};
type Spec = { paths: Record<string, Record<string, Operation>> };

const spec = yaml.load(fs.readFileSync(path.join(__dirname, "../swagger.yaml"), "utf8")) as Spec;

describe("swagger.yaml — company reads references", () => {
  it("documents the company answers route and the resend route", () => {
    const answers = spec.paths["/references/applications/{applicationId}/answers"];
    expect(answers).toBeDefined();
    expect(answers!.get!.responses).toHaveProperty("200");
    expect(answers!.get!.responses).toHaveProperty("403");
    const resend = spec.paths["/references/{referenceId}/resend"];
    expect(resend).toBeDefined();
    expect(resend!.post!.responses).toHaveProperty("200");
    expect(resend!.post!.responses).toHaveProperty("409");
  });
});
