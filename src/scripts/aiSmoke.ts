import "reflect-metadata";
import "dotenv/config";
import {
  AiModel,
  AiProvider,
  AiResponseFormat,
  isProviderConfigured,
  loadAiCatalog,
} from "../utils/integrations/ai/catalog.js";
import { completeWith, embedWith } from "../utils/integrations/ai/gateway.js";

const EMBEDDING_DIMENSIONS = 512;

const SCHEMA = {
  name: "ai_smoke_test",
  strict: true,
  schema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
};

const checkChat = async (provider: AiProvider, model: AiModel, format: AiResponseFormat) => {
  const completion = await completeWith(provider, model, {
    messages: [
      { role: "system", content: 'Reply with this JSON object and nothing else: {"ok":true}' },
      { role: "user", content: "Test" },
    ],
    max_tokens: 50,
    temperature: 0,
    response_format:
      format === "json_schema"
        ? { type: "json_schema", json_schema: SCHEMA }
        : { type: "json_object" },
  });
  const parsed = JSON.parse(completion.choices[0]?.message.content ?? "") as { ok?: unknown };
  if (parsed.ok !== true) {
    throw new Error("Reply wasn't the JSON we asked for");
  }
};

const checkEmbedding = async (provider: AiProvider, model: AiModel) => {
  const response = await embedWith(provider, model, {
    input: "Test",
    encoding_format: "float",
    dimensions: EMBEDDING_DIMENSIONS,
  });
  const length = response.data[0]?.embedding.length;
  if (length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Returned ${length} dimensions instead of ${EMBEDDING_DIMENSIONS}`);
  }
};

const report = async (label: string, check: () => Promise<void>): Promise<boolean> => {
  try {
    await check();
    console.log(`PASS  ${label}`);
    return true;
  } catch (err) {
    console.log(`FAIL  ${label}: ${(err as Error).message}`);
    return false;
  }
};

async function run(): Promise<void> {
  const catalog = loadAiCatalog();
  let failures = 0;

  for (const provider of catalog.providers) {
    if (!isProviderConfigured(provider)) {
      console.log(`SKIP  ${provider.name}: ${provider.envKey} isn't set`);
      continue;
    }
    for (const model of catalog.models.filter((item) => item.provider === provider.key)) {
      if (model.kind === "embedding") {
        const passed = await report(`${model.id} embedding`, () => checkEmbedding(provider, model));
        failures += passed ? 0 : 1;
        continue;
      }
      for (const format of model.formats ?? []) {
        const passed = await report(`${model.id} ${format}`, () => checkChat(provider, model, format));
        failures += passed ? 0 : 1;
      }
    }
  }

  console.log(failures === 0 ? "All checks passed" : `${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

void run();
