# Detailed Design — `get_raw_transcripts`: full-fidelity session reader

**Status:** design complete, ready for implementation plan.
**Standalone read:** this doc is self-contained; research/ has the evidence.

## 1. Overview

`get_recent_transcripts` (upstream gbrain, v0.29) returns `[]` on this brain and, even
when working, exposes only a **33% text-only slice** of each agent session. The 67% it
drops — tool calls, tool results, thinking — is exactly the signal self-improvement loops
need. This project adds a **fork-local** op, **`get_raw_transcripts`**, that reads agent
sessions at selectable fidelity (`text` | `full`) over a uniform local file tree covering
all 5 ingest lanes (local + cloud desktop), returns structured JSON with a markdown
renderer, and is consumable both ad hoc (CLI) and by self-improvement crons
(`dw-improve`). The upstream op is left untouched so `git merge origin/master` stays
clean.

### Goals
- G1. Full-fidelity reads (tool_use / tool_result / thinking preserved) for **all 5
  lanes**: `claude-code`, `claude-remote`, `kiro-local`, `kiro-remote`, `meshclaw-remote`.
- G2. Two access modes: **by recent window** (`days`/`limit`) and **by single session**
  (`id`/`slug`).
- G3. Two fidelity tiers: `text` (fast, conversation-only, supersedes the broken twin)
  and `full` (structured turns + tool + thinking).
- G4. Output: **structured JSON primary + markdown renderer**. Cap is a param (raised
  default; effectively uncapped for `full`), with an explicit truncation signal.
- G5. **Local-only** (raw transcripts are the most sensitive surface); NOT MCP-exposed.
- G6. Consumable by both ad hoc CLI and offline self-improve crons (no live SSH at read
  time → durable local mirror).
- G7. **Merge-clean:** ~1 line of upstream-file edit; all logic in fork-only
  `src/core/local-ops/`. Upstream `get_recent_transcripts` byte-unchanged.

### Non-goals
- NG1. Do NOT embed raw tool/thinking content into the brain (recall bloat + cost). Raw
  fidelity is a READ surface over files, orthogonal to ingest/recall. The text-tier `.md`
  ingest continues exactly as today.
- NG2. Do NOT reshape or deprecate the upstream op.
- NG3. Not a live-SSH-at-read-time tool (cron must work offline).
- NG4. No new UI beyond CLI + library/JSON.

## 2. Detailed Requirements (consolidated from idea-honing.md)

| # | Requirement |
|---|---|
| R1 | New fork-local op `get_raw_transcripts`, local-only, in `src/core/local-ops/`. |
| R2 | Fidelity `text` \| `full` (default `text`). |
| R3 | Access modes: by-window (`days`, `limit`) and by-session (`id`/`slug`). Mutually exclusive; session id wins if both given. |
| R4 | Reads all 5 lanes from a uniform local tree: local raw (`~/.claude/projects`, local kiro sqlite) + **durable remote mirror** for the 4 remote lanes. |
| R5 | `full` output = structured typed segments (role, text, tool_use{name,input}, tool_result{content,is_error}, thinking) as JSON + a markdown renderer that inlines tool/thinking blocks. |
| R6 | Cap is a param (`maxChars`, default ~500 KB; `full` effectively uncapped). Response carries a `truncated: bool` + `omittedChars` signal — never a silent slice. |
| R7 | Merge-clean: upstream files effectively untouched (≤1 registration line). Upstream `get_recent_transcripts` unchanged. |
| R8 | Out-of-repo: durable raw mirror for the 4 remote lanes (stop deleting `/tmp` copies; retain w/ 30-day retention); recover Kiro tool detail. |
| R9 | Out-of-repo: `dw-improve` gains `read.method: raw` to consume R1. |
| R10 | All-in-one delivery: R1–R9 land together. |
| R11 | Text tier supersedes the broken twin (reads `.md` + recurse) WITHOUT editing upstream `transcripts.ts`. |

## 3. Architecture Overview

```
                       READ SURFACE (fork-local, gbrain-src)
  ┌─────────────────────────────────────────────────────────────────────┐
  │  get_raw_transcripts (local op)  ──▶  reader (session-transcripts.ts) │
  │        │ mode: window | session          │                            │
  │        │ fidelity: text | full           ▼                            │
  │        │                        ┌──────────────────┐                  │
  │        │                        │ lane resolvers   │                  │
  │        │                        │  claude(jsonl)    │ tool_use/result/ │
  │        │                        │  kiro(sqlite blob)│ thinking → typed │
  │        │                        └──────────────────┘   segments       │
  │        ▼                                 │                             │
  │  render.ts  ◀── structured segments ─────┘                            │
  │   JSON (primary) + markdown (renders tool/thinking inline)            │
  └─────────────────────────────────────────────────────────────────────┘
                        reads from a UNIFORM LOCAL TREE ↓
  ┌─────────────────────────────────────────────────────────────────────┐
  │  local raw (persistent):  ~/.claude/projects/**/*.jsonl               │
  │                           ~/Library/.../kiro-cli/data.sqlite3         │
  │  durable remote mirror:   ~/.gbrain-sessions-raw/claude-remote/**     │  ← NEW (R8)
  │                           ~/.gbrain-sessions-raw/kiro-remote/data.sqlite3 │  (ONE db →
  └─────────────────────────────────────────────────────────────────────┘   2 lanes)

  LANE↔SOURCE MAP (5 lanes, 4 physical sources):
    claude-code       → ~/.claude/projects (local jsonl)
    kiro-local        → local kiro data.sqlite3
    claude-remote     → mirror claude-remote/**  (rsync'd jsonl)
    kiro-remote     ┐
    meshclaw-remote ┘ → ONE remote kiro data.sqlite3, split PER-CONVO by `meshclaw`-in-key
                        (mirrors collector's split_remote — see §4.2)
        ▲ populated by out-of-repo collectors (durable, retention-pruned)

  INGEST/RECALL PATH (UNCHANGED — text-tier .md still staged, imported, embedded)
  ~/.gbrain-sessions-staging/<lane>/*.md ── gbrain import ──▶ session pages ──▶ search/query
```

Two independent planes: the **read surface** (new, over raw files) and the **ingest/recall
plane** (unchanged). They share source data but never the same code path.

## 4. Components and Interfaces

### 4.1 `src/core/local-ops/session-transcripts.ts` (reader core) — NEW
```ts
export type Fidelity = 'text' | 'full';
export interface Segment {
  kind: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  role?: 'user' | 'assistant';
  text?: string;                       // text | thinking
  tool?: { name: string; input: unknown };      // tool_use
  result?: { content: string; isError?: boolean }; // tool_result
}
export interface RawTranscript {
  id: string;              // session id (jsonl stem / kiro conversation_id)
  lane: 'claude-code'|'claude-remote'|'kiro-local'|'kiro-remote'|'meshclaw-remote';
  project?: string;        // project/key label
  date: string | null;     // ISO; first-turn ts or updated_at
  mtime: string;
  bytes: number;           // raw source size
  segments?: Segment[];    // full fidelity only
  text?: string;           // text fidelity: conversation-only markdown
  markdown: string;        // rendered view (both tiers)
  truncated: boolean;
  omittedChars: number;
}
export interface RawReadOpts {
  fidelity?: Fidelity;            // default 'text'
  days?: number;                  // window mode (default 7)
  limit?: number;                 // window mode (default 50)
  sessionId?: string;             // session mode (id or page slug)
  lanes?: string[];               // default all 5
  maxChars?: number;              // default 500_000; ignored/huge for 'full'
}
export async function readRawTranscripts(opts: RawReadOpts): Promise<RawTranscript[]>;
```
- **Lane resolution**: a small table mapping lane → root + parser. Claude lanes →
  jsonl parser; Kiro lanes → sqlite blob parser. Remote lanes point at the durable
  mirror; local lanes at the live dirs.
- **File walk**: recursive `.jsonl` discovery (mirror of `discoverTranscripts.walk()` +
  `pruneDir`; copied ~30 lines into local-ops to avoid editing the upstream file, with a
  comment noting the shared origin). Newest-first by mtime.
- **Session mode**: resolve `sessionId` to a file (jsonl stem match) or a kiro
  `conversation_id`; return the single full transcript.

### 4.2 Parsers
- **`claude-jsonl.ts`** — parse one `.jsonl`:
  - `text` tier: reproduce the collector's user/assistant text join (parity with staged
    `.md`, so the two tiers agree).
  - `full` tier: emit typed `Segment[]` — `text`, `thinking`, `tool_use{name,input}`,
    `tool_result{content,isError}` — from the `message.content` block array, in order.
- **`kiro-sqlite.ts`** — open `data.sqlite3` read-only (`?mode=ro`), select
  `conversations_v2` rows within window / by id; parse the `value` JSON blob:
  - `text` tier: prefer pre-rendered `transcript` (parity with collector).
  - `full` tier: walk `history[].user/assistant`, extracting the tool_use / tool_result /
    thinking structures the blob carries (confirmed present — research/06).
  - **`splitRemote` flag (parity with collector):** the REMOTE kiro sqlite is ONE db
    holding BOTH lanes. When `splitRemote=true`, route each row per-convo: `key` contains
    `meshclaw` (case-insensitive) → lane `meshclaw-remote`; else → `kiro-remote`. Local
    kiro (`kiro-local`) is a separate db → no split. So a single sqlite parser + a
    `lanes` filter serves 3 of the 5 lanes; the reader dedups the one physical remote db
    read even when both remote-kiro lanes are requested. (research/08)

### 4.3 `src/core/local-ops/render.ts` — NEW
- `toMarkdown(t: RawTranscript): string` — frontmatter + turns; in `full`, inline
  ` ```tool_use name … ``` ` / ` ```tool_result … ``` ` / `> thinking` blocks. Used to
  populate `markdown`. Strips nothing silently; truncation only via `maxChars` with the
  explicit signal.

### 4.4 `src/core/local-ops/session-transcripts-op.ts` — NEW (the op)
```ts
export const get_raw_transcripts: Operation = {
  name: 'get_raw_transcripts',
  description: GET_RAW_TRANSCRIPTS_DESCRIPTION,  // local const, NOT operations-descriptions.ts
  scope: 'read',
  localOnly: true,
  params: { fidelity, days, limit, session_id, lanes, max_chars, format },
  handler: async (ctx, p) => {
    if (ctx.remote === true) throw new OperationError('permission_denied',
      'get_raw_transcripts is local-only — call via the gbrain CLI.');
    const rows = await readRawTranscripts({...});
    return p.format === 'markdown' ? rows.map(r => r.markdown) : rows;
  },
  cliHints: { name: 'raw-transcripts' },
};
export const localOps = [get_raw_transcripts];
```
- Trust gate mirrors the upstream op verbatim (defense in depth). `localOnly:true` hides
  it from HTTP tool-list; handler re-checks `ctx.remote`.

### 4.5 Registration seam (the ONLY upstream touch) — `src/core/operations.ts`
- Preferred: at the end of the `operations` array add ONE line on its own:
  `...localOps,  // FORK-LOCAL (davidtwu) — see src/core/local-ops/; do not upstream`
  plus a one-line `import { localOps } from './local-ops/session-transcripts-op.ts'`.
- Upstream appends ABOVE this trailing line each release → conflicts rare + trivial.
- (Alternative if we want ZERO array edit: concat at each consumer. Rejected as more
  surface; the single trailing line is simplest and low-risk.)

### 4.6 Out-of-repo workstream A — durable raw mirror (R8)
`~/.gbrain-bin/gbrain-collect-sessions-cloud` (+ `.py`):
- Change remote Claude rsync target `/tmp/remote-claude-projects` → persistent
  `~/.gbrain-sessions-raw/claude-remote/`; DROP the `rm -rf` cleanup for it.
- Keep a durable copy of the pulled kiro snapshot →
  `~/.gbrain-sessions-raw/kiro-remote/data.sqlite3` (instead of deleting the `/tmp`
  copy). NOTE: this ONE db feeds BOTH `kiro-remote` and `meshclaw-remote` lanes — the
  reader applies the `meshclaw`-key split at read time (§4.2). Do not try to
  pre-split into two files.
- Add retention: prune raw-mirror files older than `SESS_CUTOFF_DAYS` (30d).
- `.gitignore` + `chmod 700` the raw dir; local-only, never embedded.
- Local lanes need no mirror (live dirs are already durable).

### 4.7 Out-of-repo workstream B — dw-improve rewire (R9)
`context/dw-improve/config.yaml`: add `read.method: raw` option; `select.py` gains a raw
reader path that shells `gbrain raw-transcripts --fidelity full --json` (or imports the
library). Flip `read.method` to `raw` once R1 lands.

## 5. Data Models
- `RawTranscript` / `Segment` — §4.1.
- Kiro `conversations_v2(key, conversation_id, value, created_at, updated_at)`; fidelity
  ceiling confirmed to include tool detail (research/06).
- Claude `.jsonl` record: `{type, message:{role,content[]}, timestamp}`; content blocks
  `text|thinking|tool_use|tool_result` (research/04).

## 6. Error Handling
- Missing lane dir / mirror not yet populated → skip lane, include a `warnings[]` note in
  a `_meta` field (never silent — the prior tool's silent `[]` is the bug we're killing).
- Unreadable/%corrupt jsonl line → skip line, continue (parity with collector).
- Kiro sqlite locked / absent → skip lane with warning.
- `remote:true` → `permission_denied` (local-only).
- Truncation → `truncated:true` + `omittedChars` (explicit).
- Session id not found → empty result + `warnings: ['session <id> not found in lanes …']`.

## 7. Testing Strategy
- **Unit (fork-local, `test/local-ops/`)**:
  - claude-jsonl parser: text-tier parity with the collector's join; full-tier emits
    tool_use/tool_result/thinking segments in order; skips malformed lines.
  - kiro-sqlite parser: text-tier prefers `transcript`; full-tier recovers tool detail
    from `history`; ro-open; window + by-id.
  - render: markdown includes tool/thinking blocks in full, omits in text; truncation
    signal correct.
  - reader: window newest-first; session mode; lane filtering; maxChars cap + signal;
    missing-lane warning (no silent []).
- **Trust boundary**: `remote:true` → permission_denied; op absent from HTTP tool-list;
  present on local CLI. (New fork-local test mirroring `operations-trust-boundary.test.ts`
  but in `test/local-ops/` so it doesn't conflict.)
- **Merge-safety guard**: a test asserting upstream `get_recent_transcripts` is unchanged
  (its description const + behavior) so we notice if a merge accidentally reshapes it.
- **Drift guard**: a note/test that the copied file-walk matches `discoverTranscripts`'s
  intent (`.md`+`.txt`, recursive, prune) — so the two don't silently diverge again.
- **E2E (fixtures)**: a tiny fixture jsonl + fixture sqlite → full pipeline → JSON +
  markdown snapshots. NO real session content in fixtures (privacy).
- **Out-of-repo**: dry-run the collector change (`SESS_DRY`) to confirm the mirror path
  + retention; manual verify dw-improve `read.method: raw` reads full fidelity.

## 8. Appendices

### 8.1 Technology choices
- **New op vs extend (chosen: new local op).** Pros: upstream untouched → merge-clean;
  raw reader clearly "ours"; free to evolve. Cons: two transcript ops coexist (mitigated:
  distinct names + descriptions; upstream one is the light text scanner).
- **Durable mirror vs live SSH (chosen: durable mirror, R1).** Offline crons can't depend
  on flaky Midway SSH; mirror gives a uniform local tree. Cost: ~3× staged disk (bounded
  by 30d retention).
- **JSON + markdown (chosen).** JSON for programmatic self-improve; markdown for
  human/LLM reading. `format` param selects; JSON default.
- **Copy the walk vs import upstream helper.** `listTextFiles` isn't exported; copying ~30
  lines keeps the upstream file untouched (merge-clean) at the cost of minor duplication
  (guarded by a drift note/test).

### 8.2 Research findings (summary; full in research/01–07)
- Sessions already ingested as text-only `.md` pages (queryable); the broken tool is a
  redundant raw-file reader (research/01, 03).
- Fidelity: staged `.md` = 33% of raw; dropped 67% (tool_use 29% + tool_result 38% +
  thinking) is what self-improvement needs (research/04).
- Import is NOT 100 KB-capped; recall already spans the whole `.md` (86 chunks measured).
  The 100 KB cap is a `get_recent_transcripts`-only artifact (research/04).
- Kiro sqlite holds full tool detail → full fidelity achievable for all 5 lanes
  (research/06).
- `dw-improve` reads the lossy staging view today (`read.method: staging`) — confirmed
  value gap (research/06).
- Upstream provenance + merge-hot files; fork-local dir = conflict-free seam (research/07).

### 8.3 Alternatives considered & rejected
- **B — page-backed op**: duplicates `query --type session`, text-only, doesn't serve
  self-improvement. Rejected.
- **A-only — fix the .md twin in place**: text-only; edits upstream file (merge cost);
  doesn't serve self-improvement. Folded in as the superseding text tier instead.
- **E — richer staging (embed tool/thinking)**: recall bloat + cost + noise; wrong
  default. Rejected (NG1).
- **whoami/stdio transport fix**: intended fail-closed behavior, orthogonal, out of scope
  (research/02).
```
