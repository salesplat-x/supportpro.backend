/**
 * The voice endpoints' API docs list every response they can actually give.
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

interface Operation {
  requestBody: {
    content: Record<string, { schema: { properties: Record<string, { description?: string }> } }>;
  };
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema?: Record<string, unknown> }> }
  >;
}

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "swagger.yaml"), "utf8")) as {
  paths: Record<string, { post: Operation }>;
};

const routes = ["/voice/transcribe", "/voice/chat", "/voice/stream"];
const op = (route: string): Operation => {
  const entry = spec.paths[route];
  if (!entry) throw new Error(`${route} is not documented`);
  return entry.post;
};

describe("voice endpoints in swagger.yaml", () => {
  it.each(routes)("%s documents 403 for an unverified email", (route) => {
    expect(op(route).responses["403"]?.description).toContain("EMAIL_VERIFICATION_REQUIRED");
  });

  it.each(routes)("%s documents the 429 body", (route) => {
    const schema = op(route).responses["429"]?.content?.["application/json"]?.schema;
    expect(schema).toMatchObject({
      type: "object",
      properties: { status: { type: "boolean" }, message: { type: "string" } },
    });
  });

  it.each(routes)("%s documents 400 for a recording over the length limit", (route) => {
    expect(op(route).responses["400"]?.description).toMatch(/too long/i);
  });

  it.each(routes)("%s documents the 2-minute limit on the upload", (route) => {
    const audio = op(route).requestBody.content["multipart/form-data"]?.schema.properties["audio"];
    expect(audio?.description).toMatch(/2 minutes/);
  });

  it("/voice/transcribe documents 500 for a provider outage and 504 for the deadline", () => {
    const { responses } = op("/voice/transcribe");
    expect(responses["500"]).toBeDefined();
    expect(responses["504"]?.description).toContain("VOICE_TIMEOUT");
  });

  it.each(["/voice/chat", "/voice/stream"])(
    "%s documents 500 for the rare case the fallback clip itself is missing",
    (route) => {
      expect(op(route).responses["500"]).toBeDefined();
    }
  );
});
