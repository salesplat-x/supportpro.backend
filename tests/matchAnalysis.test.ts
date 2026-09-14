import { parseMatchAnalysis } from "../src/utils/matchAnalysis.js";

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
});
