/**
 * ner_link cycle phase (gbrain-shake pack, R6) — Step 5.
 *
 * Ephemeral PGLite; no live gateway, no live brain. Covers the design §7.5
 * matrix + the Step 5 alias-indexing decision (a):
 *   - fixture brain (1 person "Mike Stuck" + alias "mikstuck" + 3 transcripts
 *     mentioning them) → ner_link creates `mentions` edges to the person page;
 *     re-run → 0 (idempotent, links UNIQUE + ON CONFLICT DO NOTHING).
 *   - `!engine` guard: the phase runs on a checkout-less DB brain and does NOT
 *     skip with no_brain_dir (it never touches brainDir — the wrapper is
 *     DB-sourced). We assert edges appear on a DB-only engine.
 *   - meeting→project via `mentions` fires (meeting walked as a SOURCE even
 *     though meeting is not a gazetteer target).
 *   - alias "mikstuck" in a transcript ALSO links (Step 5 alias indexing).
 *
 * ALL_PHASES / cycle.ts registration is DEFERRED to Step 10 — this suite drives
 * the phase class directly via runPhaseNerLink.
 *
 * Pack gating: the gazetteer's linkable-type set is pack-driven. gbrain-shake
 * makes person+project linkable, so we set GBRAIN_SCHEMA_PACK=gbrain-shake for
 * the engine-backed cases (same pattern as linkable-types-pack-aware.test.ts).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseNerLink } from '../src/core/cycle/ner-link.ts';
import { __resetNerKnobWarnings } from '../src/core/by-mention.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;
const savedPack = process.env.GBRAIN_SCHEMA_PACK;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  process.env.GBRAIN_SCHEMA_PACK = 'gbrain-shake';
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

/** Count mentions edges INTO a target slug. */
async function mentionEdgesTo(targetSlug: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*) AS n
       FROM links l
       JOIN pages t ON t.id = l.to_page_id
      WHERE t.slug = $1 AND l.link_source = 'mentions'`,
    [targetSlug],
  );
  return Number(rows[0]?.n ?? 0);
}

// ─── happy path + idempotency ───────────────────────────────────────

describe('ner_link — creates mentions edges to a person page + idempotent', () => {
  test('3 transcripts naming "Mike Stuck" → 3 mentions edges; re-run → 0 new', async () => {
    await seedPage('people/mike-stuck', 'person', 'Person page for Mike Stuck.', {
      aliases: ['mikstuck'],
    }, 'Mike Stuck');
    await seedPage('session/t1', 'session', 'In the standup, Mike Stuck raised the returns issue.');
    await seedPage('session/t2', 'transcript', 'Mike Stuck and the team discussed sizing.');
    await seedPage('meetings/m1', 'meeting', 'Notes: Mike Stuck attended and led the review.');

    const first = await runPhaseNerLink(buildCtx(engine));
    expect(first.status).toBe('ok');
    expect((first.details as Record<string, unknown>).edges_created).toBe(3);
    expect(await mentionEdgesTo('people/mike-stuck')).toBe(3);

    // Re-run: links UNIQUE + ON CONFLICT DO NOTHING → 0 new edges.
    const second = await runPhaseNerLink(buildCtx(engine));
    expect((second.details as Record<string, unknown>).edges_created).toBe(0);
    expect(await mentionEdgesTo('people/mike-stuck')).toBe(3);
  });
});

// ─── !engine guard: DB-only brain (no checkout) still links ─────────

describe('ner_link — runs on a checkout-less DB brain (no no_brain_dir skip)', () => {
  test('edges created without any brainDir / on-disk checkout', async () => {
    // This engine has NO brain directory — the exact case the old FS-gated
    // extract phase skipped with reason=no_brain_dir. The DB-sourced ner_link
    // wrapper must produce edges regardless.
    await seedPage('people/alice-example', 'person', 'Alice Example page.', {}, 'Alice Example');
    await seedPage('session/s1', 'session', 'Alice Example joined the call.');

    const res = await runPhaseNerLink(buildCtx(engine));
    expect(res.status).toBe('ok');
    // Not a skip: no no_brain_dir reason, real work done.
    expect((res.details as Record<string, unknown>).reason).toBeUndefined();
    expect((res.details as Record<string, unknown>).edges_created).toBe(1);
    expect(await mentionEdgesTo('people/alice-example')).toBe(1);
  });
});

// ─── meeting → project via mentions ─────────────────────────────────

describe('ner_link — meeting page walked as a SOURCE links to a project', () => {
  test('meeting body naming a project → meeting→project mentions edge', async () => {
    // project is linkable under gbrain-shake; meeting is NOT a target but IS
    // walked as a source (its body is scanned).
    await seedPage('initiatives/mosaic-platform', 'project', 'The Mosaic Platform initiative.', {}, 'Mosaic Platform');
    await seedPage(
      'meetings/2026-04-03',
      'meeting',
      'Weekly sync. We reviewed progress on Mosaic Platform and next steps.',
    );

    const res = await runPhaseNerLink(buildCtx(engine));
    expect((res.details as Record<string, unknown>).edges_created).toBe(1);
    // The edge is FROM the meeting TO the project.
    const rows = await engine.executeRaw<{ from_slug: string; to_slug: string }>(
      `SELECT f.slug AS from_slug, t.slug AS to_slug
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE l.link_source = 'mentions'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from_slug).toBe('meetings/2026-04-03');
    expect(rows[0]!.to_slug).toBe('initiatives/mosaic-platform');
  });
});

// ─── Step 5 alias indexing: alias in a transcript links ─────────────

describe('ner_link — frontmatter alias links (Step 5 decision a)', () => {
  test('alias "mikstuck" in a transcript links to the person page', async () => {
    await seedPage('people/mike-stuck', 'person', 'Mike Stuck page.', {
      aliases: ['mikstuck'],
    }, 'Mike Stuck');
    // Body uses ONLY the alias handle, never the full title.
    await seedPage('session/handle-only', 'session', 'ping from mikstuck about the roadmap.');

    const res = await runPhaseNerLink(buildCtx(engine));
    expect((res.details as Record<string, unknown>).edges_created).toBe(1);
    expect(await mentionEdgesTo('people/mike-stuck')).toBe(1);
  });
});
