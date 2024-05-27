import mammoth from "mammoth";
import path from "path";
import pdfParse from "pdf-parse";

export async function extractText(buffer: Buffer, mimetype: string) {
  if (mimetype === "application/pdf") {
    const data = await pdfParse(buffer);
    return data.text;
  } else {
    const result = await mammoth.extractRawText({ buffer: buffer });
    return result.value;
  }
}

// Function to remove unnecessary characters and whitespace
export function preprocessText(text: string) {
  return text
    .replace(/[^\x20-\x7E]+/g, " ") // Replace non-printable characters with a space
    .replace(/[\s\n]+/g, " ") // Collapse multiple spaces and newlines into a single space
    .trim(); // Trim leading and trailing spaces
}

export function chunkText(text: string, maxChunkSize: number = 8000): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    // Determine the end position for the current chunk
    let end = Math.min(start + maxChunkSize, text.length);

    // If the end is not at the end of the text and the next character is not a full stop, find the next full stop
    if (end < text.length && text[end] !== ".") {
      let fullStopIndex = text.lastIndexOf(".", end);
      if (fullStopIndex > start) {
        end = fullStopIndex + 1; // Include the full stop in the chunk
      }
    }

    // Slice the text chunk and add to the result
    chunks.push(text.slice(start, end).trim());

    // Move to the next chunk
    start = end;
  }

  return chunks;
}

export function validateEmail(email: string): boolean {
  const emailRegex: RegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function firstCharToUpperCase(str: string): string {
  return str.toLowerCase().charAt(0).toUpperCase() + str.slice(1);
}

export function convertToSentenceCase(str: string): string {
  return str
    .split(" ")
    .map((word) => firstCharToUpperCase(word))
    .join(" ");
}

export function convertToSnakeCase(str: string): string {
  return str
    .split(" ")
    .map((word) => word.toLowerCase())
    .join("_");
}

export function renderTemplateString(
  template: string,
  data: Record<string, any>
): string {
  return template.replace(/{{([^}]+)}}/g, (_, key: string) => data[key]);
}

export function extractAttachments(attachments: Array<string>): Array<{
  filename: string;
  path: string;
}> {
  return attachments.map((attachment) => {
    return {
      filename: path.basename(attachment),
      path: attachment,
    };
  });
}

export function parseNigerianPhoneNumber(phone: string): string {
  return phone.replace(/[^0-9]/g, "").slice(0, 11);
}

export function generateRandomString(length: number): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let result = "";
  for (let i = length; i > 0; --i) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export function sortDirection(direction: string): -1 | 1 | 0 {
  return direction?.toLowerCase() === "asc"
    ? 1
    : direction?.toLowerCase() === "desc"
    ? -1
    : 0;
}

export function handleFilename(filename: string) {
  let oldName =
    filename.split(".") && filename.split(".").length
      ? filename
          .split(".")
          .slice(0, filename.split(".").length - 1)
          .join("_")
      : filename;
  const name =
    oldName.replace(/ /g, "-") +
    "_" +
    Date.now().toString() +
    "." +
    filename.split(".").pop();
  return { name, ext: filename.split(".").pop() };
}
