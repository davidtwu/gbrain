/**
 * R2 — Reversible entity-type backfill (`gbrain backfill-entity-types`).
 *
 * Step 3 of the entity-schema-pack plan. Re-types existing DB rows so the
 * gbrain-shake pack's declared type NAMES match what's stored, WITHOUT relying
 * on aliases (the `*unknown*→note` catch-all in unify-types-handler.ts:189 matches
 * type NAMES only, not aliases — so an alias is not a runtime shield).
 *
 * Retype rules (matched by STORED slug prefix — `/` is flattened to `__` in the
 * stored slug — or by stored type name):
 *   - slug `doppelganger-cortex/relationships__*`  → person   (~27)
 *   - slug `doppelganger-cortex/initiatives__*`    → project  (~8)
 *   - slug `doppelganger-cortex/meetings__*`       → meeting  (~22)
 *   - type = `slack-channel`                       → slack    (~103)  [ADDED, Step 1 finding]
 *
 * Three modes (`--dry-run | --apply | --revert`):
 *   - --dry-run : count what WOULD change, write nothing.
 *   - --apply   : snapshot-before-write (one tx per batch); idempotent (rows already
 *                 in the snapshot are skipped, so a crash mid-run resumes safely).
 *   - --revert  : restore the exact prior type from the snapshot, then clear the
 *                 snapshot + checkpoint (idempotent — a second revert is a no-op).
 *
 * Design of record: detailed-design.md §2 R2, §5.2 (snapshot DDL), §6.1 (error handling).
 * Idioms mirrored from src/core/backfill-base.ts: keyset pagination, reserved
 * connection + BEGIN/SET LOCAL/COMMIT per batch, config-table checkpoint.
 *
 * The snapshot table `backfill_entity_types_20260716` is DISPOSABLE scratch state:
 * it is lazily `CREATE TABLE IF NOT EXISTS`'d here, NOT declared in the static schema
 * or a migration (per design §4 research + §5.2).
 */

import type { BrainEngine, ReservedConnection } from '../core/engine.ts';

// --- Retype rules ---------------------------------------------------------

/** Stored slug prefixes (`/` already flattened to `__`). Exact-prefix match. */
const REL_PREFIX = 'doppelganger-cortex/relationships__';
const INIT_PREFIX = 'doppelganger-cortex/initiatives__';
const MEET_PREFIX = 'doppelganger-cortex/meetings__';
/** Stored type name (NOT an alias) that must be re-typed to the declared name. */
const SLACK_CHANNEL_TYPE = 'slack-channel';

const SNAPSHOT_TABLE = 'backfill_entity_types_20260716';
const CHECKPOINT_KEY = 'backfill.entity_types.last_id';
const DEFAULT_BATCH_SIZE = 500;
const PER_BATCH_TIMEOUT_SEC = 600;

/**
 * Compute the target type for a page, or null if it matches no rule. Kept in
 * lockstep with the SQL candidate predicate in {@link candidatePredicate}.
 * Slug rules win over the type rule (a slug-matched page is never also
 * slack-channel in practice, but the ordering is defined for determinism).
 */
export function targetTypeFor(row: { slug: string; type: string }): string | null {
  if (row.slug.startsWith(REL_PREFIX)) return 'person';
  if (row.slug.startsWith(INIT_PREFIX)) return 'project';
  if (row.slug.startsWith(MEET_PREFIX)) return 'meeting';
  if (row.type === SLACK_CHANNEL_TYPE) return 'slack';
  return null;
}

// --- Types ----------------------------------------------------------------

export type BackfillMode = 'dry-run' | 'apply' | 'revert';

export interface BackfillEntityTypesOpts {
  mode: BackfillMode;
  /** Required gate for --apply (mirrors backfill-base / takes.ts:620). */
  yes?: boolean;
  batchSize?: number;
  /** Testing cap on total rows examined (crash-resume simulation). */
  maxRows?: number;
  /** Ignore the checkpoint and restart from id=0. */
  fresh?: boolean;
}

export interface BackfillEntityTypesResult {
  mode: BackfillMode;
  /** Rows examined (candidates fetched). */
  examined: number;
  /** Rows whose type was changed this run (apply) or restored (revert). */
  changed: number;
  /** Per-target-type counts (person/project/meeting/slack). */
  byType: Record<string, number>;
  /** Total rows currently recorded in the snapshot table (0 if it doesn't exist). */
  snapshotRows: number;
}

/** Thrown when the expected doppelganger-cortex slugs are absent (wrong DB). */
export class WrongBrainError extends Error {}
/** Thrown when --apply is invoked without the --yes gate (or a prior --dry-run). */
export class ApplyGateError extends Error {}

// --- Checkpoint helpers (mirror backfill-base.ts convention) --------------

async function getCheckpoint(engine: BrainEngine, fresh: boolean): Promise<number> {
  if (fresh) return 0;
  try {
    const raw = await engine.getConfig(CHECKPOINT_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function setCheckpoint(engine: BrainEngine, lastId: number): Promise<void> {
  await engine.setConfig(CHECKPOINT_KEY, String(lastId));
}

async function clearCheckpoint(engine: BrainEngine): Promise<void> {
  try {
    await engine.unsetConfig(CHECKPOINT_KEY);
  } catch {
    /* best-effort */
  }
}

// --- Snapshot table -------------------------------------------------------

async function ensureSnapshotTable(engine: BrainEngine): Promise<void> {
  // §5.2 DDL. page_id PK gives ON CONFLICT (page_id) DO NOTHING idempotency.
  await engine.executeRaw(
    `CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (
      page_id       INTEGER PRIMARY KEY,
      slug          TEXT NOT NULL,
      source_id     TEXT NOT NULL,
      old_type      TEXT NOT NULL,
      new_type      TEXT NOT NULL,
      backfilled_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  );
}

async function snapshotTableExists(engine: BrainEngine): Promise<boolean> {
  const rows = await engine.executeRaw<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`public.${SNAPSHOT_TABLE}`],
  );
  return Boolean(rows[0]?.present);
}

async function countSnapshotRows(engine: BrainEngine): Promise<number> {
  if (!(await snapshotTableExists(engine))) return 0;
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${SNAPSHOT_TABLE}`,
  );
  return Number(rows[0]?.n ?? 0);
}

// --- Candidate predicate (kept in lockstep with targetTypeFor) ------------

/**
 * WHERE-fragment that names the rows any rule would re-type. `substring(... from 1
 * for char_length($n)) = $n` is an exact-prefix match (avoids LIKE's `_` wildcard
 * biting the literal `__` in the flattened slug). Params: [$1 rel, $2 init, $3 meet,
 * $4 slack-type] starting at `base`. Returns the fragment plus its params.
 */
function candidatePredicate(base: number): { sql: string; params: unknown[] } {
  const p1 = base, p2 = base + 1, p3 = base + 2, p4 = base + 3;
  const sql = `(
    substring(p.slug from 1 for char_length($${p1})) = $${p1}
    OR substring(p.slug from 1 for char_length($${p2})) = $${p2}
    OR substring(p.slug from 1 for char_length($${p3})) = $${p3}
    OR p.type = $${p4}
  )`;
  return { sql, params: [REL_PREFIX, INIT_PREFIX, MEET_PREFIX, SLACK_CHANNEL_TYPE] };
}

// --- Wrong-brain guard ----------------------------------------------------

/**
 * Assert the expected doppelganger-cortex entity slugs exist before touching
 * rows. Aborts loud (throws) if none are found — never silently no-op on the
 * wrong DB (§6.1 wrong-brain guard).
 */
async function assertRightBrain(engine: BrainEngine): Promise<void> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages p
      WHERE substring(p.slug from 1 for char_length($1)) = $1
         OR substring(p.slug from 1 for char_length($2)) = $2
         OR substring(p.slug from 1 for char_length($3)) = $3`,
    [REL_PREFIX, INIT_PREFIX, MEET_PREFIX],
  );
  const n = Number(rows[0]?.n ?? 0);
  if (n === 0) {
    throw new WrongBrainError(
      `[backfill-entity-types] wrong-brain guard: no doppelganger-cortex/{relationships,initiatives,meetings}__ pages found. ` +
        `Refusing to run — this does not look like the expected brain.`,
    );
  }
}

// --- Mode: dry-run --------------------------------------------------------

async function runDryRun(engine: BrainEngine): Promise<BackfillEntityTypesResult> {
  await assertRightBrain(engine);
  const pred = candidatePredicate(1);
  // Aggregate: for every rule-matching, not-yet-correctly-typed page, count by target.
  const rows = await engine.executeRaw<{ tgt: string; n: number }>(
    `SELECT tgt, count(*)::int AS n FROM (
       SELECT
         CASE
           WHEN substring(p.slug from 1 for char_length($1)) = $1 THEN 'person'
           WHEN substring(p.slug from 1 for char_length($2)) = $2 THEN 'project'
           WHEN substring(p.slug from 1 for char_length($3)) = $3 THEN 'meeting'
           WHEN p.type = $4 THEN 'slack'
         END AS tgt,
         p.type AS cur
       FROM pages p
       WHERE p.deleted_at IS NULL AND ${pred.sql}
     ) x
     WHERE x.tgt IS NOT NULL AND x.tgt <> x.cur
     GROUP BY tgt`,
    pred.params,
  );
  const byType: Record<string, number> = {};
  let changed = 0;
  for (const r of rows) {
    byType[r.tgt] = Number(r.n);
    changed += Number(r.n);
  }
  return {
    mode: 'dry-run',
    examined: changed,
    changed,
    byType,
    snapshotRows: await countSnapshotRows(engine),
  };
}

// --- Mode: apply ----------------------------------------------------------

interface CandidateRow {
  id: number;
  slug: string;
  source_id: string;
  type: string;
}

async function runApply(
  engine: BrainEngine,
  opts: BackfillEntityTypesOpts,
): Promise<BackfillEntityTypesResult> {
  if (!opts.yes) {
    throw new ApplyGateError(
      `[backfill-entity-types] --apply requires --yes. Run --dry-run first to preview, then re-run with --apply --yes.`,
    );
  }
  await assertRightBrain(engine);
  await ensureSnapshotTable(engine);

  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  let lastId = await getCheckpoint(engine, opts.fresh === true);
  let examined = 0;
  let changed = 0;
  const byType: Record<string, number> = {};

  while (true) {
    const remaining = opts.maxRows ? Math.max(0, opts.maxRows - examined) : Number.POSITIVE_INFINITY;
    if (remaining <= 0) break;
    const limit = Math.min(batchSize, remaining);

    // Candidate window: rule-matching, not-yet-snapshotted rows, id-ordered.
    // The NOT EXISTS(snapshot) filter is what makes --apply idempotent /
    // crash-resumable independent of the checkpoint.
    const pred = candidatePredicate(2); // $1 = lastId
    const rows = await engine.executeRaw<CandidateRow>(
      `SELECT p.id, p.slug, p.source_id, p.type
         FROM pages p
        WHERE p.id > $1
          AND p.deleted_at IS NULL
          AND ${pred.sql}
          AND NOT EXISTS (SELECT 1 FROM ${SNAPSHOT_TABLE} s WHERE s.page_id = p.id)
        ORDER BY p.id
        LIMIT $${2 + pred.params.length}`,
      [lastId, ...pred.params, limit],
    );
    if (rows.length === 0) break;
    examined += rows.length;

    // One transaction per batch: snapshot-before-write. If the snapshot INSERT
    // throws, the UPDATE never runs and the batch rolls back (§6.1 invariant).
    await engine.withReservedConnection(async (conn: ReservedConnection) => {
      await conn.executeRaw(`BEGIN`);
      try {
        if (engine.kind === 'postgres') {
          await conn.executeRaw(`SET LOCAL statement_timeout = '${PER_BATCH_TIMEOUT_SEC}s'`).catch(() => {
            /* some Postgres tiers restrict SET LOCAL */
          });
        }
        for (const row of rows) {
          const nt = targetTypeFor(row);
          if (!nt || nt === row.type) continue; // already correct → nothing to snapshot/change
          await conn.executeRaw(
            `INSERT INTO ${SNAPSHOT_TABLE} (page_id, slug, source_id, old_type, new_type)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (page_id) DO NOTHING`,
            [row.id, row.slug, row.source_id, row.type, nt],
          );
          await conn.executeRaw(`UPDATE pages SET type = $2 WHERE id = $1`, [row.id, nt]);
          changed++;
          byType[nt] = (byType[nt] ?? 0) + 1;
        }
        await conn.executeRaw(`COMMIT`);
      } catch (err) {
        await conn.executeRaw(`ROLLBACK`).catch(() => {});
        throw err;
      }
    });

    lastId = rows[rows.length - 1].id;
    await setCheckpoint(engine, lastId);
  }

  return {
    mode: 'apply',
    examined,
    changed,
    byType,
    snapshotRows: await countSnapshotRows(engine),
  };
}

// --- Mode: revert ---------------------------------------------------------

async function runRevert(
  engine: BrainEngine,
  opts: BackfillEntityTypesOpts,
): Promise<BackfillEntityTypesResult> {
  // Revert operates purely on the snapshot; if it doesn't exist there is nothing
  // to restore (safe no-op — e.g. run on a brain that was never applied).
  if (!(await snapshotTableExists(engine))) {
    return { mode: 'revert', examined: 0, changed: 0, byType: {}, snapshotRows: 0 };
  }

  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  let lastId = 0;
  let examined = 0;
  let changed = 0;
  const byType: Record<string, number> = {};

  // Keyset over snapshot.page_id, restoring old_type. Idempotent: restoring an
  // already-restored type is a no-op UPDATE.
  while (true) {
    const snapRows = await engine.executeRaw<{ page_id: number; old_type: string }>(
      `SELECT page_id, old_type FROM ${SNAPSHOT_TABLE}
        WHERE page_id > $1
        ORDER BY page_id
        LIMIT $2`,
      [lastId, batchSize],
    );
    if (snapRows.length === 0) break;
    examined += snapRows.length;

    await engine.withReservedConnection(async (conn: ReservedConnection) => {
      await conn.executeRaw(`BEGIN`);
      try {
        if (engine.kind === 'postgres') {
          await conn.executeRaw(`SET LOCAL statement_timeout = '${PER_BATCH_TIMEOUT_SEC}s'`).catch(() => {});
        }
        for (const s of snapRows) {
          await conn.executeRaw(`UPDATE pages SET type = $2 WHERE id = $1`, [s.page_id, s.old_type]);
          changed++;
          byType[s.old_type] = (byType[s.old_type] ?? 0) + 1;
        }
        await conn.executeRaw(`COMMIT`);
      } catch (err) {
        await conn.executeRaw(`ROLLBACK`).catch(() => {});
        throw err;
      }
    });

    lastId = snapRows[snapRows.length - 1].page_id;
  }

  // Fully reverse the operation: clear the snapshot + checkpoint so a subsequent
  // --apply can redo cleanly. Done AFTER all restores succeed so a mid-restore
  // failure leaves the snapshot intact for a resumable retry.
  await engine.executeRaw(`TRUNCATE ${SNAPSHOT_TABLE}`);
  await clearCheckpoint(engine);

  return { mode: 'revert', examined, changed, byType, snapshotRows: 0 };
}

// --- Public core entrypoint (testable; no process.exit) -------------------

export async function backfillEntityTypes(
  engine: BrainEngine,
  opts: BackfillEntityTypesOpts,
): Promise<BackfillEntityTypesResult> {
  switch (opts.mode) {
    case 'dry-run':
      return runDryRun(engine);
    case 'apply':
      return runApply(engine, opts);
    case 'revert':
      return runRevert(engine, opts);
  }
}

// --- CLI wrapper ----------------------------------------------------------

function parseArgs(args: string[]): BackfillEntityTypesOpts | { help: true } {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const modes: BackfillMode[] = [];
  if (args.includes('--dry-run')) modes.push('dry-run');
  if (args.includes('--apply')) modes.push('apply');
  if (args.includes('--revert')) modes.push('revert');
  if (modes.length !== 1) {
    throw new Error(
      `Specify exactly one of --dry-run | --apply | --revert (got ${modes.length}).`,
    );
  }
  const opts: BackfillEntityTypesOpts = { mode: modes[0] };
  opts.yes = args.includes('--yes');
  opts.fresh = args.includes('--fresh');
  const bsIdx = args.indexOf('--batch-size');
  if (bsIdx >= 0) {
    const n = parseInt(args[bsIdx + 1] ?? '', 10);
    if (Number.isFinite(n) && n > 0) opts.batchSize = n;
  }
  const mrIdx = args.indexOf('--max-rows');
  if (mrIdx >= 0) {
    const n = parseInt(args[mrIdx + 1] ?? '', 10);
    if (Number.isFinite(n) && n > 0) opts.maxRows = n;
  }
  return opts;
}

function printHelp(): void {
  process.stderr.write(
    `Usage: gbrain backfill-entity-types (--dry-run | --apply | --revert) [flags]\n\n` +
      `Reversible re-type of existing entity pages so gbrain-shake's declared type\n` +
      `NAMES match stored data (aliases are NOT a runtime shield; see design R2).\n\n` +
      `Rules:\n` +
      `  doppelganger-cortex/relationships__*  -> person\n` +
      `  doppelganger-cortex/initiatives__*    -> project\n` +
      `  doppelganger-cortex/meetings__*       -> meeting\n` +
      `  type = slack-channel                  -> slack\n\n` +
      `Modes:\n` +
      `  --dry-run   count what would change; write nothing\n` +
      `  --apply     snapshot-before-write, one tx per batch; idempotent/resumable\n` +
      `  --revert    restore exact prior types from the snapshot, then clear it\n\n` +
      `Flags:\n` +
      `  --yes             required to --apply (run --dry-run first to preview)\n` +
      `  --batch-size N    rows per batch (default ${DEFAULT_BATCH_SIZE})\n` +
      `  --max-rows N      cap total rows examined (testing / staged runs)\n` +
      `  --fresh           ignore the resume checkpoint\n`,
  );
}

export async function runBackfillEntityTypes(engine: BrainEngine, args: string[]): Promise<void> {
  let parsed: BackfillEntityTypesOpts | { help: true };
  try {
    parsed = parseArgs(args);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  if ('help' in parsed) {
    printHelp();
    return;
  }

  const json = args.includes('--json');
  try {
    const result = await backfillEntityTypes(engine, parsed);
    if (json) {
      process.stdout.write(JSON.stringify({ schema_version: 1, ...result }, null, 2) + '\n');
    } else {
      const parts = Object.entries(result.byType)
        .map(([t, n]) => `${n} ${t}`)
        .join(', ');
      const verb = result.mode === 'revert' ? 'restored' : result.mode === 'apply' ? 're-typed' : 'would re-type';
      process.stderr.write(
        `[backfill-entity-types] ${result.mode}: ${result.changed} pages ${verb}` +
          (parts ? ` (${parts})` : '') +
          `; snapshot rows: ${result.snapshotRows}\n`,
      );
    }
  } catch (err) {
    if (err instanceof WrongBrainError || err instanceof ApplyGateError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 3;
      return;
    }
    throw err;
  }
}
