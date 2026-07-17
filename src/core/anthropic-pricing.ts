/**
 * Anthropic chat pricing — a bare-keyed VIEW of the canonical pricing table
 * (`src/core/model-pricing.ts`).
 *
 * Kept as a distinct export because many callers look up by bare Claude id
 * (`claude-opus-4-7`) and because `estimateMaxCostUsd` carries the
 * null-on-miss contract the dream-cycle budget gate depends on. The dollar
 * numbers live in model-pricing.ts — DO NOT hand-edit prices here; this map is
 * derived from the `anthropic:` canonical entries (prefix stripped), so it
 * cannot drift from the other pricing views. (Pre-unification this map and
 * takes-quality-eval/pricing.ts duplicated the numbers and drifted: Opus 4.7
 * read $15/$75 in one and $5/$25 in the other.)
 *
 * Codex P1 #10 fold: non-Anthropic models (gemini, gpt, anything not in this
 * map) bypass the budget gate with a `BUDGET_METER_NO_PRICING` warn once per
 * process. The cycle still runs unbounded for those models.
 */

import { CANONICAL_PRICING, type ModelPricing } from './model-pricing.ts';
import { splitProviderModelId, bedrockToCanonicalKey } from './model-id.ts';

export type { ModelPricing };

/**
 * Bare-keyed Anthropic view, derived from the canonical table. Both the
 * dateless ids (`claude-haiku-4-5`, used by aliases / TIER_DEFAULTS / most
 * callers) and the dated snapshots (`claude-haiku-4-5-20251001`) are present
 * because canonical carries both.
 */
export const ANTHROPIC_PRICING: Record<string, ModelPricing> = Object.fromEntries(
  Object.entries(CANONICAL_PRICING)
    .filter(([key]) => key.startsWith('anthropic:'))
    .map(([key, pricing]) => [key.slice('anthropic:'.length), pricing]),
);

/**
 * Estimate the upper-bound USD cost of a single submit.
 * Uses (estimatedInputTokens × inputRate) + (maxOutputTokens × outputRate).
 * The maxOutputTokens upper-bounds the output cost — actual completions
 * usually return less.
 *
 * Returns null when the model isn't in the pricing map. Callers warn-once
 * and treat as zero-cost (the cycle runs unbounded for that submit).
 *
 * Accepts bare (`claude-opus-4-7`), colon-prefixed (`anthropic:claude-opus-4-7`),
 * and slash-prefixed (`anthropic/claude-opus-4-7`) ids. Routes through
 * `splitProviderModelId` so the slash-form (which arrives via CLI `--judge-model`
 * and OpenRouter recipe lists) hits the pricing table. Pre-v0.41.21.0 the inline
 * `:`-only split missed slash form → BudgetTracker no_pricing hard-fail with
 * `--max-cost N` (closes #1540).
 *
 * Also accepts Bedrock inference-profile ids (`bedrock:us.anthropic.claude-opus-4-8`)
 * — these route through `canonicalLookup`, which strips the `bedrock:` transport
 * + `us.`/`global.` region-profile prefix and prices at the native vendor rate.
 * Pre-fix the Bedrock cycle handed this id to the budget meter, missed pricing,
 * and the per-source cap failed open with `BUDGET_METER_NO_PRICING`.
 */
export function estimateMaxCostUsd(
  modelId: string,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): number | null {
  let p: ModelPricing | undefined = ANTHROPIC_PRICING[modelId];
  if (!p) {
    const { model: tail } = splitProviderModelId(modelId);
    if (tail) p = ANTHROPIC_PRICING[tail];
  }
  // Bedrock inference-profile ids (`bedrock:us.anthropic.claude-opus-4-8`) →
  // strip transport + region-profile to the native `vendor:model` key, then
  // price via the bare Anthropic view. Routing through ANTHROPIC_PRICING (not
  // canonicalLookup directly) preserves this fn's Anthropic-only null contract:
  // a non-Anthropic Bedrock id (`bedrock:us.meta.llama-...`) yields a non-
  // anthropic key whose bare tail misses the anthropic view → null → the
  // budget meter's unpriced-bypass, same as any other non-Anthropic model.
  if (!p) {
    const bedrockKey = bedrockToCanonicalKey(modelId);
    if (bedrockKey?.startsWith('anthropic:')) {
      p = ANTHROPIC_PRICING[bedrockKey.slice('anthropic:'.length)];
    }
  }
  if (!p) return null;
  return (
    (estimatedInputTokens / 1_000_000) * p.input +
    (maxOutputTokens     / 1_000_000) * p.output
  );
}
