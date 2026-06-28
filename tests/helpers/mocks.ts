// Centralised mock factory objects for all external integrations.
// Import these in test files and pass to jest.mock() factory functions.

export const openaiMocks = {
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),

  gradeAssessmentAnswers: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        responses: [
          { questionId: "q1", answer: "Good answer", score: 4 },
        ],
      }),
    },
  }),

  gradePersonalizedAnswers: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        responses: [
          { questionId: "q1", answer: "Strong answer", score: 4 },
        ],
      }),
    },
  }),

  generatePersonalizedQuestions: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        questions: ["Question 1?", "Question 2?"],
      }),
    },
  }),

  getPersonalityEvaluationQuestion: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        question: "Do you prefer working alone or in a team?",
        options: ["Alone", "Team"],
      }),
    },
  }),

  evaluatePersonalityType: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        mbtiType: "INTJ",
        responses: [
          { questionId: "q1", answer: "Introvert", dichotomyPreference: "I" },
        ],
      }),
    },
  }),

  generatePreScreeningAssessment: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        questions: [
          {
            questionId: "ps_q1",
            question: "What is your primary programming language?",
            category: "technical",
            options: ["JavaScript", "Python", "Java", "C#"],
            correctOption: "JavaScript",
            intent: "Gauge language preference",
            scoringHint: "Award 1 for JS/Python/Java/C#",
          },
        ],
      }),
    },
  }),

  scorePreScreeningAssessment: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        totalScore: 80,
        breakdown: [{ questionId: "ps_q1", score: 4 }],
      }),
    },
  }),

  assessCVandCoverLetter: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({ cvScore: 75, coverLetterScore: 70 }),
    },
  }),

  assessCV: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({ cvScore: 75 }),
    },
  }),

  extractTextFromDocument: jest.fn().mockResolvedValue("Mock CV text content"),

  preprocessCVForEmbedding: jest.fn().mockReturnValue("preprocessed cv text"),

  rankTalent: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({ rank: 1, explanation: "Top candidate" }),
    },
  }),
};

export const paystackMocks = {
  initializePayment: jest.fn().mockResolvedValue({
    status: true,
    message: "Authorization URL created",
    data: {
      authorization_url: "https://checkout.paystack.com/test",
      access_code: "ACCESS_test",
      reference: "TEST-REF-001",
    },
  }),

  verifyTransaction: jest.fn().mockResolvedValue({
    status: true,
    message: "Verification successful",
    data: {
      status: "success",
      reference: "TEST-REF-001",
      amount: 500000,
      currency: "NGN",
      customer: { email: "user@example.com" },
      plan: null,
      authorization: { authorization_code: "AUTH_test" },
    },
  }),

  webhookDataValidation: jest.fn().mockReturnValue(true),

  createCustomer: jest.fn().mockResolvedValue({
    status: true,
    data: { customer_code: "CUS_test" },
  }),

  createPlan: jest.fn().mockResolvedValue({
    status: true,
    data: { plan_code: "PLN_test123", id: 1 },
  }),

  updatePlan: jest.fn().mockResolvedValue({
    status: true,
    message: "Plan updated",
  }),

  createSubscription: jest.fn().mockResolvedValue({
    status: true,
    data: {
      subscription_code: "SUB_test123",
      email_token: "tok_test",
      status: "active",
      authorization: { authorization_code: "AUTH_test" },
      next_payment_date: null,
      cron_expression: null,
    },
  }),

  enableSubscription: jest.fn().mockResolvedValue({ status: true }),

  disableSubscription: jest.fn().mockResolvedValue({ status: true }),

  listSubscriptions: jest.fn().mockResolvedValue({
    status: true,
    data: [],
  }),

  generatePaymentObject: jest.fn().mockImplementation((amount: number, email: string, plan?: string) => ({
    amount,
    email,
    currency: "NGN",
    plan,
  })),

  generateUpdateSubscriptionLink: jest.fn().mockResolvedValue({
    status: true,
    data: { link: "https://paystack.com/manage/subscriptions/test" },
  }),

  hasRunningSubscription: jest.fn().mockResolvedValue(false),
};

export const cloudinaryMocks = {
  uploadBuffer: jest.fn().mockResolvedValue({
    url: "https://res.cloudinary.com/test/image.jpg",
    publicId: "test/image",
  }),

  replaceAsset: jest.fn().mockResolvedValue({
    url: "https://res.cloudinary.com/test/cv.pdf",
    publicId: "test/cv",
  }),

  destroyAsset: jest.fn().mockResolvedValue(undefined),

  extractPublicIdFromUrl: jest.fn().mockReturnValue("test/image"),
};

export const emailMocks = {
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
  })),
};
