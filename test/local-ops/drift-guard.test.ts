// FORK-LOCAL (davidtwu) — DRIFT GUARD (Step 7, design §7 / R7).
//
// THE ORIGINAL BUG: two transcript readers diverged on file EXTENSION. The upstream reader
// (src/core/cycle/transcript-discovery.ts:listTextFiles, and src/core/transcripts.ts) walks
// for `.md`/`.txt`; our fork reader (src/core/local-ops/session-transcripts.ts:listJsonlFiles)
// walks for `.jsonl` (the Claude session extension). Because we COPIED the ~30-line walk into
// local-ops (to keep the upstream file untouched — merge-clean, research/07) rather than
// importing it, the two can silently diverge again. This test pins the fork walk's contract:
//   - it FINDS nested `.jsonl` (recursive),
//   - it IGNORES `.md` and `.txt` (the upstream `discoverTranscripts` intent — those belong
//     to the OTHER reader; if this walk started matching them the two readers would collide),
//   - it PRUNES vendor/build dirs (node_modules, .git, dist) at descent time.
//
// If someone edits listJsonlFiles to accept `.md`/`.txt` (re-introducing the divergence
// class) or drops the prune, this fails. The comment above ties it to the upstream
// `discoverTranscripts` (.md/.txt) intent so the divergence class stays VISIBLE.
//
// Design ref: detailed-design.md §4.1 (file walk, copied+drift-noted), §7 (drift guard);
// research/07-merge-clean-strategy.md ("Shared file-walk — avoid re-introducing the drift").

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { listJsonlFiles } from '../../src/core/local-ops/session-transcripts.ts';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-drift-'));
  // A nested tree covering every case the guard cares about.
  const proj = join(root, 'projA');
  const nested = join(proj, 'sub', 'deeper'); // recursion depth > 1
  mkdirSync(nested, { recursive: true });

  // .jsonl files at multiple depths — MUST be found.
  writeFileSync(join(proj, 'top.jsonl'), '{}\n');
  writeFileSync(join(nested, 'deep.jsonl'), '{}\n');

  // .md and .txt siblings — MUST be IGNORED (they belong to the upstream .md/.txt reader).
  writeFileSync(join(proj, 'notes.md'), '# notes\n');
  writeFileSync(join(proj, 'log.txt'), 'log\n');
  writeFileSync(join(nested, 'readme.md'), '# deep notes\n');

  // Pruned dirs — a .jsonl inside these MUST NOT be found.
  const nodeModules = join(proj, 'node_modules', 'pkg');
  const gitDir = join(proj, '.git', 'objects');
  const distDir = join(proj, 'dist');
  mkdirSync(nodeModules, { recursive: true });
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(nodeModules, 'ignored.jsonl'), '{}\n');
  writeFileSync(join(gitDir, 'ignored.jsonl'), '{}\n');
  writeFileSync(join(distDir, 'ignored.jsonl'), '{}\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('drift-guard — listJsonlFiles walk contract (the .jsonl vs .md/.txt divergence class)', () => {
  test('finds nested .jsonl recursively', () => {
    const found = listJsonlFiles(root).map((p) => basename(p));
    expect(found).toContain('top.jsonl'); // depth 1
    expect(found).toContain('deep.jsonl'); // depth 3 (recursive)
  });

  test('IGNORES .md and .txt (upstream discoverTranscripts owns those extensions)', () => {
    const found = listJsonlFiles(root).map((p) => basename(p));
    expect(found).not.toContain('notes.md');
    expect(found).not.toContain('log.txt');
    expect(found).not.toContain('readme.md');
    // Every result ends in .jsonl — no other extension leaks through.
    for (const f of found) expect(f.endsWith('.jsonl')).toBe(true);
  });

  test('PRUNES node_modules / .git / dist (no .jsonl leaks from vendor/build trees)', () => {
    const found = listJsonlFiles(root);
    // The three ignored.jsonl files all live under pruned dirs — none should appear.
    expect(found.some((p) => p.includes('/node_modules/'))).toBe(false);
    expect(found.some((p) => p.includes('/.git/'))).toBe(false);
    expect(found.some((p) => p.includes('/dist/'))).toBe(false);
    // Exactly the 2 real .jsonl files, nothing else.
    expect(found.filter((p) => p.endsWith('.jsonl')).length).toBe(2);
  });

  test('missing dir → empty (no throw); the caller turns absence into a warning', () => {
    expect(listJsonlFiles(join(root, 'does-not-exist'))).toEqual([]);
  });
});
