import { DocumentTemplate } from "../entities/StaffDocument.js";

export interface ContractFacts {
  companyName: string;
  fullName: string;
  jobTitle: string;
  startDate: string;
  payParagraph: string | null;
}

interface TemplateDefinition {
  title: string;
  needsPay: boolean;
  body: (facts: ContractFacts) => string[];
}

export const CONTRACT_TEMPLATES: Record<DocumentTemplate, TemplateDefinition> = {
  [DocumentTemplate.OfferLetter]: {
    title: "Offer letter",
    needsPay: true,
    body: (facts) => [
      `Dear ${facts.fullName},`,
      `We are pleased to offer you the position of ${facts.jobTitle} at ${facts.companyName}, starting on ${facts.startDate}.`,
      facts.payParagraph ?? "",
      "This offer is subject to the company's policies and the other agreements you sign when you join. Please sign below to accept it.",
    ],
  },
  [DocumentTemplate.Nda]: {
    title: "Confidentiality agreement",
    needsPay: false,
    body: (facts) => [
      `This confidentiality agreement is between ${facts.companyName} (the company) and ${facts.fullName}, who joins as ${facts.jobTitle} on ${facts.startDate}.`,
      "1. You will keep private all information about the company, its customers and its staff that is not public and that you learn through your work.",
      "2. You will use that information only to do your job, and you will not share it outside the company without written permission.",
      "3. When you leave, you will return or delete all such information you hold.",
      "4. These duties continue after your employment ends.",
    ],
  },
  [DocumentTemplate.WorkOwnership]: {
    title: "Work-ownership agreement",
    needsPay: false,
    body: (facts) => [
      `This agreement is between ${facts.companyName} (the company) and ${facts.fullName}, who joins as ${facts.jobTitle} on ${facts.startDate}.`,
      "1. Everything you create as part of your work for the company, including code, designs, documents and inventions, belongs to the company.",
      "2. You will tell the company about such work and help it record its ownership where needed.",
      "3. Work you create in your own time, without company resources and unrelated to the company's business, stays yours.",
    ],
  },
  [DocumentTemplate.PayAgreement]: {
    title: "Pay agreement",
    needsPay: true,
    body: (facts) => [
      `This pay agreement is between ${facts.companyName} and ${facts.fullName}, who joins as ${facts.jobTitle} on ${facts.startDate}.`,
      facts.payParagraph ?? "",
      "Pay is subject to the taxes and deductions required by law. Any change to this pay will be agreed in writing.",
    ],
  },
};

export const renderContract = (
  template: DocumentTemplate,
  facts: ContractFacts
): { title: string; body: string; missing: string[] } => {
  const definition = CONTRACT_TEMPLATES[template];
  return {
    title: definition.title,
    body: definition
      .body(facts)
      .filter((paragraph) => paragraph.length > 0)
      .join("\n\n"),
    missing: definition.needsPay && !facts.payParagraph ? ["pay"] : [],
  };
};
