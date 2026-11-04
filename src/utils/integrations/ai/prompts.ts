import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import logger from "../../logger.js";
import { AiFeature, AiFeatureKey, getAiFeature, loadAiCatalog } from "./catalog.js";
import { loadSavedPrompts } from "./settings.js";

export interface AiPromptPart {
  key: string;
  label: string;
  variables?: string[];
  text: string;
}

export interface AiPromptCatalog {
  variables: Record<string, string>;
  jobs: Record<string, AiPromptPart[]>;
}

export const MAX_PROMPT_LENGTH = 30_000;

const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const OUTPUT_FIELD = /"(\w+)"\s*:/g;

const resolveYamlPath = (): string => {
  const candidates = [
    path.join(__dirname, "../../../config/aiPrompts.yaml"),
    path.join(process.cwd(), "src/config/aiPrompts.yaml"),
    path.join(process.cwd(), "dist/config/aiPrompts.yaml"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("aiPrompts.yaml not found");
  }
  return found;
};

const namesIn = (text: string, pattern: RegExp): Set<string> =>
  new Set([...text.matchAll(pattern)].map((match) => match[1]!));

export const validateAiPrompts = (catalog: AiPromptCatalog): void => {
  const problems: string[] = [];
  for (const feature of loadAiCatalog().features) {
    const parts = catalog.jobs[feature.key];
    if (feature.kind === "chat" && !parts?.length) {
      problems.push(`AI job ${feature.key} has no prompt`);
    }
    if (feature.kind === "embedding" && parts?.length) {
      problems.push(`AI job ${feature.key} sends no prompt, so it can't have one`);
    }
    for (const part of parts ?? []) {
      const declared = new Set(part.variables ?? []);
      const used = namesIn(part.text, PLACEHOLDER);
      if (declared.size !== used.size || [...used].some((name) => !declared.has(name))) {
        problems.push(`Prompt ${feature.key}.${part.key} doesn't match its variables`);
      }
      for (const name of declared) {
        if (!catalog.variables[name]) {
          problems.push(`Variable ${name} has no description`);
        }
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid AI prompts: ${problems.join("; ")}`);
  }
};

let cached: AiPromptCatalog | null = null;

export const loadAiPrompts = (): AiPromptCatalog => {
  if (cached) return cached;
  const catalog = yaml.load(fs.readFileSync(resolveYamlPath(), "utf8")) as AiPromptCatalog;
  validateAiPrompts(catalog);
  cached = catalog;
  return catalog;
};

export const getPromptParts = (key: string): AiPromptPart[] => loadAiPrompts().jobs[key] ?? [];

/**
 * Says why edited text can't be used. The app fills the placeholders and reads the reply's
 * fields, so losing either fails the job for real users, and OpenAI refuses a JSON-mode
 * request whose prompt never mentions JSON.
 */
export const promptProblem = (
  feature: AiFeature,
  part: AiPromptPart,
  text: string
): string | null => {
  if (!text.trim()) {
    return `${part.label} can't be empty`;
  }
  if (text.length > MAX_PROMPT_LENGTH) {
    return `${part.label} is too long`;
  }

  const allowed = new Set(part.variables ?? []);
  const used = namesIn(text, PLACEHOLDER);
  const missing = [...allowed].filter((name) => !used.has(name));
  if (missing.length > 0) {
    return `${part.label} must keep ${missing.map((name) => `{{${name}}}`).join(", ")}`;
  }
  const unknown = [...used].filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    return `${part.label} can't use ${unknown.map((name) => `{{${name}}}`).join(", ")}`;
  }

  if (feature.format === "json_object") {
    if (/json/i.test(part.text) && !/json/i.test(text)) {
      return `${part.label} must still ask for JSON`;
    }
    const lostFields = [...namesIn(part.text, OUTPUT_FIELD)].filter(
      (field) => !namesIn(text, OUTPUT_FIELD).has(field)
    );
    if (lostFields.length > 0) {
      return `${part.label} must keep these output fields, because the app reads them: ${lostFields.join(", ")}`;
    }
  }
  return null;
};

/** One pass only, so a placeholder typed into a CV or an answer is never expanded. */
export const fillPlaceholders = (
  text: string,
  values: Record<string, string | number>
): string =>
  text.replace(PLACEHOLDER, (placeholder, name: string) =>
    name in values ? String(values[name]) : placeholder
  );

export const renderPrompt = async (
  key: AiFeatureKey,
  partKey: string,
  values: Record<string, string | number> = {}
): Promise<string> => {
  const part = getPromptParts(key).find((item) => item.key === partKey);
  if (!part) {
    throw new Error(`AI job ${key} has no prompt part ${partKey}`);
  }

  const saved = (await loadSavedPrompts(key))[partKey];
  if (saved === undefined) {
    return fillPlaceholders(part.text, values);
  }
  const problem = promptProblem(getAiFeature(key)!, part, saved);
  if (problem) {
    logger.warn(`AI job ${key} is using its default prompt because ${problem}`);
    return fillPlaceholders(part.text, values);
  }
  return fillPlaceholders(saved, values);
};
