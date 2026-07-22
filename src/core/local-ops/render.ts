// FORK-LOCAL (davidtwu) — markdown renderer + truncation cap for the
// get_raw_transcripts read surface. PURE: no filesystem access, no I/O. Do NOT
// upstream. All fork-only logic lives under src/core/local-ops/ so
// `git merge origin/master` stays clean.
//
// See design §4.3 + §6 (R6 cap policy). This module owns the ONE place that turns
// a RawTranscript into its rendered `markdown` view and applies the maxChars cap.
//
//   full tier — frontmatter block (id/lane/date) then ordered turns. tool_use →
//               a fenced ```tool_use <name>``` block carrying the JSON input;
//               tool_result → a fenced ```tool_result``` block (```tool_result error```
//               when isError); thinking → a `>` blockquote. Renders segments in
//               their original order (parity with the parser's emission order).
//   text tier — the plain `**role:** text` conversation join (the collector-parity
//               `text` field, byte-for-byte). NO frontmatter, NO invented tool
//               blocks — so the text tier agrees with the staged `.md`.
//
// Truncation is NEVER silent: applyCap trims to maxChars and reports the exact
// omittedChars. The cap POLICY (default size, 'full' effectively uncapped) is the
// caller's concern — this module only takes maxChars as a param.

import type { Fidelity, RawTranscript, Segment } from './types.ts';

/** Prefix every line of `s` with `> ` (a markdown blockquote), preserving blank
 *  lines. Used for `thinking` segments. */
function blockquote(s: string): string {
  return s
    .split('\n')
    .map((line) => (line.length ? `> ${line}` : '>'))
    .join('\n');
}

/** Render one `full`-tier segment to a markdown block. Returns '' for a segment
 *  that carries nothing to show (caller filters empties out). */
function renderSegment(s: Segment): string {
  const role = s.role ?? 'assistant';
  switch (s.kind) {
    case 'text': {
      const text = (s.text ?? '').trim();
      if (!text) return '';
      return `**${role}:** ${text}`;
    }
    case 'thinking': {
      const text = (s.text ?? '').trim();
      if (!text) return '';
      return blockquote(text);
    }
    case 'tool_use': {
      const name = s.tool?.name ?? '';
      // Stringify the raw input shape-preserved; pretty-printed for readability.
      let input: string;
      try {
        input = JSON.stringify(s.tool?.input ?? null, null, 2);
      } catch {
        // Circular / non-serializable input — never throw out of a pure renderer.
        input = String(s.tool?.input);
      }
      const fence = name ? `\`\`\`tool_use ${name}` : '```tool_use';
      return `${fence}\n${input}\n\`\`\``;
    }
    case 'tool_result': {
      const content = s.result?.content ?? '';
      const fence = s.result?.isError ? '```tool_result error' : '```tool_result';
      return `${fence}\n${content}\n\`\`\``;
    }
    default:
      return '';
  }
}

/** Build the `full`-tier frontmatter block (id / lane / date). `date` is emitted
 *  even when null (as an empty value) so the block shape is stable. */
function frontmatter(t: RawTranscript): string {
  return ['---', `id: ${t.id}`, `lane: ${t.lane}`, `date: ${t.date ?? ''}`, '---'].join(
    '\n',
  );
}

/**
 * Render a RawTranscript to markdown.
 *
 * Tier is inferred from the transcript shape: a populated `segments` array →
 * `full` (frontmatter + tool/thinking-inlined turns); otherwise → `text` (the
 * plain `text` conversation join, verbatim). Pass `fidelity` to force a tier.
 *
 * PURE — does not mutate `t` and does not read the filesystem.
 */
export function toMarkdown(t: RawTranscript, fidelity?: Fidelity): string {
  // A populated `segments` array (even empty) means the parser ran at `full`;
  // absence of `segments` means the `text` tier. `fidelity` overrides.
  const tier: Fidelity = fidelity ?? (t.segments !== undefined ? 'full' : 'text');

  if (tier === 'text') {
    // Plain conversation join — matches the collector `.md` / the `text` field.
    return t.text ?? '';
  }

  const blocks = (t.segments ?? [])
    .map(renderSegment)
    .filter((b) => b.length > 0);
  return [frontmatter(t), ...blocks].join('\n\n');
}

/**
 * Apply a character cap to `text`.
 *
 * - At or under the limit → unchanged, `truncated:false`, `omittedChars:0`
 *   (the boundary — exactly `maxChars` — is NOT a truncation).
 * - Over the limit → trimmed to `maxChars`, `truncated:true`, and the EXACT
 *   number of dropped chars in `omittedChars`. Never a silent slice.
 * - A non-finite or negative `maxChars` means "uncapped" (never truncates) —
 *   the caller uses this for the effectively-uncapped `full` tier.
 *
 * PURE.
 */
export function applyCap(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean; omittedChars: number } {
  if (!Number.isFinite(maxChars) || maxChars < 0 || text.length <= maxChars) {
    return { text, truncated: false, omittedChars: 0 };
  }
  const kept = text.slice(0, maxChars);
  return { text: kept, truncated: true, omittedChars: text.length - kept.length };
}

/**
 * Reader-facing helper (Step 4): render a RawTranscript to markdown and apply the
 * cap in one pure step, returning a NEW transcript with `markdown`, `truncated`,
 * and `omittedChars` populated. The reader wires this over each parsed transcript
 * so the cap + render policy lives in exactly one place.
 *
 * Tier is inferred from `t` (segments → full) unless `fidelity` is passed.
 * PURE — returns a fresh object; does not mutate the input.
 */
export function renderAndCap(
  t: RawTranscript,
  maxChars: number,
  fidelity?: Fidelity,
): RawTranscript {
  const rendered = toMarkdown(t, fidelity);
  const { text: markdown, truncated, omittedChars } = applyCap(rendered, maxChars);
  return { ...t, markdown, truncated, omittedChars };
}
