/**
 * parseGeneratedQuestions — turns an AI reply into safe question rows, or a
 * clear error. It must never crash on a malformed reply.
 */

import {
  parseGeneratedQuestions,
  GeneratedQuestionsParseError,
} from "../src/utils/generatedQuestions.js";

const reply = (value: unknown) => JSON.stringify(value);
const Q1 = "You have three tasks due today and time for two. How do you decide?";
const Q2 = "A report shows sales doubled but profit fell. What would you check first?";

describe("parseGeneratedQuestions", () => {
  it("reads question objects with category and criteria", () => {
    const parsed = parseGeneratedQuestions(
      reply({
        questions: [
          { question: Q1, category: "prioritisation", criteria: "Weighs impact and deadlines." },
          { question: Q2, category: "analytical", criteria: "Looks at costs and margins." },
        ],
      }),
      { max: 5, categories: ["prioritisation", "analytical"] }
    );

    expect(parsed).toEqual([
      { question: Q1, category: "prioritisation", criteria: "Weighs impact and deadlines." },
      { question: Q2, category: "analytical", criteria: "Looks at costs and margins." },
    ]);
  });

  it("accepts plain strings, giving them the fallback category and no criteria", () => {
    expect(parseGeneratedQuestions(reply({ questions: [Q1] }), { max: 5 })).toEqual([
      { question: Q1, category: "general", criteria: null },
    ]);
  });

  it("accepts a bare JSON array", () => {
    expect(parseGeneratedQuestions(reply([Q1]), { max: 5 })).toHaveLength(1);
  });

  it("strips a markdown code fence around the JSON", () => {
    const fenced = "```json\n" + reply({ questions: [Q1] }) + "\n```";
    expect(parseGeneratedQuestions(fenced, { max: 5 })[0]!.question).toBe(Q1);
  });

  it("matches categories case-insensitively to the allowed spelling, else uses the fallback", () => {
    const parsed = parseGeneratedQuestions(
      reply({
        questions: [
          { question: Q1, category: "  OWNERSHIP " },
          { question: Q2, category: "Made-up value" },
        ],
      }),
      { max: 5, categories: ["Ownership", "Teamwork"] }
    );
    expect(parsed.map((q) => q.category)).toEqual(["Ownership", "general"]);
  });

  it("uses a custom fallback category when given", () => {
    const parsed = parseGeneratedQuestions(reply({ questions: [Q1] }), {
      max: 5,
      categories: ["logical"],
      fallbackCategory: "reasoning",
    });
    expect(parsed[0]!.category).toBe("reasoning");
  });

  it("trims text, skips junk items, and drops duplicates", () => {
    const parsed = parseGeneratedQuestions(
      reply({
        questions: [
          `  ${Q1}  `,
          null,
          42,
          { category: "logical" },
          { question: "" },
          "Why?",
          Q1.toUpperCase(),
          { question: Q2, criteria: 7 },
        ],
      }),
      { max: 5 }
    );
    expect(parsed).toEqual([
      { question: Q1, category: "general", criteria: null },
      { question: Q2, category: "general", criteria: null },
    ]);
  });

  it("drops questions that are too long and caps criteria length", () => {
    const parsed = parseGeneratedQuestions(
      reply({
        questions: [{ question: "x".repeat(1001) }, { question: Q1, criteria: "c".repeat(2000) }],
      }),
      { max: 5 }
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.criteria).toHaveLength(1000);
  });

  it("never returns more than max questions", () => {
    const many = Array.from({ length: 8 }, (_, i) => `${Q1} (variant ${i + 1})`);
    expect(parseGeneratedQuestions(reply({ questions: many }), { max: 3 })).toHaveLength(3);
  });

  it.each([
    ["no content", null],
    ["an empty string", "   "],
    ["text that is not JSON", "Sure! Here are your questions: 1. ..."],
    ["JSON with no questions list", reply({ items: [Q1] })],
    ["a questions field that is not a list", reply({ questions: Q1 })],
    ["a list with nothing usable", reply({ questions: [null, "", { question: 3 }] })],
    ["JSON null", "null"],
  ])("throws a GeneratedQuestionsParseError for %s", (_label, content) => {
    expect(() => parseGeneratedQuestions(content, { max: 5 })).toThrow(
      GeneratedQuestionsParseError
    );
  });
});
