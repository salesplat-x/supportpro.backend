import { DocumentTemplate } from "../src/entities/StaffDocument.js";
import { generateContractPdf } from "../src/utils/contractPdf.js";
import { renderContract, type ContractFacts } from "../src/utils/contractTemplates.js";

const facts: ContractFacts = {
  companyName: "Kosana Tech Ltd",
  fullName: "Ada Obi",
  jobTitle: "Product Designer",
  startDate: "3 February 2025",
  managerName: "Tunde Bakare",
  payParagraph: "Your base salary is NGN 450,000 per month.",
};

describe("contract wording", () => {
  it("writes the offer letter with the manager and start date", () => {
    const { title, body, missing } = renderContract(DocumentTemplate.OfferLetter, facts);
    expect(title).toBe("Offer letter");
    expect(missing).toEqual([]);
    expect(body).toContain("Dear Ada Obi,");
    expect(body).toContain(
      "We are pleased to offer you the position of Product Designer at Kosana Tech Ltd. You will report to Tunde Bakare and your start date is 3 February 2025."
    );
    expect(body).toContain("Your base salary is NGN 450,000 per month.");
    expect(body).toContain("Please sign below to accept it.");
  });

  it("leaves the manager out of the offer letter when there is none", () => {
    const { body } = renderContract(DocumentTemplate.OfferLetter, { ...facts, managerName: null });
    expect(body).toContain("Your start date is 3 February 2025.");
    expect(body).not.toContain("report to");
  });

  it("writes the non-disclosure agreement", () => {
    const { title, body } = renderContract(DocumentTemplate.Nda, facts);
    expect(title).toBe("Non-disclosure agreement");
    expect(body).toContain("This agreement is between Kosana Tech Ltd and Ada Obi.");
    expect(body).toContain("customer lists, pricing, source files and unreleased designs");
  });

  it("writes the work-ownership agreement with the start date", () => {
    const { body } = renderContract(DocumentTemplate.WorkOwnership, facts);
    expect(body).toContain(
      "Work made by Ada Obi in the course of employment at Kosana Tech Ltd belongs to Kosana Tech Ltd."
    );
    expect(body).toContain("Ada Obi keeps ownership of work made before 3 February 2025.");
  });

  it("asks for pay on the offer letter and pay agreement only", () => {
    const withoutPay = { ...facts, payParagraph: null };
    expect(renderContract(DocumentTemplate.OfferLetter, withoutPay).missing).toEqual(["pay"]);
    expect(renderContract(DocumentTemplate.PayAgreement, withoutPay).missing).toEqual(["pay"]);
    expect(renderContract(DocumentTemplate.Nda, withoutPay).missing).toEqual([]);
    expect(renderContract(DocumentTemplate.WorkOwnership, withoutPay).missing).toEqual([]);
  });
});

describe("contract pdf", () => {
  const base = {
    companyName: "Kosana Tech Ltd",
    logo: null,
    title: "Offer letter",
    dateLabel: "6 November 2026",
    body: renderContract(DocumentTemplate.OfferLetter, facts).body,
    signatory: "Tunde Bakare, Head of People",
    employeeName: "Ada Obi",
  };

  it.each(Object.values(DocumentTemplate))("builds an unsigned %s", async (template) => {
    const { title, body } = renderContract(template, facts);
    const pdf = await generateContractPdf({ ...base, title, body, signature: null });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("adds a signature record page after signing", async () => {
    const unsigned = await generateContractPdf({ ...base, signature: null });
    const signed = await generateContractPdf({
      ...base,
      signature: {
        name: "Ada Obi",
        email: "ada.obi@kosanatech.ng",
        signedAt: new Date("2026-11-05T13:32:00Z"),
        sentBy: "Tunde Bakare",
        sentAt: new Date("2026-11-05T08:15:00Z"),
        openedAt: new Date("2026-11-05T13:20:00Z"),
        checkCode: "a".repeat(64),
        check: { documentId: "doc-1", verifyUrl: "https://auxhr.com/verify" },
      },
    });
    expect(signed.subarray(0, 5).toString()).toBe("%PDF-");
    expect(signed.length).toBeGreaterThan(unsigned.length);
    const pages = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages(signed)).toBe(pages(unsigned) + 1);
  });
});
