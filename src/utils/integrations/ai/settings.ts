import { AppDataSource } from "../../../database/dataSource.js";
import { AiFeatureSetting } from "../../../entities/AiFeatureSetting.js";
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

let cache: { rows: Map<string, AiChoice>; loadedAt: number } | null = null;

export const clearAiSettingsCache = (): void => {
  cache = null;
};

const loadSettings = async (): Promise<Map<string, AiChoice>> => {
  if (cache && Date.now() - cache.loadedAt < SETTINGS_CACHE_MS) {
    return cache.rows;
  }
  if (!AppDataSource.isInitialized) {
    return new Map();
  }
  try {
    const rows = await AppDataSource.getRepository(AiFeatureSetting).find();
    const settings = new Map(
      rows.map((row) => [row.featureKey, { provider: row.provider, model: row.model }])
    );
    cache = { rows: settings, loadedAt: Date.now() };
    return settings;
  } catch (err) {
    logger.error(`Could not load AI settings, using defaults: ${(err as Error).message}`);
    return cache?.rows ?? new Map();
  }
};

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
  const saved = feature.lockedReason ? undefined : (await loadSettings()).get(key);
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
