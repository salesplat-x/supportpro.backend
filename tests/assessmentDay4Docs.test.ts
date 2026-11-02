import fs from "fs";
import path from "path";
import yaml from "js-yaml";

type Schema = {
  type?: string;
  minimum?: number;
  maximum?: number;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
};
type Operation = {
  parameters?: { name: string; in: string; required?: boolean; schema?: Schema }[];
  requestBody?: { content: { "application/json": { schema: Schema } } };
  responses: Record<string, { content?: { "application/json": { schema: Schema } } }>;
  security?: unknown[];
};
type Spec = { paths: Record<string, Record<string, Operation>> };

const spec = yaml.load(fs.readFileSync(path.join(__dirname, "../swagger.yaml"), "utf8")) as Spec;

const operation = (route: string, method: string): Operation => {
  const op = spec.paths[route]?.[method];
  if (!op) throw new Error(`${method.toUpperCase()} ${route} is not documented`);
  return op;
};
const bodySchema = (op: Operation) => op.requestBody!.content["application/json"].schema;
const okData = (op: Operation) =>
  op.responses["200"]!.content!["application/json"].schema.properties!.data!;

describe("swagger.yaml — Day 4 switches on the AI setup", () => {
  it.each([
    ["/ai-config/", "post"],
    ["/ai-config/{_id}", "patch"],
  ])("documents the switches and counts on %s %s", (route, method) => {
    const props = bodySchema(operation(route, method)).properties!;
    expect(props.problemSolvingAssessment).toMatchObject({ type: "boolean" });
    expect(props.cultureFitAssessment).toMatchObject({ type: "boolean" });
    for (const count of ["noOfProblemSolvingQuestions", "noOfCultureFitQuestions"]) {
      expect(props[count]).toMatchObject({ type: "integer", minimum: 1, maximum: 10 });
    }
  });
});

describe("swagger.yaml — candidate questions", () => {
  it.each(["/questions/candidate/problem-solving", "/questions/candidate/culture-fit"])(
    "documents GET %s with jobId, auth, errors and no criteria in the reply",
    (route) => {
      const op = operation(route, "get");
      const jobId = op.parameters?.find((p) => p.name === "jobId");
      expect(jobId).toMatchObject({ in: "query", required: true });
      expect(op.security).toEqual([{ bearerAuth: [] }]);
      expect(Object.keys(op.responses)).toEqual(
        expect.arrayContaining(["200", "400", "401", "403", "404", "409"])
      );
      const item = okData(op).properties!.questions!.items!;
      expect(Object.keys(item.properties!).sort()).toEqual(["id", "question", "questionType"]);
    }
  );
});

describe("swagger.yaml — candidate answers", () => {
  it.each(["/questions/answer/problem-solving", "/questions/answer/culture-fit"])(
    "documents POST %s with its body, reply and errors",
    (route) => {
      const op = operation(route, "post");
      const body = bodySchema(op);
      expect(body.required).toEqual(["jobId", "answers"]);
      expect(body.properties?.answers?.type).toBe("object");
      expect(op.security).toEqual([{ bearerAuth: [] }]);
      expect(Object.keys(op.responses)).toEqual(
        expect.arrayContaining(["200", "400", "401", "403", "404", "409", "502"])
      );
      expect(Object.keys(okData(op).properties!).sort()).toEqual([
        "answered",
        "questionType",
        "submitted",
      ]);
    }
  );
});
