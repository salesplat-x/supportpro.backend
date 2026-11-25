import { AppDataSource } from "../database/dataSource.js";
import { AiFeatureSetting } from "../entities/AiFeatureSetting.js";
import { fullNameOf } from "./staffRecord.js";
import { AiCreditError, NotFoundError, ValidationError } from "../utils/errors";
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
import {
  AiPromptPart,
  getPromptParts,
  loadAiPrompts,
  promptProblem,
} from "../utils/integrations/ai/prompts.js";
import { clearAiSettingsCache, unusableReason } from "../utils/integrations/ai/settings.js";
import { getErrorStatus } from "../utils/retry.js";
import logger from "../utils/logger.js";
import { AiSkillSetting } from "../entities/AiSkillSetting.js";
import { getAiSkill, loadAiSkills, skillProblem } from "../utils/integrations/ai/skills.js";

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
  promptParts: number;
  editedPromptParts: number;
}

export interface AiPromptPartView {
  key: string;
  label: string;
  text: string;
  defaultText: string;
  edited: boolean;
  /** Why the saved edit is being ignored, for example after the catalogue changed. */
  problem: string | null;
  variables: Array<{ name: string; description: string }>;
  /** Shared skills placed before this part's text. */
  skills: Array<{ key: string; label: string }>;
}

export interface AiSkillView {
  key: string;
  label: string;
  description: string;
  text: string;
  defaultText: string;
  edited: boolean;
  usedBy: Array<{ key: string; name: string }>;
}

export interface AiModelsOverview {
  verifiedOn: string;
  providers: Array<{
    key: string;
    name: string;
    envKey: string;
    configured: boolean;
    docsUrl: string;
  }>;
  features: AiFeatureView[];
}

const sameChoice = (a: AiChoice, model: AiModel) =>
  a.provider === model.provider && a.model === model.id;

/** A retiring model stays available only to a job already on it, so nothing new starts using it. */
const optionsFor = (feature: AiFeature, current: AiChoice): AiModel[] =>
  loadAiCatalog().models.filter(
    (model) =>
      modelFitsFeature(model, feature) &&
      (!model.retiresOn || sameChoice(current, model) || sameChoice(feature.default, model))
  );

const savedChoice = (row: AiFeatureSetting | undefined): AiChoice | null =>
  row?.provider && row.model ? { provider: row.provider, model: row.model } : null;

const toFeatureView = (feature: AiFeature, row: AiFeatureSetting | undefined): AiFeatureView => {
  const saved = feature.lockedReason ? null : savedChoice(row);
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
    promptParts: getPromptParts(feature.key).length,
    editedPromptParts: Object.keys(row?.prompts ?? {}).length,
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
    if (err instanceof AiCreditError) {
      throw failed(`${provider.name} says the account is out of credit`);
    }
    const status = getErrorStatus(err);
    throw failed(
      status ? `the provider answered with status ${status}` : "the provider didn't answer"
    );
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
  const current = savedChoice(rows.get(feature.key)) ?? feature.default;
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

const findPromptFeature = (featureKey: string): { feature: AiFeature; parts: AiPromptPart[] } => {
  const feature = getAiFeature(featureKey);
  if (!feature) {
    throw new NotFoundError("AI job not found");
  }
  const parts = getPromptParts(feature.key);
  if (parts.length === 0) {
    throw new ValidationError(`${feature.name} doesn't use a prompt`);
  }
  return { feature, parts };
};

const toPromptViews = (
  feature: AiFeature,
  parts: AiPromptPart[],
  saved: Record<string, string>
): AiPromptPartView[] => {
  const { variables } = loadAiPrompts();
  return parts.map((part) => {
    const edit = saved[part.key];
    return {
      key: part.key,
      label: part.label,
      text: edit ?? part.text,
      defaultText: part.text,
      edited: edit !== undefined,
      problem: edit === undefined ? null : promptProblem(feature, part, edit),
      variables: (part.variables ?? []).map((name) => ({
        name,
        description: variables[name] ?? "",
      })),
      skills: (part.skills ?? []).map((key) => ({ key, label: getAiSkill(key)?.label ?? key })),
    };
  });
};

export const getAiFeaturePrompts = async (featureKey: string): Promise<AiPromptPartView[]> => {
  const { feature, parts } = findPromptFeature(featureKey);
  const row = await settingsRepo().findOne({ where: { featureKey: feature.key } });
  return toPromptViews(feature, parts, row?.prompts ?? {});
};

/** Text matching the default clears the edit, so a job on its default follows catalogue updates. */
export const updateAiFeaturePrompts = async (
  adminId: string,
  featureKey: string,
  edits: Record<string, string>
): Promise<AiPromptPartView[]> => {
  const { feature, parts } = findPromptFeature(featureKey);

  for (const [partKey, text] of Object.entries(edits)) {
    const part = parts.find((item) => item.key === partKey);
    if (!part) {
      throw new ValidationError(`${feature.name} has no prompt part called ${partKey}`);
    }
    const problem = promptProblem(feature, part, text);
    if (problem) {
      throw new ValidationError(problem);
    }
  }

  const row = await settingsRepo().findOne({ where: { featureKey: feature.key } });
  const prompts = { ...(row?.prompts ?? {}) };
  for (const [partKey, text] of Object.entries(edits)) {
    if (text === parts.find((part) => part.key === partKey)!.text) {
      delete prompts[partKey];
    } else {
      prompts[partKey] = text;
    }
  }

  await settingsRepo().save(
    settingsRepo().create({
      featureKey: feature.key,
      provider: row?.provider ?? null,
      model: row?.model ?? null,
      prompts,
      updatedById: adminId,
    })
  );
  clearAiSettingsCache();

  return toPromptViews(feature, parts, prompts);
};

const skillsRepo = () => AppDataSource.getRepository(AiSkillSetting);

const jobsUsing = (skillKey: string): Array<{ key: string; name: string }> =>
  loadAiCatalog()
    .features.filter((feature) =>
      getPromptParts(feature.key).some((part) => part.skills?.includes(skillKey))
    )
    .map((feature) => ({ key: feature.key, name: feature.name }));

const toSkillViews = (saved: Map<string, string>): AiSkillView[] =>
  loadAiSkills().map((skill) => {
    const edit = saved.get(skill.key);
    return {
      key: skill.key,
      label: skill.label,
      description: skill.description,
      text: edit ?? skill.text,
      defaultText: skill.text,
      edited: edit !== undefined,
      usedBy: jobsUsing(skill.key),
    };
  });

const savedSkillTexts = async (): Promise<Map<string, string>> =>
  new Map((await skillsRepo().find()).map((row) => [row.skillKey, row.text]));

export const getAiSkills = async (): Promise<AiSkillView[]> =>
  toSkillViews(await savedSkillTexts());

/** Text matching the default clears the edit, so the skill follows later catalogue updates. */
export const updateAiSkill = async (
  adminId: string,
  skillKey: string,
  text: string
): Promise<AiSkillView[]> => {
  const skill = getAiSkill(skillKey);
  if (!skill) {
    throw new NotFoundError("AI skill not found");
  }
  const problem = skillProblem(skill.label, text);
  if (problem) {
    throw new ValidationError(problem);
  }
  if (text === skill.text) {
    await skillsRepo().delete({ skillKey });
  } else {
    await skillsRepo().save(skillsRepo().create({ skillKey, text, updatedById: adminId }));
  }
  clearAiSettingsCache();
  return toSkillViews(await savedSkillTexts());
};
