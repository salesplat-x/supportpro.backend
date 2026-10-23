/**
 * API docs (swagger.yaml) for the Day 3 endpoints and the companyValues field.
 */

import fs from "fs";
import path from "path";
import yaml from "js-yaml";

type Schema = {
  type?: string;
  enum?: string[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  maxLength?: number;
};
type Operation = {
  parameters?: { name: string; in: string; schema?: Schema }[];
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

describe("swagger.yaml — problem-solving and culture-fit generation", () => {
  it.each(["/questions/problem-solving", "/questions/culture-fit"])(
    "documents POST %s with its body, limits, auth and error responses",
    (route) => {
      const op = operation(route, "post");
      const body = bodySchema(op);

      expect(body.required).toEqual(["jobId"]);
      expect(body.properties?.jobId?.type).toBe("string");
      expect(body.properties?.count).toMatchObject({ type: "integer", minimum: 1, maximum: 10 });
      expect(op.security).toEqual([{ bearerAuth: [] }]);
      expect(Object.keys(op.responses)).toEqual(
        expect.arrayContaining(["200", "400", "401", "403", "404", "502"])
      );
    }
  );

  it("documents basedOnCompanyValues on the culture-fit response", () => {
    const schema = operation("/questions/culture-fit", "post").responses["200"]!.content![
      "application/json"
    ].schema;
    expect(JSON.stringify(schema)).toContain("basedOnCompanyValues");
  });

  it("lists the new types in GET /questions questionType", () => {
    const param = operation("/questions/", "get").parameters!.find(
      (p) => p.name === "questionType"
    );
    expect(param?.schema?.enum).toEqual(expect.arrayContaining(["problem_solving", "culture_fit"]));
  });
});

describe("swagger.yaml — companyValues on the company", () => {
  it("documents PATCH /organizations/{_id} with companyValues and its limits", () => {
    const op = operation("/organizations/{_id}", "patch");
    const values = bodySchema(op).properties?.companyValues;

    expect(values).toMatchObject({ type: "array", maxItems: 10 });
    expect(values?.items).toMatchObject({ type: "string", maxLength: 200 });
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(["200", "400", "403"]));
  });
});
