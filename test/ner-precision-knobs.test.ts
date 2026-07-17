/**
 * NER precision knobs (R5 / Step 6) — config-driven allow/ignore/first-name.
 *
 * Ephemeral PGLite. Covers the design §7.3 matrix:
 *   - allow_list forces a short handle ("F2") through the MIN_NAME_LENGTH=4 floor.
 *   - ignore_list suppresses a bare ambiguous token ("returns") UNLESS the page
 *     title is an exact/multi-word match (e.g. "Returns Signal").
 *   - reject_first_names blocks a bare first-name "Mike" but allows the
 *     multi-token "Mike Stuck" AND the "mikstuck" alias (Step 5 interaction).
 *   - malformed-config fallback: bad JSON → defaults + warn, guard stays on.
 *
 * Knob resolution is exercised both at the gazetteer/matcher unit layer
 * (buildGazetteer + findMentionedEntities with injected knobs) and through
 * loadNerKnobs reading the DB config plane, and end-to-end via runPhaseNerLink
 * which reads config itself.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  buildGazetteer,
  findMentionedEntities,
  loadNerKnobs,
  defaultNerKnobs,
  __resetNerKnobWarnings,
  NER_ALLOW_LIST_KEY,
  NER_IGNORE_LIST_KEY,
  NER_REJECT_FIRST_NAMES_KEY,
  type NerKnobs,
} from '../src/core/by-mention.ts';
import { runPhaseNerLink } from '../src/core/cycle/ner-link.ts';
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
    engine: eng, config: config as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false, remote: false, sourceId: 'default',
  } as OperationContext;
}

async function seedPage(slug: string, type: string, body: string, fm: Record<string, unknown> = {}, title?: string): Promise<void> {
  await engine.putPage(slug, { type: type as never, title: title ?? slug, compiled_truth: body, timeline: '', frontmatter: fm });
}

async function mentionEdgesTo(targetSlug: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*) AS n FROM links l JOIN pages t ON t.id = l.to_page_id
      WHERE t.slug = $1 AND l.link_source = 'mentions'`, [targetSlug]);
  return Number(rows[0]?.n ?? 0);
}

// ─── R5.1 allow_list ────────────────────────────────────────────────

describe('allow_list — short handle below MIN_NAME_LENGTH', () => {
  test('"F2" (2 chars) is NOT a gazetteer key by default but IS with allow_list', async () => {
    await seedPage('projects/f2', 'project', 'The F2 program.', {}, 'F2');

    const gDefault = await buildGazetteer(engine, { knobs: defaultNerKnobs() });
    // Default allow list already includes "F2" per DEFAULT_NER_ALLOW_LIST.
    expect(gDefault.has('f2')).toBe(true);

    // With F2 removed from the allow list, the 2-char handle is dropped.
    const knobsNoF2: NerKnobs = { ...defaultNerKnobs(), allowList: [] };
    const gNoAllow = await buildGazetteer(engine, { knobs: knobsNoF2 });
    expect(gNoAllow.has('f2')).toBe(false);
  });

  test('end-to-end: allow_list config lets a transcript link to "F2"', async () => {
    await seedPage('projects/f2', 'project', 'F2 project page.', {}, 'F2');
    await seedPage('session/s1', 'session', 'We shipped the F2 launch this week.');

    await engine.setConfig(NER_ALLOW_LIST_KEY, JSON.stringify(['F2', 'Cue']));
    const res = await runPhaseNerLink(buildCtx(engine));
    expect((res.details as Record<string, unknown>).edges_created).toBe(1);
    expect(await mentionEdgesTo('projects/f2')).toBe(1);
  });
});

// ─── R5.2 ignore_list ───────────────────────────────────────────────

describe('ignore_list — ambiguous domain word suppressed unless exact/multi-word', () => {
  test('bare "returns" title suppressed; "Returns Signal" multi-word links', async () => {
    // A project literally titled "returns" (the ambiguous common word) is
    // suppressed as a bare single-token match.
    await seedPage('projects/returns', 'project', 'A project.', {}, 'returns');
    // A project titled "Returns Signal" is the exact/multi-word exception.
    await seedPage('projects/returns-signal', 'project', 'A project.', {}, 'Returns Signal');

    const g = await buildGazetteer(engine, { knobs: defaultNerKnobs() });
    const bucket = g.get('returns') ?? [];
    const slugs = bucket.map(e => e.slug);
    // Bare "returns" title dropped; the multi-word phrase indexed.
    expect(slugs).not.toContain('projects/returns');
    expect(slugs).toContain('projects/returns-signal');

    // Body with a bare "returns" does NOT link; a "Returns Signal" phrase does.
    const bare = findMentionedEntities('We discussed returns policy.', g, {
      fromSlug: 'session/x', fromSourceId: 'default',
    });
    expect(bare).toHaveLength(0);
    const phrase = findMentionedEntities('The Returns Signal work is on track.', g, {
      fromSlug: 'session/x', fromSourceId: 'default',
    });
    expect(phrase.map(m => m.slug)).toContain('projects/returns-signal');
  });
});

// ─── R5.3 reject_first_names ─────────────────────────────────────────

describe('reject_first_names — bare first name blocked, full name + alias allowed', () => {
  test('matcher rejects bare "Mike" (person title) but allows "Mike Stuck" + alias', async () => {
    await seedPage('people/mike-stuck', 'person', 'Mike Stuck page.', { aliases: ['mikstuck'] }, 'Mike Stuck');
    // Also seed a person whose TITLE is a bare first name to prove the rule
    // targets single-token person titles.
    await seedPage('people/mike-solo', 'person', 'Just Mike.', {}, 'Mike');

    const g = await buildGazetteer(engine, { knobs: defaultNerKnobs() });

    // Bare "Mike" in body → rejected when reject_first_names on.
    const bare = findMentionedEntities('Then Mike spoke up.', g, {
      fromSlug: 'session/x', fromSourceId: 'default', rejectFirstNames: true,
    });
    expect(bare).toHaveLength(0);

    // "Mike Stuck" multi-word title → allowed.
    const full = findMentionedEntities('Mike Stuck presented.', g, {
      fromSlug: 'session/x', fromSourceId: 'default', rejectFirstNames: true,
    });
    expect(full.map(m => m.slug)).toContain('people/mike-stuck');

    // "mikstuck" alias → allowed even though single-token (alias is deliberate).
    const alias = findMentionedEntities('ping from mikstuck.', g, {
      fromSlug: 'session/x', fromSourceId: 'default', rejectFirstNames: true,
    });
    expect(alias.map(m => m.slug)).toContain('people/mike-stuck');

    // Sanity: with the knob OFF, bare "Mike" would link.
    const bareOff = findMentionedEntities('Then Mike spoke up.', g, {
      fromSlug: 'session/x', fromSourceId: 'default', rejectFirstNames: false,
    });
    expect(bareOff.length).toBeGreaterThan(0);
  });

  test('end-to-end: default config (reject on) links "Mike Stuck"+alias, not bare "Mike"', async () => {
    await seedPage('people/mike-stuck', 'person', 'Mike Stuck page.', { aliases: ['mikstuck'] }, 'Mike Stuck');
    await seedPage('session/full', 'session', 'Mike Stuck ran the review.');
    await seedPage('session/alias', 'session', 'note from mikstuck about scope.');
    await seedPage('session/bare', 'session', 'Then Mike said hello.');

    // reject_first_names defaults to true (no config set).
    const res = await runPhaseNerLink(buildCtx(engine));
    // full + alias = 2 edges; bare "Mike" alone in session/bare must NOT link.
    expect(await mentionEdgesTo('people/mike-stuck')).toBe(2);
    expect((res.details as Record<string, unknown>).reject_first_names).toBe(true);
  });
});

// ─── loadNerKnobs + malformed-config fallback ───────────────────────

describe('loadNerKnobs — config plane + malformed fallback', () => {
  test('reads valid config values', async () => {
    await engine.setConfig(NER_ALLOW_LIST_KEY, JSON.stringify(['Zed']));
    await engine.setConfig(NER_IGNORE_LIST_KEY, JSON.stringify(['foo', 'bar']));
    await engine.setConfig(NER_REJECT_FIRST_NAMES_KEY, 'false');

    const knobs = await loadNerKnobs(engine);
    expect(knobs.allowList).toEqual(['Zed']);
    expect(knobs.ignoreList).toEqual(['foo', 'bar']);
    expect(knobs.rejectFirstNames).toBe(false);
  });

  test('malformed JSON → default for THAT knob + warn (never crash, guard stays on)', async () => {
    await engine.setConfig(NER_ALLOW_LIST_KEY, 'not json[');       // malformed
    await engine.setConfig(NER_IGNORE_LIST_KEY, '{"not":"array"}'); // wrong shape
    await engine.setConfig(NER_REJECT_FIRST_NAMES_KEY, 'maybe');    // bad bool

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (m?: unknown) => { warnings.push(String(m)); };
    try {
      const knobs = await loadNerKnobs(engine);
      // All three fall back to defaults — guard NOT silently disabled.
      const d = defaultNerKnobs();
      expect(knobs.allowList).toEqual(d.allowList);
      expect(knobs.ignoreList).toEqual(d.ignoreList);
      expect(knobs.rejectFirstNames).toBe(true); // default guard stays ENABLED
    } finally {
      console.warn = origWarn;
    }
    expect(warnings.some(w => w.includes(NER_ALLOW_LIST_KEY))).toBe(true);
    expect(warnings.some(w => w.includes(NER_IGNORE_LIST_KEY))).toBe(true);
    expect(warnings.some(w => w.includes(NER_REJECT_FIRST_NAMES_KEY))).toBe(true);
  });

  test('missing config → silent defaults (not a misconfiguration)', async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (m?: unknown) => { warnings.push(String(m)); };
    try {
      const knobs = await loadNerKnobs(engine);
      expect(knobs).toEqual(defaultNerKnobs());
    } finally {
      console.warn = origWarn;
    }
    expect(warnings).toHaveLength(0);
  });
});
