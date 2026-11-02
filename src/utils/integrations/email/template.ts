import fs from "fs";
import path from "path";
import { compile } from "handlebars";
import env from "../../../config/env.js";

const logoUrl = "https://auxhr.com/aux_logo.png";

const TEMPLATE_TITLES: Record<string, string> = {
  welcome: "Welcome to Auxhr",
  welcomeRecruiter: "Welcome to Auxhr",
  "verify-email": "Verify your email address",
  "password-reset": "Reset your password",
  "payment-confirmation": "Payment confirmed",
  "onboarding-follow-up": "Finish getting started on Auxhr",
  "applicant-message": "You have a new message",
  "application-follow-up": "Finish your application",
  "staff-invite": "You've been added to a team",
  "staff-document-sign": "A document is waiting for your signature",
  "staff-document-signed": "Your signed document",
};

const TEMPLATE_PREHEADERS: Record<string, string> = {
  welcome: "Your Auxhr account is ready.",
  welcomeRecruiter: "Your Auxhr recruiter account is ready.",
  "verify-email": "Confirm your email address to activate your account.",
  "password-reset": "Use this link to reset your Auxhr password.",
  "payment-confirmation": "Your Auxhr subscription payment was successful.",
  "company-invite": "Accept your team invitation on Auxhr.",
  "onboarding-follow-up": "A couple of quick steps and you're all set.",
  "applicant-message": "A recruiter sent you a message on Auxhr.",
  "application-follow-up": "A quick next step on your application.",
  "staff-invite": "Accept your invite and join your team on Auxhr.",
  "staff-document-sign": "Review and sign your document online.",
  "staff-document-signed": "A copy of the signed document is attached.",
};

export const renderTemplate = (templateName: string, data: Record<string, unknown>): string => {
  const locals = {
    logoUrl,
    appUrl: env.website || "https://auxhr.com",
    title: TEMPLATE_TITLES[templateName] ?? "Auxhr",
    preheader: TEMPLATE_PREHEADERS[templateName] ?? "",
    ...data,
  };
  const bodyPath = path.join(process.cwd(), `templates/${templateName}.html`);
  const layoutPath = path.join(process.cwd(), "templates/layout.html");
  const body = compile(fs.readFileSync(bodyPath, "utf-8"))(locals);
  return compile(fs.readFileSync(layoutPath, "utf-8"))({ ...locals, body });
};
