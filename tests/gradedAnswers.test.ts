import {
  parseGradedAnswers,
  GradedAnswersParseError,
  MAX_ANSWER_SCORE,
  scorePercent,
} from "../src/utils/gradedAnswers.js";

const reply = (grades: unknown) => JSON.stringify({ grades });
const ids = ["q1", "q2", "q3"];

describe("parseGradedAnswers", () => {
  it("reads one grade per answer, with trimmed feedback", () => {
    const parsed = parseGradedAnswers(
      reply([
        { questionId: "q1", score: 5, feedback: "  Clear steps.  " },
        { questionId: "q2", score: 0, feedback: "Off topic." },
        { questionId: "q3", score: 3, feedback: "Partly there." },
      ]),
      ids
    );
    expect(parsed).toEqual([
      { questionId: "q1", score: 5, feedback: "Clear steps." },
      { questionId: "q2", score: 0, feedback: "Off topic." },
      { questionId: "q3", score: 3, feedback: "Partly there." },
    ]);
  });

  it("accepts a reply wrapped in a code fence", () => {
    const parsed = parseGradedAnswers(
      "```json\n" + reply([{ questionId: "q1", score: 4, feedback: "Good." }]) + "\n```",
      ["q1"]
    );
    expect(parsed).toHaveLength(1);
  });

  it("drops scores that are out of range or not whole numbers", () => {
    const parsed = parseGradedAnswers(
      reply([
        { questionId: "q1", score: MAX_ANSWER_SCORE + 1, feedback: "x" },
        { questionId: "q2", score: -1, feedback: "x" },
        { questionId: "q3", score: 2.5, feedback: "x" },
      ]),
      ids
    );
    expect(parsed).toEqual([]);
  });

  it("drops scores sent as text, and grades for questions that weren't asked", () => {
    const parsed = parseGradedAnswers(
      reply([
        { questionId: "q1", score: "4", feedback: "x" },
        { questionId: "other", score: 4, feedback: "x" },
        { questionId: "q2", score: 4, feedback: "Fine." },
      ]),
      ids
    );
    expect(parsed).toEqual([{ questionId: "q2", score: 4, feedback: "Fine." }]);
  });

  it("keeps the first grade when a question is graded twice", () => {
    const parsed = parseGradedAnswers(
      reply([
        { questionId: "q1", score: 2, feedback: "first" },
        { questionId: "q1", score: 5, feedback: "second" },
      ]),
      ids
    );
    expect(parsed).toEqual([{ questionId: "q1", score: 2, feedback: "first" }]);
  });

  it("allows a grade with no feedback, stored as an empty string", () => {
    const parsed = parseGradedAnswers(reply([{ questionId: "q1", score: 1 }]), ids);
    expect(parsed).toEqual([{ questionId: "q1", score: 1, feedback: "" }]);
  });

  it.each([
    ["empty", ""],
    ["null", null],
    ["not JSON", "Sure! Here are the grades"],
    ["no grades list", JSON.stringify({ results: [] })],
    ["grades not a list", JSON.stringify({ grades: "all good" })],
  ])("throws GradedAnswersParseError for a reply that is %s", (_label, content) => {
    expect(() => parseGradedAnswers(content, ids)).toThrow(GradedAnswersParseError);
  });
});

describe("scorePercent", () => {
  it("turns 0-5 grades into a percentage with two decimals", () => {
    expect(scorePercent([5, 3, 4])).toBe(80);
    expect(scorePercent([1, 1, 1])).toBe(20);
    expect(scorePercent([2, 3, 3])).toBe(53.33);
    expect(scorePercent([0])).toBe(0);
  });

  it("is null when there is nothing to score", () => {
    expect(scorePercent([])).toBeNull();
  });
});
