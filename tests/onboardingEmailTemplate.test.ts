import EmailService from "../src/utils/integrations/email/emailService.js";
import type { EmailPayload, EmailProvider } from "../src/utils/integrations/email/types.js";

const captureProvider = () => {
  const sent: EmailPayload[] = [];
  const provider: EmailProvider = {
    send: async (payload) => {
      sent.push(payload);
    },
  };
  return { sent, provider };
};

describe("EmailService.sendOnboardingFollowUp", () => {
  it("renders each paragraph and the call-to-action link", async () => {
    const { sent, provider } = captureProvider();

    await new EmailService(provider).sendOnboardingFollowUp({
      to: "ada@example.com",
      subject: "One quick step",
      paragraphs: ["Hi Ada,", "Upload your CV to start matching."],
      ctaLabel: "Finish your profile",
      ctaUrl: "https://auxhr.com/talentDashboard/talentProfile",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ada@example.com");
    expect(sent[0]!.subject).toBe("One quick step");
    expect(sent[0]!.html).toContain("<p>Hi Ada,</p>");
    expect(sent[0]!.html).toContain("<p>Upload your CV to start matching.</p>");
    expect(sent[0]!.html).toContain('href="https://auxhr.com/talentDashboard/talentProfile"');
    expect(sent[0]!.text).toContain(
      "Finish your profile: https://auxhr.com/talentDashboard/talentProfile"
    );
    expect(sent[0]!.tags).toEqual([{ name: "category", value: "onboarding-follow-up" }]);
  });

  it("escapes HTML from the AI or the admin so it cannot inject markup", async () => {
    const { sent, provider } = captureProvider();

    await new EmailService(provider).sendOnboardingFollowUp({
      to: "ada@example.com",
      subject: "Hi",
      paragraphs: ['<script>alert("x")</script>', '<a href="https://evil.test">click</a>'],
      ctaLabel: "Go",
      ctaUrl: "https://auxhr.com/login",
    });

    expect(sent[0]!.html).not.toContain("<script>");
    expect(sent[0]!.html).not.toContain('href="https://evil.test"');
    expect(sent[0]!.html).toContain("&lt;script&gt;");
  });

  it("lets a provider failure through so the caller can record it", async () => {
    const provider: EmailProvider = {
      send: async () => {
        throw new Error("Resend is down");
      },
    };

    await expect(
      new EmailService(provider).sendOnboardingFollowUp({
        to: "ada@example.com",
        subject: "Hi",
        paragraphs: ["Hi"],
        ctaLabel: "Go",
        ctaUrl: "https://auxhr.com/login",
      })
    ).rejects.toThrow("Resend is down");
  });
});
