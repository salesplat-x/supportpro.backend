import fs from "fs";
import path from "path";
import yaml from "js-yaml";

type Operation = {
  responses: Record<string, { content?: Record<string, unknown> }>;
  security?: unknown[];
  parameters?: { name: string; in: string }[];
};
type Spec = { paths: Record<string, Record<string, Operation>> };

const spec = yaml.load(fs.readFileSync(path.join(__dirname, "../swagger.yaml"), "utf8")) as Spec;
const ROUTE = "/interviews/{interviewId}/assessment";

describe("swagger.yaml — interview assessment", () => {
  it("documents the company's read of scores and summary, logged in, with its refusals", () => {
    const op = spec.paths[ROUTE]?.get;
    expect(op).toBeDefined();
    expect(op!.security).toEqual([{ bearerAuth: [] }]);
    expect(op!.parameters!.map((p) => p.name)).toEqual(["interviewId"]);
    expect(Object.keys(op!.responses)).toEqual(
      expect.arrayContaining(["200", "401", "403", "404"])
    );
    expect(Object.keys(op!.responses["200"]!.content ?? {})).toContain("application/json");
  });
});
