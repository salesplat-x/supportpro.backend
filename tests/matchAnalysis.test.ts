import { parseMatchAnalysis, scoreFromVerdict } from "../src/utils/matchAnalysis.js";

describe("parseMatchAnalysis", () => {
  it("keeps per-question feedback that names the question and evidence fields", () => {
    const analysis = parseMatchAnalysis(
      {
        overallFitScore: 82,
        whyFit: "Strong Kubernetes background at Seed Co.",
        questionFeedback: [
          {
            question: "How do you handle a failed production deploy?",
            whatTheyAnswered:
              "They freeze deploys, isolate the canary, then run a blameless review.",
            whatItDemonstrates: "Structured incident judgment under pressure.",
            experienceLink:
              "CV lists on-call ownership of a payments rollback playbook at Seed Co.",
          },
          { question: "   " },
          "not an object",
        ],
      },
      "high"
    );

    expect(analysis.questionFeedback).toEqual([
      {
        question: "How do you handle a failed production deploy?",
        whatTheyAnswered: "They freeze deploys, isolate the canary, then run a blameless review.",
        whatItDemonstrates: "Structured incident judgment under pressure.",
        experienceLink: "CV lists on-call ownership of a payments rollback playbook at Seed Co.",
      },
    ]);
  });

  it("defaults questionFeedback to an empty array when the model omits it", () => {
    const analysis = parseMatchAnalysis({ whyFit: "Limited evidence." }, "low");
    expect(analysis.questionFeedback).toEqual([]);
  });

  describe("overallFitScore — this is the number the AI Match column shows", () => {
    it("keeps a valid in-range score from the model as-is", () => {
      expect(parseMatchAnalysis({ overallFitScore: 73 }, "medium").overallFitScore).toBe(73);
    });

    it("rounds a fractional score", () => {
      expect(parseMatchAnalysis({ overallFitScore: 73.6 }, "medium").overallFitScore).toBe(74);
    });

    it.each([
      ["a negative score", -15, 0],
      ["a score above 100", 140, 100],
    ])("clamps %s (%i) to %i", (_label, input, expected) => {
      expect(parseMatchAnalysis({ overallFitScore: input }, "medium").overallFitScore).toBe(
        expected
      );
    });

    it("coerces a numeric string", () => {
      expect(parseMatchAnalysis({ overallFitScore: "91" }, "high").overallFitScore).toBe(91);
    });

    it.each([
      ["missing entirely", {}],
      ["null", { overallFitScore: null }],
      ["not a number", { overallFitScore: "not-a-number" }],
      ["NaN", { overallFitScore: NaN }],
      ["Infinity", { overallFitScore: Infinity }],
    ])("falls back to the verdict-derived score when the field is %s", (_label, parsed) => {
      expect(parseMatchAnalysis(parsed, "high").overallFitScore).toBe(85);
      expect(parseMatchAnalysis(parsed, "medium").overallFitScore).toBe(65);
      expect(parseMatchAnalysis(parsed, "low").overallFitScore).toBe(35);
    });
  });
});

describe("scoreFromVerdict — fallback score when the model doesn't return one", () => {
  it.each([
    ["high", 85],
    ["medium", 65],
    ["low", 35],
  ])('maps "%s" to %i', (verdict, expected) => {
    expect(scoreFromVerdict(verdict)).toBe(expected);
  });

  it.each(["", "unknown", "HIGH", "High"])(
    'falls back to 50 for an unrecognized/mis-cased verdict ("%s")',
    (verdict) => {
      expect(scoreFromVerdict(verdict)).toBe(50);
    }
  );
});
