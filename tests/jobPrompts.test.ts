const createCompletion = jest.fn();

jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: createCompletion } },
    embeddings: { create: jest.fn() },
  })),
}));

import { generateJobContent, generateJobField } from "../src/utils/integrations/openai.js";

const PLAIN_TEXT_RULE = 'Do not use markdown symbols (no "#", "*", "-")';
const RICH_TEXT_RULE = "Format the job brief and requirements text with this limited Markdown only";
const KEEP_SOURCE_RULE = "keep its wording, section order, lists and emphasis";

const lastSystemPrompt = (): string => {
  const params = createCompletion.mock.lastCall?.[0] as {
    messages: { role: string; content: string }[];
  };
  return params.messages.find((message) => message.role === "system")?.content ?? "";
};

beforeEach(() => {
  createCompletion.mockReset();
  createCompletion.mockResolvedValue({ choices: [{ message: { content: "{}" } }] });
});

describe("generateJobContent prompt", () => {
  it("keeps the plain-text contract when rich text is not requested", async () => {
    await generateJobContent({ role: "Backend Engineer" });

    const prompt = lastSystemPrompt();
    expect(prompt).toContain(PLAIN_TEXT_RULE);
    expect(prompt).toContain("written in plain text with clear section headers");
    expect(prompt).not.toContain(RICH_TEXT_RULE);
  });

  it("asks for the Markdown subset when rich text is requested", async () => {
    await generateJobContent({ role: "Backend Engineer", richText: true });

    const prompt = lastSystemPrompt();
    expect(prompt).toContain(RICH_TEXT_RULE);
    expect(prompt).not.toContain(PLAIN_TEXT_RULE);
    expect(prompt).not.toContain(KEEP_SOURCE_RULE);
  });

  it("asks to keep a pasted description's structure when one is given", async () => {
    await generateJobContent({ sourceText: "Responsibilities:\n- Close deals", richText: true });

    expect(lastSystemPrompt()).toContain(KEEP_SOURCE_RULE);
  });
});

describe("generateJobField prompt", () => {
  it("keeps the plain-text contract when rich text is not requested", async () => {
    await generateJobField({ field: "jobBrief", job: { role: "Backend Engineer" } });

    expect(lastSystemPrompt()).toContain(PLAIN_TEXT_RULE);
  });

  it.each(["jobBrief", "requirements"] as const)(
    "asks for the Markdown subset for %s when rich text is requested",
    async (field) => {
      await generateJobField({ field, richText: true, job: { role: "Backend Engineer" } });

      const prompt = lastSystemPrompt();
      expect(prompt).toContain(RICH_TEXT_RULE);
      expect(prompt).not.toContain(PLAIN_TEXT_RULE);
    }
  );

  it.each(["recruiterGuide", "skills", "goals"] as const)(
    "never formats %s, even when rich text is requested",
    async (field) => {
      await generateJobField({ field, richText: true, job: { role: "Backend Engineer" } });

      const prompt = lastSystemPrompt();
      expect(prompt).toContain(PLAIN_TEXT_RULE);
      expect(prompt).not.toContain(RICH_TEXT_RULE);
    }
  );
});
