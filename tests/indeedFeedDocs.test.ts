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

describe("swagger.yaml — Day 8 Indeed job feed", () => {
  it("documents the public feed route as XML with no login", () => {
    const get = (spec.paths["/organizations/{_id}/jobs.xml"] as Record<string, unknown> | undefined)
      ?.get as
      | { security?: unknown[]; responses: Record<string, { content?: Record<string, unknown> }> }
      | undefined;
    expect(get).toBeDefined();
    expect(get!.security).toEqual([]);
    expect(Object.keys(get!.responses["200"]!.content ?? {})).toContain("application/xml");
    expect(get!.responses["404"]).toBeDefined();
  });
});
