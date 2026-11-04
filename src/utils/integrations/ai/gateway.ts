import OpenAI from "openai";
import { createLimiter, Limiter } from "../../concurrencyLimiter.js";
import { AiConfigError } from "../../errors/AiConfigError.js";
import { getErrorStatus, withRetry } from "../../retry.js";
import { AiFeatureKey, AiModel, AiProvider } from "./catalog.js";
import { resolveAiModel } from "./settings.js";

export type AiChatParams = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  "model"
>;
export type AiEmbeddingParams = Omit<OpenAI.Embeddings.EmbeddingCreateParams, "model">;

const CONCURRENT_CALLS_PER_PROVIDER = 5;
const MISCONFIGURED_STATUSES = new Set([401, 403, 404]);

const clients = new Map<string, OpenAI>();
const limiters = new Map<string, Limiter>();

const clientFor = (provider: AiProvider): OpenAI => {
  const existing = clients.get(provider.key);
  if (existing) return existing;
  const apiKey = process.env[provider.envKey]?.trim();
  if (!apiKey) {
    throw new AiConfigError(`Add ${provider.envKey} to the environment to use ${provider.name}.`);
  }
  // The SDK otherwise reads OPENAI_BASE_URL, OPENAI_ORG_ID and OPENAI_PROJECT_ID for every client.
  const client = new OpenAI({
    apiKey,
    baseURL: provider.baseUrl,
    ...(provider.key === "openai" ? {} : { organization: null, project: null }),
  });
  clients.set(provider.key, client);
  return client;
};

const limiterFor = (provider: AiProvider): Limiter => {
  let limiter = limiters.get(provider.key);
  if (!limiter) {
    limiter = createLimiter(CONCURRENT_CALLS_PER_PROVIDER);
    limiters.set(provider.key, limiter);
  }
  return limiter;
};

/** Each model takes slightly different fields, and an unsupported one fails the whole request. */
export const buildChatRequest = (
  model: AiModel,
  params: AiChatParams
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming => {
  const { max_tokens: maxTokens, temperature, ...rest } = params;
  const request: Record<string, unknown> = { ...rest, model: model.id };
  if (temperature !== undefined && temperature !== null && model.supportsTemperature) {
    request["temperature"] = temperature;
  }
  if (maxTokens !== undefined && maxTokens !== null) {
    request[model.tokenParam ?? "max_tokens"] = Math.max(maxTokens, model.minOutputTokens ?? 0);
  }
  if (model.reasoningEffort) {
    request["reasoning_effort"] = model.reasoningEffort;
  }
  return request as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
};

const asConfigError = (err: unknown, provider: AiProvider, model: AiModel): unknown => {
  const status = getErrorStatus(err);
  return status !== undefined && MISCONFIGURED_STATUSES.has(status)
    ? new AiConfigError(`${provider.name} refused ${model.label} with status ${status}.`)
    : err;
};

/** Sends directly to one provider and model, so the admin page can test a choice before saving it. */
export const completeWith = async (
  provider: AiProvider,
  model: AiModel,
  params: AiChatParams,
  requestOptions?: OpenAI.RequestOptions
): Promise<OpenAI.Chat.Completions.ChatCompletion> => {
  const client = clientFor(provider);
  try {
    return await limiterFor(provider).run(() =>
      withRetry(() => client.chat.completions.create(buildChatRequest(model, params), requestOptions), {
        label: `${provider.name} chat completion`,
      })
    );
  } catch (err) {
    throw asConfigError(err, provider, model);
  }
};

export const complete = async (
  key: AiFeatureKey,
  params: AiChatParams,
  requestOptions?: OpenAI.RequestOptions
): Promise<OpenAI.Chat.Completions.ChatCompletion> => {
  const { provider, model } = await resolveAiModel(key);
  return completeWith(provider, model, params, requestOptions);
};

const PEOPLE_AI_TOTAL_MS = 80_000;

/**
 * For calls someone is waiting on. Timeouts are set and SDK retries are off so `withRetry`
 * doesn't multiply them. The deadline is checked before each attempt, because the limiter
 * queues without one and a call nobody is waiting for shouldn't spend money.
 */
export const completeWhileWaiting = async (
  key: AiFeatureKey,
  params: AiChatParams
): Promise<OpenAI.Chat.Completions.ChatCompletion> => {
  const { provider, model } = await resolveAiModel(key);
  const client = clientFor(provider);
  const deadline = Date.now() + PEOPLE_AI_TOTAL_MS;
  try {
    return await limiterFor(provider).run(() =>
      withRetry(
        () => {
          if (Date.now() > deadline) {
            throw new Error("The AI request waited too long");
          }
          return client.chat.completions.create(buildChatRequest(model, params), {
            timeout: provider.attemptTimeoutMs,
            maxRetries: 0,
          });
        },
        { label: `${provider.name} chat completion` }
      )
    );
  } catch (err) {
    throw asConfigError(err, provider, model);
  }
};

export const embed = async (
  key: AiFeatureKey,
  params: AiEmbeddingParams
): Promise<OpenAI.Embeddings.CreateEmbeddingResponse> => {
  const { provider, model } = await resolveAiModel(key);
  return embedWith(provider, model, params);
};

export const embedWith = async (
  provider: AiProvider,
  model: AiModel,
  params: AiEmbeddingParams
): Promise<OpenAI.Embeddings.CreateEmbeddingResponse> => {
  const client = clientFor(provider);
  try {
    return await limiterFor(provider).run(() =>
      withRetry(() => client.embeddings.create({ ...params, model: model.id }), {
        label: `${provider.name} embedding`,
      })
    );
  } catch (err) {
    throw asConfigError(err, provider, model);
  }
};
