// FORK-LOCAL (davidtwu) — Claude `.jsonl` parser for the get_raw_transcripts read
// surface. PURE: no filesystem access here (the reader in session-transcripts.ts owns
// the walk + I/O and hands us the raw string + meta). Do NOT upstream.
//
// See design §4.2. Two tiers:
//   text — reproduce the collector's user/assistant text join (parity with the staged
//          .md so the two tiers agree). Mirrors collect_claude() in
//          ~/.gbrain-bin/gbrain-collect-sessions.py.
//   full — emit ordered Segment[] (text | thinking | tool_use | tool_result) walked
//          from message.content[] in original order.
//
// Rendering to markdown and the maxChars cap are Step 3's job (render.ts); the
// `markdown` produced here is a MINIMAL placeholder to satisfy the type. Keep this
// module focused on producing structured data.

import type { Fidelity, RawTranscript, Segment } from './types.ts';

/** Metadata the reader supplies for one `.jsonl` file. `id` (jsonl stem) and
 *  `fidelity` are required by this pure parser because it has no filesystem access
 *  and cannot pick a tier itself — later steps (the reader) MUST pass them.
 *  (The design §4.2 sketch listed only {lane, project?, mtime, bytes}; `id` and
 *  `fidelity` are the pragmatic additions a pure parser needs.) */
export interface ClaudeJsonlMeta {
  id: string;
  lane: RawTranscript['lane'];
  project?: string;
  mtime: string;
  bytes: number;
  /** default 'text' */
  fidelity?: Fidelity;
}

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  // tool_use
  name?: string;
  input?: unknown;
  // tool_result
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeRecord {
  type?: string;
  message?: { role?: string; content?: unknown };
  timestamp?: string;
}

/** Join a Claude content value (string or block array) down to its text blocks only —
 *  the collector's exact behavior for the text tier. */
function textOnly(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is ClaudeContentBlock =>
          !!b && typeof b === 'object' && (b as ClaudeContentBlock).type === 'text',
      )
      .map((b) => b.text ?? '')
      .join('');
  }
  return '';
}

/** Normalize a tool_result `content` (string, or array of {type:'text',text} /
 *  nested blocks) into a single string. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          const blk = b as ClaudeContentBlock;
          if (typeof blk.text === 'string') return blk.text;
          if (typeof blk.content === 'string') return blk.content;
        }
        return '';
      })
      .join('');
  }
  if (content && typeof content === 'object') {
    const blk = content as ClaudeContentBlock;
    if (typeof blk.text === 'string') return blk.text;
  }
  return '';
}

/** Parse the newline-delimited JSON records, skipping malformed lines. */
function parseRecords(raw: string): ClaudeRecord[] {
  const out: ClaudeRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ClaudeRecord);
    } catch {
      // malformed JSON line — skip, continue (parity with the collector).
    }
  }
  return out;
}

/** Minimal placeholder markdown. Step 3 (render.ts) swaps in the real renderer;
 *  we only need the `markdown` field non-empty so the type is satisfied. */
function minimalMarkdown(
  tier: Fidelity,
  textJoin: string,
  segments: Segment[],
): string {
  if (tier === 'text') return textJoin;
  // full: minimal linear dump; NOT the final formatting (render.ts owns that).
  return segments
    .map((s) => {
      switch (s.kind) {
        case 'text':
          return `**${s.role ?? 'assistant'}:** ${s.text ?? ''}`;
        case 'thinking':
          return `> thinking: ${s.text ?? ''}`;
        case 'tool_use':
          return `[tool_use ${s.tool?.name ?? ''}] ${JSON.stringify(s.tool?.input ?? null)}`;
        case 'tool_result':
          return `[tool_result${s.result?.isError ? ' error' : ''}] ${s.result?.content ?? ''}`;
        default:
          return '';
      }
    })
    .filter((l) => l.length > 0)
    .join('\n\n');
}

/**
 * Parse one Claude `.jsonl` transcript into a RawTranscript at the requested tier.
 * Pure — no fs. `date` = the timestamp of the first record that carries one.
 */
export function parseClaudeJsonl(raw: string, meta: ClaudeJsonlMeta): RawTranscript {
  const fidelity: Fidelity = meta.fidelity ?? 'text';
  const records = parseRecords(raw);

  // date = first record with a timestamp (any type). null if none.
  let date: string | null = null;
  for (const r of records) {
    if (r.timestamp) {
      date = r.timestamp;
      break;
    }
  }

  const base = {
    id: meta.id,
    lane: meta.lane,
    project: meta.project,
    date,
    mtime: meta.mtime,
    bytes: meta.bytes,
    truncated: false,
    omittedChars: 0,
  };

  if (fidelity === 'full') {
    const segments: Segment[] = [];
    for (const r of records) {
      if (r.type !== 'user' && r.type !== 'assistant') continue;
      const role = r.type as 'user' | 'assistant';
      const content = r.message?.content;
      if (typeof content === 'string') {
        if (content.trim()) segments.push({ kind: 'text', role, text: content });
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as ClaudeContentBlock;
        switch (b.type) {
          case 'text':
            if ((b.text ?? '').trim())
              segments.push({ kind: 'text', role, text: b.text });
            break;
          case 'thinking':
            if ((b.thinking ?? '').trim())
              segments.push({ kind: 'thinking', role, text: b.thinking });
            break;
          case 'tool_use':
            segments.push({
              kind: 'tool_use',
              role,
              tool: { name: b.name ?? '', input: b.input ?? null },
            });
            break;
          case 'tool_result':
            segments.push({
              kind: 'tool_result',
              role,
              result: {
                content: toolResultText(b.content),
                isError: b.is_error === true ? true : undefined,
              },
            });
            break;
          default:
            break;
        }
      }
    }
    const markdown = minimalMarkdown('full', '', segments);
    return { ...base, segments, markdown };
  }

  // text tier — collector parity: only user/assistant records, text blocks only,
  // "**role:** text", non-empty (trimmed), joined by blank lines.
  const turns: string[] = [];
  for (const r of records) {
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    const joined = textOnly(r.message?.content);
    if (!joined.trim()) continue;
    turns.push(`**${r.type}:** ${joined.trim()}`);
  }
  const text = turns.join('\n\n');
  return { ...base, text, markdown: minimalMarkdown('text', text, []) };
}
