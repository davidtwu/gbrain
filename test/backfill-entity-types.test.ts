/**
 * R2 — Reversible entity-type backfill (entity-schema-pack Step 3).
 *
 * Exercises src/commands/backfill-entity-types.ts against an ephemeral PGLite
 * brain seeded with fixture pages:
 *   - dry-run reports counts + writes nothing.
 *   - apply re-types all four groups (relationships/initiatives/meetings slug
 *     prefixes + slack-channel type) and writes the snapshot.
 *   - revert restores the exact prior types (round-trip identity).
 *   - crash-resume: a partial apply (maxRows cap) re-runs without double-processing.
 *   - wrong-brain guard aborts when the expected doppelganger-cortex slugs are absent.
 *
 * Canonical PGLite block per CLAUDE.md test-isolation rules.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  backfillEntityTypes,
  targetTypeFor,
  WrongBrainError,
  ApplyGateError,
} from '../src/commands/backfill-entity-types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // The snapshot table is disposable scratch created lazily by the command;
  // drop it between tests so each starts clean (resetPgliteState only truncates
  // tables that exist at reset time — the command may have created it).
  await engine.executeRaw('DROP TABLE IF EXISTS backfill_entity_types_20260716');
});

// --- fixtures -------------------------------------------------------------

interface SeedPage {
  slug: string;
  type: string;
}

/**
 * Seed the four rule-matching groups plus a couple of control pages that must
 * NOT be touched. Types are seeded to their WRONG (pre-backfill) value:
 *   - relationships/initiatives/meetings pages start as 'concept'
 *   - slack pages start as 'slack-channel'
 */
async function seedPages(): Promise<{ total: number; controls: SeedPage[] }> {
  const pages: SeedPage[] = [];
  // 3 relationships → person
  for (let i = 0; i < 3; i++) pages.push({ slug: `doppelganger-cortex/relationships__person-${i}`, type: 'concept' });
  // 2 initiatives → project
  for (let i = 0; i < 2; i++) pages.push({ slug: `doppelganger-cortex/initiatives__proj-${i}`, type: 'concept' });
  // 4 meetings → meeting
  for (let i = 0; i < 4; i++) pages.push({ slug: `doppelganger-cortex/meetings__mtg-${i}`, type: 'concept' });
  // 5 slack-channel → slack (matched by TYPE, not slug)
  for (let i = 0; i < 5; i++) pages.push({ slug: `slack/channel-${i}`, type: 'slack-channel' });

  const controls: SeedPage[] = [
    // An unrelated note that must stay a note.
    { slug: 'notes/random-thought', type: 'note' },
    // A slug that looks close but isn't a prefix match (different flatten).
    { slug: 'doppelganger-cortex/relationship-summary', type: 'concept' },
  ];

  const all = [...pages, ...controls];
  for (const p of all) {
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title) VALUES ('default', $1, $2, $3)`,
      [p.slug, p.type, p.slug],
    );
  }
  return { total: pages.length, controls };
}

async function typeOf(slug: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ type: string }>(
    `SELECT type FROM pages WHERE slug = $1`,
    [slug],
  );
  return rows[0]?.type ?? null;
}

async function allTypesBySlug(): Promise<Map<string, string>> {
  const rows = await engine.executeRaw<{ slug: string; type: string }>(`SELECT slug, type FROM pages`);
  return new Map(rows.map((r) => [r.slug, r.type]));
}

// --- targetTypeFor unit ---------------------------------------------------

describe('targetTypeFor', () => {
  test('maps each rule group to its declared type NAME', () => {
    expect(targetTypeFor({ slug: 'doppelganger-cortex/relationships__mike', type: 'concept' })).toBe('person');
    expect(targetTypeFor({ slug: 'doppelganger-cortex/initiatives__mosaic', type: 'concept' })).toBe('project');
    expect(targetTypeFor({ slug: 'doppelganger-cortex/meetings__2026-04-03', type: 'concept' })).toBe('meeting');
    expect(targetTypeFor({ slug: 'slack/general', type: 'slack-channel' })).toBe('slack');
  });
  test('returns null for non-matching pages', () => {
    expect(targetTypeFor({ slug: 'notes/foo', type: 'note' })).toBeNull();
    expect(targetTypeFor({ slug: 'doppelganger-cortex/relationship-summary', type: 'concept' })).toBeNull();
  });
});

// --- dry-run --------------------------------------------------------------

describe('backfill-entity-types --dry-run', () => {
  test('reports per-type counts and writes nothing', async () => {
    await seedPages();
    const before = await allTypesBySlug();

    const res = await backfillEntityTypes(engine, { mode: 'dry-run' });
    expect(res.byType).toEqual({ person: 3, project: 2, meeting: 4, slack: 5 });
    expect(res.changed).toBe(14);
    expect(res.snapshotRows).toBe(0);

    // Nothing changed on disk.
    const after = await allTypesBySlug();
    expect(after).toEqual(before);
    // Snapshot table was never created by dry-run.
    const exists = await engine.executeRaw<{ present: boolean }>(
      `SELECT to_regclass('public.backfill_entity_types_20260716') IS NOT NULL AS present`,
    );
    expect(Boolean(exists[0].present)).toBe(false);
  });
});

// --- apply ----------------------------------------------------------------

describe('backfill-entity-types --apply', () => {
  test('requires --yes gate', async () => {
    await seedPages();
    await expect(backfillEntityTypes(engine, { mode: 'apply' })).rejects.toBeInstanceOf(ApplyGateError);
    // Nothing changed.
    expect(await typeOf('doppelganger-cortex/relationships__person-0')).toBe('concept');
  });

  test('re-types all four groups and writes the snapshot', async () => {
    await seedPages();
    const res = await backfillEntityTypes(engine, { mode: 'apply', yes: true });
    expect(res.changed).toBe(14);
    expect(res.byType).toEqual({ person: 3, project: 2, meeting: 4, slack: 5 });
    expect(res.snapshotRows).toBe(14);

    // Types actually changed.
    expect(await typeOf('doppelganger-cortex/relationships__person-0')).toBe('person');
    expect(await typeOf('doppelganger-cortex/initiatives__proj-1')).toBe('project');
    expect(await typeOf('doppelganger-cortex/meetings__mtg-3')).toBe('meeting');
    expect(await typeOf('slack/channel-0')).toBe('slack');

    // Controls untouched.
    expect(await typeOf('notes/random-thought')).toBe('note');
    expect(await typeOf('doppelganger-cortex/relationship-summary')).toBe('concept');

    // Snapshot rows carry the exact old_type/new_type.
    const snap = await engine.executeRaw<{ slug: string; old_type: string; new_type: string }>(
      `SELECT slug, old_type, new_type FROM backfill_entity_types_20260716 ORDER BY slug`,
    );
    expect(snap.length).toBe(14);
    const slackSnap = snap.find((s) => s.slug === 'slack/channel-2')!;
    expect(slackSnap.old_type).toBe('slack-channel');
    expect(slackSnap.new_type).toBe('slack');
    const relSnap = snap.find((s) => s.slug === 'doppelganger-cortex/relationships__person-1')!;
    expect(relSnap.old_type).toBe('concept');
    expect(relSnap.new_type).toBe('person');
  });

  test('idempotent: a second apply is a no-op (rows already snapshotted are skipped)', async () => {
    await seedPages();
    await backfillEntityTypes(engine, { mode: 'apply', yes: true });
    const res2 = await backfillEntityTypes(engine, { mode: 'apply', yes: true });
    expect(res2.examined).toBe(0);
    expect(res2.changed).toBe(0);
    expect(res2.snapshotRows).toBe(14); // unchanged
  });
});

// --- revert (round-trip identity) ----------------------------------------

describe('backfill-entity-types --revert', () => {
  test('restores exact prior types (round-trip identity: start == after apply+revert)', async () => {
    await seedPages();
    const start = await allTypesBySlug();

    await backfillEntityTypes(engine, { mode: 'apply', yes: true });
    const revertRes = await backfillEntityTypes(engine, { mode: 'revert' });
    expect(revertRes.changed).toBe(14);
    expect(revertRes.snapshotRows).toBe(0); // snapshot cleared after full restore

    const end = await allTypesBySlug();
    expect(end).toEqual(start);
  });

  test('idempotent: a second revert is a clean no-op', async () => {
    await seedPages();
    await backfillEntityTypes(engine, { mode: 'apply', yes: true });
    await backfillEntityTypes(engine, { mode: 'revert' });
    const res2 = await backfillEntityTypes(engine, { mode: 'revert' });
    expect(res2.changed).toBe(0);
    expect(res2.examined).toBe(0);
  });

  test('revert with no snapshot table present is a safe no-op', async () => {
    await seedPages();
    const res = await backfillEntityTypes(engine, { mode: 'revert' });
    expect(res.changed).toBe(0);
    expect(res.snapshotRows).toBe(0);
  });
});

// --- crash-resume ---------------------------------------------------------

describe('backfill-entity-types crash-resume', () => {
  test('partial apply (maxRows cap) then full re-run: no double-processing', async () => {
    await seedPages();
    // Cap the first run so it only processes a subset of candidates.
    const partial = await backfillEntityTypes(engine, { mode: 'apply', yes: true, maxRows: 5, batchSize: 2 });
    expect(partial.examined).toBeLessThanOrEqual(6); // batchSize may slightly overshoot the cap
    const snapAfterPartial = partial.snapshotRows;
    expect(snapAfterPartial).toBeGreaterThan(0);
    expect(snapAfterPartial).toBeLessThan(14);

    // Re-run to completion: only the not-yet-snapshotted rows get processed.
    const rest = await backfillEntityTypes(engine, { mode: 'apply', yes: true });
    // Total snapshot rows must be exactly 14 (no duplicates, no misses).
    expect(rest.snapshotRows).toBe(14);
    // Combined changed count across both runs equals the full set.
    expect(partial.changed + rest.changed).toBe(14);

    // Every group ended correctly typed.
    expect(await typeOf('doppelganger-cortex/relationships__person-2')).toBe('person');
    expect(await typeOf('slack/channel-4')).toBe('slack');

    // Round-trip still holds after a resumed apply.
    const revert = await backfillEntityTypes(engine, { mode: 'revert' });
    expect(revert.changed).toBe(14);
    expect(await typeOf('slack/channel-4')).toBe('slack-channel');
  });
});

// --- wrong-brain guard ----------------------------------------------------

describe('backfill-entity-types wrong-brain guard', () => {
  test('aborts when expected doppelganger-cortex slugs are absent', async () => {
    // Seed ONLY unrelated pages — no doppelganger-cortex slugs.
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title) VALUES ('default', 'notes/x', 'note', 'x')`,
    );
    await expect(backfillEntityTypes(engine, { mode: 'dry-run' })).rejects.toBeInstanceOf(WrongBrainError);
    await expect(backfillEntityTypes(engine, { mode: 'apply', yes: true })).rejects.toBeInstanceOf(WrongBrainError);
  });

  test('slack-channel-only brain still aborts (guard keys on the slug set, not slack)', async () => {
    // A brain with slack-channel pages but no cortex entity slugs is still "wrong"
    // for this backfill — the guard requires the cortex slugs to exist.
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title) VALUES ('default', 'slack/c0', 'slack-channel', 'c0')`,
    );
    await expect(backfillEntityTypes(engine, { mode: 'dry-run' })).rejects.toBeInstanceOf(WrongBrainError);
  });
});
