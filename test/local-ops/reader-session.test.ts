// FORK-LOCAL (davidtwu) — tests for the reader core (Step 5): session-by-id mode +
// non-silent warnings. Hermetic temp fixtures (mkdtemp) covering the physical sources —
// ALL synthetic, NO real session content — pointed at via the `RawReadSources`
// path-override / DI seam so the reader NEVER reads the user's real sessions.
// Fixture-building mirrors reader-window.test.ts (synthetic jsonl + temp sqlite).

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRawTranscripts,
  type RawReadSources,
} from '../../src/core/local-ops/session-transcripts.ts';

let root: string;
let claudeCodeDir: string;
let claudeRemoteDir: string;
let kiroLocalDb: string;
let kiroRemoteDb: string;

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
// Recent fixtures sit a few seconds back; the OLD claude fixture sits 90 days back —
// well outside the default 7-day window, so by-id must ignore the age filter to find it.
const T_RECENT = NOW - 2 * 1000;
const T_OLD = NOW - 90 * DAY_MS;

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
  root = mkdtempSync(join(tmpdir(), 'gbrain-reader-session-test-'));
  claudeCodeDir = join(root, 'claude-projects');
  claudeRemoteDir = join(root, 'claude-remote');
  const projA = join(claudeCodeDir, 'proj-alpha');
  const projR = join(claudeRemoteDir, 'proj-remote');
  mkdirSync(projA, { recursive: true });
  mkdirSync(projR, { recursive: true });

  // Recent claude-code session (inside any default window).
  const fileRecent = join(projA, 'sess-recent-1111.jsonl');
  writeFileSync(
    fileRecent,
    claudeJsonl('hi recent', 'reply recent', new Date(T_RECENT).toISOString()),
  );
  utimesSync(fileRecent, T_RECENT / 1000, T_RECENT / 1000);

  // OLD claude-code session (90d back — OUTSIDE the default 7-day window). by-id must
  // still find it because by-id bypasses the age filter.
  const fileOld = join(projA, 'sess-old-9999.jsonl');
  writeFileSync(fileOld, claudeJsonl('hi old', 'reply old', new Date(T_OLD).toISOString()));
  utimesSync(fileOld, T_OLD / 1000, T_OLD / 1000);

  // A claude-remote session (used to prove the lanes filter excludes it when not asked).
  const fileRemote = join(projR, 'sess-remote-2222.jsonl');
  writeFileSync(
    fileRemote,
    claudeJsonl('hi remote', 'reply remote', new Date(T_RECENT).toISOString()),
  );
  utimesSync(fileRemote, T_RECENT / 1000, T_RECENT / 1000);

  // kiro-local: its own db, one row.
  kiroLocalDb = join(root, 'kiro-local.sqlite3');
  makeKiroDb(kiroLocalDb, [
    { key: '/home/u/workplace/local-proj', cid: 'conv-local-0001', updated: T_RECENT },
  ]);

  // kiro-remote: ONE db → two lanes. One meshclaw-keyed row, one ordinary row.
  kiroRemoteDb = join(root, 'kiro-remote.sqlite3');
  makeKiroDb(kiroRemoteDb, [
    { key: '/home/u/workplace/meshclaw-agent', cid: 'conv-meshclaw-0002', updated: T_RECENT },
    { key: '/home/u/workplace/interactive', cid: 'conv-kiro-remote-0003', updated: T_RECENT },
  ]);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function sources(): RawReadSources {
  return { claudeCodeDir, claudeRemoteDir, kiroLocalDb, kiroRemoteDb };
}

describe('readRawTranscripts — session-by-id mode', () => {
  test('by-id returns exactly the one Claude session for a jsonl stem', async () => {
    const rows = await readRawTranscripts({ sessionId: 'sess-recent-1111' }, sources());
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe('sess-recent-1111');
    expect(rows[0]!.lane).toBe('claude-code');
    // Default by-id fidelity is 'full' — segments present, tool detail recovered.
    expect(rows[0]!.segments).toBeDefined();
    expect(rows[0]!.text).toBeUndefined();
    expect(rows[0]!.segments!.some((s) => s.kind === 'tool_use')).toBe(true);
    expect(rows[0]!.markdown).toContain('```tool_use Bash');
    // No warnings when the id is found.
    expect(rows._meta.warnings).toEqual([]);
  });

  test('by-id returns exactly the one Kiro session for a conversation_id', async () => {
    const rows = await readRawTranscripts({ sessionId: 'conv-meshclaw-0002' }, sources());
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe('conv-meshclaw-0002');
    // splitRemote keeps the correct lane for the matched remote row.
    expect(rows[0]!.lane).toBe('meshclaw-remote');
    expect(rows[0]!.segments).toBeDefined();
    expect(rows._meta.warnings).toEqual([]);
  });

  test('by-id respects an explicit opts.fidelity override (text)', async () => {
    const rows = await readRawTranscripts(
      { sessionId: 'sess-recent-1111', fidelity: 'text' },
      sources(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.text).toBeDefined();
    expect(rows[0]!.segments).toBeUndefined();
  });

  test('unknown id → empty result + a warning naming the id and searched lanes', async () => {
    const rows = await readRawTranscripts({ sessionId: 'no-such-session' }, sources());
    expect(rows.length).toBe(0);
    expect(rows._meta.warnings.length).toBe(1);
    const w = rows._meta.warnings[0]!;
    expect(w).toContain('no-such-session');
    expect(w).toContain('not found');
    // The default (all-5-lanes) search set is named in the warning.
    expect(w).toContain('claude-code');
    expect(w).toContain('meshclaw-remote');
  });

  test('by-id respects the lanes filter (only searches requested lanes)', async () => {
    // The id lives in claude-code; asking only for kiro lanes must NOT find it, and the
    // warning must name only the requested lanes.
    const rows = await readRawTranscripts(
      { sessionId: 'sess-recent-1111', lanes: ['kiro-local', 'kiro-remote'] },
      sources(),
    );
    expect(rows.length).toBe(0);
    const w = rows._meta.warnings[0]!;
    expect(w).toContain('kiro-local');
    expect(w).toContain('kiro-remote');
    expect(w).not.toContain('claude-code');
  });

  test('by-id ignores the age window — an OLD fixture is still found by id', async () => {
    // sess-old-9999 is 90 days old, far outside the default 7-day window; by-id finds it.
    const rows = await readRawTranscripts(
      { sessionId: 'sess-old-9999', lanes: ['claude-code'] },
      sources(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe('sess-old-9999');
    expect(rows._meta.warnings).toEqual([]);
  });
});

describe('readRawTranscripts — window mode missing-lane warnings (Step 5)', () => {
  test('missing mirror/dir → that lane skipped WITH a warning; other lanes still returned', async () => {
    const bad: RawReadSources = {
      claudeCodeDir, // present
      claudeRemoteDir: join(root, 'does-not-exist'), // missing dir
      kiroLocalDb: join(root, 'nope.sqlite3'), // missing db
      kiroRemoteDb, // present
    };
    const rows = await readRawTranscripts({ days: 30 }, bad);

    // Present lanes still come back.
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('sess-recent-1111');
    expect(ids).toContain('conv-meshclaw-0002');
    // Missing lanes dropped.
    expect(ids).not.toContain('conv-local-0001');
    expect(ids).not.toContain('sess-remote-2222');

    // ...but NON-SILENTLY: a warning names each missing source (never a silent skip).
    const warnings = rows._meta.warnings;
    expect(warnings.some((w) => w.includes('claude-remote'))).toBe(true);
    expect(warnings.some((w) => w.includes('kiro-local'))).toBe(true);
  });

  test('all sources present → no warnings (clean window read)', async () => {
    const rows = await readRawTranscripts({ days: 30 }, sources());
    expect(rows._meta.warnings).toEqual([]);
    expect(rows.length).toBeGreaterThan(0);
  });
});
