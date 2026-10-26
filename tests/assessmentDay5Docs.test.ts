/**
 * API docs (swagger.yaml) for Day 5: what a recruiter reads on an application.
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

describe("swagger.yaml — Day 5 test results on GET /applications/{_id}", () => {
  const application = () =>
    spec.paths["/applications/{_id}"]!["get"]!.responses["200"]!.content!["application/json"]!
      .schema.properties?.data?.properties?.application;

  it("documents both scores and says candidates don't get them", () => {
    const props = application()?.properties ?? {};
    expect(props.problemSolvingScore?.type).toBe("number");
    expect(props.cultureFitScore?.type).toBe("number");
    expect(props.problemSolvingScore?.description).toMatch(/candidate/i);
  });

  it.each(["problemSolvingAnswers", "cultureFitAnswers"])(
    "documents %s as graded answers with score and feedback",
    (field) => {
      const item = application()?.properties?.[field]?.items?.properties ?? {};
      expect(Object.keys(item)).toEqual(
        expect.arrayContaining(["question", "answer", "score", "maxScore", "feedback"])
      );
    }
  );
});
