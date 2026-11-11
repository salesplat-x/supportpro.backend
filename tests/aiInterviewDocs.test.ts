import fs from "fs";
import path from "path";
import yaml from "js-yaml";

type Schema = {
  type?: string;
  enum?: string[];
  nullable?: boolean;
  properties?: Record<string, Schema>;
};
type Operation = { requestBody?: { content: { "application/json": { schema: Schema } } } };
type Spec = { paths: Record<string, Record<string, Operation>> };

const spec = yaml.load(fs.readFileSync(path.join(__dirname, "../swagger.yaml"), "utf8")) as Spec;

describe("swagger.yaml — interview switch on the AI setup", () => {
  it.each([
    ["/ai-config/", "post"],
    ["/ai-config/{_id}", "patch"],
  ])("documents aiInterview and aiInterviewMode on %s %s", (route, method) => {
    const props =
      spec.paths[route]![method]!.requestBody!.content["application/json"].schema.properties!;
    expect(props.aiInterview).toMatchObject({ type: "boolean" });
    expect(props.aiInterviewMode).toMatchObject({ type: "string", enum: ["audio", "audio_video"] });
  });
});
