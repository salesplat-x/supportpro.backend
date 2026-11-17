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

const invite = {
  email: "ada@example.com",
  firstName: "Ada",
  companyName: "Acme Ltd",
  companyLogoUrl: "https://example.com/logo.png",
  inviterName: "Hana Resources",
  jobTitle: "Product Designer",
  department: "Design",
  managerName: "Tunde Bakare",
  startDate: "Tue 1 Dec 2026",
  expiresOn: "Tue 10 Nov 2026",
  inviteLink: "https://auxhr.com/join-staff/abc123",
};

describe("EmailService.sendStaffInvite", () => {
  it("names the company, the role and who sent it, with one link to accept", async () => {
    const { sent, provider } = captureProvider();

    await new EmailService(provider).sendStaffInvite(invite);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ada@example.com");
    expect(sent[0]!.subject).toBe("You've been added to Acme Ltd");
    expect(sent[0]!.html).toContain("Product Designer · Design team");
    expect(sent[0]!.html).toContain("Tunde Bakare");
    expect(sent[0]!.html).toContain("<strong>Tue 10 Nov 2026</strong>");
    expect(sent[0]!.html).toContain("Hana Resources sent this invite");
    expect(sent[0]!.html).toContain('src="https://example.com/logo.png"');
    expect(sent[0]!.html).toContain('href="https://auxhr.com/join-staff/abc123"');
    expect(sent[0]!.text).toContain("https://auxhr.com/join-staff/abc123");
    expect(sent[0]!.tags).toEqual([{ name: "category", value: "staff-invite" }]);
  });

  it("leaves out the logo when the company has none", async () => {
    const { sent, provider } = captureProvider();

    await new EmailService(provider).sendStaffInvite({ ...invite, companyLogoUrl: null });

    expect(sent[0]!.html).not.toContain('alt="Acme Ltd"');
  });

  it("escapes company and job text so HR input cannot inject markup", async () => {
    const { sent, provider } = captureProvider();

    await new EmailService(provider).sendStaffInvite({
      ...invite,
      companyName: "Acme <b>Ltd</b>",
      jobTitle: "<script>alert(1)</script>",
    });

    expect(sent[0]!.html).not.toContain("<script>alert(1)</script>");
    expect(sent[0]!.html).not.toContain("<b>Ltd</b>");
    expect(sent[0]!.html).toContain("Acme &lt;b&gt;Ltd&lt;/b&gt;");
  });

  it("throws when the provider fails, so the caller can record that the invite did not go out", async () => {
    const provider: EmailProvider = {
      send: async () => {
        throw new Error("provider down");
      },
    };

    await expect(new EmailService(provider).sendStaffInvite(invite)).rejects.toThrow(
      "provider down"
    );
  });
});
