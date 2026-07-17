# Research Synthesis — Entity Schema Pack (gbrain-shake)

Four research passes (R3–R7) + two Q-debates (Q1, Q5). Findings that shape the design,
and — critically — the points that REOPEN a prior requirements decision.

## Confirmed, no change

- **Two new cycle phases**, DB-sourced + pack-gated: `discover_entities` (after extract_atoms)
  and `ner_link` (after it). Must guard on `!engine` only, NEVER `brainDir` (that FS-skip is
  what neutered the existing `extract` phase). NER is CLI-only today; wrapping `extractNerLinks`
  as a phase is clean (no LLM cost). 3 ALL_PHASES-pinning tests must be updated.
  [cycle-phase-registration.md]
- **Migrations:** append v123 to MIGRATIONS array; a new table must land in FOUR places
  (migrate.ts + schema.sql + pglite-schema.ts + regenerate schema-embedded.ts). Version is
  `config.version`, no schema_version table. [migrations-and-tables.md]
- **entity_proposals DDL** defined (mirrors take_proposals; promote target differs:
  `promoted_slug TEXT` not `promoted_row_num`; JSONB aliases; proposal_run_id for bulk rollback).
- **NER precision knobs (Q2)** store as JSON in `config` table (`ner.ignore_list`,
  `ner.allow_list`, `ner.reject_first_names`); precedent `skillopt.allowed_skills`. No migration.
- **Widen entity-type list in TWO co-located spots:** `by-mention.ts:33` AND `extract-ner.ts:206`
  (independent twin). Same 4-type filter also in onboard/checks, impact-capture, init-nudge,
  doctor — audit all. (expert-routing person/company lists are separate; leave them.)
- **extends: gbrain-base-v2** confirmed; parent near-inert (no runtime merge, T20 unshipped);
  meeting→person `attended` edge is HARDCODED (link-extraction.ts:703/792), pack-independent.

## REOPENED / NEW decisions for the Iteration Checkpoint

### RO-1 (BIG): the take_proposals "review queue" is HALF-BUILT.
The propose→queue side is real + tested; the review→accept→promote side was **never coded**
— `accepted`/`rejected` status + acted_at + promoted_row_num exist in DDL but NOTHING writes
them. No `gbrain takes propose --accept` verb, no MCP tool. Live: 17 rows, all pending, 0 acted.
**Impact on Q3:** "mirror the proven take_proposals review UX" is only half-possible — the
accept/promote path + CLI + MCP are NET-NEW code, not a copy. Scope of the discovery feature
is larger than assumed. (Side effect: David's 17 pending take-proposals are currently
un-actionable by any code path.)

### RO-2 (correction): path_prefixes DOES set stored type at import.
Corrects earlier "filing-hint-only" claim. Type precedence in parseMarkdown (markdown.ts:135):
frontmatter type → inferTypeFromPack(path_prefixes) → default concept. Entity pages are
`concept` only because (a) collector FLATTENS subfolders (`sed 's|/|__|g'`) killing the
`/folder/` boundary, and (b) base-v2 declares no such prefixes.
**Impact on collector fix + Q4:** cleanest fix = rewrite frontmatter `type:` during staging in
gbrain-refresh-vault, gated on shake pack active (Option a). Option b (pack path_prefixes) is
blocked by the flatten. Does NOT change the backfill (existing DB rows still need re-typing),
but simplifies the collector side.
NOTE: gazetteer QUERY path is still hardcoded-type-only — that finding is unchanged.

### RO-3: LINKABLE_ENTITY_TYPES widening — const-append vs TODO-1 pack-awareness.
- const-append: ~2 lines (two sites), but widens `project` linkability GLOBALLY for all packs.
- TODO-1 (pack-aware `linkable` boolean on PageTypeSchema): MEDIUM effort, fits the existing
  `expert_routing`/`extractable` per-type boolean pattern exactly, scopes linkability to the
  shake pack. WebFetch confirms NO public gbrain design for this — but the in-tree
  expert_routing/extractable pattern is the alignment target.
**Decision needed:** const-append (fast, global) vs TODO-1 (clean, pack-scoped, more work).

### RO-4: backfill reversibility is a NEW pattern for this repo.
No date-suffixed snapshot-table precedent exists; all existing backfills are in-place
idempotent UPDATEs with a config checkpoint, none reversible. Our snapshot-table + --revert
is net-new (but straightforward: lazy CREATE TABLE IF NOT EXISTS, disposable, out of static
schema, in a src/commands/backfill-entity-types.ts). Confirms Q4 feasible.

## Net scope picture
Larger than the initial "just a pack + backfill":
1. pack YAML (gbrain-shake) — small
2. backfill command w/ snapshot + revert — small-medium, new pattern
3. collector frontmatter-typing fix — small
4. widen entity-type list (const or TODO-1) — small OR medium
5. NER wrapped as a DB cycle phase — medium
6. discover_entities phase (LLM, budgeted, pack-gated) — medium
7. entity_proposals table (4-place migration) — medium
8. **review/accept/promote path + CLI + MCP — NET-NEW (not a mirror), medium-large** ← RO-1
