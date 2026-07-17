/**
 * v0.41.21.0 — single source of truth for model-id parsing (PRICING side).
 *
 * Splits `provider:model`, `provider/model`, and bare `model` strings into
 * a `{provider, model}` pair. Five pricing/budget sites across the codebase
 * used to inline their own ad-hoc split (colon-only); the slash-form miss
 * kept refiring as a bug class (#1540 most recently). One helper kills it.
 *
 * **Name disambiguation:** the gateway-side resolver `src/core/ai/model-resolver.ts`
 * has its own `parseModelId` that throws on bare names (a gateway routing
 * decision needs an explicit provider; pricing can fall through to bare-key
 * pricing-table lookup). To avoid in-project name collision, this helper is
 * named `splitProviderModelId`. Both functions accept the same input shapes
 * after v0.41.21.0; they differ in how they handle bare names (this returns
 * `{provider: null, model: 'bare'}`; the gateway one throws).
 *
 * Separator precedence: `:` wins over `/`. The motivating case is
 * OpenRouter's nested form `openrouter:anthropic/claude-sonnet-4.6` —
 * the canonical transport-vs-vendor split is on the leading colon, so the
 * helper returns `{provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6'}`.
 * Downstream pricing lookups that miss on the slash-bearing tail land in
 * the caller's existing "unknown model" path (warn-once or no_pricing,
 * depending on the caller). We do NOT recursively peel inner provider
 * prefixes — that would conflate transport identity with billing identity
 * (OpenRouter markup ≠ native Anthropic pricing).
 *
 * Defensive contract: null / undefined / empty / whitespace-only input
 * returns `{provider: null, model: ''}` rather than throwing. The TypeScript
 * signature reflects this so callers can pass uncertain input without
 * `as any` casts (env-var-unset paths, optional config fields).
 */

export interface SplitProviderModelId {
  /** Provider prefix when separator present; null for bare or empty input. */
  provider: string | null;
  /** Model tail after the separator; '' for empty input. */
  model: string;
}

const EMPTY: SplitProviderModelId = { provider: null, model: '' };

export function splitProviderModelId(input: string | null | undefined): SplitProviderModelId {
  if (input === null || input === undefined) return EMPTY;
  const trimmed = input.trim();
  if (trimmed.length === 0) return EMPTY;

  const colon = trimmed.indexOf(':');
  if (colon !== -1) {
    return {
      provider: trimmed.slice(0, colon),
      model: trimmed.slice(colon + 1),
    };
  }

  const slash = trimmed.indexOf('/');
  if (slash !== -1) {
    return {
      provider: trimmed.slice(0, slash),
      model: trimmed.slice(slash + 1),
    };
  }

  return { provider: null, model: trimmed };
}

/**
 * v0.41.x (#1698) — canonical `provider:model` normalizer shared by every chat-adapter
 * site that used to inline the colon-only `x.includes(':') ? x : `anthropic:${x}`` check.
 * That inline silently mangled slash form: `anthropic/claude-sonnet-4-6` (no colon) became
 * the malformed `anthropic:anthropic/claude-sonnet-4-6`, which `resolveRecipe` accepted at
 * the provider level and only blew up later inside `gateway.chat()`.
 *
 * Behavior (built on `splitProviderModelId`, so it inherits colon-first precedence):
 *   - `anthropic/claude-sonnet-4-6`        → `anthropic:claude-sonnet-4-6`  (slash → colon)
 *   - `claude-sonnet-4-6`                  → `anthropic:claude-sonnet-4-6`  (bare → default)
 *   - `anthropic:claude-sonnet-4-6`        → unchanged                      (colon identity)
 *   - `openrouter:anthropic/claude-4.6`    → unchanged   (nested: inner slash preserved)
 *   - ''/'   ' (empty/whitespace)          → returned as-is (downstream throws loudly)
 *   - `:claude-sonnet-4-6` / `/claude-...` → returned as-is (malformed leading separator —
 *                                            empty-string provider; downstream throws loudly)
 */
/**
 * Bedrock region inference-profile prefixes. Newer Bedrock models are
 * inference-profile-only (the raw on-demand id fails with ValidationException),
 * so ids arrive region-prefixed. These prefixes are billing-irrelevant — the
 * price is the underlying vendor+model's canonical rate, identical across
 * regions. `us.`/`global.` are what the Bedrock recipe ships today; `eu.`/`apac.`
 * are the other published AWS cross-region profiles, folded in so a non-US
 * install doesn't silently re-open the budget gate.
 */
const BEDROCK_PROFILE_PREFIX = /^(?:us|global|eu|apac)\./;

/**
 * Peel a Bedrock inference-profile id down to its canonical `provider:model`
 * pricing key, or return null when the input isn't a Bedrock-transport id.
 *
 * The Bedrock recipe (`src/core/ai/recipes/bedrock.ts`, via a LiteLLM proxy)
 * hands consumers ids shaped like `bedrock:us.anthropic.claude-opus-4-8`:
 *   - `bedrock:` (or `bedrock/`) — transport prefix
 *   - `us.` / `global.` / `eu.` / `apac.` — region inference-profile prefix
 *   - `anthropic.claude-opus-4-8` — a DOTTED `vendor.model` tail
 * None of the Bedrock framing changes the price, so this strips the transport +
 * region layers and rewrites the dotted `vendor.model` tail into the native
 * `vendor:model` form the canonical chat-pricing table is keyed by (e.g.
 * `anthropic:claude-opus-4-8`). Non-Bedrock ids return null so callers fall
 * through to their normal lookup. Pre-fix these ids missed every pricing table
 * → `estimateMaxCostUsd` returned null → the dream-cycle budget gate emitted
 * `BUDGET_METER_NO_PRICING` and the per-source cap failed open on Bedrock runs.
 *
 * Note: this maps to the NATIVE vendor rate. A Bedrock/Cohere embed id
 * (`bedrock:us.cohere.embed-v4:0`) rewrites to `cohere:embed-v4:0`, which is
 * absent from the chat-pricing table (embeddings price separately) and so
 * correctly stays a miss.
 */
export function bedrockToCanonicalKey(input: string | null | undefined): string | null {
  const { provider, model } = splitProviderModelId(input);
  if (provider !== 'bedrock' || !model) return null;
  const profileStripped = model.replace(BEDROCK_PROFILE_PREFIX, '');
  // Bedrock model ids are dotted `vendor.model`; the vendor becomes the
  // canonical provider and the remainder the model. Split on the FIRST dot.
  const dot = profileStripped.indexOf('.');
  if (dot === -1) return null;
  const vendor = profileStripped.slice(0, dot);
  const modelTail = profileStripped.slice(dot + 1);
  if (!vendor || !modelTail) return null;
  return `${vendor}:${modelTail}`;
}

export function normalizeModelId(input: string, defaultProvider = 'anthropic'): string {
  const { provider, model } = splitProviderModelId(input);
  // Return unchanged (so resolveRecipe throws loudly — #1698) when:
  //   - empty/whitespace input (`model === ''`), or
  //   - a malformed leading separator (`:foo` / `/foo`) — splitProviderModelId yields an
  //     EMPTY-STRING provider for those. Without this guard the `provider ?` truthiness
  //     below treats `''` as "no provider" and silently coerces the model to the default
  //     (e.g. `:claude-sonnet-4-6` → `anthropic:claude-sonnet-4-6`), masking a typo as a
  //     valid Anthropic model. A `null` provider (bare name like `claude-opus-4-7`) still
  //     defaults — that's the intended path.
  if (!model || provider === '') return input;
  return provider ? `${provider}:${model}` : `${defaultProvider}:${model}`;
}
