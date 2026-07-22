// FORK-LOCAL (davidtwu) — CLI SMOKE TEST (Step 7, plan §Tests bullet 3).
//
// Runs the BUILT CLI path (`bun run src/cli.ts raw-transcripts …`) as a subprocess against
// a hermetic GBRAIN_RAW_* fixture tree (NEVER real sessions) and asserts:
//   - exit 0,
//   - stdout is a VALID JSON `{ transcripts, warnings }` wrapper,
//   - the generic op→CLI path surfaces the command AND its flags end-to-end
//     (--json / --days / --fidelity / --session / --lanes / --max-chars).
//
// These flag assertions are the real-CLI counterpart of the op-layer unit test (op.test.ts):
// they prove the fixes for the generic-parser gaps hold through an actual argv parse —
//   * `--session` (CLI key `session`, folded into session_id in the op),
//   * `--lanes` (comma-split string → lane array in the op),
//   * `--json` (declared boolean no-op so it doesn't swallow the next flag's value).
//
// Warnings presentation is also asserted: they ride the JSON wrapper on STDOUT (machine-
// visible for --json consumers) AND echo to STDERR for a human (never polluting stdout JSON).
//
// spawnSync pattern mirrors test/frontmatter-cli.test.ts. `process.execPath` under
// `bun test` is the bun binary, so `[run, src/cli.ts, …]` runs the CLI in-repo.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = ['run', 'src/cli.ts', 'raw-transcripts'];

let root: string;
let claudeCodeDir: string;

/** Fixture env: claude-code → real fixture; the other 3 lanes → nonexistent paths so their
 *  skips generate non-silent warnings (proving the warnings channel end-to-end). */
function fixtureEnv(): Record<string, string> {
  return {
    GBRAIN_RAW_CLAUDE_CODE_DIR: claudeCodeDir,
    GBRAIN_RAW_CLAUDE_REMOTE_DIR: join(root, 'nope-claude-remote'),
    GBRAIN_RAW_KIRO_LOCAL_DB: join(root, 'nope-kiro-local.sqlite3'),
    GBRAIN_RAW_KIRO_REMOTE_DB: join(root, 'nope-kiro-remote.sqlite3'),
  };
}

function runCli(args: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(process.execPath, [...CLI, ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
    env: { ...process.env, ...fixtureEnv() },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 };
}

function claudeJsonl(userText: string, assistantText: string, ts: string): string {
  return (
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: userText }, timestamp: ts }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'thinking...' },
            { type: 'text', text: assistantText },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
        timestamp: ts,
      }),
    ].join('\n') + '\n'
  );
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-cli-smoke-'));
  claudeCodeDir = join(root, 'claude-projects');
  const proj = join(claudeCodeDir, 'proj-alpha');
  mkdirSync(proj, { recursive: true });
  const now = new Date().toISOString();
  // Long assistant text so the text-tier render comfortably exceeds the 60-char cap in the
  // truncation test (a short reply would render under the cap and truncate nothing).
  const longReply =
    'reply one — this is a deliberately long assistant response so the text-tier markdown ' +
    'render exceeds the max-chars cap and exercises the explicit truncation signal path.';
  writeFileSync(join(proj, 'sess-smoke-1.jsonl'), claudeJsonl('hi one', longReply, now));
  const nested = join(claudeCodeDir, 'proj-beta', 'nested');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'sess-smoke-2.jsonl'), claudeJsonl('hi two', longReply, now));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('raw-transcripts CLI smoke (generic op→CLI path, hermetic)', () => {
  test('--json --days 1 → exit 0 + valid { transcripts, warnings } JSON on stdout', () => {
    const { stdout, code } = runCli(['--json', '--days', '1']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout); // throws → test fails if not valid JSON
    expect(Array.isArray(parsed.transcripts)).toBe(true);
    expect(Array.isArray(parsed.warnings)).toBe(true);
    // `--json` did NOT swallow `--days 1` (the pre-fix bug): both fixture sessions are recent.
    expect(parsed.transcripts.length).toBe(2);
  });

  test('--fidelity full → segments present (full-tier flows through the CLI)', () => {
    const { stdout, code } = runCli(['--days', '7', '--fidelity', 'full', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.transcripts.length).toBe(2);
    expect(Array.isArray(parsed.transcripts[0].segments)).toBe(true);
  });

  test('--session <stem> → exactly that one session', () => {
    const { stdout, code } = runCli(['--session', 'sess-smoke-2', '--fidelity', 'full']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.transcripts.length).toBe(1);
    expect(parsed.transcripts[0].id).toBe('sess-smoke-2');
  });

  test('--lanes kiro-local → filters OUT claude-code (array flag parsed)', () => {
    const { stdout, code } = runCli(['--days', '7', '--lanes', 'kiro-local', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    // claude-code excluded → no fixture transcripts; the requested (missing) kiro-local warns.
    expect(parsed.transcripts.length).toBe(0);
  });

  test('--lanes claude-code,kiro-local (comma) → claude-code included', () => {
    const { stdout, code } = runCli(['--days', '7', '--lanes', 'claude-code,kiro-local', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.transcripts.length).toBe(2);
  });

  test('--max-chars 60 → explicit truncation signal (never a silent slice)', () => {
    const { stdout, code } = runCli(['--days', '7', '--lanes', 'claude-code', '--max-chars', '60', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.transcripts.length).toBe(2);
    const anyTruncated = parsed.transcripts.some(
      (t: { truncated: boolean; omittedChars: number }) => t.truncated && t.omittedChars > 0,
    );
    expect(anyTruncated).toBe(true);
    for (const t of parsed.transcripts) {
      if (t.truncated) expect(t.markdown.length).toBeLessThanOrEqual(60);
    }
  });

  test('warnings: JSON wrapper on stdout AND echoed to stderr (human), stdout stays clean', () => {
    const { stdout, stderr, code } = runCli(['--days', '7', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout); // stdout is CLEAN JSON despite stderr warnings
    // 3 missing lanes → non-silent warnings in the wrapper.
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.warnings.some((w: string) => w.includes('claude-remote'))).toBe(true);
    // …and echoed to stderr for a human at the terminal.
    expect(stderr).toContain('raw-transcripts:');
    expect(stderr).toContain('claude-remote');
  });
});
