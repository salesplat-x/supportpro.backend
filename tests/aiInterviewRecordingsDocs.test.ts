import fs from "fs";
import path from "path";
import yaml from "js-yaml";

type Schema = { type?: string; format?: string; properties?: Record<string, Schema> };
type Operation = {
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: { content: Record<string, { schema: Schema }> };
  responses: Record<string, { content?: Record<string, unknown> }>;
  security?: unknown[];
};
type Spec = { paths: Record<string, Record<string, Operation>> };

const spec = yaml.load(fs.readFileSync(path.join(__dirname, "../swagger.yaml"), "utf8")) as Spec;
const ROUTE = "/interviews/{interviewId}/questions/{questionId}/recording";

describe("swagger.yaml — interview recordings", () => {
  it("documents the upload: one multipart recording file, logged in, with its refusals", () => {
    const op = spec.paths[ROUTE]?.put;
    expect(op).toBeDefined();
    expect(op!.security).toEqual([{ bearerAuth: [] }]);
    expect(op!.parameters!.map((p) => p.name)).toEqual(["interviewId", "questionId"]);
    const body = op!.requestBody!.content["multipart/form-data"]!.schema;
    expect(body.properties!.recording).toMatchObject({ type: "string", format: "binary" });
    expect(Object.keys(op!.responses)).toEqual(
      expect.arrayContaining(["200", "400", "401", "403", "404", "503"])
    );
  });

  it("documents opening a recording, with 403 for anyone but the candidate and the company", () => {
    const op = spec.paths[ROUTE]?.get;
    expect(op).toBeDefined();
    expect(op!.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(op!.responses)).toEqual(
      expect.arrayContaining(["200", "401", "403", "404", "503"])
    );
    expect(Object.keys(op!.responses["200"]!.content ?? {})).toEqual(
      expect.arrayContaining(["audio/*", "video/*"])
    );
  });
});
