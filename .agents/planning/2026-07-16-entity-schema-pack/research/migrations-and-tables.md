# Migrations & Table-Creation Conventions (entity-schema-pack)

Research for the PDD. Read-only investigation of gbrain's migration system so a new
`entity_proposals` table and a reversible backfill can be built correctly on BOTH engines.

Repo: `/Volumes/workplace/workplace/unison_sync/scratchpad/yc/gbrain-src` (branch `feat/entity-schema-pack`)
Live DB (Postgres, read-only): `docker exec gbrain-brain-pg psql -U postgres -d gbrain -c "..."`

---

## 1. Migration system (`src/core/migrate.ts`, 5958 lines)

### Registry shape
- Migrations are a single append-only array `export const MIGRATIONS: Migration[]`
  starting at `src/core/migrate.ts:115`. Version 1 is the baseline (the static schema
  creates everything with `IF NOT EXISTS`); the array holds v2…v122.
- `Migration` interface (`src/core/migrate.ts:17-58`):
  ```ts
  interface Migration {
    version: number;                 // numeric, must be unique & monotonic
    name: string;                    // snake_case label, e.g. 'take_proposals_v0_36'
    sql: string;                     // engine-agnostic DDL; '' for handler-only / sqlFor-only
    sqlFor?: { postgres?: string; pglite?: string };  // engine-specific overrides `sql`
    transaction?: boolean;           // default true; set false for CREATE INDEX CONCURRENTLY
    handler?: (engine) => Promise<void>;   // TS-level data transforms (runs OUTSIDE txn)
    idempotent?: boolean;            // NEW migrations should set explicitly (default true)
    verify?: (engine) => Promise<boolean>; // opt-in post-condition probe
  }
  ```
- `LATEST_VERSION` is derived as `Math.max(...MIGRATIONS.map(m => m.version))`
  (`migrate.ts:5510`). No separate constant to bump.

### How version is tracked
- **There is no `schema_version` table.** The version lives as a single row in the
  `config` key/value table: `config['version']`. Confirmed live: `SELECT * FROM
  schema_version` errors ("relation does not exist"); the doctor's "schema_version=122"
  reads `config.version`.
- `runMigrations` (`migrate.ts:5835`): reads `config.version`, sorts MIGRATIONS
  ascending, runs every `m.version > current`, and calls `engine.setConfig('version',
  String(m.version))` after each migration's SQL + handler + verify all succeed
  (`migrate.ts:5952`). A failure leaves the version at the prior value so the next run
  retries cleanly.
- Engine SQL selection: `const sql = m.sqlFor?.[engine.kind] ?? m.sql` (`migrate.ts:5882`)
  — `sqlFor.postgres` / `sqlFor.pglite` win over the shared `sql`.
- `hasPendingMigrations` (`migrate.ts:5700`) is the cheap gate: `config.version <
  LATEST_VERSION`.

### How to add a new table migration (template)
Follow the recent additive-table migrations verbatim:
- **take_proposals** — v69, `migrate.ts:3386-3440` (the closest analog to entity_proposals).
- **context_volunteer_events** — v117, `migrate.ts:5238-5272` (clean recent CREATE TABLE
  + two indexes, no CONCURRENTLY).
- **op_checkpoint_paths** — v115, `migrate.ts:5163-5188` (child table + FK CASCADE).
- **pages_links_extracted_at** — v112, `migrate.ts:5027-5090` (the ADD COLUMN +
  `CREATE INDEX CONCURRENTLY` template, `transaction: false`, handler-based, with
  invalid-remnant pre-drop and a PGLite plain-index branch).

Pattern for a plain new table (no CONCURRENTLY needed on an empty table):
```ts
{
  version: 123,                       // = current LATEST_VERSION + 1
  name: 'entity_proposals_v0_43',
  idempotent: true,
  sql: `
    CREATE TABLE IF NOT EXISTS entity_proposals ( ... );
    CREATE UNIQUE INDEX IF NOT EXISTS ... ;
    CREATE INDEX IF NOT EXISTS ... ;
  `,
}
```
Add it at the **end** of the array (`migrate.ts:112` comment: "Add new migrations at the
end. Never modify existing ones."). The array is sorted by version at runtime, so
insertion order is corrected, but by convention append.

Watch the renumbering footgun: several migrations carry "Renumbered vN → vM at merge"
comments (e.g. v113 at `migrate.ts:5105`, v116/117 at `migrate.ts:5235`) because master
merges claim version numbers. Pick the next free number at ship time; a `/ship`-time
merge may bump it.

---

## 2. Dual-engine gotcha (CRITICAL — a new table lands in FOUR places)

The migration alone is NOT enough. Fresh installs never replay migrations from v1 — they
load a static schema snapshot, then the migration runner only applies versions **above**
the snapshot's baseline. A table declared only in the migration will be **missing on
fresh installs** of the engine whose static schema doesn't carry it. The invariant
(CLAUDE.md): "`postgres-engine.ts` and `pglite-engine.ts` move in lockstep — a new
method/SQL shape lands in BOTH."

Concretely, `take_proposals`, `context_volunteer_events`, etc. each appear in ALL of:

| # | File | Role | Evidence |
|---|------|------|----------|
| 1 | `src/core/migrate.ts` MIGRATIONS array | upgrade path for existing brains | take_proposals v69 `migrate.ts:3408` |
| 2 | `src/schema.sql` | canonical Postgres fresh-install schema | take_proposals `schema.sql:1270`; ctx_volunteer `schema.sql:747` |
| 3 | `src/core/pglite-schema.ts` (`PGLITE_SCHEMA_SQL_TEMPLATE`) | PGLite fresh-install schema | take_proposals `pglite-schema.ts:755`; ctx_volunteer `pglite-schema.ts:977` |
| 4 | `src/core/schema-embedded.ts` (`SCHEMA_SQL`) | **AUTO-GENERATED from schema.sql** for the compiled binary | take_proposals `schema-embedded.ts:1274` |

- **#4 is auto-generated — do NOT hand-edit.** `scripts/build-schema.sh`
  (`package.json` script `build:schema`) regenerates `schema-embedded.ts` from
  `schema.sql` (escaping backticks/`$`). After editing `schema.sql`, run
  `bun run build:schema`.
- So the manual edits are **three**: the migration (`migrate.ts`), the Postgres static
  schema (`schema.sql`), and the PGLite static schema (`pglite-schema.ts`); then
  regenerate `schema-embedded.ts`.
- **The config.json-says-pglite / live-DB-is-Postgres footgun**: `engine.kind` is
  resolved from `GBRAIN_DATABASE_URL`/`DATABASE_URL` at connect time, not from
  config.json alone (`src/core/config.ts:478 effectiveEnvDatabaseUrl`,
  `engine-factory.ts`). This live brain runs Postgres because `GBRAIN_DATABASE_URL` is
  set. The schema-version hash the doctor reports is read from the **PGLite** branch
  (per the v114 comment `migrate.ts:5142`), so parity between the two static schemas
  matters for drift detection. Bottom line: declare the table in BOTH static schemas
  identically, or a fresh install on the "other" engine silently lacks the table and
  parity tests (`test/e2e/engine-parity.test.ts`) fail.
- **Forward-reference bootstrap**: if the new table/column is referenced by another
  forward-declared object during bootstrap, it must be added to the probe set in
  `applyForwardReferenceBootstrap` — `pglite-engine.ts:438` and `postgres-engine.ts:366`
  (guarded by `test/schema-bootstrap-coverage.test.ts`). A standalone new table with its
  own indexes generally does NOT need this; ADD COLUMN on an existing table sometimes does
  (see v121's note `pglite-engine.ts:909`).
- **JSONB rule** (CLAUDE.md, applies if entity_proposals uses `proposed_aliases jsonb`):
  never `JSON.stringify(x)::jsonb`; pass a raw object to `engine.executeRaw` /
  `executeRawJsonb`, or bind `$N::text::jsonb`. Guarded by `scripts/check-jsonb-*`.
- **RLS**: on Postgres, new tables auto-get RLS via the `auto_enable_rls` DDL event
  trigger (v35); the v117 comment (`migrate.ts:5248`) confirms new tables are covered
  automatically. No manual RLS statement needed in the migration.
- **CONCURRENTLY**: only needed for indexes on an already-large table. A brand-new empty
  table's indexes build instantly → use plain `CREATE INDEX` + default `transaction:true`
  (as v115/v117 do). Reserve the `transaction:false` + reserved-connection + invalid-remnant
  pre-drop dance (v112 `migrate.ts:5057-5089`) for adding an index to a populated table.

---

## 3. Proposed DDL: `entity_proposals`

Mirrors `take_proposals` (live `\d take_proposals`: BIGSERIAL PK, FK to `sources(id)` ON
DELETE CASCADE, idempotency UNIQUE index on
`(source_id, page_slug, content_hash, prompt_version)`, a partial pending index, a
run-id index, and a status CHECK). Adapted for entity proposals:

```sql
CREATE TABLE IF NOT EXISTS entity_proposals (
  id                  BIGSERIAL PRIMARY KEY,
  source_id           TEXT         NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_page_slug    TEXT         NOT NULL,          -- page the entity was proposed FROM
  content_hash        TEXT         NOT NULL,          -- hash of source content (idempotency)
  prompt_version      TEXT         NOT NULL,          -- extractor prompt version (idempotency)
  proposed_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  proposed_slug       TEXT         NOT NULL,          -- candidate canonical slug
  proposed_type       TEXT         NOT NULL
                        CHECK (proposed_type IN ('person','project')),
  proposed_aliases    JSONB,                          -- alias list; NULL if none (see JSONB rule)
  confidence          REAL,
  model_id            TEXT         NOT NULL,
  status              TEXT         NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','accepted','rejected')),
  acted_at            TIMESTAMPTZ,
  acted_by            TEXT,
  promoted_page_slug  TEXT                             -- slug of the page created on accept
);

-- Idempotency: one proposal per (source, source page, content, prompt) — mirrors
-- take_proposals_idempotency_idx so re-running extraction on unchanged pages is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS entity_proposals_idempotency_idx
  ON entity_proposals (source_id, source_page_slug, content_hash, prompt_version);

-- Fast queue read: pending proposals per source, newest first.
CREATE INDEX IF NOT EXISTS entity_proposals_pending_idx
  ON entity_proposals (source_id, status, proposed_at DESC)
  WHERE status = 'pending';

-- Optional: look up by proposed slug for dedup against already-promoted entities.
CREATE INDEX IF NOT EXISTS entity_proposals_slug_idx
  ON entity_proposals (source_id, proposed_slug);
```

Notes / decisions for the PDD:
- **`proposed_aliases`: JSONB, not `text[]`.** gbrain avoids Postgres arrays in this
  schema (grep shows JSONB everywhere, arrays nowhere in these tables) and PGLite is
  friendlier to JSONB. Store `["Bob","Robert"]`. Obey the JSONB write rule (§2).
- **`source_id` + `source_page_slug`** instead of take_proposals' single `page_slug`
  because your task listed both `source_page_slug` and `source_id`; `source_id` is the
  FK (multi-source isolation, CLAUDE.md invariant), `source_page_slug` is the page.
  Note slug uniqueness is `(source_id, slug)` — do not treat slug as globally unique.
- **`proposed_type` CHECK** enum guards `person|project`. If the schema pack may add
  types later, prefer the v114 kebab-regex-CHECK pattern (`migrate.ts:5124`) over a
  closed IN-list to avoid a constraint-swap migration per new type.
- **Type dedup / promotion**: `promoted_page_slug` records the accepted page (parallels
  take_proposals' `promoted_row_num`). `acted_at`/`acted_by` audit the decision.
- take_proposals has extras you likely don't need (`wave_version`, `proposal_run_id`,
  `dedup_against_fence_rows`, `predicted_brier*`). If you want bulk-rollback of a bad
  extraction run (the take_proposals `--rollback <run_id>` feature, `migrate.ts:3399`),
  add a `proposal_run_id TEXT NOT NULL` + `entity_proposals_run_id_idx` — recommended
  given you also want a reversible backfill.

---

## 4. Backfill snapshot table + `--apply/--revert/--dry-run` script

### Precedent for one-time date-suffixed snapshot tables: NONE (it's ad-hoc)
- There is **no existing `*_20260716` / one-time snapshot table** in the repo. Grep for
  date-suffixed or `snapshot_` tables finds only `page_versions`
  (`schema.sql:563`) and `page_generation` snapshots — both are **permanent** feature
  tables, not one-time migration scratch tables.
- All existing backfills are **in-place UPDATE** operations with a resumable checkpoint
  in `config` (`backfill.<name>.last_id`), NOT snapshot-then-mutate. See
  `backfill-effective-date.ts`, `backfill-registry.ts`. **None of them are reversible** —
  they rely on idempotent recompute, not an old-value snapshot.
- So a reversible `backfill_entity_types_20260716` snapshot table is a **new convention**
  for this repo. That's fine, but call it out in the PDD as net-new. Recommendation:
  make it a real migration-created table (so it exists on both engines) OR create it
  lazily inside the backfill command with `CREATE TABLE IF NOT EXISTS` (simpler for a
  one-time job; it never needs to ship in the static schema). Given it's one-time and
  disposable, **lazy `CREATE TABLE IF NOT EXISTS` inside the command** is the lighter
  choice and avoids burning a permanent migration version on scratch state.

### Proposed snapshot DDL
```sql
-- One-time reversible backfill of entity page `type` (person|project).
-- Created lazily by `gbrain backfill entity-types`; safe to DROP after --revert
-- is no longer needed. Not part of the static schema (disposable scratch state).
CREATE TABLE IF NOT EXISTS backfill_entity_types_20260716 (
  id            BIGSERIAL PRIMARY KEY,
  source_id     TEXT        NOT NULL,     -- for scoped revert; not FK'd (scratch table)
  slug          TEXT        NOT NULL,
  old_type      TEXT,                     -- value before backfill (NULL-safe)
  new_type      TEXT        NOT NULL,
  backfilled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS backfill_entity_types_20260716_key
  ON backfill_entity_types_20260716 (source_id, slug);
```
- UNIQUE `(source_id, slug)` makes re-running `--apply` idempotent (INSERT … ON CONFLICT
  DO NOTHING so the FIRST-seen old_type is preserved for a correct revert).
- `--revert` reads this table and writes each `old_type` back, then optionally DROPs the
  table.

### Script structure: a `src/commands/` command, NOT a standalone script
- Precedent: `src/commands/backfill.ts` is the CLI dispatcher; it parses `--dry-run`,
  `--fresh`, `--max-errors` (`backfill.ts:67`), looks up a registered backfill via
  `getBackfill(kind)` (`backfill.ts:137`), and calls `runBackfill(engine, spec, opts)`
  (`backfill.ts:170`). The reusable engine is `src/core/backfill-base.ts`
  (`runBackfill`, keyset pagination + adaptive batch-halving + reserved-connection
  writes + `config`-table checkpoint).
- BUT the generic `runBackfill` engine (`backfill-base.ts`) does NOT snapshot old values
  and has no `--revert`. For a reversible one-time job you have two options:
  1. **New dedicated command** `src/commands/backfill-entity-types.ts` (a standalone
     command in the same dir), modeled on `backfill.ts` for flag parsing but with three
     modes: `--dry-run` (count + print what would change, write nothing — mirrors
     `backfill-effective-date.ts:215` dry-run branch), `--apply` (snapshot old_type into
     the table via INSERT…ON CONFLICT DO NOTHING, then UPDATE pages), `--revert` (read
     snapshot, restore old_type). Reuse `backfill-base.ts` conventions:
     `engine.withReservedConnection` + `BEGIN`/`SET LOCAL statement_timeout`/`COMMIT`
     per batch (`backfill-base.ts:257-303`), keyset checkpoint in `config`
     (`backfill.<name>.last_id`, `backfill-base.ts:108`), and `--fresh` to reset.
  2. Register a spec in `backfill-registry.ts` for the `--apply`/`--dry-run` half
     (in-place UPDATE with idempotent compute) and add a separate `--revert` command.
     The registry's `compute()` signature returns `{id, updates}` per row but has no hook
     to also write a snapshot row, so option 1 (bespoke command) is cleaner for
     reversibility.
- **Recommendation**: standalone `src/commands/backfill-entity-types.ts` that borrows the
  keyset+reserved-connection+checkpoint idioms from `backfill-base.ts`, with the snapshot
  table above. Wire it into the CLI dispatch (see how `backfill.ts` and
  `edges-backfill.ts` are dispatched in `src/cli.ts`). Progress via `src/core/progress.ts`
  (CLAUDE.md bulk-command rules; `apply-migrations` and `backfill` already stream through it).
- Engine parity: the backfill must run on both engines. `backfill-base.ts` already guards
  Postgres-only bits (`engine.kind === 'postgres'` for `SET LOCAL`, CONCURRENTLY index —
  `backfill-base.ts:141,262`); mirror that.

---

## 5. Config-driven lists for NER precision knobs (Q2: allow-list / ignore-list / first-name-rejection)

### Storage: the `config` key/value table + JSON-string values
- `config` is `(key TEXT PRIMARY KEY, value TEXT NOT NULL)` — `schema.sql:597`,
  `pglite-schema.ts:422`. Access via the engine contract:
  `engine.getConfig(key): Promise<string|null>` and `engine.setConfig(key, value)`
  (`engine.ts:2005-2006`), plus `unsetConfig` (`engine.ts:2012`).
- **JSON lists live in config as a JSON-stringified value in the `value` column.** This
  is an established pattern — the canonical precedent is
  **`skillopt.allowed_skills`** (`operations.ts:4975`):
  ```ts
  const allowedRaw = await ctx.engine.getConfig('skillopt.allowed_skills');
  let allowed: string[] = [];
  try { if (allowedRaw) allowed = JSON.parse(allowedRaw) as string[]; }
  catch { /* fall through to deny */ }
  ```
  Note: this is the plain `value TEXT` column holding a JSON array string — NOT a
  `::jsonb` column, so the JSONB double-encode rule does NOT apply here (you're writing a
  text value with `setConfig`). Other dotted-namespace config keys confirm the
  convention: `search.cache.enabled`, `search.mode`, `search.reranker.enabled`,
  `link_resolution.global_basename`, `mcp.publish_advisor`, `models.default`
  (`operations.ts`, `model-config.ts:170`, `link-extraction.ts:1225`).

### Recommended keys for the NER knobs
```
ner.ignore_list         -> JSON array of slugs/surface-forms to never propose as entities
ner.allow_list          -> JSON array to always allow (overrides heuristic rejection)
ner.reject_first_names  -> "true"/"false" scalar (bare string, like search.mcp_keyword_only)
```
Read pattern (mirror `skillopt.allowed_skills` exactly):
```ts
async function getNerIgnoreList(engine: BrainEngine): Promise<string[]> {
  const raw = await engine.getConfig('ner.ignore_list');
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}
// boolean knob (mirror operations.ts:1456 search.mcp_keyword_only)
const rejectFirstNames = (await engine.getConfig('ner.reject_first_names')) === 'true';
```
Write via `engine.setConfig('ner.ignore_list', JSON.stringify(list))`. No migration
needed — `config` already exists and takes arbitrary keys (INSERT … ON CONFLICT DO
UPDATE, see `backfill-effective-date.ts:107`).

- Where it plugs in: NER runs through `src/core/extract-ner.ts` (typed-NER over the
  gazetteer built by `src/core/by-mention.ts` `buildGazetteer`/`findMentionedEntities`).
  The allow/ignore/first-name-rejection filters belong in the gazetteer-build or
  mention-filter path there. `extract-ner.ts` currently has no config-list reads — this
  is net-new wiring, but the config read/write plumbing is exactly the
  `skillopt.allowed_skills` shape above.
- Structured/typed config (the `GBrainConfig` object in `config.ts`, loaded from
  `~/.gbrain/config.json`, `config.ts:497`) is a SEPARATE mechanism (file-based,
  engine-selection + embedding config). For per-brain runtime-tunable lists, use the DB
  `config` table (getConfig/setConfig), not the JSON file — it's per-brain, editable over
  MCP/CLI, and doesn't require a file write.

---

## Summary of exact steps to add `entity_proposals` on BOTH engines
1. Add a migration object (next free version, currently would be **123**) to the
   `MIGRATIONS` array end in `src/core/migrate.ts` — plain `CREATE TABLE IF NOT EXISTS`
   + indexes, `idempotent: true`, default `transaction: true` (empty table, no
   CONCURRENTLY). Template: v117 `context_volunteer_events` (`migrate.ts:5238`).
2. Add the identical DDL to `src/schema.sql` (Postgres fresh install).
3. Add the identical DDL to `PGLITE_SCHEMA_SQL_TEMPLATE` in `src/core/pglite-schema.ts`
   (PGLite fresh install).
4. Run `bun run build:schema` to regenerate `src/core/schema-embedded.ts` (do NOT
   hand-edit it).
5. If any other object forward-references the table during bootstrap, add it to the probe
   set in `applyForwardReferenceBootstrap` (both engines) — usually NOT needed for a
   standalone table.
6. Verify with the parity + bootstrap tests: `test/e2e/engine-parity.test.ts`,
   `test/schema-bootstrap-coverage.test.ts` (DATABASE_URL-gated e2e catches PGLite-hidden
   bugs).

## Key file:line citations
- Migration interface: `src/core/migrate.ts:17-58`; array start `:115`; runner `:5835`;
  version via config `:5836,5952`; engine SQL pick `:5882`; LATEST_VERSION `:5510`.
- Template migrations: take_proposals v69 `:3386-3440`; ctx_volunteer v117 `:5238-5272`;
  op_checkpoint_paths v115 `:5163-5188`; pages_links_extracted_at v112 (CONCURRENTLY)
  `:5027-5090`; kebab-regex CHECK v114 `:5124-5161`.
- Static schemas: `src/schema.sql:1270` (take_proposals), `:747` (ctx_volunteer), `:597`
  (config table); `src/core/pglite-schema.ts:755`, `:977`, `:422`;
  `src/core/schema-embedded.ts:1274` (auto-gen); `scripts/build-schema.sh`.
- Backfill: `src/core/backfill-base.ts` (generic runner, checkpoint `:108`, reserved-conn
  writes `:257-303`); `src/core/backfill-effective-date.ts` (dry-run `:215`, checkpoint
  `:33,105`); `src/core/backfill-registry.ts` (spec registration); command dispatch
  `src/commands/backfill.ts:67,137,170`. No date-suffixed snapshot precedent — page_versions
  `src/schema.sql:563` is the only "snapshot" table and it's permanent.
- Config lists: `config` table `schema.sql:597`; getConfig/setConfig `engine.ts:2005-2006`;
  JSON-array-in-config precedent `src/core/operations.ts:4975` (skillopt.allowed_skills);
  boolean-in-config `operations.ts:1456`; dotted keys throughout `model-config.ts:170`,
  `link-extraction.ts:1225`. NER path: `src/core/extract-ner.ts`, `src/core/by-mention.ts`.
