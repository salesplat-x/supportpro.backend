import { mergeSubmittedAnswers, answerTextForQuestion } from "../src/utils/answerResponses.js";

describe("answerResponses", () => {
  it("keeps the submitted answer text and real question ids when the LLM uses `question`", () => {
    const questionId = "11111111-1111-4111-8111-111111111111";
    const merged = mergeSubmittedAnswers(
      { [questionId]: "I shipped the billing cutover." },
      [{ question: questionId, answer: "rewritten by the model", score: 4 }]
    );

    expect(merged).toEqual([
      { questionId, answer: "I shipped the billing cutover.", score: 4 },
    ]);
  });

  it("finds a stored answer when the grader saved the id in `question`", () => {
    const questionId = "11111111-1111-4111-8111-111111111111";
    const text = answerTextForQuestion(
      [{ question: questionId, answer: "Quiet evenings, then a walk." }],
      questionId,
      "How do you recharge?"
    );
    expect(text).toBe("Quiet evenings, then a walk.");
  });
});
