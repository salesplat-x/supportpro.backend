import fs from "fs";
import path from "path";
import yaml from "js-yaml";

type Schema = { type?: string; maxLength?: number; properties?: Record<string, Schema> };
type Op = {
  parameters?: { name: string; in: string; schema?: Schema }[];
  requestBody?: { content: Record<string, { schema: Schema }> };
};
const spec = yaml.load(fs.readFileSync(path.join(__dirname, "../swagger.yaml"), "utf8")) as {
  paths: Record<string, Record<string, Op>>;
};

describe("swagger.yaml — Day 9 applicant source", () => {
  const route = spec.paths["/jobs/applications/{jobId}"]!;

  it("documents source on the apply body", () => {
    const body = route["patch"]!.requestBody?.content["application/json"]?.schema;
    expect(body?.properties?.["source"]?.type).toBe("string");
    expect(body?.properties?.["source"]?.maxLength).toBe(50);
  });

  it("documents the source filter on the applicant list", () => {
    const param = route["get"]!.parameters?.find((p) => p.name === "source");
    expect(param?.in).toBe("query");
    expect(param?.schema?.type).toBe("string");
  });

  it("documents source on the application", () => {
    const text = fs.readFileSync(path.join(__dirname, "../swagger.yaml"), "utf8");
    const app = text.slice(text.indexOf("  /applications/{_id}:"));
    expect(app.slice(0, app.indexOf("\n  /", 5))).toMatch(
      /\n\s+source:\n\s+type: string\n\s+nullable: true/
    );
  });
});
