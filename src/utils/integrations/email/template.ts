import fs from "fs";
import path from "path";
import { compile } from "handlebars";

const logoUrl = "https://auxhr.com/aux_logo.png";

export const renderTemplate = (templateName: string, data: Record<string, unknown>): string => {
  const templatePath = path.join(process.cwd(), `templates/${templateName}.html`);
  const htmlTemplate = fs.readFileSync(templatePath, "utf-8");
  return compile(htmlTemplate)({ logoUrl, ...data });
};
