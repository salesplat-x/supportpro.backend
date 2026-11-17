import {
  parseGeneratedQuestions,
  GeneratedQuestionsParseError,
  redistributeCorrectOptions,
} from "../src/utils/generatedQuestions.js";

const reply = (value: unknown) => JSON.stringify(value);
const Q1 = "You have three tasks due today and time for two. Which do you drop?";
const Q2 = "A report shows sales doubled but profit fell. What would you check first?";
const OPTIONS = ["The cheapest task", "The latest task", "The least urgent task", "None of them"];
const PARSE = { max: 5, optionCount: 4, maxOptionLength: 300 };

const item = (question: string, extra: Record<string, unknown> = {}) => ({
  question,
  options: OPTIONS,
  correctOption: 2,
  ...extra,
});

const correctText = (q: { options: string[]; correctOption: number }) => q.options[q.correctOption];

describe("parseGeneratedQuestions", () => {
  it("reads multiple-choice questions with category, criteria, options and the correct option", () => {
    const parsed = parseGeneratedQuestions(
      reply({
        questions: [
          item(Q1, { category: "prioritisation", criteria: "Least urgent goes first." }),
          item(Q2, { category: "analytical", criteria: "Margins explain it." }),
        ],
      }),
      { ...PARSE, categories: ["prioritisation", "analytical"] }
    );

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      question: Q1,
      category: "prioritisation",
      criteria: "Least urgent goes first.",
    });
    for (const q of parsed) {
      expect([...q.options].sort()).toEqual([...OPTIONS].sort());
      expect(correctText(q)).toBe("The least urgent task");
    }
  });

  it("accepts a bare JSON array and strips a markdown code fence", () => {
    expect(parseGeneratedQuestions(reply([item(Q1)]), PARSE)).toHaveLength(1);
    const fenced = "```json\n" + reply({ questions: [item(Q1)] }) + "\n```";
    expect(parseGeneratedQuestions(fenced, PARSE)[0]!.question).toBe(Q1);
  });

  it("matches categories case-insensitively to the allowed spelling, else uses the fallback", () => {
    const parsed = parseGeneratedQuestions(
      reply({
        questions: [item(Q1, { category: "  OWNERSHIP " }), item(Q2, { category: "Made-up" })],
      }),
      { ...PARSE, categories: ["Ownership", "Teamwork"], fallbackCategory: "reasoning" }
    );
    expect(parsed.map((q) => q.category)).toEqual(["Ownership", "reasoning"]);
  });

  it.each([
    ["a plain string", Q1],
    ["no options", { question: Q1, correctOption: 0 }],
    ["three options", item(Q1, { options: OPTIONS.slice(0, 3) })],
    ["five options", item(Q1, { options: [...OPTIONS, "Fifth"] })],
    ["a blank option", item(Q1, { options: ["A", " ", "C", "D"] })],
    ["a non-text option", item(Q1, { options: ["A", 2, "C", "D"] })],
    ["duplicate options", item(Q1, { options: ["Same", "same ", "C", "D"] })],
    ["an option that is too long", item(Q1, { options: ["x".repeat(301), "B", "C", "D"] })],
    ["no correct option", item(Q1, { correctOption: undefined })],
    ["a correct option out of range", item(Q1, { correctOption: 4 })],
    ["a negative correct option", item(Q1, { correctOption: -1 })],
    ["a fractional correct option", item(Q1, { correctOption: 1.5 })],
    ["the correct option as text", item(Q1, { correctOption: "2" })],
  ])("skips an item with %s", (_label, bad) => {
    const parsed = parseGeneratedQuestions(reply({ questions: [bad, item(Q2)] }), PARSE);
    expect(parsed.map((q) => q.question)).toEqual([Q2]);
  });

  it("trims text and drops duplicate questions", () => {
    const parsed = parseGeneratedQuestions(
      reply({
        questions: [
          item(`  ${Q1}  `, { options: OPTIONS.map((o) => ` ${o} `) }),
          item(Q1.toUpperCase()),
        ],
      }),
      PARSE
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.question).toBe(Q1);
    expect(parsed[0]!.options.every((o) => o === o.trim())).toBe(true);
  });

  it("drops questions that are too long and caps criteria length", () => {
    const parsed = parseGeneratedQuestions(
      reply({
        questions: [item("x".repeat(1001)), item(Q1, { criteria: "c".repeat(2000) })],
      }),
      PARSE
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.criteria).toHaveLength(1000);
  });

  it("never returns more than max questions", () => {
    const many = Array.from({ length: 8 }, (_, i) => item(`${Q1} (variant ${i + 1})`));
    expect(parseGeneratedQuestions(reply({ questions: many }), { ...PARSE, max: 3 })).toHaveLength(
      3
    );
  });

  it.each([
    ["no content", null],
    ["an empty string", "   "],
    ["text that is not JSON", "Sure! Here are your questions: 1. ..."],
    ["JSON with no questions list", reply({ items: [item(Q1)] })],
    ["a questions field that is not a list", reply({ questions: Q1 })],
    ["a list with nothing usable", reply({ questions: [null, "", { question: 3 }, Q1] })],
    ["JSON null", "null"],
  ])("throws a GeneratedQuestionsParseError for %s", (_label, content) => {
    expect(() => parseGeneratedQuestions(content, PARSE)).toThrow(GeneratedQuestionsParseError);
  });
});

describe("redistributeCorrectOptions", () => {
  it("keeps the correct answer text and spreads it across letters", () => {
    const questions = Array.from({ length: 8 }, () => ({
      options: ["A", "B", "C", "D"],
      correctOption: 1,
    }));
    const result = redistributeCorrectOptions(questions);
    expect(result.every((q) => q.options[q.correctOption] === "B")).toBe(true);
    expect(new Set(result.map((q) => q.correctOption)).size).toBeGreaterThan(1);
  });
});
