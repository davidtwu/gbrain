// FORK-LOCAL (davidtwu) — get_raw_transcripts read surface.
// All fork-only logic lives under src/core/local-ops/ so `git merge origin/master`
// stays clean; do NOT upstream. Types are the contract shared by the lane parsers
// (claude-jsonl.ts, kiro-sqlite.ts), the renderer (render.ts), and the reader
// (session-transcripts.ts). See .agents/planning/2026-07-21-gbrain-jsonl-transcript-bridge/
// design/detailed-design.md §4.1.

/** Read fidelity tier. `text` = conversation-only (parity with the collector's staged
 *  .md); `full` = structured ordered segments including tool/thinking detail. */
export type Fidelity = 'text' | 'full';

/** One ordered piece of a transcript at `full` fidelity, emitted from a Claude
 *  `message.content[]` block or a Kiro history entry in original order. */
export interface Segment {
  kind: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  role?: 'user' | 'assistant';
  /** Present for `text` and `thinking` kinds. */
  text?: string;
  /** Present for `tool_use`. `input` is the raw tool input, shape-preserved. */
  tool?: { name: string; input: unknown };
  /** Present for `tool_result`. */
  result?: { content: string; isError?: boolean };
}

/** A single parsed session transcript. `segments` is populated only at `full`
 *  fidelity; `text` is populated only at `text` fidelity; `markdown` is always
 *  populated (a rendered view — the real renderer lands in Step 3 / render.ts). */
export interface RawTranscript {
  /** Session id: jsonl stem (Claude) or kiro conversation_id. */
  id: string;
  lane:
    | 'claude-code'
    | 'claude-remote'
    | 'kiro-local'
    | 'kiro-remote'
    | 'meshclaw-remote';
  /** Project/key label (Claude: parent dir name; Kiro: key tail). */
  project?: string;
  /** ISO date; first-turn timestamp (Claude) or updated_at (Kiro). null if unknown. */
  date: string | null;
  /** ISO mtime of the raw source. */
  mtime: string;
  /** Raw source size in bytes. */
  bytes: number;
  /** `full` fidelity only: ordered typed segments. */
  segments?: Segment[];
  /** `text` fidelity only: conversation-only markdown (collector-parity join). */
  text?: string;
  /** Rendered markdown view (both tiers). */
  markdown: string;
  /** Explicit truncation signal — never a silent slice. */
  truncated: boolean;
  /** Chars dropped by the maxChars cap (0 when not truncated). */
  omittedChars: number;
}

/** Options for the reader (session-transcripts.ts, Step 4/5). Included here so the
 *  whole read surface shares one type module. */
export interface RawReadOpts {
  /** default 'text' */
  fidelity?: Fidelity;
  /** window mode: default 7 */
  days?: number;
  /** window mode: default 50 */
  limit?: number;
  /** session mode: session id or page slug (wins over window mode if given) */
  sessionId?: string;
  /** default all 5 lanes */
  lanes?: string[];
  /** default 500_000; effectively ignored/huge for 'full' */
  maxChars?: number;
}
