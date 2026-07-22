// FORK-LOCAL (davidtwu) — tests for the reader core (Step 4, WINDOW MODE).
// Builds a hermetic temp fixture tree (mkdtemp) covering all 4 physical sources —
// ALL synthetic, NO real session content — and points the reader at it via the
// `RawReadSources` path-override / DI seam so it NEVER reads the user's real sessions.
// Fixture-building mirrors claude-jsonl.test.ts (jsonl lines) + kiro-sqlite.test.ts
// (temp sqlite rows).

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRawTranscripts,
  type RawReadSources,
} from '../../src/core/local-ops/session-transcripts.ts';
import { readKiroSqlite, type KiroReadOpts } from '../../src/core/local-ops/kiro-sqlite.ts';
import type { RawTranscript } from '../../src/core/local-ops/types.ts';

let root: string;
let claudeCodeDir: string;
let claudeRemoteDir: string;
let kiroLocalDb: string;
let kiroRemoteDb: string;

// A base time; every fixture is offset a few seconds back from it so all sit well
// inside any window >= 1 day and get distinct, well-ordered mtimes/updated_at.
const NOW = Date.now();
const secondsAgo = (s: number) => NOW - s * 1000;

// Distinct offsets → a deterministic newest-first order across lanes:
//   A (1s) > kiro-local (2s) > claude-remote (3s) > meshclaw (4s) > B (5s) > kiro-remote-plain (6s)
const T_A = secondsAgo(1);
const T_KIRO_LOCAL = secondsAgo(2);
const T_CLAUDE_REMOTE = secondsAgo(3);
const T_MESHCLAW = secondsAgo(4);
const T_B = secondsAgo(5);
const T_KIRO_REMOTE = secondsAgo(6);

// A long assistant text used to exercise the maxChars cap on one claude file.
const BIG_TEXT = 'x'.repeat(2000);

function claudeJsonl(userText: string, assistantText: string, ts: string): string {
  return (
    [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: userText },
        timestamp: ts,
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'thinking about it' },
            { type: 'text', text: assistantText },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
        timestamp: ts,
      }),
    ].join('\n') + '\n'
  );
}

// Kiro blob mirroring kiro-sqlite.test.ts (text tier prefers `transcript`; full tier
// recovers tool detail from `history`).
function kiroBlob(cid: string): string {
  return JSON.stringify({
    conversation_id: cid,
    transcript: ['**user:** q', '**assistant:** a'],
    history: [
      {
        user: { content: { Prompt: { prompt: 'do it' } } },
        assistant: {
          ToolUse: {
            content: 'working',
            thinking: 'hmm',
            tool_uses: [{ id: 't1', name: 'execute_bash', args: { command: 'bun test' } }],
          },
        },
      },
      {
        user: {
          content: {
            ToolUseResults: {
              tool_use_results: [{ tool_use_id: 't1', content: [{ Text: 'ok' }], status: 'Success' }],
            },
          },
        },
        assistant: { Response: { content: 'done' } },
      },
    ],
  });
}

function makeKiroDb(path: string, rows: Array<{ key: string; cid: string; updated: number }>) {
  const db = new Database(path); // writable ONLY to build the fixture
  db.run(`CREATE TABLE conversations_v2 (
    key TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (key, conversation_id)
  )`);
  const ins = db.prepare(
    'INSERT INTO conversations_v2 (key, conversation_id, value, created_at, updated_at) VALUES (?,?,?,?,?)',
  );
  for (const r of rows) ins.run(r.key, r.cid, kiroBlob(r.cid), r.updated - 5000, r.updated);
  db.close();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-reader-test-'));
  claudeCodeDir = join(root, 'claude-projects');
  claudeRemoteDir = join(root, 'claude-remote');
  // Nest each claude file under a project subdir to exercise the recursive walk +
  // the parent-dir → project inference.
  const projA = join(claudeCodeDir, 'proj-alpha');
  const projB = join(claudeCodeDir, 'proj-beta');
  const projR = join(claudeRemoteDir, 'proj-remote');
  mkdirSync(projA, { recursive: true });
  mkdirSync(projB, { recursive: true });
  mkdirSync(projR, { recursive: true });

  const fileA = join(projA, 'sess-aaaa1111.jsonl');
  const fileB = join(projB, 'sess-bbbb2222.jsonl');
  const fileR = join(projR, 'sess-rrrr3333.jsonl');
  writeFileSync(fileA, claudeJsonl('hi A', 'reply A', new Date(T_A).toISOString()));
  writeFileSync(fileB, claudeJsonl('hi B', BIG_TEXT, new Date(T_B).toISOString()));
  writeFileSync(fileR, claudeJsonl('hi R', 'reply R', new Date(T_CLAUDE_REMOTE).toISOString()));

  // Set mtimes (utimesSync takes seconds). atime == mtime is fine.
  utimesSync(fileA, T_A / 1000, T_A / 1000);
  utimesSync(fileB, T_B / 1000, T_B / 1000);
  utimesSync(fileR, T_CLAUDE_REMOTE / 1000, T_CLAUDE_REMOTE / 1000);

  // A stray non-.jsonl file must be ignored by the walk.
  writeFileSync(join(projA, 'notes.txt'), 'ignore me');

  // kiro-local: its own db, one row.
  kiroLocalDb = join(root, 'kiro-local.sqlite3');
  makeKiroDb(kiroLocalDb, [
    { key: '/home/u/workplace/local-proj', cid: 'conv-local-0001', updated: T_KIRO_LOCAL },
  ]);

  // kiro-remote: ONE db → two lanes. One meshclaw-keyed row, one ordinary row.
  kiroRemoteDb = join(root, 'kiro-remote.sqlite3');
  makeKiroDb(kiroRemoteDb, [
    { key: '/home/u/workplace/meshclaw-agent', cid: 'conv-meshclaw-0002', updated: T_MESHCLAW },
    { key: '/home/u/workplace/interactive', cid: 'conv-kiro-remote-0003', updated: T_KIRO_REMOTE },
  ]);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Build a fresh sources bag; `readKiro` optionally overridden (for the single-open spy). */
function sources(
  readKiro?: (dbPath: string, opts: KiroReadOpts) => RawTranscript[],
): RawReadSources {
  return { claudeCodeDir, claudeRemoteDir, kiroLocalDb, kiroRemoteDb, readKiro };
}

describe('readRawTranscripts — window mode', () => {
  test('merges all lanes newest-first by mtime/date', async () => {
    const rows = await readRawTranscripts({ days: 30, fidelity: 'text' }, sources());
    expect(rows.map((r) => r.id)).toEqual([
      'sess-aaaa1111', // T_A (1s)
      'conv-local-0001', // T_KIRO_LOCAL (2s)
      'sess-rrrr3333', // T_CLAUDE_REMOTE (3s)
      'conv-meshclaw-0002', // T_MESHCLAW (4s)
      'sess-bbbb2222', // T_B (5s)
      'conv-kiro-remote-0003', // T_KIRO_REMOTE (6s)
    ]);
    // lane stamping + project inference (claude: parent dir; kiro: key tail).
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('sess-aaaa1111')!.lane).toBe('claude-code');
    expect(byId.get('sess-aaaa1111')!.project).toBe('proj-alpha');
    expect(byId.get('sess-rrrr3333')!.lane).toBe('claude-remote');
    expect(byId.get('conv-local-0001')!.lane).toBe('kiro-local');
    expect(byId.get('conv-meshclaw-0002')!.lane).toBe('meshclaw-remote');
    expect(byId.get('conv-kiro-remote-0003')!.lane).toBe('kiro-remote');
  });

  test('limit is respected (newest N)', async () => {
    const rows = await readRawTranscripts({ days: 30, limit: 3 }, sources());
    expect(rows.map((r) => r.id)).toEqual([
      'sess-aaaa1111',
      'conv-local-0001',
      'sess-rrrr3333',
    ]);
  });

  test('lanes filter selects only requested lanes', async () => {
    const rows = await readRawTranscripts(
      { days: 30, lanes: ['claude-code', 'kiro-local'] },
      sources(),
    );
    expect(new Set(rows.map((r) => r.lane))).toEqual(new Set(['claude-code', 'kiro-local']));
    expect(rows.map((r) => r.id).sort()).toEqual(
      ['conv-local-0001', 'sess-aaaa1111', 'sess-bbbb2222'].sort(),
    );
  });

  test('both remote-kiro lanes requested → remote db opened exactly ONCE, rows split', async () => {
    // Wrap the real reader with a per-path counter to PROVE single-open.
    const opens: Record<string, number> = {};
    const spy = (dbPath: string, opts: KiroReadOpts): RawTranscript[] => {
      opens[dbPath] = (opens[dbPath] ?? 0) + 1;
      return readKiroSqlite(dbPath, opts);
    };
    const rows = await readRawTranscripts(
      { days: 30, lanes: ['kiro-remote', 'meshclaw-remote'], fidelity: 'full' },
      sources(spy),
    );
    // The remote db was opened exactly once even though two lanes were requested.
    expect(opens[kiroRemoteDb]).toBe(1);
    // kiro-local db was NOT touched (not requested).
    expect(opens[kiroLocalDb]).toBeUndefined();
    // Rows split to the correct lanes.
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('conv-meshclaw-0002')!.lane).toBe('meshclaw-remote');
    expect(byId.get('conv-kiro-remote-0003')!.lane).toBe('kiro-remote');
    expect(rows.length).toBe(2);
  });

  test('requesting only one remote-kiro lane still opens once and filters out the other', async () => {
    const opens: Record<string, number> = {};
    const spy = (dbPath: string, opts: KiroReadOpts): RawTranscript[] => {
      opens[dbPath] = (opens[dbPath] ?? 0) + 1;
      return readKiroSqlite(dbPath, opts);
    };
    const rows = await readRawTranscripts(
      { days: 30, lanes: ['meshclaw-remote'] },
      sources(spy),
    );
    expect(opens[kiroRemoteDb]).toBe(1);
    expect(rows.map((r) => r.id)).toEqual(['conv-meshclaw-0002']);
  });

  test('fidelity flows through: full → segments present, no text', async () => {
    const rows = await readRawTranscripts(
      { days: 30, lanes: ['claude-code'], fidelity: 'full' },
      sources(),
    );
    const a = rows.find((r) => r.id === 'sess-aaaa1111')!;
    expect(a.segments).toBeDefined();
    expect(a.text).toBeUndefined();
    // full markdown inlines the tool_use fenced block.
    expect(a.markdown).toContain('```tool_use Bash');
    expect(a.segments!.some((s) => s.kind === 'tool_use')).toBe(true);
  });

  test('fidelity flows through: text → text present, no segments', async () => {
    const rows = await readRawTranscripts(
      { days: 30, lanes: ['claude-code'], fidelity: 'text' },
      sources(),
    );
    const a = rows.find((r) => r.id === 'sess-aaaa1111')!;
    expect(a.text).toBeDefined();
    expect(a.segments).toBeUndefined();
    expect(a.markdown).toContain('**assistant:** reply A');
  });

  test('maxChars cap reflected via truncated flag on the oversized fixture', async () => {
    // Oversized fixture (fileB carries BIG_TEXT). A small cap truncates it.
    const capped = await readRawTranscripts(
      { days: 30, lanes: ['claude-code'], fidelity: 'text', maxChars: 50 },
      sources(),
    );
    const bCapped = capped.find((r) => r.id === 'sess-bbbb2222')!;
    expect(bCapped.truncated).toBe(true);
    expect(bCapped.omittedChars).toBeGreaterThan(0);
    expect(bCapped.markdown.length).toBe(50);

    // With the default (uncapped-for-full / 500k-for-text) it is NOT truncated.
    const uncapped = await readRawTranscripts(
      { days: 30, lanes: ['claude-code'], fidelity: 'text' },
      sources(),
    );
    const bUncapped = uncapped.find((r) => r.id === 'sess-bbbb2222')!;
    expect(bUncapped.truncated).toBe(false);
    expect(bUncapped.omittedChars).toBe(0);
  });

  test('missing lane dir/db is skipped (no throw) — other lanes still returned', async () => {
    const bad: RawReadSources = {
      claudeCodeDir,
      claudeRemoteDir: join(root, 'does-not-exist'),
      kiroLocalDb: join(root, 'nope.sqlite3'),
      kiroRemoteDb,
    };
    const rows = await readRawTranscripts({ days: 30 }, bad);
    // claude-code + the remote kiro lanes still come back; the two missing sources drop.
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('sess-aaaa1111');
    expect(ids).toContain('conv-meshclaw-0002');
    expect(ids).not.toContain('conv-local-0001');
    expect(ids).not.toContain('sess-rrrr3333');
  });
});
