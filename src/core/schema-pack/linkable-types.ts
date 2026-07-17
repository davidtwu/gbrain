// v0.42 (entity-schema-pack, Step 2 / R4 / TODO-1) — pack-driven linkable types.
//
// Pre-Step-2: by-mention.ts hardcoded
//   LINKABLE_ENTITY_TYPES = ['person','company','organization','entity']
// as the gazetteer LINK-TARGET filter, with an INDEPENDENT twin copy of the
// same literal in extract-ner.ts's buildTargetTypeMap SQL.
//
// Step 2: the active schema pack declares which types are `linkable: true`
// (mirrors the existing `expert_routing` / `extractable` per-type booleans in
// expert-types.ts / extractable.ts). buildGazetteer + buildTargetTypeMap now
// resolve their target-type set from the active pack instead of the const.
//
// PARITY (R4.3) + the Step-4 gap:
//   `organization` and `entity` are NOT declared page-type NAMES in any base
//   pack — `organization` is only a `company` ALIAS in gbrain-base-v2, and
//   `entity` is a PRIMITIVE, not a page type. They therefore CANNOT be marked
//   `linkable: true` without first ADDING them as page types (which would
//   change the base-pack taxonomy and risk breaking the gbrain-base-equivalence
//   pin + schema-stat pins — a much larger blast radius).
//
//   The parity-preserving mechanism is instead the fallback const: base packs
//   do NOT adopt the `linkable` flag at all, so `linkableTypesFromManifest`
//   returns the legacy 4-type const for them → the base-pack gazetteer target
//   set is byte-for-byte unchanged. gbrain-shake DOES adopt the flag
//   (person/project true, meeting false) → its target set is {person, project}.
//   This is the correct reading of "keep the const as the fallback literal".

import type { BrainEngine } from '../engine.ts';
import type { SchemaPackManifest } from './manifest-v1.ts';
import { loadActivePackBestEffort } from './best-effort.ts';

/**
 * Legacy hardcoded gazetteer link-target types. Used as the fallback when the
 * active pack does NOT adopt the `linkable` flag (all base packs today), so
 * pre-Step-2 gazetteer behavior is preserved byte-for-byte.
 *
 * `organization` / `entity` live here (and only here) because they are not
 * declarable page-type names in the base packs — see the module header.
 */
export const LINKABLE_ENTITY_TYPES = ['person', 'company', 'organization', 'entity'] as const;

/**
 * Pure: resolve the linkable page-type NAMES from a manifest.
 *
 * - If the manifest declares ANY `linkable` flag on ANY page type (true OR
 *   false), the pack has ADOPTED the linkable concept → return exactly the
 *   names where `linkable === true`, in manifest declaration order.
 * - If NO page type carries a `linkable` flag, the pack has NOT adopted it →
 *   fall back to the legacy const (byte-for-byte pre-Step-2 behavior).
 *
 * A pack that adopts the flag but marks every type `false` intentionally
 * yields `[]` (no gazetteer targets) — the empty-filter contract, NOT a
 * silent re-widening to the const.
 */
export function linkableTypesFromManifest(
  pack: Pick<SchemaPackManifest, 'page_types'>,
): string[] {
  const adopted = pack.page_types.some(pt => pt.linkable !== undefined);
  if (!adopted) return [...LINKABLE_ENTITY_TYPES];
  return pack.page_types.filter(pt => pt.linkable === true).map(pt => pt.name);
}

/**
 * Engine-level: resolve linkable types from the ACTIVE pack. Best-effort pack
 * load; on any failure (no pack, corrupt manifest, trust reject) OR a pack that
 * never adopted the flag → legacy const fallback, so auto-linking never
 * silently breaks on an unconfigured / legacy brain.
 *
 * `engine` is accepted for call-site consistency with buildGazetteer(engine);
 * the active pack itself is resolved from config (via loadActivePackBestEffort),
 * matching how extract-ner.ts already loads the pack.
 */
export async function linkableTypesFromPack(engine: BrainEngine): Promise<string[]> {
  const pack = await loadActivePackBestEffort({ engine } as never);
  if (!pack?.manifest) return [...LINKABLE_ENTITY_TYPES];
  return linkableTypesFromManifest(pack.manifest);
}
