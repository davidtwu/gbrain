// FORK-LOCAL (davidtwu) — tests for the markdown renderer + truncation cap (Step 3).
// In-memory RawTranscript fixtures only — NO fs, no real session content.

import { describe, test, expect } from 'bun:test';
import { toMarkdown, applyCap, renderAndCap } from '../../src/core/local-ops/render.ts';
import type { RawTranscript, Segment } from '../../src/core/local-ops/types.ts';

// A `full`-tier transcript exercising every segment kind in order.
const FULL_SEGMENTS: Segment[] = [
  { kind: 'text', role: 'user', text: 'Please list the files.' },
  { kind: 'thinking', role: 'assistant', text: 'I should run ls\nto see the tree.' },
  { kind: 'text', role: 'assistant', text: 'Let me list them.' },
  {
    kind: 'tool_use',
    role: 'assistant',
    tool: { name: 'Bash', input: { command: 'ls -la' } },
  },
  {
    kind: 'tool_result',
    role: 'user',
    result: { content: 'file_a.ts\nfile_b.ts' },
  },
  {
    kind: 'tool_result',
    role: 'user',
    result: { content: 'command not found', isError: true },
  },
  { kind: 'text', role: 'assistant', text: 'Found two files.' },
];

function fullTranscript(overrides: Partial<RawTranscript> = {}): RawTranscript {
  return {
    id: 'sess-abcd1234',
    lane: 'claude-code',
    project: 'myproj',
    date: '2026-07-20T10:00:00.000Z',
    mtime: '2026-07-20T10:05:00.000Z',
    bytes: 123,
    segments: FULL_SEGMENTS,
    markdown: '',
    truncated: false,
    omittedChars: 0,
    ...overrides,
  };
}

function textTranscript(overrides: Partial<RawTranscript> = {}): RawTranscript {
  const text = [
    '**user:** Please list the files.',
    '**assistant:** Let me list them.',
    '**assistant:** Found two files.',
  ].join('\n\n');
  return {
    id: 'sess-abcd1234',
    lane: 'claude-code',
    project: 'myproj',
    date: '2026-07-20T10:00:00.000Z',
    mtime: '2026-07-20T10:05:00.000Z',
    bytes: 123,
    text,
    markdown: '',
    truncated: false,
    omittedChars: 0,
    ...overrides,
  };
}

describe('toMarkdown — full tier', () => {
  const md = toMarkdown(fullTranscript());

  test('includes frontmatter with id/lane/date', () => {
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('id: sess-abcd1234');
    expect(md).toContain('lane: claude-code');
    expect(md).toContain('date: 2026-07-20T10:00:00.000Z');
  });

  test('renders tool_use as a fenced ```tool_use block with the JSON input', () => {
    expect(md).toContain('```tool_use Bash');
    expect(md).toContain('"command": "ls -la"');
    // fence opens and closes
    expect(md).toMatch(/```tool_use Bash\n[\s\S]*?\n```/);
  });

  test('renders tool_result as a fenced ```tool_result block, marking errors', () => {
    expect(md).toContain('```tool_result\nfile_a.ts\nfile_b.ts\n```');
    expect(md).toContain('```tool_result error\ncommand not found\n```');
  });

  test('renders thinking as a `>` blockquote (per line)', () => {
    expect(md).toContain('> I should run ls');
    expect(md).toContain('> to see the tree.');
  });

  test('renders text turns as **role:** text', () => {
    expect(md).toContain('**user:** Please list the files.');
    expect(md).toContain('**assistant:** Found two files.');
  });

  test('blocks appear in original segment order', () => {
    const iThinking = md.indexOf('> I should run ls');
    const iText = md.indexOf('**assistant:** Let me list them.');
    const iToolUse = md.indexOf('```tool_use Bash');
    const iToolResult = md.indexOf('```tool_result\nfile_a.ts');
    const iErr = md.indexOf('```tool_result error');
    const iFound = md.indexOf('**assistant:** Found two files.');
    expect(iThinking).toBeGreaterThan(-1);
    expect(iThinking).toBeLessThan(iText);
    expect(iText).toBeLessThan(iToolUse);
    expect(iToolUse).toBeLessThan(iToolResult);
    expect(iToolResult).toBeLessThan(iErr);
    expect(iErr).toBeLessThan(iFound);
  });
});

describe('toMarkdown — text tier', () => {
  const md = toMarkdown(textTranscript());

  test('is the plain conversation join (equals the `text` field)', () => {
    expect(md).toBe(textTranscript().text ?? '');
  });

  test('has NO frontmatter and NO invented tool/thinking blocks', () => {
    expect(md).not.toContain('---');
    expect(md).not.toContain('```tool_use');
    expect(md).not.toContain('```tool_result');
    expect(md).not.toMatch(/^>/m);
  });

  test('empty text transcript renders empty markdown', () => {
    expect(toMarkdown(textTranscript({ text: undefined }))).toBe('');
  });
});

describe('toMarkdown — tier inference & purity', () => {
  test('an empty segments array still infers the full tier (frontmatter present)', () => {
    const md = toMarkdown(fullTranscript({ segments: [] }));
    expect(md).toContain('id: sess-abcd1234');
    expect(md).not.toContain('**');
  });

  test('explicit fidelity overrides inference', () => {
    // Force text tier on a full transcript (no text field) → empty.
    expect(toMarkdown(fullTranscript(), 'text')).toBe('');
  });

  test('null date renders as an empty value, not the string "null"', () => {
    const md = toMarkdown(fullTranscript({ date: null }));
    expect(md).toContain('date: \n');
    expect(md).not.toContain('date: null');
  });

  test('does not mutate the input transcript', () => {
    const t = fullTranscript();
    const before = JSON.stringify(t);
    toMarkdown(t);
    expect(JSON.stringify(t)).toBe(before);
  });
});

describe('applyCap', () => {
  test('under the limit → unchanged, truncated:false, omittedChars:0', () => {
    const r = applyCap('hello', 100);
    expect(r.text).toBe('hello');
    expect(r.truncated).toBe(false);
    expect(r.omittedChars).toBe(0);
  });

  test('exactly at the boundary → NOT truncated', () => {
    const r = applyCap('hello', 5);
    expect(r.text).toBe('hello');
    expect(r.truncated).toBe(false);
    expect(r.omittedChars).toBe(0);
  });

  test('over the limit → trimmed to maxChars with exact omittedChars', () => {
    const r = applyCap('hello world', 5);
    expect(r.text).toBe('hello');
    expect(r.text.length).toBe(5);
    expect(r.truncated).toBe(true);
    expect(r.omittedChars).toBe(6); // "hello world" (11) - 5
  });

  test('one char over → omittedChars:1', () => {
    const r = applyCap('hello!', 5);
    expect(r.text).toBe('hello');
    expect(r.truncated).toBe(true);
    expect(r.omittedChars).toBe(1);
  });

  test('maxChars 0 truncates everything and reports the full length', () => {
    const r = applyCap('abc', 0);
    expect(r.text).toBe('');
    expect(r.truncated).toBe(true);
    expect(r.omittedChars).toBe(3);
  });

  test('non-finite maxChars (Infinity) means uncapped — never truncates', () => {
    const big = 'x'.repeat(1000);
    const r = applyCap(big, Infinity);
    expect(r.text).toBe(big);
    expect(r.truncated).toBe(false);
    expect(r.omittedChars).toBe(0);
  });

  test('negative maxChars means uncapped', () => {
    const r = applyCap('abc', -1);
    expect(r.text).toBe('abc');
    expect(r.truncated).toBe(false);
    expect(r.omittedChars).toBe(0);
  });
});

describe('renderAndCap', () => {
  test('populates markdown + cap fields, no truncation under a huge limit', () => {
    const out = renderAndCap(fullTranscript(), 500_000);
    expect(out.markdown).toContain('```tool_use Bash');
    expect(out.truncated).toBe(false);
    expect(out.omittedChars).toBe(0);
  });

  test('reports truncation when the rendered markdown exceeds maxChars', () => {
    const out = renderAndCap(fullTranscript(), 10);
    expect(out.markdown.length).toBe(10);
    expect(out.truncated).toBe(true);
    expect(out.omittedChars).toBeGreaterThan(0);
    // exact accounting: kept + omitted == full render length
    const fullLen = toMarkdown(fullTranscript()).length;
    expect(out.markdown.length + out.omittedChars).toBe(fullLen);
  });

  test('text-tier markdown is the plain join (no tool blocks) and is not mutated in place', () => {
    const t = textTranscript();
    const out = renderAndCap(t, 500_000);
    expect(out.markdown).toBe(t.text ?? '');
    expect(out.markdown).not.toContain('```tool_use');
    // input untouched
    expect(t.markdown).toBe('');
  });
});
