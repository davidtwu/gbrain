/**
 * v0.43 (gbrain-shake entity pack, Step 10) — MCP review tools
 * `entity_proposals_list` + `entity_proposals_act`.
 *
 * These mirror `gbrain entities propose --list/--accept/--reject` by REUSING the
 * exported lifecycle fns from src/commands/entities.ts (listProposals /
 * acceptProposal / rejectProposal). The tests dispatch through the actual
 * Operation handlers (found in the operations registry, same path the MCP
 * server + `gbrain call` invoke) and assert behavior parity with the CLI:
 *   - list returns pending proposals; status filter honored.
 *   - act accept promotes → creates the page (verify via getPage) + stamps
 *     status=accepted + promoted_slug.
 *   - act reject stamps status=rejected.
 *   - guards: unknown id, double-accept, slug-collision surface (never clobber).
 *
 * Ephemeral PGLite; no live gateway. The accept path routes through the default
 * PageCreator (the put_page operation), exactly like the CLI's default creator —
 * so this exercises the same write-through the operator CLI uses.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { EntityProposalInput, EntityProposalRow } from '../src/core/types.ts';

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

const listOp = operations.find((o) => o.name === 'entity_proposals_list')!;
const actOp = operations.find((o) => o.name === 'entity_proposals_act')!;

function ctx(): OperationContext {
  return {
    engine: engine as unknown as BrainEngine,
    config: { engine: 'pglite' } as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  } as OperationContext;
}

const personRow: EntityProposalInput = {
  source_id: 'default',
  source_page_slug: 'meetings/2026-04-03',
  proposed_slug: 'people/alice-example',
  proposed_type: 'person',
  proposed_title: 'Alice Example',
  proposed_aliases: ['Alice'],
  org_hint: 'acme-example',
  content_hash: 'hash-person',
  prompt_version: 'v1',
  proposal_run_id: 'run-1',
  confidence: 0.9,
  model_id: 'anthropic:claude-opus-4-8',
};

const projectRow: EntityProposalInput = {
  source_id: 'default',
  source_page_slug: 'meetings/2026-04-03',
  proposed_slug: 'projects/mosaic',
  proposed_type: 'project',
  proposed_title: 'Mosaic',
  proposed_aliases: [],
  org_hint: null,
  content_hash: 'hash-project',
  prompt_version: 'v1',
  proposal_run_id: 'run-1',
  confidence: 0.8,
  model_id: 'anthropic:claude-opus-4-8',
};

// ─── the ops exist + reuse entities.ts (registry sanity) ────────────────

describe('entity_proposals ops are registered with the right scope', () => {
  test('list is read-scope, act is write-scope + mutating', () => {
    expect(listOp).toBeTruthy();
    expect(listOp.scope).toBe('read');
    expect(actOp).toBeTruthy();
    expect(actOp.scope).toBe('write');
    expect(actOp.mutating).toBe(true);
  });
});

// ─── list parity ────────────────────────────────────────────────────────

describe('entity_proposals_list — parity with `entities propose --list`', () => {
  test('returns pending proposals by default', async () => {
    await engine.insertEntityProposal(personRow);
    await engine.insertEntityProposal(projectRow);

    const rows = (await listOp.handler(ctx(), {})) as EntityProposalRow[];
    expect(rows.map((r) => r.proposed_slug).sort()).toEqual(['people/alice-example', 'projects/mosaic']);
    for (const r of rows) expect(r.status).toBe('pending');
  });

  test('status filter honored (rejected shows only rejected)', async () => {
    const p = await engine.insertEntityProposal(personRow);
    await engine.insertEntityProposal(projectRow);
    await engine.actEntityProposal(p!.id, { status: 'rejected', acted_by: 'test' });

    const rejected = (await listOp.handler(ctx(), { status: 'rejected' })) as EntityProposalRow[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0].proposed_slug).toBe('people/alice-example');

    const pending = (await listOp.handler(ctx(), { status: 'pending' })) as EntityProposalRow[];
    expect(pending.map((r) => r.proposed_slug)).toEqual(['projects/mosaic']);
  });
});

// ─── act accept parity ────────────────────────────────────────────────────

describe('entity_proposals_act accept — creates page + stamps (parity with --accept)', () => {
  test('accept promotes: page created + proposal stamped accepted', async () => {
    const p = await engine.insertEntityProposal(personRow);

    const res = (await actOp.handler(ctx(), { id: p!.id, action: 'accept', acted_by: 'mcp' })) as {
      ok: boolean;
      promotedSlug?: string;
    };
    expect(res.ok).toBe(true);
    expect(res.promotedSlug).toBe('people/alice-example');

    // Page exists (created via the put_page-op default creator).
    const page = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(page).toBeTruthy();
    expect(page!.type).toBe('person');

    // Proposal stamped.
    const rows = await engine.listEntityProposals({ status: 'accepted', limit: 100 });
    expect(rows).toHaveLength(1);
    expect(rows[0].promoted_slug).toBe('people/alice-example');
    expect(rows[0].acted_by).toBe('mcp');
  });

  test('acted_by defaults to "mcp" when omitted', async () => {
    const p = await engine.insertEntityProposal(projectRow);
    await actOp.handler(ctx(), { id: p!.id, action: 'accept' });
    const rows = await engine.listEntityProposals({ status: 'accepted', limit: 100 });
    expect(rows[0].acted_by).toBe('mcp');
  });

  test('double-accept guarded (second accept fails not_pending)', async () => {
    const p = await engine.insertEntityProposal(personRow);
    await actOp.handler(ctx(), { id: p!.id, action: 'accept' });
    const res2 = (await actOp.handler(ctx(), { id: p!.id, action: 'accept' })) as {
      ok: boolean;
      reason?: string;
    };
    expect(res2.ok).toBe(false);
    expect(res2.reason).toBe('not_pending');
  });

  test('slug collision surfaced — existing page not clobbered', async () => {
    // Pre-create the page the proposal would promote to, with distinct content.
    await engine.putPage('people/alice-example', {
      type: 'person' as never,
      title: 'Alice Example (hand-authored)',
      compiled_truth: 'ORIGINAL hand-authored body.',
    });
    const p = await engine.insertEntityProposal(personRow);
    const res = (await actOp.handler(ctx(), { id: p!.id, action: 'accept' })) as {
      ok: boolean;
      reason?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('slug_collision');
    // Untouched.
    const page = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(page!.compiled_truth).toContain('ORIGINAL hand-authored body.');
    // Proposal stays pending (retryable).
    const pending = await engine.listEntityProposals({ status: 'pending', limit: 100 });
    expect(pending).toHaveLength(1);
  });

  test('unknown id → not_found', async () => {
    const res = (await actOp.handler(ctx(), { id: 99999, action: 'accept' })) as {
      ok: boolean;
      reason?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_found');
  });
});

// ─── act reject parity ──────────────────────────────────────────────────

describe('entity_proposals_act reject — stamps rejected (parity with --reject)', () => {
  test('reject stamps status=rejected; no page created', async () => {
    const p = await engine.insertEntityProposal(personRow);
    const res = (await actOp.handler(ctx(), { id: p!.id, action: 'reject', acted_by: 'mcp' })) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);

    const rows = await engine.listEntityProposals({ status: 'rejected', limit: 100 });
    expect(rows).toHaveLength(1);
    expect(rows[0].acted_by).toBe('mcp');

    // No page was created.
    const page = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(page).toBeFalsy();
  });
});

// ─── invalid action ──────────────────────────────────────────────────────

describe('entity_proposals_act — invalid action rejected', () => {
  test('action other than accept/reject throws', async () => {
    const p = await engine.insertEntityProposal(personRow);
    await expect(actOp.handler(ctx(), { id: p!.id, action: 'delete' })).rejects.toThrow();
  });

  test('dry_run short-circuits without mutating', async () => {
    const p = await engine.insertEntityProposal(personRow);
    const dctx = { ...ctx(), dryRun: true } as OperationContext;
    const res = (await actOp.handler(dctx, { id: p!.id, action: 'accept' })) as { dry_run?: boolean };
    expect(res.dry_run).toBe(true);
    // Still pending.
    const pending = await engine.listEntityProposals({ status: 'pending', limit: 100 });
    expect(pending).toHaveLength(1);
  });
});
