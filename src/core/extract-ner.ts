// src/core/extract-ner.ts
// v0.41.18.0 (A10, T7). NER link extraction reuses the by-mention gazetteer
// and applies schema-pack `link_types[].inference.regex` patterns to assign
// a typed link verb ("CEO of Acme" → 'works_at' linking the page to Acme).
//
// Codex finding #12 design (locked): do NOT split link_source='ner' as a
// new provenance — that would break every existing link_source='mentions'
// query (backlink-count filter, orphan-ratio, doctor checks). Instead:
// keep link_source='mentions' AND set link_kind='typed_ner' on the new row
// (v98 added the column). Legacy plain mentions stay link_kind=NULL
// (semantically 'plain').
//
// The links UNIQUE constraint excludes link_kind, so an existing plain
// mention row + a typed_ner row for the same (from, to, type, source, origin)
// collide — DO NOTHING. NER does NOT overwrite plain mentions; the verb
// link goes in as a different row with a different link_type.

import type { BrainEngine } from './engine.ts';
import type { LinkBatchInput } from './engine.ts';
import { buildGazetteer, findMentionedEntities, loadNerKnobs, type Gazetteer, type NerKnobs } from './by-mention.ts';
import { inferLinkTypeFromPack } from './schema-pack/link-inference.ts';
import { loadActivePackBestEffort } from './schema-pack/best-effort.ts';
import { linkableTypesFromPack } from './schema-pack/linkable-types.ts';

export interface ExtractNerOpts {
  /** When true: enumerate but don't write. */
  dryRun?: boolean;
  /** Optional source-id filter on the WALK (gazetteer stays brain-wide). */
  sourceIdFilter?: string;
  /** Optional page-type filter on the WALK. */
  typeFilter?: string;
  /** Only scan pages with updated_at after this ISO date. */
  since?: string;
  /**
   * Pre-built gazetteer (T7+: combined `--by-mention --ner` walk shares
   * one gazetteer across both passes). When omitted, this fn builds its own.
   */
  gazetteer?: Gazetteer;
  /** Optional progress hook called per processed page. */
  onProgress?: (done: number, total: number, created: number) => void;
  /**
   * Step 5 (R6.3): when true, write a PLAIN `mentions` edge (link_kind NULL)
   * for every gazetteer body match — not just the verb-typed rows. This is the
   * `ner_link` cycle phase's mode: gbrain-shake declares no `inference.regex`,
   * so the verb-inference path produces zero edges; the graph-populating value
   * comes from plain mentions. The CLI (`gbrain extract --ner`) leaves this
   * OFF to preserve its "typed NER only" contract (plain mentions are the
   * separate `--by-mention` pass there). Default false.
   *
   * When on, the run is NOT gated on the pack having link_types/inference — the
   * gazetteer alone suffices. Verb inference still runs when the pack has
   * patterns, layering a typed_ner row on top (distinct link_kind → both rows
   * coexist under the links UNIQUE constraint).
   */
  emitPlainMentions?: boolean;
  /**
   * Step 6 (R5): resolved NER precision knobs. When provided, threads the
   * `rejectFirstNames` rule into the matcher. When omitted, loaded from config
   * (malformed → defaults + warn). Passed through to `buildGazetteer` when this
   * fn builds its own gazetteer so allow/ignore lists apply consistently.
   */
  knobs?: NerKnobs;
}

export interface ExtractNerResult {
  /** Pages scanned. */
  pages: number;
  /** Typed-NER links created (or would-have-created in dry-run). */
  created: number;
  /** Pages where the active schema pack had no link_types at all. */
  pack_unavailable: boolean;
}

/** Context window scanned around each mention for verb-pattern matching. */
const CONTEXT_WINDOW_CHARS = 80;

/**
 * Pure helper: get the context window around a mention's character offset.
 * Returns the substring [offset - W, offset + name.length + W] of the body.
 * Caller passes (body, offset, name.length).
 */
export function getContextWindow(
  body: string,
  offset: number,
  nameLen: number,
  window: number = CONTEXT_WINDOW_CHARS,
): string {
  const start = Math.max(0, offset - window);
  const end = Math.min(body.length, offset + nameLen + window);
  return body.slice(start, end);
}

/**
 * Pure helper: derive the entity-type→link-verb pair from a single mention.
 * Returns null when (a) target type unknown, (b) pack has no inference for
 * that type, (c) no verb pattern matches the surrounding context.
 *
 * Exported for unit tests; the orchestrator below uses it directly.
 */
export function inferNerLinkType(
  pack: Parameters<typeof inferLinkTypeFromPack>[0],
  targetType: string | undefined,
  context: string,
): string | null {
  if (!targetType) return null;
  try {
    return inferLinkTypeFromPack(pack, targetType, context);
  } catch {
    return null;
  }
}

/**
 * extractNerLinks: walk pages, find body mentions, apply schema-pack
 * inference regex per (target_type, surrounding context) to assign a typed
 * link verb. Returns count of created links.
 *
 * Best-effort wrt the schema pack: if no active pack OR no link_types
 * declared OR no inference.regex on any link_type, the function returns
 * pack_unavailable=true and 0 created. Caller (CLI / handler) surfaces a
 * one-line hint instead of an error.
 */
export async function extractNerLinks(
  engine: BrainEngine,
  opts: ExtractNerOpts = {},
): Promise<ExtractNerResult> {
  const dryRun = opts.dryRun ?? false;
  const emitPlainMentions = opts.emitPlainMentions ?? false;

  // Pack best-effort. Verb inference needs link_types[].inference.regex; the
  // plain-mentions mode (ner_link phase) does NOT — the gazetteer alone drives
  // it. So the pack-gate below only short-circuits when we're in verb-only mode
  // (CLI). In plain-mentions mode a pack with no inference is fine.
  const pack = await loadActivePackBestEffort({ engine } as never);
  const hasLinkTypes = !!pack?.manifest?.link_types && pack.manifest.link_types.length > 0;
  const hasRegex = hasLinkTypes
    ? pack!.manifest.link_types!.some(
        (lt) => lt.inference && typeof lt.inference === 'object' && 'regex' in lt.inference,
      )
    : false;
  // Verb inference is only possible when the pack has regex patterns.
  const verbInferenceEnabled = hasRegex;
  if (!emitPlainMentions && !verbInferenceEnabled) {
    // CLI/typed-only mode with nothing to infer → nothing to do (unchanged).
    return { pages: 0, created: 0, pack_unavailable: true };
  }

  // Step 6: resolve knobs so the matcher applies reject_first_names, and pass
  // them into buildGazetteer (allow/ignore lists) when we build our own.
  const knobs = opts.knobs ?? await loadNerKnobs(engine);
  const gazetteer = opts.gazetteer ?? await buildGazetteer(engine, { knobs });
  if (gazetteer.size === 0) {
    return { pages: 0, created: 0, pack_unavailable: false };
  }

  // Pre-fetch target entity types so inferLinkType has the type signal
  // without an N+1 getPage round-trip. Pulls the slug→type map from
  // listAllPageRefs + a single listPages projection.
  const targetTypeMap = await buildTargetTypeMap(engine);

  const allRefs = opts.sourceIdFilter
    ? (await engine.listAllPageRefs()).filter((r) => r.source_id === opts.sourceIdFilter)
    : await engine.listAllPageRefs();

  let processed = 0;
  let created = 0;
  const batch: LinkBatchInput[] = [];
  const BATCH_SIZE = 500;
  const sinceMs = opts.since ? new Date(opts.since).getTime() : null;

  async function flush() {
    if (batch.length === 0) return;
    if (!dryRun) {
      try {
        created += await engine.addLinksBatch(batch); // gbrain-allow-direct-insert: extract-ner — typed NER link write
      } catch {
        // batch error: drop; the per-page progress continues
      }
    } else {
      created += batch.length;
    }
    batch.length = 0;
  }

  for (const { slug, source_id } of allRefs) {
    const page = await engine.getPage(slug, { sourceId: source_id });
    if (!page) continue;
    if (opts.typeFilter && page.type !== opts.typeFilter) continue;
    if (sinceMs !== null) {
      const updatedMs = new Date(page.updated_at).getTime();
      if (Number.isFinite(updatedMs) && updatedMs <= sinceMs) continue;
    }
    processed++;
    opts.onProgress?.(processed, allRefs.length, created);

    const body = page.compiled_truth + '\n\n' + (page.timeline ?? '');
    if (!body.trim()) continue;

    const mentions = findMentionedEntities(body, gazetteer, {
      fromSlug: slug,
      fromSourceId: source_id,
      rejectFirstNames: knobs.rejectFirstNames,
    });
    if (mentions.length === 0) continue;

    for (const m of mentions) {
      const targetType = targetTypeMap.get(`${m.source_id}::${m.slug}`);
      const context = getContextWindow(body, m.offset, m.name.length);
      // Verb inference only when the pack has patterns. In plain-mentions mode
      // with no patterns this is always null → we fall to the plain edge.
      const verb = verbInferenceEnabled && pack?.manifest
        ? inferNerLinkType(pack.manifest, targetType, context)
        : null;

      if (verb) {
        batch.push({
          from_slug: slug,
          to_slug: m.slug,
          link_type: verb,
          link_source: 'mentions',
          link_kind: 'typed_ner',
          context: m.name,
          from_source_id: source_id,
          to_source_id: m.source_id,
        });
      } else if (emitPlainMentions) {
        // R6.3: plain `mentions` edge (link_kind NULL). Idempotent via the
        // links UNIQUE (from, to, type, source, origin) + ON CONFLICT DO NOTHING.
        batch.push({
          from_slug: slug,
          to_slug: m.slug,
          link_type: 'mentions',
          link_source: 'mentions',
          context: m.name,
          from_source_id: source_id,
          to_source_id: m.source_id,
        });
      } else {
        continue;
      }
      if (batch.length >= BATCH_SIZE) await flush();
    }
  }

  await flush();
  return { pages: processed, created, pack_unavailable: false };
}

/**
 * Helper: build a Map<sourceId::slug → type> for all entity-typed pages.
 * One round-trip via listPages. Targets cached at extraction-start so
 * inferNerLinkType doesn't pay an N+1 cost per mention.
 */
async function buildTargetTypeMap(engine: BrainEngine): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    // Step 2 / R4: target types come from the active pack (pack-aware), the
    // twin of buildGazetteer's filter. Falls back to LINKABLE_ENTITY_TYPES
    // when the pack has not adopted the `linkable` flag. Empty → empty map.
    const linkableTypes = await linkableTypesFromPack(engine);
    if (linkableTypes.length === 0) return map;
    const typeList = linkableTypes.map(t => `'${t.replace(/'/g, "''")}'`).join(', ');
    const result = await engine.executeRaw<{ slug: string; source_id: string; type: string }>(
      `SELECT slug, source_id, type FROM pages
         WHERE type IN (${typeList})
           AND deleted_at IS NULL`,
    );
    for (const row of result) {
      map.set(`${row.source_id}::${row.slug}`, row.type);
    }
  } catch {
    // Engine error → empty map; inferNerLinkType returns null for unknown types.
  }
  return map;
}
