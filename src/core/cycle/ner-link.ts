/**
 * gbrain-shake entity schema pack (R6) — `ner_link` cycle phase. Step 5.
 *
 * The payoff phase: after Steps 1-4 (pack active + entity pages backfilled +
 * linkable), this walks SOURCE pages (transcripts/emails/meetings/sessions/…)
 * by body text and writes `mentions` edges to the linkable entity pages the
 * gazetteer knows about. This is the deterministic (non-LLM) half of the graph
 * loop — the FIRST graph edges the brain ever gets.
 *
 * It is a thin BaseCyclePhase wrapper around `extractNerLinks` (src/core/
 * extract-ner.ts), which was CLI-only until now. The wrapper adds:
 *   - the cycle envelope (uniform run(ctx, opts) → PhaseResult, source scope,
 *     error mapping) via BaseCyclePhase;
 *   - `emitPlainMentions: true` — gbrain-shake declares NO
 *     `link_types[].inference.regex`, so the verb-inference path produces zero
 *     edges. The graph-populating value comes from PLAIN `mentions` edges, so
 *     the phase asks extractNerLinks to write them. (The CLI `gbrain extract
 *     --ner` keeps its verb-only contract; plain mentions there are the
 *     separate `--by-mention` pass.)
 *   - the R5 precision knobs (allow/ignore lists + reject_first_names), loaded
 *     once from config and threaded into the gazetteer + matcher.
 *
 * Guards (design §6.4):
 *   - `!engine` ONLY (NEVER brainDir). This is DB-sourced; the walk iterates
 *     the engine's pages, not an on-disk checkout. The old extract phase
 *     FS-skipped on a checkout-less DB brain (`no_brain_dir`) and never linked
 *     anything — this phase must NOT repeat that. The `!engine` guard lives in
 *     cycle.ts at registration (Step 10); the phase body assumes a live engine.
 *   - Empty gazetteer (fresh brain, pre-backfill) → clean 0-edge no-op, not an
 *     error.
 *   - Idempotent: the links UNIQUE constraint + ON CONFLICT DO NOTHING means a
 *     re-run over unchanged pages creates 0 new edges.
 *
 * Pack-gating (R6.2): the phase runs only when the active pack declares
 * `ner_link` in its `phases:` list. That gate lives in cycle.ts (via
 * packDeclaresPhase) and is wired in Step 10 alongside ALL_PHASES registration
 * — DEFERRED here. This module only builds the phase class + a standalone entry
 * point `runPhaseNerLink`, mirroring how discover-entities.ts exposes
 * `runPhaseDiscoverEntities`. The phase `name` is cast to CyclePhase because
 * the union entry also lands in Step 10.
 */

import { BaseCyclePhase, type ScopedReadOpts, type BasePhaseOpts } from './base-phase.ts';
import { extractNerLinks, type ExtractNerResult } from '../extract-ner.ts';
import { loadNerKnobs, type NerKnobs } from '../by-mention.ts';
import { GBrainError } from '../types.ts';
import type { OperationContext } from '../operations.ts';
import type { BrainEngine } from '../engine.ts';
import type { PhaseStatus, CyclePhase } from '../cycle.ts';

export interface NerLinkOpts extends BasePhaseOpts {
  /** Only scan pages updated after this ISO date (incremental pass). */
  since?: string;
  /** Optional page-type filter on the WALK (default: all source pages). */
  typeFilter?: string;
  /**
   * Inject resolved precision knobs (tests). Production loads them from config
   * via loadNerKnobs (malformed → defaults + warn).
   */
  knobs?: NerKnobs;
  /**
   * Test/override seam: inject the extractor so unit tests run hermetically
   * without re-deriving the whole extractNerLinks pipeline. Production uses the
   * real extractNerLinks.
   */
  extractor?: (
    engine: BrainEngine,
    args: { since?: string; typeFilter?: string; sourceIdFilter?: string; dryRun: boolean; knobs: NerKnobs },
  ) => Promise<ExtractNerResult>;
}

export interface NerLinkResult {
  pages_scanned: number;
  edges_created: number;
  pack_unavailable: boolean;
}

/**
 * BaseCyclePhase subclass. Deterministic (no LLM), so the budget meter is a
 * no-op here — budgetUsdDefault is 0 and no checkBudget() calls are made. The
 * base still constructs a meter; it simply never gates.
 */
class NerLinkPhase extends BaseCyclePhase {
  readonly name = 'ner_link' as CyclePhase;
  protected readonly budgetUsdKey = 'cycle.ner_link.budget_usd';
  protected readonly budgetUsdDefault = 0;

  protected override mapErrorCode(err: unknown): string {
    if (err instanceof GBrainError) return err.problem;
    return 'NER_LINK_UNKNOWN';
  }

  protected async process(
    engine: BrainEngine,
    scope: ScopedReadOpts,
    _ctx: OperationContext,
    opts: NerLinkOpts,
  ): Promise<{ summary: string; details: Record<string, unknown>; status?: PhaseStatus }> {
    const dryRun = opts.dryRun ?? false;
    // R5: resolve the precision knobs once (allow/ignore lists + first-name
    // rejection). extractNerLinks threads them into the gazetteer + matcher.
    const knobs = opts.knobs ?? await loadNerKnobs(engine);

    // Source scope: the extractNerLinks walk supports a single sourceIdFilter.
    // BaseCyclePhase gives us `scope.sourceId` (scalar) — federated multi-source
    // (`scope.sourceIds`) is not yet a param on extractNerLinks, so we scope to
    // the scalar when present and otherwise walk brain-wide. The gazetteer's
    // own cross-source guard (findMentionedEntities) prevents cross-source
    // edges regardless.
    const sourceIdFilter = scope.sourceId;

    const runExtract = opts.extractor
      ? (args: { since?: string; typeFilter?: string; sourceIdFilter?: string; dryRun: boolean; knobs: NerKnobs }) =>
          opts.extractor!(engine, args)
      : (args: { since?: string; typeFilter?: string; sourceIdFilter?: string; dryRun: boolean; knobs: NerKnobs }) =>
          extractNerLinks(engine, {
            dryRun: args.dryRun,
            emitPlainMentions: true, // R6.3: the graph-populating mode
            knobs: args.knobs,
            ...(args.since ? { since: args.since } : {}),
            ...(args.typeFilter ? { typeFilter: args.typeFilter } : {}),
            ...(args.sourceIdFilter ? { sourceIdFilter: args.sourceIdFilter } : {}),
          });

    const res = await runExtract({
      dryRun,
      knobs,
      ...(opts.since ? { since: opts.since } : {}),
      ...(opts.typeFilter ? { typeFilter: opts.typeFilter } : {}),
      ...(sourceIdFilter ? { sourceIdFilter } : {}),
    });

    const result: NerLinkResult = {
      pages_scanned: res.pages,
      edges_created: res.created,
      pack_unavailable: res.pack_unavailable,
    };

    // pack_unavailable in plain-mentions mode means the gazetteer was empty
    // (no linkable entity pages yet) — a clean no-op, NOT a failure. Report it
    // as 'ok' with the count 0 so doctor/report reads it as "nothing to link".
    const summary =
      `ner_link: scanned ${result.pages_scanned} source pages, ` +
      `${result.edges_created} mention edge${result.edges_created === 1 ? '' : 's'} ` +
      `${dryRun ? 'would be created' : 'created'}` +
      (res.created === 0 && res.pages === 0 ? ' (empty gazetteer — no linkable entity pages)' : '');

    return {
      summary,
      details: { ...result, dry_run: dryRun, reject_first_names: knobs.rejectFirstNames },
      status: 'ok',
    };
  }
}

/**
 * Public entry point — mirrors `runPhaseDiscoverEntities` so the cycle
 * orchestrator (Step 10) can call it uniformly once ner_link is registered in
 * ALL_PHASES / cycle.ts.
 */
export async function runPhaseNerLink(ctx: OperationContext, opts: NerLinkOpts = {}) {
  return new NerLinkPhase().run(ctx, opts);
}

/** Test-only access to internals. */
export const __testing = {
  NerLinkPhase,
};
