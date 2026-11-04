import { AppDataSource } from "../database/dataSource.js";
import { AiFeatureSetting } from "../entities/AiFeatureSetting.js";
import { fullNameOf } from "./staffRecord.js";
import { NotFoundError, ValidationError } from "../utils/errors";
import {
  AiChoice,
  AiFeature,
  AiModel,
  AiProvider,
  findModel,
  getAiFeature,
  getAiProvider,
  isProviderConfigured,
  loadAiCatalog,
  modelFitsFeature,
} from "../utils/integrations/ai/catalog.js";
import { completeWith } from "../utils/integrations/ai/gateway.js";
import { clearAiSettingsCache, unusableReason } from "../utils/integrations/ai/settings.js";
import { getErrorStatus } from "../utils/retry.js";
import logger from "../utils/logger.js";

const settingsRepo = () => AppDataSource.getRepository(AiFeatureSetting);

export interface AiModelOption {
  provider: string;
  model: string;
  label: string;
  retiresOn: string | null;
  replacement: string | null;
}

export interface AiFeatureView {
  key: string;
  name: string;
  description: string;
  group: string;
  lockedReason: string | null;
  current: AiChoice;
  usingDefault: boolean;
  notice: string | null;
  updatedAt: Date | null;
  updatedByName: string | null;
  options: AiModelOption[];
}

export interface AiModelsOverview {
  verifiedOn: string;
  providers: Array<{ key: string; name: string; envKey: string; configured: boolean; docsUrl: string }>;
  features: AiFeatureView[];
}

const sameChoice = (a: AiChoice, model: AiModel) => a.provider === model.provider && a.model === model.id;

/** A retiring model stays available only to a job already on it, so nothing new starts using it. */
const optionsFor = (feature: AiFeature, current: AiChoice): AiModel[] =>
  loadAiCatalog().models.filter(
    (model) =>
      modelFitsFeature(model, feature) &&
      (!model.retiresOn || sameChoice(current, model) || sameChoice(feature.default, model))
  );

const toFeatureView = (feature: AiFeature, row: AiFeatureSetting | undefined): AiFeatureView => {
  const saved = feature.lockedReason || !row ? null : { provider: row.provider, model: row.model };
  const notice = saved ? unusableReason(feature, saved) : null;
  const current = saved && !notice ? saved : feature.default;
  return {
    key: feature.key,
    name: feature.name,
    description: feature.description,
    group: feature.group,
    lockedReason: feature.lockedReason ?? null,
    current,
    usingDefault: current === feature.default,
    notice,
    updatedAt: saved ? row!.updatedAt : null,
    updatedByName: saved && row!.updatedBy ? fullNameOf(row!.updatedBy) : null,
    options: optionsFor(feature, current).map((model) => ({
      provider: model.provider,
      model: model.id,
      label: model.label,
      retiresOn: model.retiresOn ?? null,
      replacement: model.replacement ?? null,
    })),
  };
};

const loadRows = async (): Promise<Map<string, AiFeatureSetting>> => {
  const rows = await settingsRepo().find({ relations: { updatedBy: true } });
  return new Map(rows.map((row) => [row.featureKey, row]));
};

export const getAiModelsOverview = async (): Promise<AiModelsOverview> => {
  const catalog = loadAiCatalog();
  const rows = await loadRows();
  return {
    verifiedOn: catalog.verifiedOn,
    providers: catalog.providers.map((provider) => ({
      key: provider.key,
      name: provider.name,
      envKey: provider.envKey,
      configured: isProviderConfigured(provider),
      docsUrl: provider.docsUrl,
    })),
    features: catalog.features.map((feature) => toFeatureView(feature, rows.get(feature.key))),
  };
};

const TEST_SCHEMA = {
  name: "ai_model_test",
  strict: true,
  schema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
};

/** Provider error text is logged, not returned, because it can quote part of the API key. */
const assertModelAnswers = async (
  feature: AiFeature,
  provider: AiProvider,
  model: AiModel
): Promise<void> => {
  const failed = (reason: string) =>
    new ValidationError(`${model.label} didn't pass the test, so it wasn't saved: ${reason}.`);

  let content: string | null | undefined;
  try {
    const completion = await completeWith(
      provider,
      model,
      {
        messages: [
          { role: "system", content: 'Reply with this JSON object and nothing else: {"ok":true}' },
          { role: "user", content: "Test" },
        ],
        max_tokens: 50,
        response_format:
          feature.format === "json_schema"
            ? { type: "json_schema", json_schema: TEST_SCHEMA }
            : { type: "json_object" },
      },
      { timeout: provider.attemptTimeoutMs, maxRetries: 0 }
    );
    content = completion.choices[0]?.message.content;
  } catch (err) {
    logger.error(`AI model test failed for ${model.id}: ${(err as Error).message}`);
    const status = getErrorStatus(err);
    throw failed(status ? `the provider answered with status ${status}` : "the provider didn't answer");
  }

  let parsed: { ok?: unknown } | null = null;
  try {
    parsed = JSON.parse(content ?? "") as { ok?: unknown };
  } catch {
    parsed = null;
  }
  if (parsed?.ok !== true) {
    throw failed("its reply wasn't the JSON we asked for");
  }
};

export const updateAiFeatureModel = async (
  adminId: string,
  featureKey: string,
  choice: AiChoice
): Promise<AiFeatureView> => {
  const feature = getAiFeature(featureKey);
  if (!feature) {
    throw new NotFoundError("AI job not found");
  }
  if (feature.lockedReason) {
    throw new ValidationError(feature.lockedReason);
  }

  const provider = getAiProvider(choice.provider);
  const model = findModel(loadAiCatalog(), choice);
  if (!provider || !model) {
    throw new ValidationError("Choose a model from the catalogue");
  }
  if (!isProviderConfigured(provider)) {
    throw new ValidationError(`Add ${provider.envKey} to the environment to use ${provider.name}`);
  }

  const rows = await loadRows();
  const row = rows.get(feature.key);
  const current = row ? { provider: row.provider, model: row.model } : feature.default;
  if (!optionsFor(feature, current).includes(model)) {
    throw new ValidationError(`${model.label} can't be chosen for ${feature.name}`);
  }

  await assertModelAnswers(feature, provider, model);

  await settingsRepo().save(
    settingsRepo().create({
      featureKey: feature.key,
      provider: provider.key,
      model: model.id,
      updatedById: adminId,
    })
  );
  clearAiSettingsCache();

  return toFeatureView(feature, (await loadRows()).get(feature.key));
};
