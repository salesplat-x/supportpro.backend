import fs from "fs";
import path from "path";
import yaml from "js-yaml";

export const AI_FEATURE_KEYS = [
  "cv_matching",
  "applicant_verdict",
  "talent_fit_evidence",
  "talent_cv_reader",
  "scout_cv_scoring",
  "scout_shortlist_summary",
  "personalized_questions",
  "ai_interview_questions",
  "reference_questions",
  "ai_interview_followup",
  "ai_interview_scoring",
  "personality_questions",
  "problem_solving_questions",
  "culture_fit_questions",
  "prescreening_questions",
  "prescreening_scoring",
  "role_answer_grading",
  "personalized_answer_grading",
  "personality_type",
  "personality_fit",
  "job_post_writer",
  "job_field_writer",
  "employee_job_description",
  "company_profile_reader",
  "goal_suggestions",
  "development_plan",
  "weekly_coaching",
  "efficiency_tip",
  "applicant_message",
  "onboarding_email",
  "application_follow_up_email",
  "support_reply",
] as const;

export type AiFeatureKey = (typeof AI_FEATURE_KEYS)[number];
export type AiModelKind = "chat" | "embedding";
export type AiResponseFormat = "json_object" | "json_schema";
export type AiTokenParam = "max_tokens" | "max_completion_tokens";

export interface AiProvider {
  key: string;
  name: string;
  envKey: string;
  baseUrl: string;
  docsUrl: string;
  attemptTimeoutMs: number;
}

/** USD. A period with no `from` applies from the start; a later `from` takes over on that day. */
export interface AiPricePeriod {
  from?: string;
  inputPerMillion: number;
  outputPerMillion?: number;
}

/** USD per minute of audio, for the voice models that aren't in the model list. */
export interface AiAudioPrice {
  provider: string;
  model: string;
  perMinute: number;
}

export interface AiModel {
  id: string;
  provider: string;
  label: string;
  kind: AiModelKind;
  formats?: AiResponseFormat[];
  tokenParam?: AiTokenParam;
  supportsTemperature?: boolean;
  reasoningEffort?: string;
  minOutputTokens?: number;
  retiresOn?: string;
  replacement?: string;
  pricing?: AiPricePeriod[];
}

export interface AiChoice {
  provider: string;
  model: string;
}

export interface AiFeature {
  key: AiFeatureKey;
  name: string;
  description: string;
  group: string;
  kind: AiModelKind;
  format?: AiResponseFormat;
  default: AiChoice;
  lockedReason?: string;
}

export interface AiCatalog {
  verifiedOn: string;
  pricesVerifiedOn?: string;
  providers: AiProvider[];
  models: AiModel[];
  audioPricing?: AiAudioPrice[];
  features: AiFeature[];
}

const resolveYamlPath = (): string => {
  const candidates = [
    path.join(__dirname, "../../../config/aiCatalog.yaml"),
    path.join(process.cwd(), "src/config/aiCatalog.yaml"),
    path.join(process.cwd(), "dist/config/aiCatalog.yaml"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("aiCatalog.yaml not found");
  }
  return found;
};

export const findModel = (catalog: AiCatalog, choice: AiChoice): AiModel | undefined =>
  catalog.models.find((model) => model.id === choice.model && model.provider === choice.provider);

/** The price in force on `day` (YYYY-MM-DD), or null when the model is unpriced. */
export const priceOn = (model: AiModel, day: string): AiPricePeriod | null => {
  let found: AiPricePeriod | null = null;
  for (const period of model.pricing ?? []) {
    if ((period.from ?? "") <= day && (period.from ?? "") >= (found?.from ?? "")) {
      found = period;
    }
  }
  return found;
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const isPrice = (value: unknown): boolean => typeof value === "number" && value >= 0;

const pricingProblems = (model: AiModel): string[] => {
  const problems: string[] = [];
  const periods = model.pricing ?? [];
  if (periods.length > 0 && periods.filter((period) => !period.from).length !== 1) {
    problems.push(`Model ${model.id} needs exactly one price without a from date`);
  }
  for (const period of periods) {
    if (period.from !== undefined && !DAY_PATTERN.test(period.from)) {
      problems.push(`Model ${model.id} has a price from ${period.from}, which isn't YYYY-MM-DD`);
    }
    if (!isPrice(period.inputPerMillion)) {
      problems.push(`Model ${model.id} has no input price`);
    }
    if (model.kind === "chat" && !isPrice(period.outputPerMillion)) {
      problems.push(`Chat model ${model.id} has no output price`);
    }
  }
  return problems;
};

export const modelFitsFeature = (model: AiModel, feature: AiFeature): boolean =>
  model.kind === feature.kind && (!feature.format || !!model.formats?.includes(feature.format));

/** A bad catalogue must stop the app at boot, not fail a candidate's request hours later. */
export const validateAiCatalog = (catalog: AiCatalog): void => {
  const problems: string[] = [];
  const providerKeys = new Set(catalog.providers.map((provider) => provider.key));

  for (const model of catalog.models) {
    if (!providerKeys.has(model.provider)) {
      problems.push(`Model ${model.id} has an unknown provider ${model.provider}`);
    }
    if (model.kind === "chat" && (!model.formats?.length || !model.tokenParam)) {
      problems.push(`Chat model ${model.id} needs formats and tokenParam`);
    }
    if (model.replacement && !catalog.models.some((other) => other.id === model.replacement)) {
      problems.push(`Model ${model.id} has an unknown replacement ${model.replacement}`);
    }
    problems.push(...pricingProblems(model));
  }

  for (const price of catalog.audioPricing ?? []) {
    if (!providerKeys.has(price.provider) || !isPrice(price.perMinute)) {
      problems.push(`Audio price for ${price.model} needs a known provider and a perMinute price`);
    }
  }

  for (const key of AI_FEATURE_KEYS) {
    if (!catalog.features.some((feature) => feature.key === key)) {
      problems.push(`Feature ${key} is missing`);
    }
  }

  for (const feature of catalog.features) {
    if (!(AI_FEATURE_KEYS as readonly string[]).includes(feature.key)) {
      problems.push(`Feature ${feature.key} is not known to the code`);
    }
    const model = findModel(catalog, feature.default);
    if (!model) {
      problems.push(`Feature ${feature.key} has an unknown default model`);
    } else if (!modelFitsFeature(model, feature)) {
      problems.push(`Feature ${feature.key} can't use its default model ${model.id}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid AI catalogue: ${problems.join("; ")}`);
  }
};

let cached: AiCatalog | null = null;

export const loadAiCatalog = (): AiCatalog => {
  if (cached) return cached;
  const catalog = yaml.load(fs.readFileSync(resolveYamlPath(), "utf8")) as AiCatalog;
  validateAiCatalog(catalog);
  cached = catalog;
  return catalog;
};

export const getAiFeature = (key: string): AiFeature | undefined =>
  loadAiCatalog().features.find((feature) => feature.key === key);

export const getAiProvider = (key: string): AiProvider | undefined =>
  loadAiCatalog().providers.find((provider) => provider.key === key);

export const isProviderConfigured = (provider: AiProvider): boolean =>
  !!process.env[provider.envKey]?.trim();
