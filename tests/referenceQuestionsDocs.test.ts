import fs from "fs";
import path from "path";
import yaml from "js-yaml";

type Operation = {
  responses?: Record<string, unknown>;
  requestBody?: unknown;
};
type Spec = { paths: Record<string, Record<string, Operation>> };

const spec = yaml.load(fs.readFileSync(path.join(__dirname, "../swagger.yaml"), "utf8")) as Spec;

describe("swagger.yaml — company reference questions", () => {
  it("documents reading, saving and writing questions with AI", () => {
    const route = spec.paths["/organizations/{_id}/reference-questions"];
    expect(route!.get!.responses).toHaveProperty("200");
    expect(route!.put!.requestBody).toBeDefined();
    expect(route!.put!.responses).toHaveProperty("400");
    const generate = spec.paths["/organizations/{_id}/reference-questions/generate"];
    expect(generate!.post!.requestBody).toBeDefined();
    expect(generate!.post!.responses).toHaveProperty("502");
  });

  it("documents the waiting jobs and sending", () => {
    expect(
      spec.paths["/organizations/{_id}/reference-questions/jobs"]!.get!.responses
    ).toHaveProperty("200");
    const send = spec.paths["/organizations/{_id}/reference-questions/send"];
    expect(send!.post!.requestBody).toBeDefined();
    expect(send!.post!.responses).toHaveProperty("403");
  });
});
