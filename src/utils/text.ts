import mammoth from "mammoth";
import path from "path";
import pdfParse from "pdf-parse";

export function calculateTimeLeft(date: Date): string {
  const dateObj = new Date(date);
  const today = new Date();
  const timeDifference = dateObj.getTime() - today.getTime();
  const msPerMin = 1000 * 60;
  const msPerHour = msPerMin * 60;
  const msPerDay = msPerHour * 24;

  if (timeDifference < msPerHour) {
    const minute = Math.floor(timeDifference / msPerMin);
    if (minute === 0) return "in less than an hour";
    return minute === 1 ? "in a minute" : `in ${minute} minutes`;
  }
  if (timeDifference < msPerDay) {
    const hours = Math.floor(timeDifference / msPerHour);
    return hours === 1 ? "in an hour" : `in ${hours} hours`;
  }
  const days = Math.floor(timeDifference / msPerDay);
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

export function convertSimilarityToPercentage(similarityScore: number): number {
  if (similarityScore < 0 || similarityScore > 1) {
    throw new Error("Similarity score must be between 0 and 1");
  }
  return Number(((1 - similarityScore) * 100).toFixed(2));
}

export async function extractText(buffer: Buffer, mimetype: string): Promise<string> {
  if (mimetype === "application/pdf") {
    const data = await pdfParse(buffer);
    return data.text;
  }
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

export function preprocessText(text: string): string {
  return text
    .replace(/[^\x20-\x7E]+/g, " ")
    .replace(/[\s\n]+/g, " ")
    .trim();
}

export function chunkText(text: string, maxChunkSize = 28600): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChunkSize, text.length);
    if (end < text.length && text[end] !== ".") {
      const fullStopIndex = text.lastIndexOf(".", end);
      if (fullStopIndex > start) end = fullStopIndex + 1;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks;
}

export function overlapChunkText(text: string, maxChunkSize = 28600, overlapSize = 500): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxChunkSize;
    if (end > text.length) {
      end = text.length;
    } else {
      const fullStopIndex = text.lastIndexOf(".", end);
      if (fullStopIndex > start) end = fullStopIndex + 1;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
    if (start < text.length) start = Math.max(0, end - overlapSize);
  }
  return chunks;
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

export function sortDirection(direction: string): "ASC" | "DESC" {
  return direction?.toLowerCase() === "asc" ? "ASC" : "DESC";
}

export function handleFilename(filename: string): { name: string; ext: string | undefined } {
  const parts = filename.split(".");
  const oldName = parts.length > 1 ? parts.slice(0, parts.length - 1).join("_") : filename;
  const name = oldName.replace(/ /g, "-") + "_" + Date.now().toString();
  return { name, ext: parts.pop() };
}

export function renderTemplateString(template: string, data: Record<string, unknown>): string {
  return template.replace(/{{([^}]+)}}/g, (_, key: string) => String(data[key] ?? ""));
}

export function extractAttachments(
  attachments: string[]
): Array<{ filename: string; path: string }> {
  return attachments.map((attachment) => ({
    filename: path.basename(attachment),
    path: attachment,
  }));
}

export function embeddingToString(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export function stringToEmbedding(str: string): number[] {
  return str.slice(1, -1).split(",").map(Number);
}
