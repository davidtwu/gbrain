// FORK-LOCAL (davidtwu) — tests for the Claude `.jsonl` parser (Step 1).
// Synthetic fixture only — NO real session content.

import { describe, test, expect } from 'bun:test';
import { parseClaudeJsonl, type ClaudeJsonlMeta } from '../../src/core/local-ops/claude-jsonl.ts';
import type { Segment } from '../../src/core/local-ops/types.ts';

// A fake 4-turn conversation exercising every block kind + edge cases:
//  1. user, string content
//  2. assistant, block array: thinking + text + tool_use
//  3. user, tool_result block (+ a whitespace-only text block that must drop)
//  4. assistant, text block
// Plus: a malformed JSON line (must be skipped) and a non-user/assistant record
// (type: 'summary', must be ignored by both tiers).
const LINES = [
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'Please list the files.' },
    timestamp: '2026-07-20T10:00:00.000Z',
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'I should run ls to see the tree.' },
        { type: 'text', text: 'Let me list them.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
      ],
    },
    timestamp: '2026-07-20T10:00:01.000Z',
  }),
  '{ this is not valid json',
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', content: 'file_a.ts\nfile_b.ts', is_error: false },
        { type: 'text', text: '   ' },
      ],
    },
    timestamp: '2026-07-20T10:00:02.000Z',
  }),
  JSON.stringify({
    type: 'summary',
    message: { role: 'assistant', content: 'IGNORE ME — not a turn' },
    timestamp: '2026-07-20T10:00:03.000Z',
  }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Found two files.' }] },
    timestamp: '2026-07-20T10:00:04.000Z',
  }),
];
const RAW = LINES.join('\n') + '\n';

const META: ClaudeJsonlMeta = {
  id: 'sess-abcd1234',
  lane: 'claude-code',
  project: 'myproj',
  mtime: '2026-07-20T10:05:00.000Z',
  bytes: RAW.length,
};

describe('parseClaudeJsonl', () => {
  test('text tier reproduces the collector-style join (parity)', () => {
    const t = parseClaudeJsonl(RAW, { ...META, fidelity: 'text' });
    // Only user/assistant, text blocks only, "**role:** text", blank-line joined.
    // The tool_use / thinking / tool_result blocks contribute NO text; the
    // whitespace-only text block drops; the 'summary' record is ignored.
    const expected = [
      '**user:** Please list the files.',
      '**assistant:** Let me list them.',
      // turn 3 (user tool_result) has no text block -> dropped entirely
      '**assistant:** Found two files.',
    ].join('\n\n');
    expect(t.text).toBe(expected);
    expect(t.markdown).toBe(expected); // text-tier markdown == the join for now
    expect(t.segments).toBeUndefined();
  });

  test('full tier emits tool_use/tool_result/thinking segments in original order', () => {
    const t = parseClaudeJsonl(RAW, { ...META, fidelity: 'full' });
    expect(t.text).toBeUndefined();
    const kinds = (t.segments as Segment[]).map((s) => s.kind);
    expect(kinds).toEqual([
      'text', // turn 1 user string
      'thinking', // turn 2
      'text', // turn 2
      'tool_use', // turn 2
      'tool_result', // turn 3 (whitespace text block dropped)
      'text', // turn 4
    ]);
    const tu = t.segments!.find((s) => s.kind === 'tool_use')!;
    expect(tu.tool).toEqual({ name: 'Bash', input: { command: 'ls -la' } });
    const tr = t.segments!.find((s) => s.kind === 'tool_result')!;
    expect(tr.result?.content).toBe('file_a.ts\nfile_b.ts');
    expect(tr.result?.isError).toBeUndefined();
    const th = t.segments!.find((s) => s.kind === 'thinking')!;
    expect(th.text).toBe('I should run ls to see the tree.');
  });

  test('malformed line skipped; empty/whitespace content dropped; date = first timestamp', () => {
    const t = parseClaudeJsonl(RAW, { ...META, fidelity: 'full' });
    // date is the first record's timestamp.
    expect(t.date).toBe('2026-07-20T10:00:00.000Z');
    // The malformed line did not throw and did not appear as a segment.
    expect(t.segments!.every((s) => s.kind !== undefined)).toBe(true);
    // The whitespace-only text block in turn 3 was dropped (no empty text seg).
    const emptyText = t.segments!.filter((s) => s.kind === 'text' && !(s.text ?? '').trim());
    expect(emptyText.length).toBe(0);
    // meta passthrough
    expect(t.id).toBe('sess-abcd1234');
    expect(t.lane).toBe('claude-code');
    expect(t.project).toBe('myproj');
    expect(t.bytes).toBe(RAW.length);
    expect(t.truncated).toBe(false);
    expect(t.omittedChars).toBe(0);
  });

  test('date is null when no record carries a timestamp', () => {
    const noTs = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
    const t = parseClaudeJsonl(noTs, META);
    expect(t.date).toBeNull();
  });
});
