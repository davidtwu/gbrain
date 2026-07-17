// Step 1 (entity-schema-pack) — gbrain-shake pack manifest tests.
//
// The pack is a STANDALONE artifact at this step: not active, no code reads its
// `linkable`/`phases` yet (Steps 2/5/8). These tests pin the manifest SHAPE and
// the R1b corpus-coverage guard (the data-loss safety net).
//
// Pinned contracts:
//   - gbrain-shake.yaml parses + validates via parseSchemaPackManifest
//   - extends gbrain-base-v2
//   - declares person/project/meeting with correct `linkable` flags
//   - declares the real generated types base-v2 omits (session, action, brag-book)
//   - slack aliases include slack-channel; slack-channel is NOT its own type
//   - excludes deal / tweet / social-digest
//   - VC link verbs (founded/invested_in/led_round/yc_partner/advises) absent;
//     mentions/relates_to/discusses/works_at/attended kept
//   - declares discover_entities + ner_link phases
//   - keeps the *unknown*→note catch-all
//   - R1b corpus-coverage: every DISTINCT live type is covered by types+aliases

import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  parseSchemaPackManifest,
  parseYamlMini,
  type SchemaPackManifest,
} from '../src/core/schema-pack/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const baseDir = join(here, '..', 'src', 'core', 'schema-pack', 'base');

function loadPack(name: string): SchemaPackManifest {
  const p = join(baseDir, `${name}.yaml`);
  if (!existsSync(p)) throw new Error(`bundled pack not found at ${p}`);
  const raw = readFileSync(p, 'utf-8');
  return parseSchemaPackManifest(parseYamlMini(raw), { path: p });
}

/**
 * Coverage set for a pack = declared page_type NAMES ∪ all their aliases.
 * This is what the R1b pre-activation coverage TEST checks against the live
 * DISTINCT-type set. (NOTE for Step 4: the runtime `*unknown*→note` catch-all
 * only exempts NAMES, not aliases — see the pack YAML header caveat.)
 */
function coverageSet(pack: SchemaPackManifest): Set<string> {
  const s = new Set<string>();
  for (const pt of pack.page_types) {
    s.add(pt.name);
    for (const a of pt.aliases) s.add(a);
  }
  return s;
}

describe('Step 1: gbrain-shake manifest parses + validates', () => {
  test('gbrain-shake.yaml parses via parseSchemaPackManifest without error', () => {
    const pack = loadPack('gbrain-shake');
    expect(pack.name).toBe('gbrain-shake');
    expect(pack.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pack.api_version).toBe('gbrain-schema-pack-v1');
  });

  test('extends gbrain-base-v2', () => {
    const pack = loadPack('gbrain-shake');
    expect(pack.extends).toBe('gbrain-base-v2');
  });
});

describe('Step 1: entity types + linkable flags (R1)', () => {
  const pack = loadPack('gbrain-shake');
  const byName = Object.fromEntries(pack.page_types.map((p) => [p.name, p]));

  test('declares person (linkable: true, expert_routing: true)', () => {
    expect(byName.person).toBeDefined();
    expect(byName.person.primitive).toBe('entity');
    expect(byName.person.linkable).toBe(true);
    expect(byName.person.expert_routing).toBe(true);
  });

  test('declares project (linkable: true)', () => {
    expect(byName.project).toBeDefined();
    expect(byName.project.linkable).toBe(true);
  });

  test('declares meeting (linkable: false — source-only, keeps attended edge)', () => {
    expect(byName.meeting).toBeDefined();
    expect(byName.meeting.primitive).toBe('temporal');
    expect(byName.meeting.linkable).toBe(false);
  });
});

describe('Step 1: real generated types base-v2 omits (R1b.1)', () => {
  const pack = loadPack('gbrain-shake');
  const names = new Set(pack.page_types.map((p) => p.name));

  test('declares session / action / brag-book', () => {
    expect(names.has('session')).toBe(true);
    expect(names.has('action')).toBe(true);
    expect(names.has('brag-book')).toBe(true);
  });
});

describe('Step 1: slack typing (R1b.2)', () => {
  const pack = loadPack('gbrain-shake');
  const byName = Object.fromEntries(pack.page_types.map((p) => [p.name, p]));

  test('slack declares slack-channel as an alias', () => {
    expect(byName.slack).toBeDefined();
    expect(byName.slack.aliases).toContain('slack-channel');
  });

  test('slack-channel is an alias of slack, NOT its own page type (Q7 ruling)', () => {
    expect(byName['slack-channel']).toBeUndefined();
  });
});

describe('Step 1: dropped VC/social types (R1b.3)', () => {
  const pack = loadPack('gbrain-shake');
  const names = new Set(pack.page_types.map((p) => p.name));

  test('does NOT declare deal / tweet / social-digest', () => {
    expect(names.has('deal')).toBe(false);
    expect(names.has('tweet')).toBe(false);
    expect(names.has('social-digest')).toBe(false);
  });
});

describe('Step 1: link verbs (R1b.6)', () => {
  const pack = loadPack('gbrain-shake');
  const verbs = new Set(pack.link_types.map((l) => l.name));

  test('keeps mentions / relates_to / discusses / works_at / attended', () => {
    for (const v of ['mentions', 'relates_to', 'discusses', 'works_at', 'attended']) {
      expect(verbs.has(v)).toBe(true);
    }
  });

  test('drops the VC verbs (founded / invested_in / led_round / yc_partner / advises)', () => {
    for (const v of ['founded', 'invested_in', 'led_round', 'yc_partner', 'advises']) {
      expect(verbs.has(v)).toBe(false);
    }
  });
});

describe('Step 1: cycle phase declaration (R1.4)', () => {
  const pack = loadPack('gbrain-shake');

  test('declares discover_entities + ner_link (inert until Steps 5/8)', () => {
    expect(pack.phases).toBeDefined();
    expect(pack.phases).toContain('discover_entities');
    expect(pack.phases).toContain('ner_link');
  });
});

describe('Step 1: catch-all safety net (R1b.5)', () => {
  const pack = loadPack('gbrain-shake');

  test('keeps the *unknown*→note retype rule, LAST', () => {
    const rules = pack.mapping_rules ?? [];
    expect(rules.length).toBeGreaterThan(0);
    const last = rules[rules.length - 1];
    expect(last.kind).toBe('retype');
    expect((last as { from_type: string }).from_type).toBe('*unknown*');
    expect((last as { to_type: string }).to_type).toBe('note');
  });
});

describe('Step 1: R1b corpus-coverage guard (the data-loss fixture)', () => {
  const pack = loadPack('gbrain-shake');
  const covered = coverageSet(pack);

  // Live DISTINCT `pages.type` set (fixture representative of the 4,282-page
  // brain). Every one MUST be covered by pack types+aliases or the catch-all
  // would flatten it to `note`.
  const LIVE_DISTINCT_TYPES = [
    'session',
    'email',
    'concept',
    'note',
    'slack-channel',
    'action',
    'brag-book',
    'reference',
    'extract_receipt',
    'vault-cleanup',
    'person',
    'project',
    'meeting',
  ];

  test('every live DISTINCT type is covered by pack types+aliases (0 uncovered)', () => {
    const uncovered = LIVE_DISTINCT_TYPES.filter((t) => !covered.has(t));
    // Prints the covered-vs-corpus diff on failure (the demo artifact).
    expect(uncovered).toEqual([]);
  });

  test('reference / extract_receipt / vault-cleanup declared as NAMES (not alias-only)', () => {
    // Design choice: these low-count system/import types are declared as their
    // own page_types so the names-only runtime catch-all cannot flatten them.
    const names = new Set(pack.page_types.map((p) => p.name));
    expect(names.has('reference')).toBe(true);
    expect(names.has('extract_receipt')).toBe(true);
    expect(names.has('vault-cleanup')).toBe(true);
  });
});
