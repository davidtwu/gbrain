/**
 * discover_entities cycle phase (gbrain-shake pack, R7) — Step 8.
 *
 * Ephemeral PGLite + a stubbed extractor (no live gateway, no live brain).
 * Covers the design §7.6 test matrix:
 *   - stubbed gateway → proposes person/project from a fixture transcript;
 *     rows land in entity_proposals.
 *   - respects the max_proposals cap.
 *   - dedups against existing pages AND pending proposals.
 *   - idempotent re-run (same content_hash → no new rows).
 *   - does NOT emit type=organization (org signal → org_hint attribute).
 *   - budget cap enforced (stubbed meter).
 *
 * ALL_PHASES / cycle.ts registration is deferred to Step 10 — this suite
 * exercises the phase class directly via runPhaseDiscoverEntities.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  runPhaseDiscoverEntities,
  parseDiscoverOutput,
  deriveProposedSlug,
  contentHash,
  DISCOVER_ENTITIES_PROMPT_VERSION,
  type DiscoverEntitiesExtractor,
  type ProposedEntity,
} from '../src/core/cycle/discover-entities.ts';
import { BudgetMeter } from '../src/core/cycle/budget-meter.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

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

// ─── Helpers ────────────────────────────────────────────────────────

async function seedSourcePage(slug: string, type: string, body: string): Promise<void> {
  await engine.putPage(slug, {
    type,
    title: slug,
    compiled_truth: body,
  });
}

function buildCtx(eng: BrainEngine, config: Record<string, unknown> = {}): OperationContext {
  return {
    engine: eng,
    config: config as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  } as OperationContext;
}

/** Stub extractor that returns a fixed set of entities regardless of input. */
function stubExtractor(entities: ProposedEntity[]): DiscoverEntitiesExtractor {
  return async () => entities.map((e) => ({ ...e }));
}

// ─── parseDiscoverOutput ────────────────────────────────────────────

describe('parseDiscoverOutput', () => {
  test('parses a clean person/project array', () => {
    const raw = '[{"title":"Mike Stuck","type":"person"},{"title":"Mosaic","type":"project"}]';
    const { entities } = parseDiscoverOutput(raw);
    expect(entities).toHaveLength(2);
    expect(entities[0]!.type).toBe('person');
    expect(entities[1]!.type).toBe('project');
  });

  test('strips markdown code fence', () => {
    const raw = '```json\n[{"title":"Alice","type":"person"}]\n```';
    expect(parseDiscoverOutput(raw).entities).toHaveLength(1);
  });

  test('drops org-typed entities (counted separately)', () => {
    const raw = '[{"title":"Acme","type":"organization"},{"title":"Bob","type":"person"}]';
    const { entities, droppedOrg } = parseDiscoverOutput(raw);
    expect(entities).toHaveLength(1);
    expect(entities[0]!.title).toBe('Bob');
    expect(droppedOrg).toBe(1);
  });

  test('drops malformed rows (missing title / unknown type)', () => {
    const raw = '[{"type":"person"},{"title":"X","type":"widget"},{"title":"Ok","type":"project"}]';
    const { entities, droppedMalformed } = parseDiscoverOutput(raw);
    expect(entities).toHaveLength(1);
    expect(droppedMalformed).toBe(2);
  });

  test('captures org_hint + aliases on a person', () => {
    const raw = '[{"title":"Mike Stuck","type":"person","aliases":["Mike"],"org_hint":"Acme"}]';
    const { entities } = parseDiscoverOutput(raw);
    expect(entities[0]!.org_hint).toBe('Acme');
    expect(entities[0]!.aliases).toEqual(['Mike']);
  });

  test('returns empty on garbage', () => {
    expect(parseDiscoverOutput('not json at all').entities).toHaveLength(0);
    expect(parseDiscoverOutput('').entities).toHaveLength(0);
  });
});

describe('deriveProposedSlug', () => {
  test('prefixes person/project + slugifies title', () => {
    expect(deriveProposedSlug({ title: 'Mike Stuck', type: 'person' })).toBe('people/mike-stuck');
    expect(deriveProposedSlug({ title: 'Project Mosaic', type: 'project' })).toBe('projects/project-mosaic');
  });

  test('respects an already-prefixed explicit slug', () => {
    expect(deriveProposedSlug({ title: 'X', type: 'person', slug: 'people/custom-slug' })).toBe('people/custom-slug');
  });
});

// ─── Phase: happy path ──────────────────────────────────────────────

describe('discover_entities — proposes person/project from a transcript', () => {
  test('writes person + project proposals to entity_proposals', async () => {
    await seedSourcePage(
      'session/2026-04-03-standup',
      'session',
      'Mike Stuck walked through the Mosaic returns initiative in the standup.',
    );

    const res = await runPhaseDiscoverEntities(buildCtx(engine), {
      extractor: stubExtractor([
        { title: 'Mike Stuck', type: 'person', aliases: ['Mike'], org_hint: 'Amazon' },
        { title: 'Mosaic', type: 'project' },
      ]),
      budgetUsd: 0, // disable per-source gate for the happy path
      brainBudgetUsd: 0,
    });

    expect(res.status).toBe('ok');
    expect((res.details as Record<string, unknown>).proposals_inserted).toBe(2);

    const rows = await engine.listEntityProposals({ status: 'pending' });
    expect(rows.length).toBe(2);
    const byType = new Map(rows.map((r) => [r.proposed_type, r]));
    expect(byType.get('person')!.proposed_slug).toBe('people/mike-stuck');
    expect(byType.get('person')!.org_hint).toBe('Amazon');
    expect(byType.get('person')!.proposed_aliases).toEqual(['Mike']);
    expect(byType.get('project')!.proposed_slug).toBe('projects/mosaic');
    expect(byType.get('person')!.prompt_version).toBe(DISCOVER_ENTITIES_PROMPT_VERSION);
  });
});

// ─── Phase: max_proposals cap ───────────────────────────────────────

describe('discover_entities — respects max_proposals cap', () => {
  test('stops writing once the cap is hit', async () => {
    await seedSourcePage('session/big', 'session', 'A meeting with lots of new names.');

    const many: ProposedEntity[] = Array.from({ length: 10 }, (_, i) => ({
      title: `Person ${i}`,
      type: 'person' as const,
    }));

    const res = await runPhaseDiscoverEntities(buildCtx(engine), {
      extractor: stubExtractor(many),
      maxProposals: 3,
      budgetUsd: 0,
      brainBudgetUsd: 0,
    });

    expect((res.details as Record<string, unknown>).proposals_inserted).toBe(3);
    expect((res.details as Record<string, unknown>).cap_reached).toBe(true);
    expect((await engine.listEntityProposals()).length).toBe(3);
  });
});

// ─── Phase: dedup vs existing pages + pending proposals ─────────────

describe('discover_entities — dedups against existing pages + pending proposals', () => {
  test('skips an entity whose slug already exists as a page', async () => {
    await seedSourcePage('session/s1', 'session', 'Mike Stuck was mentioned.');
    // Existing person page — the entity already exists.
    await engine.putPage('people/mike-stuck', { type: 'person', title: 'Mike Stuck', compiled_truth: 'x' });

    const res = await runPhaseDiscoverEntities(buildCtx(engine), {
      extractor: stubExtractor([{ title: 'Mike Stuck', type: 'person' }]),
      budgetUsd: 0,
      brainBudgetUsd: 0,
    });

    expect((res.details as Record<string, unknown>).proposals_inserted).toBe(0);
    expect((res.details as Record<string, unknown>).dropped_duplicate).toBe(1);
    expect((await engine.listEntityProposals()).length).toBe(0);
  });

  test('skips an entity already pending in the queue', async () => {
    await seedSourcePage('session/s2', 'session', 'New project Mosaic.');
    await engine.insertEntityProposal({
      source_id: 'default',
      source_page_slug: 'session/other',
      proposed_slug: 'projects/mosaic',
      proposed_type: 'project',
      proposed_title: 'Mosaic',
      content_hash: 'preexisting',
      prompt_version: DISCOVER_ENTITIES_PROMPT_VERSION,
      proposal_run_id: 'run-prior',
      model_id: 'test',
    });

    const res = await runPhaseDiscoverEntities(buildCtx(engine), {
      extractor: stubExtractor([{ title: 'Mosaic', type: 'project' }]),
      budgetUsd: 0,
      brainBudgetUsd: 0,
    });

    expect((res.details as Record<string, unknown>).proposals_inserted).toBe(0);
    // Only the pre-existing pending row remains.
    expect((await engine.listEntityProposals({ status: 'pending' })).length).toBe(1);
  });
});

// ─── Phase: idempotent re-run ───────────────────────────────────────

describe('discover_entities — idempotent re-run', () => {
  test('second run over unchanged page + same entity writes no new rows', async () => {
    await seedSourcePage('session/s3', 'session', 'Alice Example leads the Fit project.');
    const extractor = stubExtractor([
      { title: 'Alice Example', type: 'person' },
      { title: 'Fit', type: 'project' },
    ]);

    const first = await runPhaseDiscoverEntities(buildCtx(engine), { extractor, budgetUsd: 0, brainBudgetUsd: 0 });
    expect((first.details as Record<string, unknown>).proposals_inserted).toBe(2);

    // Simulate a brand-new run: pending dedup would already catch same slug, so
    // to prove the DB-level content_hash idempotency (ON CONFLICT), act the
    // pending rows first (remove them from the pending dedup set) then re-run.
    const pending = await engine.listEntityProposals({ status: 'pending' });
    for (const p of pending) {
      await engine.actEntityProposal(p.id, { status: 'rejected', acted_by: 'test' });
    }

    const second = await runPhaseDiscoverEntities(buildCtx(engine), { extractor, budgetUsd: 0, brainBudgetUsd: 0 });
    // Same body + same slug → same content_hash → ON CONFLICT DO NOTHING.
    expect((second.details as Record<string, unknown>).proposals_inserted).toBe(0);
    expect((await engine.listEntityProposals()).length).toBe(2); // only the two rejected rows
  });
});

// ─── Phase: never emits type=organization ───────────────────────────

describe('discover_entities — org signal never becomes a page', () => {
  test('org-typed candidate dropped; org attached as org_hint on a person', async () => {
    await seedSourcePage('session/s4', 'session', 'Bob at Acme discussed things.');

    const res = await runPhaseDiscoverEntities(buildCtx(engine), {
      // Extractor tries to sneak an org through as a typed entity + a person
      // that carries an org_hint. The phase must drop the org, keep the person.
      extractor: stubExtractor([
        { title: 'Acme Corp', type: 'organization' as unknown as ProposedEntity['type'] },
        { title: 'Bob', type: 'person', org_hint: 'Acme Corp' },
      ]),
      budgetUsd: 0,
      brainBudgetUsd: 0,
    });

    expect((res.details as Record<string, unknown>).dropped_org).toBe(1);
    const rows = await engine.listEntityProposals();
    expect(rows.length).toBe(1);
    expect(rows[0]!.proposed_type).toBe('person');
    expect(rows[0]!.org_hint).toBe('Acme Corp');
    // No row is type=organization (CHECK constraint would also reject it).
    expect(rows.every((r) => r.proposed_type === 'person' || r.proposed_type === 'project')).toBe(true);
  });
});

// ─── Phase: budget cap enforced ─────────────────────────────────────

describe('discover_entities — budget cap enforced', () => {
  test('per-source meter exhaustion stops the phase with warn status', async () => {
    await seedSourcePage('session/b1', 'session', 'Name One here.');
    await seedSourcePage('session/b2', 'session', 'Name Two here.');
    await seedSourcePage('session/b3', 'session', 'Name Three here.');

    // A meter with a tiny cap so the first priced submit exhausts it.
    const meter = new BudgetMeter({ budgetUsd: 0.0000001, phase: 'discover_entities', auditPath: '/tmp/discover-budget-test.jsonl' });

    let calls = 0;
    const countingExtractor: DiscoverEntitiesExtractor = async () => {
      calls += 1;
      return [{ title: `Person ${calls}`, type: 'person' }];
    };

    const res = await runPhaseDiscoverEntities(buildCtx(engine), {
      extractor: countingExtractor,
      meter,
      model: 'claude-opus-4-8', // priced model so the meter actually gates
    });

    expect(res.status).toBe('warn');
    expect((res.details as Record<string, unknown>).budget_exhausted).toBe(true);
    // Budget check happens BEFORE the extractor call, so no page was processed.
    expect(calls).toBe(0);
    expect((await engine.listEntityProposals()).length).toBe(0);
  });

  test('brain-wide backstop stops the phase even when per-source gate is open', async () => {
    await seedSourcePage('session/c1', 'session', 'X'.repeat(4000));
    await seedSourcePage('session/c2', 'session', 'Y'.repeat(4000));

    let calls = 0;
    const countingExtractor: DiscoverEntitiesExtractor = async () => {
      calls += 1;
      return [{ title: `Person ${calls}`, type: 'person' }];
    };

    const res = await runPhaseDiscoverEntities(buildCtx(engine), {
      extractor: countingExtractor,
      budgetUsd: 100, // per-source gate wide open
      brainBudgetUsd: 0.0000001, // brain backstop is tiny → trips first page
      model: 'claude-opus-4-8',
    });

    expect(res.status).toBe('warn');
    expect((res.details as Record<string, unknown>).budget_exhausted).toBe(true);
    expect(calls).toBe(0);
  });
});

// ─── contentHash folds slug ─────────────────────────────────────────

describe('contentHash', () => {
  test('same body + different slug → different hash (multi-entity page)', () => {
    const body = 'Alice and Bob talked.';
    expect(contentHash(body, 'people/alice')).not.toBe(contentHash(body, 'people/bob'));
  });

  test('same body + same slug → stable hash (idempotency)', () => {
    const body = 'Alice and Bob talked.';
    expect(contentHash(body, 'people/alice')).toBe(contentHash(body, 'people/alice'));
  });
});
