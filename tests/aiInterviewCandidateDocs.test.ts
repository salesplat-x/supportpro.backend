import fs from "fs";
import path from "path";
import yaml from "js-yaml";

type Operation = {
  parameters?: { name: string; in: string; required?: boolean }[];
  responses: Record<string, unknown>;
  security?: unknown[];
};
type Spec = { paths: Record<string, Record<string, Operation>> };

const spec = yaml.load(fs.readFileSync(path.join(__dirname, "../swagger.yaml"), "utf8")) as Spec;
const ROUTE = "/interviews/{interviewId}";

describe("swagger.yaml — candidate interview", () => {
  it("documents loading the interview for the logged-in candidate, with its refusals", () => {
    const op = spec.paths[ROUTE]?.get;
    expect(op).toBeDefined();
    expect(op!.security).toEqual([{ bearerAuth: [] }]);
    expect(op!.parameters!.map((p) => p.name)).toEqual(["interviewId"]);
    expect(Object.keys(op!.responses)).toEqual(
      expect.arrayContaining(["200", "401", "403", "404"])
    );
  });
});
