// FORK-LOCAL (davidtwu) — the reader core for the get_raw_transcripts read surface.
// Resolves the 5 ingest lanes to their 4 physical sources, walks/reads each, merges
// newest-first, applies the maxChars cap, and renders markdown. Do NOT upstream — all
// fork-only logic lives under src/core/local-ops/ so `git merge origin/master` stays
// clean.
//
// See design §4.1 (readRawTranscripts + RawReadOpts + the LANE↔SOURCE MAP), §6 (error
// handling — "never a silent [] without a reason"), + research/07 (merge-clean file-walk)
// + research/08 (5 lanes → 4 physical sources; the ONE remote kiro db feeds BOTH
// kiro-remote and meshclaw-remote, split at read time).
//
// LANE → SOURCE (design §3 map):
//   claude-code       → ~/.claude/projects                       (recursive *.jsonl walk)
//   claude-remote     → ~/.gbrain-sessions-raw/claude-remote     (recursive *.jsonl walk)
//   kiro-local        → ~/Library/Application Support/kiro-cli/data.sqlite3
//                       (splitRemote:false, lane 'kiro-local')
//   kiro-remote     ┐
//   meshclaw-remote ┘ → ~/.gbrain-sessions-raw/kiro-remote/data.sqlite3
//                       (ONE read, splitRemote:true, then filter to requested lanes)
//
// TWO ACCESS MODES (design R3):
//   WINDOW MODE (Step 4)  — by recent `days`/`limit`, merged newest-first across lanes.
//   BY-ID MODE  (Step 5)  — `opts.sessionId` returns the SINGLE matching full transcript;
//                           session id WINS over the window and BYPASSES the age filter.
//
// NON-SILENT WARNINGS (Step 5, design §6): a missing lane dir/db (window mode) or an
// unknown session id (by-id mode) never produces a silent []. Warnings are surfaced via
// a non-enumerable `_meta.warnings` property on the returned array (see RawTranscriptsResult
// + withMeta below) — backward-compatible with Step 4's `RawTranscript[]` return, so
// callers that only touch array methods (Step 4's test, Step 6's op) are unaffected.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

import type { RawReadOpts, RawTranscript } from './types.ts';
import { parseClaudeJsonl } from './claude-jsonl.ts';
import { readKiroSqlite, type KiroReadOpts } from './kiro-sqlite.ts';
import { renderAndCap } from './render.ts';

// --- defaults (design §4.1) --------------------------------------------------------
const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 50;
/** Text-tier cap (design §4.1 / R6). `full` is effectively uncapped (Infinity). */
const DEFAULT_TEXT_MAX_CHARS = 500_000;
const ALL_LANES: RawTranscript['lane'][] = [
  'claude-code',
  'claude-remote',
  'kiro-local',
  'kiro-remote',
  'meshclaw-remote',
];

/**
 * Path-override / DI seam for the reader's 4 physical sources.
 *
 * This is the mechanism TESTS use to point the reader at temp fixture dirs so it
 * NEVER touches the user's real sessions — and the seam Step 5 (session-by-id) and
 * Step 6 (the op) reuse. Precedence per field: `sources` arg > `GBRAIN_RAW_*` env >
 * home-dir default. `readKiro` is an optional injectable kiro reader (defaults to
 * `readKiroSqlite`); the reader-window test wraps it with a counter to PROVE the
 * remote db is opened exactly once even when both remote-kiro lanes are requested.
 */
export interface RawReadSources {
  /** claude-code lane root (recursive *.jsonl). Default ~/.claude/projects */
  claudeCodeDir?: string;
  /** claude-remote lane root (recursive *.jsonl). Default ~/.gbrain-sessions-raw/claude-remote */
  claudeRemoteDir?: string;
  /** kiro-local db. Default ~/Library/Application Support/kiro-cli/data.sqlite3 */
  kiroLocalDb?: string;
  /** kiro-remote + meshclaw-remote share this ONE db. Default ~/.gbrain-sessions-raw/kiro-remote/data.sqlite3 */
  kiroRemoteDb?: string;
  /** DI seam (tests/Step 6): override the kiro reader; defaults to readKiroSqlite. */
  readKiro?: (dbPath: string, opts: KiroReadOpts) => RawTranscript[];
}

interface ResolvedSources {
  claudeCodeDir: string;
  claudeRemoteDir: string;
  kiroLocalDb: string;
  kiroRemoteDb: string;
  readKiro: (dbPath: string, opts: KiroReadOpts) => RawTranscript[];
}

function resolveSources(sources?: RawReadSources): ResolvedSources {
  const home = homedir();
  const env = process.env;
  return {
    claudeCodeDir:
      sources?.claudeCodeDir ??
      env.GBRAIN_RAW_CLAUDE_CODE_DIR ??
      join(home, '.claude', 'projects'),
    claudeRemoteDir:
      sources?.claudeRemoteDir ??
      env.GBRAIN_RAW_CLAUDE_REMOTE_DIR ??
      join(home, '.gbrain-sessions-raw', 'claude-remote'),
    kiroLocalDb:
      sources?.kiroLocalDb ??
      env.GBRAIN_RAW_KIRO_LOCAL_DB ??
      join(home, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3'),
    kiroRemoteDb:
      sources?.kiroRemoteDb ??
      env.GBRAIN_RAW_KIRO_REMOTE_DB ??
      join(home, '.gbrain-sessions-raw', 'kiro-remote', 'data.sqlite3'),
    readKiro: sources?.readKiro ?? readKiroSqlite,
  };
}

// --- non-silent warnings channel (Step 5, design §6) -------------------------------

/** Metadata surfaced alongside the transcripts. Step 6's op reads `warnings` to relay
 *  them to callers (never a silent skip). */
export interface RawReadMeta {
  /** Human-readable notes: a missing lane source (window mode) or an unknown session
   *  id (by-id mode). Empty when everything requested was found. */
  warnings: string[];
}

/**
 * The reader's return value: a `RawTranscript[]` (Step 4's contract, UNCHANGED for
 * every array consumer) carrying a NON-ENUMERABLE `_meta` property.
 *
 * WHY this shape (design §6 says "surface via a `_meta` field"): it is the
 * least-disruptive option — the value still IS a `RawTranscript[]`, so Step 4's test
 * and Step 6's op keep using `.map`/`.find`/`.length`/index access with zero changes,
 * while `_meta.warnings` is reliably reachable for the op. `_meta` is non-enumerable so
 * `JSON.stringify(rows)` (the op's `--json` row output) serializes ONLY the array
 * elements — the op must surface `rows._meta.warnings` explicitly (e.g. to stderr or a
 * wrapper), NOT expect them inside the JSON rows.
 */
export type RawTranscriptsResult = RawTranscript[] & { _meta: RawReadMeta };

/** Attach the non-enumerable `_meta` and return the array as a RawTranscriptsResult. */
function withMeta(rows: RawTranscript[], warnings: string[]): RawTranscriptsResult {
  Object.defineProperty(rows, '_meta', {
    value: { warnings } satisfies RawReadMeta,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return rows as RawTranscriptsResult;
}

/** Resolve the requested-lanes set (opts.lanes, filtered to valid lanes; default all 5). */
function computeRequested(lanes?: string[]): Set<RawTranscript['lane']> {
  return new Set<RawTranscript['lane']>(
    (lanes && lanes.length > 0 ? (lanes as RawTranscript['lane'][]) : ALL_LANES).filter(
      (l): l is RawTranscript['lane'] => (ALL_LANES as string[]).includes(l as string),
    ),
  );
}

// --- file walk (COPIED from src/core/cycle/transcript-discovery.ts listTextFiles +
// src/core/sync.ts pruneDir, ~30 lines, to keep the upstream files UNTOUCHED per
// research/07). Adapted here to accept `.jsonl` (the Claude session extension) instead
// of `.md`/`.txt`. Shared origin noted so a future upstream walk change can be mirrored;
// the Step 7 drift-guard test asserts this copy still accepts `.jsonl`. ------------------

/** Directory names never worth descending into (mirror of sync.ts PRUNE_DIR_NAMES). */
const PRUNE_DIR_NAMES = new Set<string>([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'venv',
  '.raw',
  'ops',
]);

/** Descent-time prune: skip dotfiles and known vendor/build trees (mirror of
 *  sync.ts pruneDir, minus the submodule-gitfile check which session dirs don't need). */
function pruneDir(name: string): boolean {
  if (!name) return true;
  if (name.startsWith('.')) return false;
  if (PRUNE_DIR_NAMES.has(name)) return false;
  if (name.endsWith('.raw')) return false;
  return true;
}

/** Recursive `.jsonl` discovery with descent-time pruning. Sorted for determinism.
 *  Exported (fork-local) so the Step 7 drift-guard test can assert this copied walk still
 *  accepts `.jsonl`, ignores `.md`/`.txt`, and prunes vendor dirs — the divergence class
 *  (two readers disagreeing on file extension) that caused the original bug. */
export function listJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string) {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      // missing/unreadable dir — skip (the caller's existsSync pre-check turns a
      // missing lane root into a warning; this guards deeper unreadable subdirs).
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          if (!pruneDir(name)) continue;
          walk(full);
        } else if (st.isFile() && name.endsWith('.jsonl')) {
          out.push(full);
        }
      } catch {
        // skip unreadable entries
      }
    }
  }
  walk(dir);
  return out.sort();
}

// --- lane readers ------------------------------------------------------------------

/** Resolve the effective maxChars cap. Explicit opts wins; else text→500k, full→uncapped.
 *  `fidelity` is passed in because window mode defaults to 'text' but by-id defaults to
 *  'full' — the cap policy must follow the mode's effective fidelity. */
function resolveMaxChars(opts: RawReadOpts, fidelity: 'text' | 'full'): number {
  if (typeof opts.maxChars === 'number') return opts.maxChars;
  return fidelity === 'full' ? Infinity : DEFAULT_TEXT_MAX_CHARS;
}

/** Stat + read + parse ONE Claude jsonl file into a RawTranscript (no window filter, no
 *  render). Shared by window mode (after the cutoff check) and by-id mode (which
 *  bypasses the window). Returns null on stat/read failure. */
function parseOneClaudeFile(
  filePath: string,
  lane: RawTranscript['lane'],
  fidelity: 'text' | 'full',
): RawTranscript | null {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  // id = full jsonl stem (unique per session — the by-id match target).
  // project = parent dir name (Claude encodes the project in the enclosing dir).
  const stem = basename(filePath, '.jsonl');
  const parent = basename(dirname(filePath));
  return parseClaudeJsonl(raw, {
    id: stem,
    lane,
    project: parent,
    mtime: new Date(st.mtimeMs).toISOString(),
    bytes: st.size,
    fidelity,
  });
}

/** Walk one Claude jsonl lane dir, parse each file within the window into a transcript. */
function readClaudeLane(
  dir: string,
  lane: RawTranscript['lane'],
  fidelity: 'text' | 'full',
  cutoffMs: number,
): RawTranscript[] {
  const out: RawTranscript[] = [];
  for (const filePath of listJsonlFiles(dir)) {
    let st;
    try {
      st = statSync(filePath);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoffMs) continue; // window filter (mirror kiro's updated_at > cutoff)
    const t = parseOneClaudeFile(filePath, lane, fidelity);
    if (t) out.push(t);
  }
  return out;
}

/** Window-mode Claude lane read with a non-silent missing-source warning (design §6):
 *  a missing lane root dir emits a warning and skips (never a silent []). */
function readClaudeLaneOrWarn(
  dir: string,
  lane: RawTranscript['lane'],
  fidelity: 'text' | 'full',
  cutoffMs: number,
  warnings: string[],
): RawTranscript[] {
  if (!existsSync(dir)) {
    warnings.push(`${lane}: source directory not found (${dir}) — lane skipped`);
    return [];
  }
  try {
    return readClaudeLane(dir, lane, fidelity, cutoffMs);
  } catch {
    warnings.push(`${lane}: source directory unreadable (${dir}) — lane skipped`);
    return [];
  }
}

/** Window-mode Kiro db read with a non-silent missing/unreadable-source warning. The
 *  existsSync pre-check means a missing db is reported (not a swallowed ro-open throw)
 *  AND the db is never opened — so the single-open guarantee the reader-window test
 *  asserts still holds (readKiro is called at most once for the remote db). */
function readKiroDbOrWarn(
  readKiro: (dbPath: string, opts: KiroReadOpts) => RawTranscript[],
  dbPath: string,
  kiroOpts: KiroReadOpts,
  laneLabel: string,
  warnings: string[],
): RawTranscript[] {
  if (!existsSync(dbPath)) {
    warnings.push(`${laneLabel}: kiro db not found (${dbPath}) — lane skipped`);
    return [];
  }
  try {
    return readKiro(dbPath, kiroOpts);
  } catch {
    warnings.push(`${laneLabel}: kiro db unreadable (${dbPath}) — lane skipped`);
    return [];
  }
}

/** Sort key: prefer mtime, fall back to date. ISO strings sort chronologically. */
function sortKey(t: RawTranscript): string {
  return t.mtime || t.date || '';
}

/**
 * BY-ID MODE (design R3): resolve `opts.sessionId` to the SINGLE matching transcript.
 *
 * - Claude lanes: match a `.jsonl` whose stem === sessionId, searching ALL files and
 *   DELIBERATELY BYPASSING the age/window filter (a by-id read is the self-improve
 *   "drill into one old session" case).
 * - Kiro lanes: `readKiro(..., { conversationId })` — id wins over window inside the
 *   sqlite parser; a match returns exactly one row, lane already stamped (the remote db
 *   is opened ONCE with splitRemote, then filtered to the requested lanes).
 * - Fidelity: defaults to 'full' (deep read) UNLESS `opts.fidelity` is set explicitly.
 * - Unknown id → returns [] AND pushes a `session <id> not found in lanes [...]` warning
 *   (never a silent []). Does NOT throw.
 */
function readBySessionId(
  opts: RawReadOpts,
  resolved: ResolvedSources,
  requested: Set<RawTranscript['lane']>,
  warnings: string[],
): RawTranscript[] {
  const sessionId = opts.sessionId as string;
  // By-id is the self-improve "drill into ONE session" use case → 'full' by default,
  // but an explicit opts.fidelity wins (design R3 + Step 5 guidance).
  const fidelity: 'text' | 'full' = opts.fidelity ?? 'full';
  const maxChars = resolveMaxChars(opts, fidelity);
  const found: RawTranscript[] = [];

  // --- Claude lanes: stem === sessionId across ALL files (age/window BYPASSED). ---
  const claudeLanes: Array<[RawTranscript['lane'], string]> = [];
  if (requested.has('claude-code')) claudeLanes.push(['claude-code', resolved.claudeCodeDir]);
  if (requested.has('claude-remote'))
    claudeLanes.push(['claude-remote', resolved.claudeRemoteDir]);
  for (const [lane, dir] of claudeLanes) {
    for (const filePath of listJsonlFiles(dir)) {
      if (basename(filePath, '.jsonl') !== sessionId) continue;
      const t = parseOneClaudeFile(filePath, lane, fidelity);
      if (t) found.push(renderAndCap(t, maxChars, fidelity));
    }
  }

  // --- Kiro lanes: conversation_id match (readKiroSqlite: id wins over window). ---
  if (requested.has('kiro-local') && existsSync(resolved.kiroLocalDb)) {
    try {
      const rows = resolved.readKiro(resolved.kiroLocalDb, {
        fidelity,
        conversationId: sessionId,
        splitRemote: false,
        lane: 'kiro-local',
      });
      for (const r of rows) found.push(renderAndCap(r, maxChars, fidelity));
    } catch {
      // unreadable → treated as not-found here (the aggregate warning below covers it).
    }
  }
  const wantsKiroRemote = requested.has('kiro-remote');
  const wantsMeshclaw = requested.has('meshclaw-remote');
  // ONE open of the remote db even in by-id mode (mirrors window mode's single-open).
  if ((wantsKiroRemote || wantsMeshclaw) && existsSync(resolved.kiroRemoteDb)) {
    try {
      const rows = resolved.readKiro(resolved.kiroRemoteDb, {
        fidelity,
        conversationId: sessionId,
        splitRemote: true, // routes each matched row to kiro-remote | meshclaw-remote by key
      });
      for (const r of rows) {
        if (requested.has(r.lane)) found.push(renderAndCap(r, maxChars, fidelity));
      }
    } catch {
      // unreadable → not-found (aggregate warning below).
    }
  }

  // Unknown id → non-silent (design §6): report the id + which lanes were searched.
  if (found.length === 0) {
    warnings.push(`session ${sessionId} not found in lanes [${[...requested].join(', ')}]`);
  }
  return found;
}

/**
 * Read raw session transcripts across the requested lanes.
 *
 * Two access modes (design R3):
 *  - BY-ID: if `opts.sessionId` is set it WINS over the window and returns the single
 *    matching full transcript (age/window filter bypassed); unknown id → [] + a warning.
 *  - WINDOW: otherwise, read each requested lane within the `days` window, merge
 *    newest-first by mtime/date, apply `limit`, then render + cap each. The ONE physical
 *    remote kiro db is read at most ONCE even when both `kiro-remote` and
 *    `meshclaw-remote` are requested (rows are split by key at read time, then filtered).
 *
 * Return: a `RawTranscript[]` (Step 4's contract, unchanged for array consumers) carrying
 * a non-enumerable `_meta.warnings` (see RawTranscriptsResult). A missing lane source
 * (window) or an unknown id (by-id) is reported there — never a silent [] (design §6).
 *
 * `sources` is the path-override / DI seam (see RawReadSources) so callers — chiefly
 * TESTS — can point at temp fixtures without touching the user's real sessions.
 */
export async function readRawTranscripts(
  opts: RawReadOpts,
  sources?: RawReadSources,
): Promise<RawTranscriptsResult> {
  const resolved = resolveSources(sources);
  const requested = computeRequested(opts.lanes);
  const warnings: string[] = [];

  // ---- BY-ID MODE (session id wins over window; bypasses the age filter) ----------
  if (opts.sessionId) {
    const found = readBySessionId(opts, resolved, requested, warnings);
    return withMeta(found, warnings);
  }

  // ---- WINDOW MODE ----------------------------------------------------------------
  const fidelity = opts.fidelity ?? 'text';
  const days = opts.days ?? DEFAULT_DAYS;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const maxChars = resolveMaxChars(opts, fidelity);
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const collected: RawTranscript[] = [];

  // --- Claude lanes (recursive jsonl walk) ---
  if (requested.has('claude-code')) {
    collected.push(
      ...readClaudeLaneOrWarn(resolved.claudeCodeDir, 'claude-code', fidelity, cutoffMs, warnings),
    );
  }
  if (requested.has('claude-remote')) {
    collected.push(
      ...readClaudeLaneOrWarn(
        resolved.claudeRemoteDir,
        'claude-remote',
        fidelity,
        cutoffMs,
        warnings,
      ),
    );
  }

  // --- local kiro (its own db, no split) ---
  if (requested.has('kiro-local')) {
    collected.push(
      ...readKiroDbOrWarn(
        resolved.readKiro,
        resolved.kiroLocalDb,
        { fidelity, cutoffMs, splitRemote: false, lane: 'kiro-local' },
        'kiro-local',
        warnings,
      ),
    );
  }

  // --- remote kiro: ONE db feeds BOTH kiro-remote + meshclaw-remote (research/08).
  // Read it ONCE with splitRemote, then filter to the requested lanes. This is the
  // single-open guarantee the reader-window test asserts via a wrapped readKiro counter.
  const wantsKiroRemote = requested.has('kiro-remote');
  const wantsMeshclaw = requested.has('meshclaw-remote');
  if (wantsKiroRemote || wantsMeshclaw) {
    const remoteLaneLabel = [
      wantsKiroRemote ? 'kiro-remote' : null,
      wantsMeshclaw ? 'meshclaw-remote' : null,
    ]
      .filter((x): x is string => x !== null)
      .join('/');
    const rows = readKiroDbOrWarn(
      resolved.readKiro,
      resolved.kiroRemoteDb,
      { fidelity, cutoffMs, splitRemote: true },
      remoteLaneLabel,
      warnings,
    );
    for (const r of rows) {
      if (requested.has(r.lane)) collected.push(r);
    }
  }

  // --- merge newest-first, apply limit, then render + cap each ---
  collected.sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : 0));
  const windowed = collected.slice(0, limit);
  return withMeta(
    windowed.map((t) => renderAndCap(t, maxChars, fidelity)),
    warnings,
  );
}
