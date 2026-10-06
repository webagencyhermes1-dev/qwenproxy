import { createHash } from "crypto";
import { Hono } from "hono";
import { fetchQwenModels } from "../services/qwen.js";
import { loadAccounts } from "../core/accounts.ts";
import {
  getAccountCooldownInfo,
  getHeadersReadyAccountIds,
  isAccountHeadersReady,
} from "../core/account-manager.ts";
import { getAccountsByPriority } from "../core/account-priority.ts";
import { NotFoundError } from "../core/errors.js";
import { sendOpenAIError } from "./error-helpers.js";
import { withDeadline, FailFastTimeoutError } from "./fail-fast.js";
import { config } from "../core/config.js";
import {
  getModelCapabilities,
  getModelContextWindow,
  syncModelMetadata,
} from "../core/model-registry.ts";
import { listMediaGenerationModels } from "../services/media-generation.ts";
import { isPlaywrightInitialized } from "../services/playwright.ts";
import { isAuthMockEnabled } from "../services/auth-playwright.ts";

const app = new Hono();

/**
 * Stable creation timestamp for synthetic models (the static chat fallback
 * and media-generation models). Uses a fixed value so the ETag remains stable
 * across requests.
 * 2025-01-01T00:00:00Z
 */
const MEDIA_MODELS_CREATED_AT = 1735689600;

function getPreferredModelsAccountId(): string | undefined {
  try {
    const accounts = loadAccounts();
    if (accounts.length === 0) return undefined;

    // Prefer an account whose browser is already open so the models fetch
    // reuses the running session instead of launching a new browser for a
    // standby account. Among usable accounts, follow the same priority
    // order as request routing: HOT (headers-ready) first, then any open
    // browser, then plain priority order.
    const usable = getAccountsByPriority(accounts).filter(
      (account) => !getAccountCooldownInfo(account.id),
    );
    const ready = usable.find((account) =>
      isAccountHeadersReady(account.id),
    );
    const initialized = usable.find((account) =>
      isPlaywrightInitialized(account.id),
    );
    return (ready || initialized || usable[0] || accounts[0]).id;
  } catch {
    return undefined;
  }
}

export type PublicModel = {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  context_window?: number;
  is_active?: boolean;
  capabilities?: Record<string, unknown>;
  [key: string]: unknown;
};

function baseModelId(modelId: string): string {
  // Strip any reasoning suffix (-low, -medium, -high, -fast, -thinking) so the
  // public /v1/models catalog returns strictly canonical unique base models without duplicates.
  return modelId.replace(/-(?:low|medium|high|fast|no-thinking|thinking)$/, "");
}
/**
 * Returns the public model catalog from the selected account's live
 * catalog. Suffixes (-fast/-thinking) are not synthesized; reasoning
 * is controlled via standard `reasoning_effort` (low/medium/high).
 */
export function expandModelVariants(
  models: PublicModel[],
  accountId?: string,
): PublicModel[] {
  syncModelMetadata(
    models as unknown as Array<Record<string, unknown> & { id: string }>,
    accountId,
  );
  const baseModels = new Map<string, PublicModel>();

  for (const model of models) {
    if (!model?.id) continue;
    const baseId = baseModelId(model.id);
    if (!baseModels.has(baseId)) {
      baseModels.set(baseId, {
        ...model,
        id: baseId,
        object: "model",
      });
    }
  }

  return [...baseModels.values()];
}

function toAnthropicModel(model: PublicModel, accountId?: string) {
  const capabilities = getModelCapabilities(model.id, accountId);
  const isFastVariant = model.id.endsWith("-fast");
  const contextWindow =
    model.context_window ?? getModelContextWindow(model.id, accountId);

  return {
    id: model.id,
    display_name:
      typeof model.name === "string" && model.name ? model.name : model.id,
    created_at: new Date(
      typeof model.created === "number" ? model.created * 1000 : Date.now(),
    ).toISOString(),
    max_input_tokens: contextWindow,
    max_tokens: capabilities.maxOutputTokens,
    type: "model" as const,
    capabilities: {
      batch: { supported: false },
      citations: { supported: capabilities.supportsCitations },
      code_execution: { supported: capabilities.supportsCodeExecution },
      image_input: { supported: capabilities.supportsVision },
      pdf_input: { supported: capabilities.supportsDocument },
      structured_outputs: {
        supported: capabilities.supportsStructuredOutputs,
      },
      thinking: {
        supported: capabilities.supportsThinking,
        types: {
          enabled: { supported: capabilities.supportsThinking },
          disabled: {
            supported: isFastVariant || capabilities.canSkipThinking,
          },
        },
      },
      audio_input: { supported: capabilities.supportsAudio },
      video_input: { supported: capabilities.supportsVideo },
    },
  };
}

function wantsAnthropicModelsFormat(
  anthropicVersion: string | undefined | null,
): boolean {
  return !!anthropicVersion;
}

/**
 * Annotate live models with media-generation metadata and append the media
 * models Qwen did not return, so /v1/models always advertises them.
 */
function augmentWithMediaModels(expanded: PublicModel[]): PublicModel[] {
  // Advertise media generation models so clients can discover them via
  // /v1/models, including their supported generation modalities. Annotate a
  // live model in place when Qwen already returned the same ID.
  const mediaDefinitions = listMediaGenerationModels();
  const mediaById = new Map(mediaDefinitions.map((definition) => [definition.id, definition]));
  const expandedWithMedia = expanded.map((model) => {
    const definition = mediaById.get(model.id);
    if (!definition) return model;
    return {
      ...model,
      media_generation: definition.kind,
      media_modes: definition.modes,
      media_reference_required: definition.modes.every(
        (mode) => mode === "i2i" || mode === "i2v",
      ),
    };
  });
  const existing = new Set(expanded.map((model) => model.id));
  const mediaModels: PublicModel[] = mediaDefinitions
    .filter(({ id }) => !existing.has(id))
    .map(({ id, kind, modes }) => ({
      id,
      object: "model",
      created: MEDIA_MODELS_CREATED_AT,
      owned_by: "qwen",
      media_generation: kind,
      media_modes: modes,
      media_reference_required: modes.every(
        (mode) => mode === "i2i" || mode === "i2v",
      ),
    }));

  return [...expandedWithMedia, ...mediaModels];
}

async function loadModelsWithVariants(): Promise<{
  models: PublicModel[];
  accountId?: string;
}> {
  const accountId = getPreferredModelsAccountId();
  const models = (await fetchQwenModels(accountId)) as unknown as PublicModel[];
  const expanded = expandModelVariants(models, accountId);
  return {
    models: augmentWithMediaModels(expanded),
    accountId,
  };
}

/**
 * Last-resort catalog built WITHOUT any account or Playwright access: the
 * model IDs this proxy itself references (alias targets, chat pool models)
 * plus the media-generation definitions. Served when the pool is cold and no
 * live catalog has ever been fetched, so /v1/models still answers 200
 * instantly instead of erroring while warmup is stuck. Never written to the
 * catalog cache — a later live fetch replaces it.
 */
function buildStaticCatalog(): PublicModel[] {
  const ids = new Set<string>([
    "qwen3.8-max",
    "qwen3.7-plus",
    ...config.qwen.chatPoolModels,
  ]);
  const models: PublicModel[] = [...ids].map((id) => ({
    id,
    object: "model",
    created: MEDIA_MODELS_CREATED_AT,
    owned_by: "qwen",
  }));
  return augmentWithMediaModels(models);
}

function findModel(
  models: PublicModel[],
  modelId: string,
): PublicModel | undefined {
  // Variants are materialized by expandModelVariants only when the live
  // catalog says they are supported. Do not synthesize an invalid variant for
  // a direct lookup.
  return models.find((entry) => entry.id === modelId);
}

// ─── Bounded catalog loading ─────────────────────────────────────────────────
//
// The live catalog fetch acquires the per-account Playwright mutex
// (`headers:<account>`). Warmup holds that mutex for minutes while header
// capture is stuck, so an unbounded fetch makes /v1/models queue behind a
// 60s acquire timeout (observed: request hanging ~60s, then failing). The
// request path therefore:
//   1. serves a fresh in-memory catalog without touching Playwright at all,
//   2. only attempts a live fetch while at least one account is HOT
//      (headers-ready) — a cold/stuck pool can never block the endpoint,
//   3. bounds every live attempt with a 2s deadline (single-flight: concurrent
//      requests share one attempt, so at most one mutex waiter exists),
//   4. opens a short circuit after a failed attempt instead of retrying the
//      mutex on every request,
//   5. falls back to the last successful catalog, else a static built-in
//      catalog that needs no account access (source "static"), so the
//      endpoint still answers 200 instantly on a cold pool.

/** Mirrors MODEL_CACHE_TTL_MS in services/qwen.ts. */
const CATALOG_FRESH_MS = 60 * 60 * 1000;
/** Hard budget for one live catalog attempt on the request path. */
const LIVE_FETCH_BUDGET_MS = 2_000;
/** After a failed live attempt, skip live attempts for this long. */
const LIVE_FAILURE_COOLDOWN_MS = 15_000;

type CatalogSnapshot = {
  models: PublicModel[];
  accountId?: string;
  fetchedAt: number;
};

let catalogCache: CatalogSnapshot | null = null;
let staticCatalogCache: PublicModel[] | null = null;
let liveCatalogLoad: Promise<{
  models: PublicModel[];
  accountId?: string;
}> | null = null;
let liveCatalogBlockedUntil = 0;

/**
 * Static catalog snapshot. Built once (pure, no I/O) and NEVER written to
 * `catalogCache` — it must not mask a live fetch once an account warms up.
 */
function staticFallbackSnapshot(): CatalogSnapshot {
  if (!staticCatalogCache) staticCatalogCache = buildStaticCatalog();
  return { models: staticCatalogCache, fetchedAt: Date.now() };
}

/**
 * A live fetch may only start when the pool can actually serve it. Mock mode
 * (tests) fetches through Node's fetch and needs no account.
 */
function canAttemptLiveCatalog(): boolean {
  if (isAuthMockEnabled()) return true;
  try {
    return getHeadersReadyAccountIds().length > 0;
  } catch {
    return false;
  }
}

/** Single-flight live load; late success still refreshes the cache. */
function startLiveCatalogLoad(): Promise<{
  models: PublicModel[];
  accountId?: string;
}> {
  if (liveCatalogLoad) return liveCatalogLoad;

  const load = loadModelsWithVariants();
  liveCatalogLoad = load;
  load
    .then((result) => {
      catalogCache = { ...result, fetchedAt: Date.now() };
    })
    .catch((error: unknown) => {
      liveCatalogBlockedUntil = Date.now() + LIVE_FAILURE_COOLDOWN_MS;
      console.warn(
        "⚠️ [Models] Live catalog refresh failed; serving cached catalog when available:",
        error instanceof Error ? error.message : String(error),
      );
    })
    .finally(() => {
      if (liveCatalogLoad === load) liveCatalogLoad = null;
    });
  return load;
}

async function getCatalogSnapshot(): Promise<{
  snapshot: CatalogSnapshot;
  source: "live" | "cache" | "stale" | "static";
}> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.fetchedAt < CATALOG_FRESH_MS) {
    return { snapshot: catalogCache, source: "cache" };
  }
  const staleFallback = catalogCache
    ? ({ snapshot: catalogCache, source: "stale" as const })
    : null;

  if (now < liveCatalogBlockedUntil) {
    if (staleFallback) return staleFallback;
    return { snapshot: staticFallbackSnapshot(), source: "static" };
  }

  if (!canAttemptLiveCatalog()) {
    if (staleFallback) return staleFallback;
    return { snapshot: staticFallbackSnapshot(), source: "static" };
  }

  try {
    const result = await withDeadline(
      "model catalog fetch",
      LIVE_FETCH_BUDGET_MS,
      () => startLiveCatalogLoad(),
    );
    const snapshot: CatalogSnapshot = {
      models: result.models,
      accountId: result.accountId,
      fetchedAt: Date.now(),
    };
    catalogCache = snapshot;
    return { snapshot, source: "live" };
  } catch (error) {
    if (error instanceof FailFastTimeoutError) {
      liveCatalogBlockedUntil = Date.now() + LIVE_FAILURE_COOLDOWN_MS;
    } else {
      console.warn(
        "⚠️ [Models] Live catalog fetch failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (staleFallback) return staleFallback;
    return { snapshot: staticFallbackSnapshot(), source: "static" };
  }
}

app.get("/v1/models", async (c) => {
  try {
    const { snapshot, source } = await getCatalogSnapshot();
    const allModels = snapshot.models;
    const accountId = snapshot.accountId;
    const anthropic = wantsAnthropicModelsFormat(c.req.header("anthropic-version"));

    c.header("X-Models-Source", source);

    if (anthropic) {
      return c.json({
        data: allModels.map((model) => toAnthropicModel(model, accountId)),
        has_more: false,
      });
    }

    const etag = `"${createHash("md5").update(JSON.stringify(allModels)).digest("hex")}"`;

    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304);
    }

    c.header("Cache-Control", "public, max-age=3600");
    c.header("ETag", etag);

    return c.json({
      object: "list",
      data: allModels,
    });
  } catch (error) {
    console.error("❌ [Models] Error fetching models:", error);
    return sendOpenAIError(c, error);
  }
});

app.get("/v1/models/:model", async (c) => {
  try {
    const modelId = c.req.param("model");
    const { snapshot, source } = await getCatalogSnapshot();
    const allModels = snapshot.models;
    const accountId = snapshot.accountId;
    const model = findModel(allModels, modelId);
    const anthropic = wantsAnthropicModelsFormat(c.req.header("anthropic-version"));

    c.header("X-Models-Source", source);

    if (!model) {
      if (anthropic) {
        return c.json(
          {
            type: "error",
            error: {
              type: "not_found_error",
              message: `Model '${modelId}' not found`,
            },
          },
          404,
        );
      }
      return sendOpenAIError(c, new NotFoundError("Model not found"));
    }

    if (anthropic) {
      return c.json(toAnthropicModel(model, accountId));
    }

    return c.json(model);
  } catch (error) {
    console.error("❌ [Models] Error fetching model:", error);
    return sendOpenAIError(c, error);
  }
});


export { app };
