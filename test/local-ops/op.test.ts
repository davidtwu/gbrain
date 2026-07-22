// FORK-LOCAL (davidtwu) — tests for the `get_raw_transcripts` op (Step 6).
//   1. trust gate: remote:true → permission_denied (mirror of the upstream op).
//   2. remote:false + hermetic fixtures → returns results; format:'json' → structured
//      objects, format:'markdown' → strings; warnings surfaced in the wrapper.
//   3. the op is registered in the exported `operations` array.
//
// The op's handler calls readRawTranscripts WITHOUT a `sources` arg, so it reads the real
// default paths UNLESS overridden. We point the `GBRAIN_RAW_*` env vars (the reader's env
// override seam) at temp fixtures so the test is hermetic and NEVER reads real sessions.
// A deliberately-missing lane source generates a non-silent warning we assert on. Env is
// reset after each test.

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { get_raw_transcripts } from '../../src/core/local-ops/session-transcripts-op.ts';

let root: string;
let claudeCodeDir: string;

const NOW = Date.now();
const T_RECENT = NOW - 2 * 1000;

// Env keys the reader honors (resolveSources in session-transcripts.ts).
const ENV_KEYS = [
  'GBRAIN_RAW_CLAUDE_CODE_DIR',
  'GBRAIN_RAW_CLAUDE_REMOTE_DIR',
  'GBRAIN_RAW_KIRO_LOCAL_DB',
  'GBRAIN_RAW_KIRO_REMOTE_DB',
] as const;

function claudeJsonl(userText: string, assistantText: string, ts: string): string {
  return (
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: userText }, timestamp: ts }),
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

// Minimal OperationContext. Only `remote` is read by the handler; the rest are shape
// fillers (the handler never touches the engine — the reader reads files directly).
function makeContext(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: {} as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: false,
    ...overrides,
  } as OperationContext;
}

/**
 * Point the reader at a hermetic fixture tree via env. claude-code gets a real fixture;
 * the other three sources point at NONEXISTENT paths so their lanes generate non-silent
 * warnings (proving warnings are surfaced) while claude-code still returns results.
 */
function setFixtureEnv() {
  process.env.GBRAIN_RAW_CLAUDE_CODE_DIR = claudeCodeDir;
  process.env.GBRAIN_RAW_CLAUDE_REMOTE_DIR = join(root, 'nope-claude-remote');
  process.env.GBRAIN_RAW_KIRO_LOCAL_DB = join(root, 'nope-kiro-local.sqlite3');
  process.env.GBRAIN_RAW_KIRO_REMOTE_DB = join(root, 'nope-kiro-remote.sqlite3');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-op-test-'));
  claudeCodeDir = join(root, 'claude-projects');
  const projA = join(claudeCodeDir, 'proj-alpha');
  mkdirSync(projA, { recursive: true });
  const fileA = join(projA, 'sess-op-1111.jsonl');
  writeFileSync(fileA, claudeJsonl('hi op', 'reply op', new Date(T_RECENT).toISOString()));
  utimesSync(fileA, T_RECENT / 1000, T_RECENT / 1000);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('get_raw_transcripts — trust gate', () => {
  test('remote:true → permission_denied (OperationError, mirror of upstream op)', async () => {
    const ctx = makeContext({ remote: true });
    let threw = false;
    let message = '';
    try {
      await get_raw_transcripts.handler(ctx, { days: 7 });
    } catch (e) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    expect(threw, 'remote:true MUST reject').toBe(true);
    expect(message.toLowerCase()).toContain('local-only');
  });

  test('op is declared localOnly (hidden from the HTTP tool-list)', () => {
    expect(get_raw_transcripts.localOnly).toBe(true);
    expect(get_raw_transcripts.scope).toBe('read');
  });
});

describe('get_raw_transcripts — remote:false returns results over hermetic fixtures', () => {
  test("format:'json' (default) → structured transcript objects + warnings", async () => {
    setFixtureEnv();
    const ctx = makeContext({ remote: false });
    const res = (await get_raw_transcripts.handler(ctx, { days: 7, fidelity: 'full' })) as {
      transcripts: any[];
      warnings: string[];
    };
    // structured objects (not strings): the claude-code fixture round-trips.
    expect(Array.isArray(res.transcripts)).toBe(true);
    expect(res.transcripts.length).toBe(1);
    const t = res.transcripts[0];
    expect(typeof t).toBe('object');
    expect(t.id).toBe('sess-op-1111');
    expect(t.lane).toBe('claude-code');
    expect(Array.isArray(t.segments)).toBe(true); // full fidelity → segments present
    // warnings surfaced for the 3 deliberately-missing sources (never silent, §6).
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.warnings.some((w) => w.includes('claude-remote'))).toBe(true);
  });

  test("format:'markdown' → array of rendered markdown strings + warnings", async () => {
    setFixtureEnv();
    const ctx = makeContext({ remote: false });
    const res = (await get_raw_transcripts.handler(ctx, {
      days: 7,
      fidelity: 'full',
      format: 'markdown',
    })) as { transcripts: string[]; warnings: string[] };
    expect(res.transcripts.length).toBe(1);
    expect(typeof res.transcripts[0]).toBe('string');
    // full-fidelity markdown inlines the tool_use fenced block.
    expect(res.transcripts[0]).toContain('```tool_use Bash');
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  test('snake_case params map to camelCase reader opts (session_id, max_chars)', async () => {
    setFixtureEnv();
    const ctx = makeContext({ remote: false });
    // Unknown session_id → empty transcripts + a "not found" warning (never a silent []).
    const res = (await get_raw_transcripts.handler(ctx, {
      session_id: 'does-not-exist-0000',
      max_chars: 100,
    })) as { transcripts: any[]; warnings: string[] };
    expect(res.transcripts.length).toBe(0);
    expect(res.warnings.some((w) => w.includes('does-not-exist-0000'))).toBe(true);
  });
});

describe('get_raw_transcripts — registration', () => {
  test('present in the exported operations array', () => {
    const op = operations.find((o) => o.name === 'get_raw_transcripts');
    expect(op).toBeDefined();
    expect(op!.localOnly).toBe(true);
    expect(op!.cliHints?.name).toBe('raw-transcripts');
  });
});
