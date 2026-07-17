/**
 * v0.43 (gbrain-shake entity pack, Step 10) — runCycle wiring for the two new
 * entity phases: `discover_entities` + `ner_link`.
 *
 * These are the orchestrator-level integration tests that pin the Step 10
 * registration (the phase modules themselves are unit-tested in
 * discover-entities-phase.test.ts + ner-link-phase.test.ts). Ephemeral PGLite,
 * no live gateway, no live brain. Covers:
 *   - shake active → both phases run, discover_entities BEFORE ner_link, and
 *     ner_link produces real mentions edges (via committed entity pages);
 *   - non-shake pack active → both phases SKIP with reason=not_in_active_pack
 *     + pack_gated:true (the greppable marker);
 *   - `!engine` guard → both phases skip with no_database (never no_brain_dir),
 *     i.e. the DB-sourced phases are NOT brainDir-gated.
 *
 * We drive runCycle with `phases: ['discover_entities', 'ner_link']` so the test
 * is fast + hermetic and doesn't depend on the other 22 phases' fixtures. The
 * discover_entities LLM call would need the gateway, so on the shake path we
 * scope discovery to a source-type set with no matching pages (0 LLM calls, a
 * clean status:ok) and let ner_link do the graph work deterministically.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runCycle } from '../src/core/cycle.ts';
import { __resetNerKnobWarnings } from '../src/core/by-mention.ts';

let engine: PGLiteEngine;
const savedPack = process.env.GBRAIN_SCHEMA_PACK;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  if (savedPack === undefined) delete process.env.GBRAIN_SCHEMA_PACK;
  else process.env.GBRAIN_SCHEMA_PACK = savedPack;
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __resetNerKnobWarnings();
});

async function truncateCycleLocks(): Promise<void> {
  await (engine as unknown as { db: { query: (q: string) => Promise<unknown> } }).db.query(
    'DELETE FROM gbrain_cycle_locks',
  );
}

async function seedPage(
  slug: string,
  type: string,
  body: string,
  frontmatter: Record<string, unknown> = {},
  title?: string,
): Promise<void> {
  await engine.putPage(slug, {
    type: type as never,
    title: title ?? slug,
    compiled_truth: body,
    timeline: '',
    frontmatter,
  });
}

// ─── shake active: both phases run, discover BEFORE ner, ner links ──────

describe('runCycle wiring — gbrain-shake active runs discover_entities → ner_link', () => {
  test('both phases run in order (discover before ner) and ner_link creates edges', async () => {
    process.env.GBRAIN_SCHEMA_PACK = 'gbrain-shake';
    await truncateCycleLocks();

    // A committed person page (linkable under shake) + a transcript that names
    // them. ner_link should write a mentions edge deterministically. We do NOT
    // seed any session/transcript/meeting/email page that names a NEW entity, so
    // discover_entities finds candidates but makes zero LLM calls on an empty
    // scan (status ok, 0 proposals) — no gateway needed.
    await seedPage('people/mike-stuck', 'person', 'Person page for Mike Stuck.', {}, 'Mike Stuck');
    await seedPage('session/t1', 'session', 'In the standup, Mike Stuck raised the returns issue.');

    const report = await runCycle(engine, {
      brainDir: null, // checkout-less DB brain — DB-sourced phases must still run
      phases: ['discover_entities', 'ner_link'],
    });

    const names = report.phases.map((p) => p.phase);
    expect(names).toEqual(['discover_entities', 'ner_link']);

    const discover = report.phases.find((p) => p.phase === 'discover_entities')!;
    const ner = report.phases.find((p) => p.phase === 'ner_link')!;

    // Neither is pack-gated-skipped.
    expect(discover.details?.reason).not.toBe('not_in_active_pack');
    expect(ner.details?.reason).not.toBe('not_in_active_pack');

    // discover ran (status ok/warn, not skipped); ner produced the edge.
    expect(discover.status === 'ok' || discover.status === 'warn').toBe(true);
    expect(ner.status).toBe('ok');
    expect((ner.details as Record<string, unknown>).edges_created).toBe(1);

    // Ordering: discover_entities index < ner_link index.
    expect(names.indexOf('discover_entities')).toBeLessThan(names.indexOf('ner_link'));
  });
});

// ─── non-shake pack: both phases skip pack_gated ────────────────────────

describe('runCycle wiring — non-shake pack skips both phases (pack_gated)', () => {
  test('discover_entities + ner_link both skip with not_in_active_pack', async () => {
    process.env.GBRAIN_SCHEMA_PACK = 'gbrain-base-v2'; // declares no phases
    await truncateCycleLocks();

    const report = await runCycle(engine, {
      brainDir: null,
      phases: ['discover_entities', 'ner_link'],
    });

    for (const phase of ['discover_entities', 'ner_link'] as const) {
      const r = report.phases.find((p) => p.phase === phase)!;
      expect(r.status).toBe('skipped');
      expect((r.details as Record<string, unknown>).reason).toBe('not_in_active_pack');
      expect((r.details as Record<string, unknown>).pack_gated).toBe(true);
    }
  });
});

// ─── !engine guard: no_database, NOT no_brain_dir ───────────────────────

describe('runCycle wiring — !engine guard skips with no_database (never no_brain_dir)', () => {
  test('null engine → both phases skip no_database', async () => {
    const report = await runCycle(null, {
      brainDir: null,
      phases: ['discover_entities', 'ner_link'],
    });
    for (const phase of ['discover_entities', 'ner_link'] as const) {
      const r = report.phases.find((p) => p.phase === phase)!;
      expect(r.status).toBe('skipped');
      expect((r.details as Record<string, unknown>).reason).toBe('no_database');
      // Critically NOT the FS-gated skip — these phases never touch brainDir.
      expect((r.details as Record<string, unknown>).reason).not.toBe('no_brain_dir');
    }
  });
});
