import { AppDataSource } from "../../../database/dataSource.js";
import { AiFeatureSetting } from "../../../entities/AiFeatureSetting.js";
import { AiSkillSetting } from "../../../entities/AiSkillSetting.js";
import logger from "../../logger.js";
import {
  AiChoice,
  AiFeature,
  AiFeatureKey,
  AiModel,
  AiProvider,
  findModel,
  getAiFeature,
  getAiProvider,
  isProviderConfigured,
  loadAiCatalog,
  modelFitsFeature,
} from "./catalog.js";

const SETTINGS_CACHE_MS = 30_000;

interface SavedFeature {
  choice: AiChoice | null;
  prompts: Record<string, string>;
}

let cache: { rows: Map<string, SavedFeature>; loadedAt: number } | null = null;
let skillCache: { texts: Record<string, string>; loadedAt: number } | null = null;

export const clearAiSettingsCache = (): void => {
  cache = null;
  skillCache = null;
};

/** The admin's wording for each edited skill. Skills missing here use their default. */
export const loadSavedSkills = async (): Promise<Record<string, string>> => {
  if (skillCache && Date.now() - skillCache.loadedAt < SETTINGS_CACHE_MS) {
    return skillCache.texts;
  }
  if (!AppDataSource.isInitialized) {
    return {};
  }
  try {
    const rows = await AppDataSource.getRepository(AiSkillSetting).find();
    const texts = Object.fromEntries(rows.map((row) => [row.skillKey, row.text]));
    skillCache = { texts, loadedAt: Date.now() };
    return texts;
  } catch (err) {
    logger.error(`Could not load AI skills, using defaults: ${(err as Error).message}`);
    return skillCache?.texts ?? {};
  }
};

const loadSettings = async (): Promise<Map<string, SavedFeature>> => {
  if (cache && Date.now() - cache.loadedAt < SETTINGS_CACHE_MS) {
    return cache.rows;
  }
  if (!AppDataSource.isInitialized) {
    return new Map();
  }
  try {
    const rows = await AppDataSource.getRepository(AiFeatureSetting).find();
    const settings = new Map(
      rows.map((row) => [
        row.featureKey,
        {
          choice: row.provider && row.model ? { provider: row.provider, model: row.model } : null,
          prompts: row.prompts,
        },
      ])
    );
    cache = { rows: settings, loadedAt: Date.now() };
    return settings;
  } catch (err) {
    logger.error(`Could not load AI settings, using defaults: ${(err as Error).message}`);
    return cache?.rows ?? new Map();
  }
};

export const loadSavedPrompts = async (key: AiFeatureKey): Promise<Record<string, string>> =>
  (await loadSettings()).get(key)?.prompts ?? {};

export const unusableReason = (feature: AiFeature, choice: AiChoice): string | null => {
  const provider = getAiProvider(choice.provider);
  const model = findModel(loadAiCatalog(), choice);
  if (!provider || !model) {
    return `${choice.model} is no longer in the catalogue`;
  }
  if (!isProviderConfigured(provider)) {
    return `${provider.envKey} isn't set`;
  }
  if (!modelFitsFeature(model, feature)) {
    return `${model.label} can't do this job`;
  }
  return null;
};

export interface ResolvedAiModel {
  feature: AiFeature;
  provider: AiProvider;
  model: AiModel;
  usingDefault: boolean;
  /** Why the saved choice was skipped. */
  notice: string | null;
}

const resolved = (
  feature: AiFeature,
  choice: AiChoice,
  usingDefault: boolean,
  notice: string | null
): ResolvedAiModel => ({
  feature,
  provider: getAiProvider(choice.provider)!,
  model: findModel(loadAiCatalog(), choice)!,
  usingDefault,
  notice,
});

export const resolveAiModel = async (key: AiFeatureKey): Promise<ResolvedAiModel> => {
  const feature = getAiFeature(key)!;
  const saved = feature.lockedReason ? null : ((await loadSettings()).get(key)?.choice ?? null);
  if (!saved) {
    return resolved(feature, feature.default, true, null);
  }
  const reason = unusableReason(feature, saved);
  if (reason) {
    logger.warn(`AI job ${key} is using its default because ${reason}`);
    return resolved(feature, feature.default, true, reason);
  }
  return resolved(feature, saved, false, null);
};
