/**
 * entity_proposals table + engine methods (gbrain-shake pack, R7/R8; migration v125).
 *
 * Step 7 of the entity-schema-pack plan. Covers:
 *   - Fresh PGLite install → entity_proposals exists with the right
 *     columns/constraints (four-place declaration, §6.6/§7.4).
 *   - Migration v124→v125 path adds the table; idempotent + verify passes twice.
 *   - Engine methods round-trip: insert (ON CONFLICT → one row), list by status,
 *     act (pending→accepted stamps promoted_slug + acted_at; double-act guarded).
 *   - proposed_aliases JSONB round-trips as a genuine array (no double-encode).
 *
 * PGLite-only: there is no hermetic Postgres fresh-install harness in the unit
 * suite (the Postgres half runs in the DATABASE_URL-gated e2e parity/bootstrap
 * tests). The static-schema assertions below (schema.sql via schema-embedded +
 * pglite-schema) pin the Postgres shape indirectly since all three must match.
 *
 * Canonical PGLite block per CLAUDE.md test-isolation rules.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runMigrations, MIGRATIONS, LATEST_VERSION } from '../src/core/migrate.ts';

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
});

describe('entity_proposals — migration v125 registration', () => {
  test('v125 exists with the expected name + idempotent flag', () => {
    const v125 = MIGRATIONS.find((m) => m.version === 125);
    expect(v125).toBeDefined();
    expect(v125!.name).toBe('entity_proposals_v0_43');
    expect(v125!.idempotent).toBe(true);
  });

  test('v125 is the latest version', () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(125);
  });

  test('v125 SQL declares the table + both indexes + idempotency UNIQUE', () => {
    const sql = MIGRATIONS.find((m) => m.version === 125)!.sql;
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS entity_proposals');
    expect(sql).toContain("CHECK (proposed_type IN ('person','project'))");
    expect(sql).toContain("CHECK (status IN ('pending','accepted','rejected'))");
    expect(sql).toContain('UNIQUE (source_id, source_page_slug, content_hash, prompt_version)');
    expect(sql).toContain('entity_proposals_pending_idx');
    expect(sql).toContain('entity_proposals_run_idx');
    expect(sql).toContain("WHERE status = 'pending'");
  });
});

describe('entity_proposals — fresh install (four-place declaration)', () => {
  test('table exists after schema init', async () => {
    const rows = await engine.executeRaw<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'entity_proposals'`,
    );
    expect(rows.length).toBe(1);
  });

  test('columns match the design §5.1 DDL', async () => {
    const rows = await engine.executeRaw<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'entity_proposals'
        ORDER BY ordinal_position`,
    );
    const byName = new Map(rows.map((r) => [r.column_name, r]));
    // Every design column present.
    for (const col of [
      'id', 'source_id', 'source_page_slug', 'proposed_slug', 'proposed_type',
      'proposed_title', 'proposed_aliases', 'org_hint', 'content_hash',
      'prompt_version', 'proposal_run_id', 'status', 'confidence', 'model_id',
      'proposed_at', 'acted_at', 'acted_by', 'promoted_slug',
    ]) {
      expect(byName.has(col)).toBe(true);
    }
    // proposed_aliases is JSONB.
    expect(byName.get('proposed_aliases')!.data_type).toBe('jsonb');
    // NOT NULL enforcement on the required columns.
    expect(byName.get('source_id')!.is_nullable).toBe('NO');
    expect(byName.get('proposed_type')!.is_nullable).toBe('NO');
    expect(byName.get('proposed_aliases')!.is_nullable).toBe('NO');
    // Nullable audit columns.
    expect(byName.get('acted_at')!.is_nullable).toBe('YES');
    expect(byName.get('promoted_slug')!.is_nullable).toBe('YES');
  });

  test('indexes present: pending (partial) + run + idempotency UNIQUE', async () => {
    const rows = await engine.executeRaw<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'entity_proposals'`,
    );
    const defs = rows.map((r) => r.indexdef).join('\n');
    expect(rows.some((r) => r.indexname === 'entity_proposals_pending_idx')).toBe(true);
    expect(rows.some((r) => r.indexname === 'entity_proposals_run_idx')).toBe(true);
    // Partial pending index.
    expect(defs).toMatch(/entity_proposals_pending_idx[\s\S]*WHERE[\s\S]*pending/);
    // Idempotency UNIQUE constraint (auto-named or via UNIQUE()).
    expect(defs).toMatch(/UNIQUE[\s\S]*source_id[\s\S]*content_hash[\s\S]*prompt_version/);
  });

  test('proposed_type CHECK rejects non-person/project', async () => {
    await expect(
      engine.executeRaw(
        `INSERT INTO entity_proposals
           (source_id, source_page_slug, proposed_slug, proposed_type, proposed_title,
            content_hash, prompt_version, proposal_run_id, model_id)
         VALUES ('default','p/1','x','organization','X','h','v1','r1','m')`,
      ),
    ).rejects.toThrow();
  });

  test('static schemas (embedded + pglite) both declare the table', async () => {
    const { SCHEMA_SQL } = await import('../src/core/schema-embedded.ts');
    const { PGLITE_SCHEMA_SQL } = await import('../src/core/pglite-schema.ts');
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS entity_proposals');
    expect(PGLITE_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS entity_proposals');
  });
});

describe('entity_proposals — migration v124→v125 path', () => {
  test('applying v125 onto a v124 DB adds the table; idempotent + verify twice', async () => {
    // Simulate a brain stamped at v124 that lacks the table.
    await engine.executeRaw('DROP TABLE IF EXISTS entity_proposals CASCADE');
    await engine.setConfig('version', '124');

    const before = await engine.executeRaw<{ present: boolean }>(
      `SELECT to_regclass('public.entity_proposals') IS NOT NULL AS present`,
    );
    expect(Boolean(before[0].present)).toBe(false);

    const r1 = await runMigrations(engine);
    expect(r1.applied).toBeGreaterThanOrEqual(1);

    const after = await engine.executeRaw<{ present: boolean }>(
      `SELECT to_regclass('public.entity_proposals') IS NOT NULL AS present`,
    );
    expect(Boolean(after[0].present)).toBe(true);

    // Re-run: nothing pending, verify block stays satisfied (no throw, 0 applied).
    const r2 = await runMigrations(engine);
    expect(r2.applied).toBe(0);

    // v125 verify hook returns true against the live table.
    const v125 = MIGRATIONS.find((m) => m.version === 125)!;
    expect(await v125.verify!(engine)).toBe(true);
    expect(await v125.verify!(engine)).toBe(true);
  }, 60_000);
});

describe('entity_proposals — engine methods round-trip', () => {
  const baseRow = {
    source_id: 'default',
    source_page_slug: 'meetings/2026-04-03',
    proposed_slug: 'people/alice-example',
    proposed_type: 'person' as const,
    proposed_title: 'Alice Example',
    proposed_aliases: ['Alice', 'A. Example'],
    org_hint: 'acme-example',
    content_hash: 'hash-abc',
    prompt_version: 'v1',
    proposal_run_id: 'run-1',
    confidence: 0.9,
    model_id: 'anthropic:claude-opus-4-8',
  };

  test('insertEntityProposal inserts once; second call with same key is a no-op (ON CONFLICT)', async () => {
    const first = await engine.insertEntityProposal(baseRow);
    expect(first).not.toBeNull();
    expect(typeof first!.id).toBe('number');

    const dup = await engine.insertEntityProposal(baseRow);
    expect(dup).toBeNull();

    const all = await engine.listEntityProposals();
    expect(all.length).toBe(1);
  });

  test('proposed_aliases round-trips as a genuine JSON array (no double-encode)', async () => {
    await engine.insertEntityProposal(baseRow);
    const [row] = await engine.listEntityProposals();
    expect(Array.isArray(row.proposed_aliases)).toBe(true);
    expect(row.proposed_aliases).toEqual(['Alice', 'A. Example']);
    // Confirm jsonb_typeof is 'array' at the DB layer (the #2339 guard).
    const jt = await engine.executeRaw<{ t: string }>(
      `SELECT jsonb_typeof(proposed_aliases) AS t FROM entity_proposals WHERE id = $1`,
      [row.id],
    );
    expect(jt[0].t).toBe('array');
  });

  test('empty/omitted aliases default to []', async () => {
    await engine.insertEntityProposal({ ...baseRow, proposed_aliases: undefined, content_hash: 'h2' });
    const rows = await engine.listEntityProposals();
    expect(rows[0].proposed_aliases).toEqual([]);
  });

  test('listEntityProposals filters by status', async () => {
    await engine.insertEntityProposal(baseRow);
    await engine.insertEntityProposal({ ...baseRow, content_hash: 'h2', proposed_slug: 'projects/mosaic', proposed_type: 'project', proposed_title: 'Mosaic' });

    const pending = await engine.listEntityProposals({ status: 'pending' });
    expect(pending.length).toBe(2);
    const accepted = await engine.listEntityProposals({ status: 'accepted' });
    expect(accepted.length).toBe(0);
  });

  test('actEntityProposal accept stamps status + promoted_slug + acted_at + acted_by', async () => {
    const ins = await engine.insertEntityProposal(baseRow);
    const acted = await engine.actEntityProposal(ins!.id, {
      status: 'accepted',
      acted_by: 'david',
      promoted_slug: 'people/alice-example',
    });
    expect(acted).not.toBeNull();
    expect(acted!.status).toBe('accepted');
    expect(acted!.promoted_slug).toBe('people/alice-example');
    expect(acted!.acted_by).toBe('david');
    expect(acted!.acted_at).toBeInstanceOf(Date);

    // No longer pending; visible under accepted filter.
    expect((await engine.listEntityProposals({ status: 'pending' })).length).toBe(0);
    expect((await engine.listEntityProposals({ status: 'accepted' })).length).toBe(1);
  });

  test('actEntityProposal reject stamps status without promoted_slug', async () => {
    const ins = await engine.insertEntityProposal(baseRow);
    const acted = await engine.actEntityProposal(ins!.id, { status: 'rejected', acted_by: 'david' });
    expect(acted!.status).toBe('rejected');
    expect(acted!.promoted_slug).toBeNull();
    expect(acted!.acted_at).toBeInstanceOf(Date);
  });

  test('double-act is guarded: a non-pending row does not transition again', async () => {
    const ins = await engine.insertEntityProposal(baseRow);
    await engine.actEntityProposal(ins!.id, { status: 'accepted', acted_by: 'david', promoted_slug: 'people/alice-example' });
    const second = await engine.actEntityProposal(ins!.id, { status: 'rejected', acted_by: 'someone-else' });
    expect(second).toBeNull();

    const [row] = await engine.listEntityProposals();
    expect(row.status).toBe('accepted');
    expect(row.acted_by).toBe('david');
  });

  test('actEntityProposal on a missing id returns null', async () => {
    expect(await engine.actEntityProposal(999999, { status: 'accepted', acted_by: 'x' })).toBeNull();
  });
});
