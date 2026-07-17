# Research: Collector typing path + LINKABLE_ENTITY_TYPES widening

Date: 2026-07-16 · Branch: `feat/entity-schema-pack` · Read-only investigation (no code modified).

---

## A. How a page gets its `type` on vault import

### A1. The type-assignment chain (traced)

`gbrain import <dir>` → `src/commands/import.ts` walks the dir, computes a
**relative path**, and calls `importFile(eng, filePath, relativePath, {..., activePack})`:

- `src/commands/import.ts:230` — `const relativePath = relative(dir, filePath);`
- `src/commands/import.ts:242` — `importFile(eng, filePath, relativePath, { noEmbed, sourceId, activePack: importActivePack })`
- `src/commands/import.ts:91-102` — active pack is loaded **once** at import entry via `loadActivePack({cfg, remote:false, sourceId})` and threaded to every file (`importActivePack = { page_types: resolved.manifest.page_types }`).

`importFile` → `parseMarkdown` does the actual type assignment. The single
decisive line is:

- **`src/core/markdown.ts:135-137`**
  ```ts
  const type = coerceFrontmatterString(frontmatter.type) || (
    opts?.activePack ? inferTypeFromPack(filePath, opts.activePack) : inferType(filePath)
  );
  ```

**Precedence is exactly:**
1. **Frontmatter `type:`** if present (`coerceFrontmatterString(frontmatter.type)`), else
2. **Path-prefix inference** — `inferTypeFromPack(filePath, activePack)` (pack-aware) or `inferType(filePath)` (legacy), else
3. **Default `'concept'`** — the fallback returned by both `inferTypeFromPack` (`markdown.ts:508`, `:512`) and `inferTypeWithPrefixes` (`markdown.ts:602`) when no prefix matches.

### A2. What the vault files actually contain (sampled)

Counts match the task: Relationships (27), Initiatives (8), Meetings (22).

None of the three folders carry a frontmatter `type:` field. `grep -l '^type:'`
across all three folders returned zero files. What they DO carry:

- **Relationships/** e.g. `Abhi Gaur.md` — frontmatter is `tags: [relationship]` + `aliases: [...]`. No `type:`.
- **Initiatives/** e.g. `AI Fluency Program.md` — `tags: [initiative]` + `aliases: [...]`. No `type:`.
- **Meetings/** e.g. `2026-05-01_....md` — `tags: [meeting]`, `date:`, `subject:`, `organizer:`. No `type:`.

### A3. WHERE `type: concept` comes from (root cause)

It is **assigned by the importer's default fallback**, NOT present in the vault
files. The mechanism is a collision between the staging step and path-prefix
matching:

1. The vault files have no `type:` frontmatter (A2), so step 1 of the precedence chain misses.
2. The collector **flattens** subfolder structure during staging.
   `gbrain-refresh-vault` copies each file with
   `rel=$(echo "$src" | sed "s|$VAULT/$f/||; s|/|__|g")` — every `/` in the
   sub-path becomes `__`. So `doppelganger-cortex/Relationships/Abhi Gaur.md`
   is staged as `.../doppelganger-cortex/Relationships__Abhi Gaur.md`
   (verified: `Relationships/Abhi Gaur.md` → `Relationships__Abhi Gaur.md`).
3. `inferTypeFromPack` / `inferTypeWithPrefixes` matches path **prefixes** of the
   form `/relationships/`, `/meetings/`, `/projects/` (needle = `'/' + prefix`,
   `markdown.ts:508`, `:598`). Because the folder name is now glued to the
   filename with `__` and no bounding `/`, the needle `/meetings/` (and there is
   no `/relationships/` or `/initiatives/` prefix in gbrain-base at all) never
   matches.
4. Nothing matches → **default `'concept'`**.

Note the active pack is `gbrain-base-v2` (from `~/.gbrain/config.json`:
`"schema_pack": "gbrain-base-v2"`). That pack declares `person`, `company`,
`media`, `concept`, etc. — but has **no `relationships/`, `initiatives/`, or
`meetings/`→type path_prefixes** that would match this vault's folder names even
if the path weren't flattened. (`meeting` exists as a type in the legacy
`GBRAIN_BASE_PATH_PREFIXES` table at `markdown.ts:468` with prefix `/meetings/`,
but that requires the un-flattened path.)

### A4. Does path_prefixes set the STORED type? (verification of earlier finding)

**Earlier finding is WRONG for the import path — corrected here.** For
`gbrain import` (and `sync`), path_prefixes IS the mechanism that sets the stored
`type`: `parseMarkdown` calls `inferTypeFromPack(filePath, activePack)` and the
returned value becomes `parsed.type`, which `importFile` writes as the page's
`type` column (`import-file.ts:544`, `:553`, `:753`). So a pack `path_prefixes`
entry that matches the file path DOES assign the stored type at import time.

The "path_prefixes is only a filing hint, not stored type" belief may be true for
some other surface (e.g. put_page filing suggestions), but it does NOT hold for
the vault import path. This is the load-bearing correction for the collector fix.

---

## A5. Cleanest collector-fix mechanism (gated on gbrain-shake pack)

Goal: Relationships→`person`, Initiatives→`project`, Meetings→`meeting` at import
time, gated on the gbrain-shake pack being active.

Two clean options; **Option (a) rewrite frontmatter during staging is recommended
for a first version** because it is decoupled from the flatten bug and needs zero
engine change.

**Option (a) — collector rewrites frontmatter `type:` during staging (RECOMMENDED).**
In `gbrain-refresh-vault`, when copying a file from `Relationships/`,
`Initiatives/`, `Meetings/`, prepend/inject a `type:` frontmatter key
(`person` / `project` / `meeting`). Because frontmatter `type:` is precedence
step 1 (`markdown.ts:135`), it wins unconditionally over path inference and the
flatten bug becomes irrelevant.
- Pros: no engine change; survives the `__`-flatten; explicit and debuggable;
  trivially gated (only inject when the shake pack is the active pack — the
  collector can read `~/.gbrain/config.json` `schema_pack` or shell out to
  `gbrain schema active`).
- Cons: mutates the staged copy (not the source vault — staging is a throwaway
  `~/.gbrain-import-staging`, so this is safe); the injected `type` values must
  be types the active pack declares, or lint will flag them.
- Effort: ~15-30 lines of bash/awk in `gbrain-refresh-vault` (staging loop
  already knows which folder `$f`/sub-path each file came from).

**Option (b) — pack `path_prefixes` honored by importer.** Add
`relationships/`→person, `initiatives/`→project, `meetings/`→meeting prefixes to
the gbrain-shake pack manifest. `inferTypeFromPack` already consults active-pack
`path_prefixes` (`markdown.ts:494-513`), so this is the "native" path.
- **Blocker:** the collector's `__`-flatten (A3) destroys the `/folder/` boundary
  the prefix matcher needs. Option (b) only works if the collector ALSO stops
  flattening (preserve `Relationships/` as a real subdir in staging), i.e. change
  the `sed "s|/|__|g"` to keep sub-paths. That is a second, riskier collector
  edit (slug/dedup implications since slugs derive from path).
- Effort: pack manifest edit (small) + collector de-flatten (medium, with slug
  regression risk). Higher blast radius than (a).

**Recommendation:** ship Option (a) for v1 (frontmatter rewrite in the staging
loop, gated on active pack == gbrain-shake). Revisit Option (b) later if/when the
collector stops flattening for other reasons. Either way the type values must
exist in the shake pack's `page_types[]` (person, project, meeting) so lint/retype
stay clean.

---

## B. LINKABLE_ENTITY_TYPES widening

### B1. ALL hardcoded copies of the entity-type list (must be widened together)

The gazetteer const and its SQL twin are the two that matter for auto-linking;
the rest are the same `('person','company','organization','entity')` filter
copied across onboarding/doctor/health surfaces. Full inventory (file:line):

**Auto-linking (the two the task is about):**
- `src/core/by-mention.ts:33` — `export const LINKABLE_ENTITY_TYPES = ['person', 'company', 'organization', 'entity']` (gazetteer source of truth; consumed at `:159` to build the SQL `IN (...)` filter).
- `src/core/extract-ner.ts:206` — `WHERE type IN ('person', 'company', 'organization', 'entity')` in `buildTargetTypeMap`. **This is its OWN independent hardcoded copy** — confirmed. It is NOT derived from `LINKABLE_ENTITY_TYPES`; it must be widened in lockstep or NER-inferred link types for `project` pages will be dropped (`inferNerLinkType` returns null for unknown target types).

**Same 4-type filter, other surfaces (widen if 'project' should count there too):**
- `src/core/onboard/checks.ts:122, 145, 217, 238`
- `src/core/onboard/impact-capture.ts:68, 76, 84`
- `src/core/onboard/init-nudge.ts:59, 66, 74`

**Doctor/health counters (`entity, person, company, organization` — same set, different order):**
- `src/commands/doctor.ts:5781, 5875`

**Related but distinct 2-type lists (`['person','company']`) — expert-routing, NOT linkable-entity; do NOT blindly widen:**
- `src/core/postgres-engine.ts:5010, 5041` and `src/core/pglite-engine.ts:5026, 5060` — find_experts SQL.
- `src/commands/enrich.ts:70`, `src/commands/whoknows.ts:97` — `DEFAULT_TYPES`.
- These are already slated for pack-awareness via `expertTypesFromPack` (`src/core/schema-pack/expert-types.ts`) — a separate, already-built helper. Leave them out of the linkable-types change.

### B2. Const-append vs TODO-1 pack-awareness

**Option (i) — append `'project'` to the const (`by-mention.ts:33`) + mirror in `extract-ner.ts:206`.**
- Effort: ~2 lines + tests. Minimal.
- Blast radius: SMALL but note **two** call sites must change together (by-mention
  const AND the independent extract-ner SQL literal). Widens auto-linking globally
  for EVERY brain/pack, not just shake — a gbrain-base user with `project` pages
  would also start auto-linking them. That may be acceptable (project is a benign
  linkable type) but it is not pack-gated.

**Option (ii) — implement TODO-1 (pack-aware linkable types).**
- The infrastructure pattern already exists and is proven: `expertTypesFromPack`
  (`expert-types.ts`) and `extractableTypesFromPack` (`extractable.ts`) both read a
  boolean flag off `pack.page_types[]` and return the matching type list/set. A
  `linkableTypesFromPack` would be a near-copy.
- BUT: the pack manifest has **no `linkable` field today**. `PageTypeSchema`
  (`manifest-v1.ts:99-140`) declares `path_prefixes`, `aliases`, `extractable`,
  `expert_routing`, `subtypes` — no `linkable`/`auto_link` boolean. So TODO-1
  requires: (1) add a `linkable: z.boolean().default(...)` field to
  `PageTypeSchema`; (2) set it true for person/company/organization/entity in all
  base packs (gbrain-base, -v2, engineer, everything, etc. — parity-pinned by
  `test/regressions/gbrain-base-equivalence.test.ts`); (3) write
  `linkableTypesFromPack`; (4) thread the active pack into `buildGazetteer`
  (currently takes only `engine` + opts — no pack) AND into `buildTargetTypeMap`
  in extract-ner; (5) decide the default for the empty/legacy-pack case to
  preserve current behavior.
- Effort: MEDIUM (multi-file: manifest schema + 5-7 base pack YAMLs + new helper +
  two call-site rewires + back-compat default + tests + the base-equivalence
  parity test). Blast radius MEDIUM — touches the manifest schema (every pack
  re-validates) and two extraction/linking hot paths.

### B3. Recommendation

**For a first version: Option (i) const-append, but pack-gate it minimally.**
The cleanest v1 that matches the design intent without the full manifest change:
- Append `'project'` to `LINKABLE_ENTITY_TYPES` (`by-mention.ts:33`) AND to the
  `extract-ner.ts:206` SQL literal — these two MUST move together.
- If widening must be scoped to the shake pack only (not gbrain-base users), the
  smallest pack-aware step is to have `buildGazetteer`/`buildTargetTypeMap` accept
  the already-loaded active pack and union `LINKABLE_ENTITY_TYPES` with the pack's
  entity-primitive types — but that is effectively starting TODO-1.
- Given the shake pack is new and the plan already introduces it, **do TODO-1
  properly IF the same PDD is adding the `linkable` concept to the manifest
  anyway** (it fits the existing `expert_routing`/`extractable` pattern exactly and
  avoids a second global-widening regret later). Otherwise, const-append is the
  correct low-risk v1 — just remember it is TWO literals (by-mention + extract-ner),
  and it widens for all packs.

The deciding question for the PDD author: **should `project` auto-linking be
global (const-append) or shake-pack-only (TODO-1)?** If global is acceptable,
const-append is the right first version. If it must be pack-scoped, TODO-1 is
unavoidable and its cost is MEDIUM (manifest field + base-pack parity updates +
two call-site rewires).

---

## C. WebSearch findings

**No `WebSearch` tool is available in this environment** (only `WebFetch`). I ran
WebFetch against DuckDuckGo HTML + GitHub search as a substitute.

Findings:
- gbrain is a real open-source project: **github.com/garrytan/gbrain** ("Postgres-native
  personal knowledge brain: hybrid RAG search, self-wiring entity graph, 34 agent
  skills"), plus forks (grindingalpha/gbrain) and doc mirrors (deepwiki.com,
  langlabs.io, upd.dev, vectorize.io, gbrain.homes).
- **Schema packs** ARE publicly documented (upd.dev/garrytan/gbrain: "build your own
  pack", `schema detect` / `schema suggest` / `schema review-candidates --apply`).
  General entity extraction / self-wiring entity graph is described (deepwiki,
  lucaberton.com).
- **Nothing public on the specific TODO-1 design** — no mention of "pack-aware
  linkable types", "LINKABLE_ENTITY_TYPES", or a "by-mention gazetteer" in any
  indexed public doc (checked deepwiki overview directly; it covers the
  read-write loop + bi-temporal facts ontology but NOT gazetteer/linkable-type
  pack-awareness). GitHub repo search for "gbrain schema pack by-mention" → 0 results.

**Conclusion for C:** there is no public upstream design doc to align TODO-1
against. The internal precedent to follow is gbrain's own established pattern:
`expert_routing` (`expert-types.ts`) and `extractable` (`extractable.ts`) — a
per-`page_type` boolean flag read by a `*FromPack` helper. A `linkable` flag +
`linkableTypesFromPack` would be the idiomatic, in-tree-consistent shape.

---

## Key citations
- Type assignment: `src/core/markdown.ts:135-137` (precedence), `:494-513` (`inferTypeFromPack`), `:591-604` (`inferTypeWithPrefixes` default 'concept').
- Import wiring: `src/commands/import.ts:91-102` (load pack), `:230` (relativePath), `:242` (importFile call).
- Stored type write: `src/core/import-file.ts:544, 553, 753`.
- Collector flatten (root cause of `type:concept`): `~/.gbrain-bin/gbrain-refresh-vault` (`sed "s|/|__|g"` in the staging copy loop).
- Vault files: no `type:` frontmatter in Relationships/Initiatives/Meetings (only `tags:`).
- Linkable const + SQL twin: `src/core/by-mention.ts:33` + `:159`; `src/core/extract-ner.ts:206` (independent copy).
- Pack-aware precedents: `src/core/schema-pack/expert-types.ts`, `src/core/schema-pack/extractable.ts`; manifest `PageTypeSchema` at `src/core/schema-pack/manifest-v1.ts:99-140` (no `linkable` field yet).
- Active pack: `~/.gbrain/config.json` → `"schema_pack": "gbrain-base-v2"`.
