/**
 * API docs (swagger.yaml) for Day 6: the personality fit on an application.
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

type Schema = {
  type?: string;
  description?: string;
  items?: Schema;
  properties?: Record<string, Schema>;
};
type Spec = {
  paths: Record<
    string,
    Record<string, { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }>
  >;
};

const spec = yaml.load(fs.readFileSync(path.join(__dirname, "../swagger.yaml"), "utf8")) as Spec;

describe("swagger.yaml — Day 6 personality fit on GET /applications/{_id}", () => {
  const application = () =>
    spec.paths["/applications/{_id}"]!["get"]!.responses["200"]!.content!["application/json"]!
      .schema.properties?.data?.properties?.application;

  it("documents the fit score and reason and says candidates don't get them", () => {
    const props = application()?.properties ?? {};
    expect(props.personalityFitScore?.type).toBe("number");
    expect(props.personalityFitReason?.type).toBe("string");
    expect(props.personalityFitScore?.description).toMatch(/0.100/);
    expect(props.personalityFitScore?.description).toMatch(/candidate/i);
    expect(props.personalityFitReason?.description).toMatch(/candidate/i);
  });
});
