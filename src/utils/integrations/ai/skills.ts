import fs from "fs";
import path from "path";
import yaml from "js-yaml";

/** Instructions several AI jobs share, kept in one place so one edit reaches them all. */
export interface AiSkill {
  key: string;
  label: string;
  description: string;
  text: string;
}

export const MAX_SKILL_LENGTH = 4000;

const PLACEHOLDER = /\{\{\w+\}\}/;

const resolveYamlPath = (): string => {
  const candidates = [
    path.join(__dirname, "../../../config/aiSkills.yaml"),
    path.join(process.cwd(), "src/config/aiSkills.yaml"),
    path.join(process.cwd(), "dist/config/aiSkills.yaml"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("aiSkills.yaml not found");
  }
  return found;
};

/** Why a skill's text can't be used, or null. Skills are pasted in as-is, so no placeholders. */
export const skillProblem = (label: string, text: string): string | null => {
  if (!text.trim()) return `${label} can't be empty`;
  if (text.length > MAX_SKILL_LENGTH) return `${label} is too long`;
  if (PLACEHOLDER.test(text)) return `${label} can't use {{placeholders}}`;
  return null;
};

export const validateAiSkills = (skills: AiSkill[]): void => {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const skill of skills) {
    if (keys.has(skill.key)) problems.push(`Skill ${skill.key} is listed twice`);
    keys.add(skill.key);
    if (!skill.label?.trim() || !skill.description?.trim()) {
      problems.push(`Skill ${skill.key} needs a label and a description`);
    }
    const problem = skillProblem(skill.key, skill.text ?? "");
    if (problem) problems.push(problem);
  }
  if (problems.length > 0) {
    throw new Error(`Invalid AI skills: ${problems.join("; ")}`);
  }
};

let cached: AiSkill[] | null = null;

export const loadAiSkills = (): AiSkill[] => {
  if (cached) return cached;
  const file = yaml.load(fs.readFileSync(resolveYamlPath(), "utf8")) as { skills: AiSkill[] };
  validateAiSkills(file.skills);
  cached = file.skills;
  return cached;
};

export const getAiSkill = (key: string): AiSkill | undefined =>
  loadAiSkills().find((skill) => skill.key === key);
