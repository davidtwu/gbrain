// Step 2 (entity-schema-pack) — pack-aware linkable types (R4 / TODO-1).
//
// Pins the Step-2 rewire: buildGazetteer + buildTargetTypeMap resolve their
// gazetteer LINK-TARGET type set from the ACTIVE pack (via linkableTypesFromPack)
// instead of the hardcoded LINKABLE_ENTITY_TYPES const.
//
// New test file (not editing schema-pack-gbrain-shake.test.ts) per Step 2 task.
//
// Pinned contracts:
//   - linkableTypesFromManifest(gbrain-shake) → {person, project} (meeting is
//     linkable:false; NOT a target).
//   - linkableTypesFromManifest(gbrain-base-v2) → the legacy const
//     {person, company, organization, entity} — BASE PARITY (the critical one).
//     base-v2 does NOT adopt the `linkable` flag, so the helper falls back to
//     the const, preserving pre-Step-2 gazetteer behavior byte-for-byte.
//   - const fallback when a manifest carries no `linkable` flags at all.
//   - Integration: a project-typed page IS a gazetteer target under shake,
//     NOT under base-v2.
//   - Regression: the base-v2 gazetteer target set is byte-for-byte the old const.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildGazetteer } from '../src/core/by-mention.ts';
import {
  parseSchemaPackManifest,
  parseYamlMini,
  type SchemaPackManifest,
} from '../src/core/schema-pack/index.ts';
import {
  linkableTypesFromManifest,
  LINKABLE_ENTITY_TYPES,
} from '../src/core/schema-pack/linkable-types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const baseDir = join(here, '..', 'src', 'core', 'schema-pack', 'base');

function loadPack(name: string): SchemaPackManifest {
  const p = join(baseDir, `${name}.yaml`);
  if (!existsSync(p)) throw new Error(`bundled pack not found at ${p}`);
  return parseSchemaPackManifest(parseYamlMini(readFileSync(p, 'utf-8')), { path: p });
}

// ============================================================
// linkableTypesFromManifest — pure manifest resolution
// ============================================================

describe('linkableTypesFromManifest — pure', () => {
  test('gbrain-shake → {person, project} (meeting linkable:false excluded)', () => {
    const types = linkableTypesFromManifest(loadPack('gbrain-shake'));
    expect(types).toContain('person');
    expect(types).toContain('project');
    expect(types).not.toContain('meeting');
    // Exactly the two adopted-true types.
    expect(new Set(types)).toEqual(new Set(['person', 'project']));
  });

  test('gbrain-base-v2 → legacy const (BASE PARITY) — pack has no linkable flags', () => {
    const pack = loadPack('gbrain-base-v2');
    // Pre-condition: base-v2 does NOT adopt the linkable flag anywhere.
    expect(pack.page_types.every(pt => pt.linkable === undefined)).toBe(true);
    // Therefore the helper returns the legacy 4-type const, byte-for-byte.
    expect(linkableTypesFromManifest(pack)).toEqual([...LINKABLE_ENTITY_TYPES]);
  });

  test('gbrain-base → legacy const (BASE PARITY) — pack has no linkable flags', () => {
    const pack = loadPack('gbrain-base');
    expect(pack.page_types.every(pt => pt.linkable === undefined)).toBe(true);
    expect(linkableTypesFromManifest(pack)).toEqual([...LINKABLE_ENTITY_TYPES]);
  });

  test('const fallback: a manifest with zero linkable flags → legacy const', () => {
    const fake: Pick<SchemaPackManifest, 'page_types'> = {
      page_types: [
        { name: 'note', primitive: 'concept', path_prefixes: [], aliases: [], extractable: false, expert_routing: false } as any,
        { name: 'person', primitive: 'entity', path_prefixes: [], aliases: [], extractable: false, expert_routing: false } as any,
      ],
    };
    expect(linkableTypesFromManifest(fake)).toEqual([...LINKABLE_ENTITY_TYPES]);
  });

  test('adopted-but-all-false → empty (empty-filter contract, NOT re-widen to const)', () => {
    const fake: Pick<SchemaPackManifest, 'page_types'> = {
      page_types: [
        { name: 'note', primitive: 'concept', path_prefixes: [], aliases: [], extractable: false, expert_routing: false, linkable: false } as any,
      ],
    };
    expect(linkableTypesFromManifest(fake)).toEqual([]);
  });

  test('declaration order preserved', () => {
    const fake: Pick<SchemaPackManifest, 'page_types'> = {
      page_types: [
        { name: 'project', primitive: 'concept', path_prefixes: [], aliases: [], extractable: false, expert_routing: false, linkable: true } as any,
        { name: 'note', primitive: 'concept', path_prefixes: [], aliases: [], extractable: false, expert_routing: false, linkable: false } as any,
        { name: 'person', primitive: 'entity', path_prefixes: [], aliases: [], extractable: false, expert_routing: false, linkable: true } as any,
      ],
    };
    expect(linkableTypesFromManifest(fake)).toEqual(['project', 'person']);
  });
});

// ============================================================
// buildGazetteer — engine integration under different active packs
// ============================================================

describe('buildGazetteer — pack-aware target types', () => {
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
    await engine.executeRaw('DELETE FROM links');
    await engine.executeRaw('DELETE FROM pages');
  });

  async function seedPersonAndProject() {
    await engine.putPage('people/mike-stuck', {
      type: 'person', title: 'Mike Stuck', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    await engine.putPage('initiatives/mosaic-platform', {
      type: 'project' as any, title: 'Mosaic Platform', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
  }

  test('under gbrain-shake: project page IS a gazetteer target', async () => {
    process.env.GBRAIN_SCHEMA_PACK = 'gbrain-shake';
    await seedPersonAndProject();
    const g = await buildGazetteer(engine);
    expect(g.has('mike')).toBe(true);    // person → target
    expect(g.has('mosaic')).toBe(true);  // project → target under shake
  });

  test('under gbrain-base-v2: project page is NOT a gazetteer target', async () => {
    process.env.GBRAIN_SCHEMA_PACK = 'gbrain-base-v2';
    await seedPersonAndProject();
    const g = await buildGazetteer(engine);
    expect(g.has('mike')).toBe(true);     // person still a target
    expect(g.has('mosaic')).toBe(false);  // project NOT linkable under base-v2
  });

  test('BASE PARITY regression: base-v2 gazetteer target set == old const set', async () => {
    // Seed one page of every type in the legacy const + a project + a note.
    // The gazetteer under base-v2 must include EXACTLY the const-typed pages
    // (person/company; organization/entity have no pages here but the SQL
    // filter is the const), and MUST NOT include project or note.
    process.env.GBRAIN_SCHEMA_PACK = 'gbrain-base-v2';
    await engine.putPage('people/alice-example', {
      type: 'person', title: 'Alice Example', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    await engine.putPage('companies/widget-co', {
      type: 'company', title: 'Widget Corp', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    await engine.putPage('initiatives/some-project', {
      type: 'project' as any, title: 'Some Project', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    await engine.putPage('notes/random-note', {
      type: 'note' as any, title: 'Random Note', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    const g = await buildGazetteer(engine);
    // Gather the set of target slugs the gazetteer produced.
    const slugs = new Set<string>();
    for (const bucket of g.values()) for (const e of bucket) slugs.add(e.slug);
    expect(slugs.has('people/alice-example')).toBe(true);   // person: const
    expect(slugs.has('companies/widget-co')).toBe(true);    // company: const
    expect(slugs.has('initiatives/some-project')).toBe(false); // project: NOT const
    expect(slugs.has('notes/random-note')).toBe(false);     // note: NOT const
  });
});
