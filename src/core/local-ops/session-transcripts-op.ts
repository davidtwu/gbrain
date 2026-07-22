// FORK-LOCAL (davidtwu) — the `get_raw_transcripts` op (Step 6).
// Defines the local-only op that exposes the reader core (session-transcripts.ts)
// through gbrain's Operation contract (dispatch + CLI). Do NOT upstream — all fork-only
// logic lives under src/core/local-ops/ so `git merge origin/master` stays clean.
//
// The op is the FULL-FIDELITY companion to the upstream `get_recent_transcripts`:
//   - upstream op  → text-only, corpus-based, ~33% slice, HTTP-hidden (localOnly).
//   - this fork op → RAW agent-session reads at selectable fidelity (text|full) over all
//                    5 ingest lanes, by recent window OR single session id, structured
//                    JSON + markdown, explicit cap + warnings.
//
// TRUST POSTURE (design §4.4 / §6): mirrors the upstream op VERBATIM — `localOnly:true`
// hides it from the HTTP tool-list AND the handler re-checks `ctx.remote === true` →
// permission_denied (defense in depth). Raw transcripts are the most sensitive surface
// (tool calls, thinking, results); they never leave the local machine.
//
// See .agents/planning/2026-07-21-gbrain-jsonl-transcript-bridge/design/detailed-design.md
// §4.4 (op definition), §4.5 (registration seam), §6 (error handling), R5/R6/R7.

import type { Operation, OperationContext } from '../operations.ts';
import { OperationError } from '../operations.ts';
import { readRawTranscripts } from './session-transcripts.ts';
import type { RawReadOpts } from './types.ts';

/**
 * Local description constant (NOT operations-descriptions.ts — keeping it fork-local
 * avoids editing an upstream file whose strings are pinned by upstream tests, per
 * research/07). Describes the read surface for the CLI/tool-list.
 */
export const GET_RAW_TRANSCRIPTS_DESCRIPTION =
  'Reads RAW agent-session transcripts at selectable fidelity. FULL-FIDELITY companion ' +
  "to the upstream get_recent_transcripts (which is text-only, ~33% slice): this op " +
  'preserves tool_use / tool_result / thinking. Covers all 5 lanes (claude-code, ' +
  'claude-remote, kiro-local, kiro-remote, meshclaw-remote). Two access modes: by recent ' +
  'window (days/limit) OR a single session id (session_id wins over the window). Fidelity ' +
  "'text' (conversation-only) | 'full' (structured typed segments). Returns structured " +
  "JSON (format 'json', default) or an array of rendered markdown strings (format " +
  "'markdown'); either way warnings are surfaced alongside (missing lane / unknown id are " +
  'never silent). max_chars caps the render with an explicit truncation signal. Local-only: ' +
  'rejects remote (MCP/HTTP) callers with permission_denied — call via the gbrain CLI.';

/**
 * The op. `scope:'read'`, `localOnly:true`. snake_case params map to the reader's
 * camelCase `RawReadOpts` (session_id → sessionId, max_chars → maxChars).
 *
 * RETURN SHAPE (design §4.4 reconciled with §6's "warnings never silent"): a WRAPPER
 * object `{ transcripts, warnings }`. The design sketched returning `rows` (json) or
 * `rows.map(r => r.markdown)` (markdown) directly, but the reader carries its warnings on
 * a NON-ENUMERABLE `rows._meta.warnings` that `JSON.stringify` drops — so returning the
 * bare rows would silently lose warnings over the wire, violating §6. Wrapping is the
 * correct reconciliation:
 *   - format 'json' (default): { transcripts: RawTranscript[],  warnings: string[] }
 *   - format 'markdown':       { transcripts: string[] (each r.markdown), warnings: string[] }
 */
export const get_raw_transcripts: Operation = {
  name: 'get_raw_transcripts',
  description: GET_RAW_TRANSCRIPTS_DESCRIPTION,
  scope: 'read',
  // Local-only: rejects HTTP-borne MCP traffic at tool-list time (serve-http.ts filters
  // on `localOnly`) AND at runtime via the in-handler ctx.remote check (mirror of the
  // upstream get_recent_transcripts posture — defense in depth: hidden + rejected).
  localOnly: true,
  params: {
    fidelity: {
      type: 'string',
      enum: ['text', 'full'],
      description:
        "Read fidelity. 'text' = conversation-only (fast; supersedes the broken twin). " +
        "'full' = structured typed segments incl. tool_use/tool_result/thinking. " +
        "Window mode defaults to 'text'; session mode defaults to 'full'.",
    },
    days: { type: 'number', description: 'Window mode: look-back in days. Default 7.' },
    limit: { type: 'number', description: 'Window mode: max transcripts. Default 50.' },
    session_id: {
      type: 'string',
      description:
        'Session mode: a jsonl stem (Claude) or kiro conversation_id. Wins over the ' +
        'window and bypasses the age filter. Unknown id → empty transcripts + a warning. ' +
        'CLI: `--session-id <id>` (generic dash→underscore path) OR the `--session <id>` ' +
        'alias below.',
    },
    // CLI-only alias for `session_id`. The generic op→CLI parser maps `--session` to the
    // key `session` (NOT `session_id`), so without this the flag would be silently dropped
    // (Step 7 CLI-flag verification). Declaring it keeps the fix fork-local — no cli.ts edit
    // — and the handler folds `session ?? session_id`. MCP callers keep using `session_id`.
    session: {
      type: 'string',
      description: 'CLI alias for session_id (`--session <id>`). Folded into session_id.',
    },
    lanes: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Restrict to these lanes (claude-code, claude-remote, kiro-local, kiro-remote, ' +
        'meshclaw-remote). Default: all 5. CLI: comma-separated (`--lanes claude-code,kiro-local`).',
    },
    max_chars: {
      type: 'number',
      description:
        "Cap on the rendered markdown per transcript. Default ~500 KB for 'text', " +
        "effectively uncapped for 'full'. Over the cap → truncated:true + omittedChars.",
    },
    format: {
      type: 'string',
      enum: ['json', 'markdown'],
      description:
        "Output shape. 'json' (default) → { transcripts: <structured objects>, warnings }. " +
        "'markdown' → { transcripts: <rendered markdown strings>, warnings }.",
    },
    // CLI ergonomics no-op. The op ALWAYS returns the { transcripts, warnings } wrapper and
    // the CLI renderer serializes it as JSON (formatResult's default branch). `--json` is
    // declared as a boolean ONLY so the generic parser recognizes it as a flag rather than
    // consuming the FOLLOWING token as its value (`raw-transcripts --json --days 1` would
    // otherwise silently swallow `--days`). It selects nothing on its own. Step 7.
    json: {
      type: 'boolean',
      description: 'CLI no-op flag (output is always JSON). Accepted so `--json` does not eat the next arg.',
    },
  },
  handler: async (ctx: OperationContext, p: Record<string, unknown>) => {
    // Trust gate — mirror the upstream get_recent_transcripts VERBATIM. MCP / HTTP callers
    // (`remote=true`) are blocked; local CLI callers (`remote=false`) pass through. Raw
    // transcripts are local-only.
    if (ctx.remote === true) {
      throw new OperationError(
        'permission_denied',
        'get_raw_transcripts is local-only — call via the gbrain CLI.',
      );
    }

    // `lanes` arrives as a real array from MCP callers, but the generic op→CLI parser hands
    // a single string. Accept both: comma-split a string into the lane array (repo CLI
    // convention — cf. `--tools`/`--dimensions` in src/commands/*), pass an array through.
    const normalizeLanes = (v: unknown): string[] | undefined => {
      if (Array.isArray(v)) return v as string[];
      if (typeof v === 'string') {
        const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
        return parts.length > 0 ? parts : undefined;
      }
      return undefined;
    };

    // Map snake_case op params → camelCase RawReadOpts. `session` is the CLI alias for
    // `session_id` (folded here; session_id wins if somehow both are set).
    const sessionId =
      typeof p.session_id === 'string'
        ? p.session_id
        : typeof p.session === 'string'
          ? p.session
          : undefined;
    const opts: RawReadOpts = {
      fidelity: p.fidelity === 'full' || p.fidelity === 'text' ? p.fidelity : undefined,
      days: typeof p.days === 'number' ? p.days : undefined,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      sessionId,
      lanes: normalizeLanes(p.lanes),
      maxChars: typeof p.max_chars === 'number' ? p.max_chars : undefined,
    };

    const rows = await readRawTranscripts(opts);
    // `rows._meta.warnings` is non-enumerable (JSON.stringify drops it) — surface it
    // explicitly in the wrapper so it never goes silent (design §6).
    const warnings = rows._meta.warnings;
    // Warnings presentation (Step 7): the op has no custom formatResult case, so the CLI
    // always serializes the { transcripts, warnings } wrapper as JSON to STDOUT — warnings
    // are therefore always machine-visible for `--json`/programmatic consumers (dw-improve).
    // For a HUMAN at a terminal there is no separate non-JSON renderer, so we ALSO echo the
    // warnings to STDERR (never stdout — keeps the JSON payload clean for `| jq`), matching
    // the repo's diagnostics-to-stderr convention (see CLAUDE.md "Bulk-action progress
    // reporting"). We only reach here when remote===false (the trust gate above throws for
    // remote callers), so this stderr note is the local CLI/dream surface only.
    if (warnings.length > 0) {
      for (const w of warnings) console.error(`raw-transcripts: ${w}`);
    }
    const format = p.format === 'markdown' ? 'markdown' : 'json';
    return format === 'markdown'
      ? { transcripts: rows.map((r) => r.markdown), warnings }
      : { transcripts: rows, warnings };
  },
  cliHints: { name: 'raw-transcripts' },
};

/** Fork-local op bundle — registered in operations.ts via a single trailing `...localOps`. */
export const localOps: Operation[] = [get_raw_transcripts];
