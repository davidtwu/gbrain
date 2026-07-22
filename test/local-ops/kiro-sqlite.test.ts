// FORK-LOCAL (davidtwu) — tests for the Kiro sqlite parser (Step 2).
// Builds a TINY synthetic sqlite fixture in a temp file — NO real session content.
// The blob shapes mirror the real Kiro `conversations_v2.value` structure confirmed
// against the live db (assistant Response/ToolUse variants; user Prompt/ToolUseResults;
// tool_use {name,args}; tool_result {content:[{Text}], status:"Success"|"Error"}).

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKiroSqlite } from '../../src/core/local-ops/kiro-sqlite.ts';

let dir: string;
let dbPath: string;

// updated_at values (ms). Both are "recent" relative to the window cutoff below.
const MESHCLAW_UPDATED = 1_800_000_100_000;
const KIRO_UPDATED = 1_800_000_200_000;

// A synthetic blob carrying BOTH a pre-rendered `transcript` list (for the text tier)
// AND a `history` array with a tool_use + tool_result + thinking (for the full tier),
// so a single fixture exercises both tiers.
function makeBlob(cid: string) {
  return JSON.stringify({
    conversation_id: cid,
    // pre-rendered transcript — text tier MUST prefer this over the history join.
    transcript: ['**user:** prerendered question', '**assistant:** prerendered answer'],
    history: [
      {
        // user asks
        user: { content: { Prompt: { prompt: 'run the tests' } } },
        // assistant thinks, says something, then calls a tool
        assistant: {
          ToolUse: {
            content: 'Let me run the test suite.',
            thinking: 'I should invoke the bash tool.',
            tool_uses: [{ id: 't1', name: 'execute_bash', args: { command: 'bun test' } }],
          },
        },
      },
      {
        // user turn carrying the tool result (one Success, one Error)
        user: {
          content: {
            ToolUseResults: {
              tool_use_results: [
                { tool_use_id: 't1', content: [{ Text: 'ok: 3 pass' }], status: 'Success' },
                { tool_use_id: 't1', content: [{ Text: 'boom' }], status: 'Error' },
              ],
            },
          },
        },
        // assistant final response
        assistant: { Response: { content: 'All good, three passed.' } },
      },
    ],
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-kiro-test-'));
  dbPath = join(dir, 'data.sqlite3');
  const db = new Database(dbPath); // writable ONLY to build the fixture
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
  // Row 1: key names the meshclaw workspace → meshclaw-remote when splitRemote.
  ins.run(
    '/home/user/workplace/meshclaw-agent',
    'conv-meshclaw-0001',
    makeBlob('conv-meshclaw-0001'),
    MESHCLAW_UPDATED - 5000,
    MESHCLAW_UPDATED,
  );
  // Row 2: ordinary interactive key → kiro-remote when splitRemote.
  ins.run(
    '/home/user/workplace/some-project',
    'conv-interactive-0002',
    makeBlob('conv-interactive-0002'),
    KIRO_UPDATED - 5000,
    KIRO_UPDATED,
  );
  db.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readKiroSqlite', () => {
  test('window select returns both rows; splitRemote routes lanes by meshclaw-in-key', () => {
    const rows = readKiroSqlite(dbPath, { cutoffMs: 1_800_000_000_000, splitRemote: true });
    expect(rows.length).toBe(2);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('conv-meshclaw-0001')!.lane).toBe('meshclaw-remote');
    expect(byId.get('conv-interactive-0002')!.lane).toBe('kiro-remote');
    // project = last path segment of the key.
    expect(byId.get('conv-meshclaw-0001')!.project).toBe('meshclaw-agent');
  });

  test('splitRemote=false uses the caller-supplied lane (kiro-local), no split', () => {
    const rows = readKiroSqlite(dbPath, {
      cutoffMs: 1_800_000_000_000,
      splitRemote: false,
      lane: 'kiro-local',
    });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.lane === 'kiro-local')).toBe(true);
  });

  test('text tier prefers the pre-rendered transcript list', () => {
    const rows = readKiroSqlite(dbPath, {
      cutoffMs: 1_800_000_000_000,
      splitRemote: true,
      fidelity: 'text',
    });
    const r = rows.find((x) => x.id === 'conv-interactive-0002')!;
    expect(r.text).toBe('**user:** prerendered question\n\n**assistant:** prerendered answer');
    expect(r.markdown).toBe(r.text!);
    expect(r.segments).toBeUndefined();
    // date derived from updated_at (ms → ISO).
    expect(r.date).toBe(new Date(KIRO_UPDATED).toISOString());
  });

  test('full tier recovers tool_use/tool_result/thinking in order', () => {
    const rows = readKiroSqlite(dbPath, {
      cutoffMs: 1_800_000_000_000,
      splitRemote: true,
      fidelity: 'full',
    });
    const r = rows.find((x) => x.id === 'conv-meshclaw-0001')!;
    expect(r.text).toBeUndefined();
    const kinds = r.segments!.map((s) => s.kind);
    // turn 1: user prompt (text), assistant thinking, assistant text, tool_use
    // turn 2: two tool_results (Success + Error), assistant Response text
    expect(kinds).toEqual([
      'text', // user prompt
      'thinking', // assistant thinking
      'text', // assistant ToolUse preamble content
      'tool_use', // execute_bash
      'tool_result', // Success
      'tool_result', // Error
      'text', // assistant Response
    ]);
    const tu = r.segments!.find((s) => s.kind === 'tool_use')!;
    expect(tu.tool).toEqual({ name: 'execute_bash', input: { command: 'bun test' } });
    const results = r.segments!.filter((s) => s.kind === 'tool_result');
    expect(results[0].result).toEqual({ content: 'ok: 3 pass', isError: undefined });
    expect(results[1].result).toEqual({ content: 'boom', isError: true });
    const th = r.segments!.find((s) => s.kind === 'thinking')!;
    expect(th.text).toBe('I should invoke the bash tool.');
  });

  test('by-id select returns exactly one row', () => {
    const rows = readKiroSqlite(dbPath, {
      conversationId: 'conv-meshclaw-0001',
      splitRemote: true,
      fidelity: 'full',
    });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('conv-meshclaw-0001');
    expect(rows[0].lane).toBe('meshclaw-remote');
  });

  test('malformed JSON blob row is skipped, not thrown', () => {
    const p2 = join(dir, 'bad.sqlite3');
    const w = new Database(p2);
    w.run(`CREATE TABLE conversations_v2 (
      key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (key, conversation_id))`);
    const insBad = w.prepare('INSERT INTO conversations_v2 VALUES (?,?,?,?,?)');
    insBad.run('/k/good', 'good', makeBlob('good'), 1, KIRO_UPDATED);
    insBad.run('/k/bad', 'bad', '{ not valid json', 1, KIRO_UPDATED);
    w.close();
    const rows = readKiroSqlite(p2, { cutoffMs: 1_800_000_000_000, splitRemote: false, lane: 'kiro-local' });
    expect(rows.map((r) => r.id)).toEqual(['good']);
  });

  test('opened read-only: no write lock / no db mutation / no sidecar files', () => {
    // Snapshot the row count via an independent handle, run the reader, re-check.
    const before = (() => {
      const d = new Database(dbPath, { readonly: true });
      const n = (d.query('SELECT COUNT(*) AS c FROM conversations_v2').get() as { c: number }).c;
      d.close();
      return n;
    })();
    readKiroSqlite(dbPath, { cutoffMs: 1_800_000_000_000, splitRemote: true, fidelity: 'full' });
    const after = (() => {
      const d = new Database(dbPath, { readonly: true });
      const n = (d.query('SELECT COUNT(*) AS c FROM conversations_v2').get() as { c: number }).c;
      d.close();
      return n;
    })();
    expect(after).toBe(before);
    // A read-only open must not leave a rollback journal or WAL sidecar behind.
    expect(existsSync(dbPath + '-journal')).toBe(false);
    expect(existsSync(dbPath + '-wal')).toBe(false);
  });
});
