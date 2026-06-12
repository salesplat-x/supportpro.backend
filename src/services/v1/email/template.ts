import fs from "fs";
import path from "path";
import { compile } from "handlebars";

export const renderTemplate = (templateName: string, data: Record<string, any>): string => {
  const htmlTemplate = fs.readFileSync(
    path.join(__dirname, `../../../../templates/${templateName}.html`),
    "utf-8"
  );
  return compile(htmlTemplate)(data);
};
