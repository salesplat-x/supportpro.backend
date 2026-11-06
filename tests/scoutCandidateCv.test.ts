import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { ScoutCandidate } from "../src/entities/ScoutCandidate.js";
import { createTalent } from "./helpers/fixtures.js";
import { createRecruiter } from "./helpers/scout.js";

jest.mock("../src/utils/integrations/spaces.js", () => ({
  uploadPrivateToSpaces: jest.fn(),
  getFromSpaces: jest.fn(),
  uploadToSpaces: jest.fn(),
  deleteFromSpaces: jest.fn(),
  deleteSpacesObjectQuietly: jest.fn(),
  spacesKeyFor: jest.fn(),
  assertSpacesConfigured: jest.fn(),
  ALLOWED_IMAGE_TYPES: [],
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn(),
  assessTalentFit: jest.fn(),
}));

const spaces = jest.requireMock("../src/utils/integrations/spaces.js") as {
  getFromSpaces: jest.Mock;
};

const WORD_FILE = Buffer.from("PK\u0003\u0004word/document.xml");

let app: ReturnType<typeof createApp>;

const createCandidate = (overrides: Partial<ScoutCandidate> = {}) => {
  const repo = testDataSource.getRepository(ScoutCandidate);
  return repo.save(
    repo.create({
      emailNormalized: `ada_${Math.random().toString(36).slice(2)}@example.com`,
      fullName: "Ada Obi",
      cvFileKey: "scout-cvs/job/cv.pdf",
      cvText: "Ada Obi. Enterprise account executive.",
      ...overrides,
    })
  );
};

const openCv = (candidateId: string, token: string) =>
  request(app)
    .get(`/v1/scout/candidates/${candidateId}/cv`)
    .set("Authorization", `Bearer ${token}`)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => callback(null, Buffer.concat(chunks)));
    });

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
});

describe("GET /v1/scout/candidates/:candidateId/cv", () => {
  it("returns a stored PDF exactly as it was uploaded", async () => {
    const { token } = await createRecruiter();
    const candidate = await createCandidate();
    const original = Buffer.from("%PDF-1.7 the real file");
    spaces.getFromSpaces.mockResolvedValue(original);

    const res = await openCv(candidate.id, token);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toBe('inline; filename="ada-obi-cv.pdf"');
    expect((res.body as Buffer).equals(original)).toBe(true);
  });

  it("rebuilds a Word CV as a real PDF so the browser can open it", async () => {
    const { token } = await createRecruiter();
    const candidate = await createCandidate({ cvFileKey: "scout-cvs/job/cv.docx" });
    spaces.getFromSpaces.mockResolvedValue(WORD_FILE);

    const res = await openCv(candidate.id, token);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(body.equals(WORD_FILE)).toBe(false);
  });

  it("explains the problem when the file is unreadable and no text was kept", async () => {
    const { token } = await createRecruiter();
    const candidate = await createCandidate({ cvFileKey: "scout-cvs/job/cv.docx", cvText: null });
    spaces.getFromSpaces.mockResolvedValue(WORD_FILE);

    const res = await openCv(candidate.id, token);

    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse((res.body as Buffer).toString()).error.code).toBe("CV_UNREADABLE");
  });

  it("returns 404 when no file is stored", async () => {
    const { token } = await createRecruiter();
    const candidate = await createCandidate({ cvFileKey: null });

    const res = await openCv(candidate.id, token);

    expect(res.status).toBe(404);
    expect(spaces.getFromSpaces).not.toHaveBeenCalled();
  });

  it("refuses a talent account", async () => {
    const { token } = await createTalent();
    const candidate = await createCandidate();

    const res = await openCv(candidate.id, token);

    expect(res.status).toBe(403);
    expect(spaces.getFromSpaces).not.toHaveBeenCalled();
  });
});
