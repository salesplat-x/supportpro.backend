import { DocumentTemplate } from "../entities/StaffDocument.js";

export interface ContractFacts {
  companyName: string;
  fullName: string;
  jobTitle: string;
  startDate: string;
  managerName: string | null;
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
      `We are pleased to offer you the position of ${facts.jobTitle} at ${facts.companyName}.${
        facts.managerName
          ? ` You will report to ${facts.managerName} and your start date is ${facts.startDate}.`
          : ` Your start date is ${facts.startDate}.`
      }`,
      facts.payParagraph ?? "",
      "This offer is subject to the terms in your employment agreement. Please sign below to accept it.",
    ],
  },
  [DocumentTemplate.Nda]: {
    title: "Non-disclosure agreement",
    needsPay: false,
    body: (facts) => [
      `This agreement is between ${facts.companyName} and ${facts.fullName}.`,
      `${facts.fullName} agrees to keep all confidential company information private, during and after employment.`,
      "Confidential information includes customer lists, pricing, source files and unreleased designs.",
    ],
  },
  [DocumentTemplate.WorkOwnership]: {
    title: "Work-ownership agreement",
    needsPay: false,
    body: (facts) => [
      `Work made by ${facts.fullName} in the course of employment at ${facts.companyName} belongs to ${facts.companyName}.`,
      "This includes designs, code, documents and ideas created for the company.",
      `${facts.fullName} keeps ownership of work made before ${facts.startDate}.`,
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
