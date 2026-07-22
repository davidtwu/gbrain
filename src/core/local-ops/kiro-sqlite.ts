// FORK-LOCAL (davidtwu) — Kiro `data.sqlite3` parser for the get_raw_transcripts read
// surface. Reads `conversations_v2` READ-ONLY and turns each row's `value` JSON blob
// into a RawTranscript at `text` or `full` fidelity. Do NOT upstream.
//
// See design §4.2 + research/06 (fidelity ceiling) + research/08 (the remote-db split).
// Two tiers, mirroring collect_kiro() in ~/.gbrain-bin/gbrain-collect-sessions.py:
//   text — prefer the pre-rendered `transcript` list (collector parity); else fall back
//          to a `history[].user/assistant` text join.
//   full — walk `history[].user/assistant` and emit ordered Segment[] recovering the
//          tool_use / tool_result / thinking detail the collector's text view drops.
//
// `splitRemote` mirrors the collector: the REMOTE kiro sqlite is ONE physical db holding
// BOTH the interactive `kiro-remote` lane AND the 24/7 `meshclaw-remote` agent's convos,
// distinguished per-row by whether the `key` names the meshclaw workspace. Local kiro
// (`kiro-local`) is its own db → no split; the caller supplies the lane.
//
// Rendering to markdown and the maxChars cap are Step 3's job (render.ts); the `markdown`
// produced here is a MINIMAL placeholder (same convention as claude-jsonl.ts) so the type
// is satisfied. Keep this module focused on producing structured data.

import { Database } from 'bun:sqlite';
import type { Fidelity, RawTranscript, Segment } from './types.ts';

/** Options for one physical Kiro sqlite db. Access is EITHER window mode
 *  (`cutoffMs` → `updated_at > cutoffMs`) OR by-id (`conversationId`); if both are
 *  given, `conversationId` wins (design R3 — session id wins over window). */
export interface KiroReadOpts {
  /** default 'text' */
  fidelity?: Fidelity;
  /** window mode: return rows with `updated_at > cutoffMs`. */
  cutoffMs?: number;
  /** by-id mode: return the single row with this `conversation_id` (wins over window). */
  conversationId?: string;
  /** When true, route each row's lane by `key.toLowerCase().includes('meshclaw')`
   *  → 'meshclaw-remote', else 'kiro-remote' (the ONE remote db → 2 lanes split). */
  splitRemote?: boolean;
  /** Lane to stamp when `splitRemote` is false (e.g. 'kiro-local'). Required in that
   *  case; ignored when `splitRemote` is true. */
  lane?: RawTranscript['lane'];
}

interface Conv2Row {
  key: string | null;
  conversation_id: string;
  value: string;
  created_at: number;
  updated_at: number;
}

// --- Kiro blob shapes (only the fields we read; everything else is ignored) --------
interface KiroToolUse {
  id?: string;
  name?: string;
  orig_name?: string;
  args?: unknown;
  orig_args?: unknown;
}
interface KiroToolResult {
  tool_use_id?: string;
  content?: unknown; // array of { Text: string } | { Json: unknown } | string
  status?: string; // "Success" | "Error"
}
interface KiroAssistant {
  Response?: { content?: unknown; thinking?: unknown };
  ToolUse?: { content?: unknown; thinking?: unknown; tool_uses?: KiroToolUse[] };
  thinking?: unknown;
}
interface KiroUserContent {
  Prompt?: { prompt?: unknown };
  ToolUseResults?: { tool_use_results?: KiroToolResult[] };
}
interface KiroHistoryTurn {
  user?: { content?: KiroUserContent | unknown };
  assistant?: KiroAssistant;
}
interface KiroBlob {
  transcript?: unknown;
  history?: unknown;
}

/** Route a row to its lane given the split flag. */
function laneFor(opts: KiroReadOpts, key: string | null): RawTranscript['lane'] {
  if (opts.splitRemote) {
    return (key ?? '').toLowerCase().includes('meshclaw')
      ? 'meshclaw-remote'
      : 'kiro-remote';
  }
  // Non-split: caller supplies the lane (e.g. 'kiro-local'). Default defensively.
  return opts.lane ?? 'kiro-local';
}

/** Last path segment of the key (collector's `key.split('/')[-1] or key`). */
function projectFromKey(key: string | null): string | undefined {
  if (!key) return undefined;
  const tail = key.split('/').pop();
  return (tail && tail.length > 0 ? tail : key) || undefined;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Normalize a Kiro tool_result `content` (array of {Text}|{Json}|string) to a string. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          const blk = b as { Text?: unknown; Json?: unknown };
          if (typeof blk.Text === 'string') return blk.Text;
          if ('Json' in blk) return JSON.stringify(blk.Json);
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** Extract an assistant-side thinking string, if the blob carries one. Real Kiro rows
 *  don't emit a dedicated thinking field today, but the design mandates recovering it
 *  when present, so we look in the plausible spots (Response/ToolUse/turn level). */
function thinkingText(a: KiroAssistant | undefined): string {
  if (!a) return '';
  return (
    asString(a.Response?.thinking) ||
    asString(a.ToolUse?.thinking) ||
    asString(a.thinking)
  );
}

/** The prompt string from a user turn's content, if any. */
function userPrompt(content: KiroUserContent | undefined): string {
  return asString(content?.Prompt?.prompt);
}

/** Minimal placeholder markdown — mirrors claude-jsonl.ts. Step 3 (render.ts) owns the
 *  real renderer; we only need `markdown` non-empty to satisfy the type. */
function minimalMarkdown(tier: Fidelity, textJoin: string, segments: Segment[]): string {
  if (tier === 'text') return textJoin;
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

/** text tier: prefer the pre-rendered `transcript` list; else join `history` turns
 *  (collector parity — user Prompt + assistant Response.content only). */
function textJoin(blob: KiroBlob): string {
  const t = blob.transcript;
  if (Array.isArray(t) && t.length > 0) {
    return t
      .map((x) => String(x))
      .filter((s) => s.trim())
      .join('\n\n');
  }
  const parts: string[] = [];
  const history = Array.isArray(blob.history) ? (blob.history as KiroHistoryTurn[]) : [];
  for (const turn of history) {
    if (!turn || typeof turn !== 'object') continue;
    const prompt = userPrompt(turn.user?.content as KiroUserContent | undefined);
    if (prompt) parts.push(`**user:** ${prompt}`);
    const respText = asString(turn.assistant?.Response?.content);
    if (respText) parts.push(`**assistant:** ${respText}`);
  }
  return parts.join('\n\n');
}

/** full tier: walk `history[].user/assistant` in order, emitting typed segments.
 *  Per turn we emit the user side first (prompt text, then tool_results) then the
 *  assistant side (thinking, then text, then tool_use calls) — mirroring the collector's
 *  user-before-assistant turn processing while recovering the dropped tool/thinking detail. */
function fullSegments(blob: KiroBlob): Segment[] {
  const segments: Segment[] = [];
  const history = Array.isArray(blob.history) ? (blob.history as KiroHistoryTurn[]) : [];
  for (const turn of history) {
    if (!turn || typeof turn !== 'object') continue;

    // --- user side ---
    const uc = turn.user?.content as KiroUserContent | undefined;
    const prompt = userPrompt(uc);
    if (prompt.trim()) segments.push({ kind: 'text', role: 'user', text: prompt });
    const trs = uc?.ToolUseResults?.tool_use_results;
    if (Array.isArray(trs)) {
      for (const tr of trs) {
        if (!tr || typeof tr !== 'object') continue;
        segments.push({
          kind: 'tool_result',
          role: 'user',
          result: {
            content: toolResultText(tr.content),
            isError: tr.status === 'Error' ? true : undefined,
          },
        });
      }
    }

    // --- assistant side ---
    const a = turn.assistant;
    if (a) {
      const think = thinkingText(a);
      if (think.trim()) segments.push({ kind: 'thinking', role: 'assistant', text: think });
      // A turn is EITHER a Response (final text) OR a ToolUse (preamble + calls).
      const respText = asString(a.Response?.content);
      const toolPreamble = asString(a.ToolUse?.content);
      const assistantText = respText || toolPreamble;
      if (assistantText.trim())
        segments.push({ kind: 'text', role: 'assistant', text: assistantText });
      const toolUses = a.ToolUse?.tool_uses;
      if (Array.isArray(toolUses)) {
        for (const tu of toolUses) {
          if (!tu || typeof tu !== 'object') continue;
          segments.push({
            kind: 'tool_use',
            role: 'assistant',
            tool: { name: tu.name ?? tu.orig_name ?? '', input: tu.args ?? tu.orig_args ?? null },
          });
        }
      }
    }
  }
  return segments;
}

function rowToTranscript(row: Conv2Row, opts: KiroReadOpts): RawTranscript | null {
  let blob: KiroBlob;
  try {
    blob = JSON.parse(row.value) as KiroBlob;
  } catch {
    // malformed JSON blob — skip row, continue (parity with the collector).
    return null;
  }
  const fidelity: Fidelity = opts.fidelity ?? 'text';
  const iso = Number.isFinite(row.updated_at)
    ? new Date(row.updated_at).toISOString()
    : null;
  const base = {
    id: row.conversation_id,
    lane: laneFor(opts, row.key),
    project: projectFromKey(row.key),
    date: iso,
    mtime: iso ?? '',
    bytes: Buffer.byteLength(row.value, 'utf8'),
    truncated: false,
    omittedChars: 0,
  };

  if (fidelity === 'full') {
    const segments = fullSegments(blob);
    return { ...base, segments, markdown: minimalMarkdown('full', '', segments) };
  }
  const text = textJoin(blob);
  return { ...base, text, markdown: minimalMarkdown('text', text, []) };
}

/**
 * Read a Kiro `data.sqlite3` READ-ONLY and return parsed transcripts.
 *
 * The db is opened with a `file:${path}?mode=ro` URI + `{ readonly: true }`, so no write
 * lock is taken and no journal/WAL sidecar is created. Rows whose `value` fails JSON parse
 * are skipped. The handle is always closed (finally).
 *
 * When `splitRemote` is true, each row is routed to `kiro-remote` or `meshclaw-remote` by
 * its `key` — so a SINGLE physical remote db feeds both lanes from one read. The caller
 * (the reader) can therefore open the remote db ONCE even when both lanes are requested,
 * then filter the returned rows by lane.
 */
export function readKiroSqlite(dbPath: string, opts: KiroReadOpts = {}): RawTranscript[] {
  const db = new Database(`file:${dbPath}?mode=ro`, { readonly: true });
  try {
    let rows: Conv2Row[];
    if (opts.conversationId != null) {
      rows = db
        .query(
          'SELECT key, conversation_id, value, created_at, updated_at ' +
            'FROM conversations_v2 WHERE conversation_id = ?',
        )
        .all(opts.conversationId) as Conv2Row[];
    } else {
      const cutoff = opts.cutoffMs ?? 0;
      rows = db
        .query(
          'SELECT key, conversation_id, value, created_at, updated_at ' +
            'FROM conversations_v2 WHERE updated_at > ?',
        )
        .all(cutoff) as Conv2Row[];
    }
    const out: RawTranscript[] = [];
    for (const row of rows) {
      const t = rowToTranscript(row, opts);
      if (t) out.push(t);
    }
    return out;
  } finally {
    db.close();
  }
}
