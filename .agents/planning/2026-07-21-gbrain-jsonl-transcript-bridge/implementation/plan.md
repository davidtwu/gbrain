# Implementation Plan — `get_raw_transcripts`

Test-driven, incremental. Each step is a working, demoable increment; tests are written
with the code that introduces the behavior (never a trailing "add tests" step). Steps
build forward and end by wiring into the op + CLI, then the out-of-repo workstreams.

Design ref: `../design/detailed-design.md`. Research: `../research/01–08`.

## Progress checklist
- [ ] Step 1 — Types + claude-jsonl parser (text + full), fixtures
- [ ] Step 2 — kiro-sqlite parser (text + full) with `splitRemote`
- [ ] Step 3 — Markdown renderer + truncation signal
- [ ] Step 4 — Reader: lane resolution, window mode, single-source dedup
- [ ] Step 5 — Reader: session-by-id mode + missing-lane warnings
- [ ] Step 6 — The local op `get_raw_transcripts` + trust gate + registration seam
- [ ] Step 7 — CLI surface `gbrain raw-transcripts` + merge-safety/drift guard tests
- [ ] Step 8 — Out-of-repo: durable raw mirror (cloud collector) + retention
- [ ] Step 9 — Out-of-repo: dw-improve `read.method: raw`
- [ ] Step 10 — End-to-end verification + docs

---

### Step 1: Types + Claude `.jsonl` parser (both fidelity tiers)
**Objective.** Establish `Segment`/`RawTranscript` types and a pure parser that turns one
Claude `.jsonl` file into a `RawTranscript` at `text` or `full` fidelity.

**Guidance.** New files: `src/core/local-ops/types.ts`, `src/core/local-ops/claude-jsonl.ts`.
- `text`: reproduce the collector's join (only `type in user|assistant`, text blocks,
  `**role:** text`) so the text tier matches the staged `.md` byte-for-byte in spirit.
- `full`: emit ordered `Segment[]` — `text`, `thinking`, `tool_use{name,input}`,
  `tool_result{content,isError}` — from `message.content[]`. Skip malformed JSON lines.
- Pure function `parseClaudeJsonl(raw: string, meta): RawTranscript`; no fs here.

**Tests (`test/local-ops/claude-jsonl.test.ts`).**
- text-tier parity: given a fixture jsonl, output equals the expected collector-style join.
- full-tier: tool_use/tool_result/thinking segments present, in original order.
- malformed line skipped; empty/whitespace content dropped; date = first timestamp.

**Integration.** Foundation types used by every later step.

**Demo.** `bun test test/local-ops/claude-jsonl.test.ts` green; a REPL/script call parses a
committed fixture and prints both tiers.

---

### Step 2: Kiro sqlite parser with `splitRemote`
**Objective.** Parse `conversations_v2` rows into `RawTranscript[]` at both tiers, with the
`meshclaw`-key split for the remote DB.

**Guidance.** New file `src/core/local-ops/kiro-sqlite.ts`.
- Open read-only (`file:${path}?mode=ro`). Query by window (`updated_at > cutoff`) or by
  `conversation_id`.
- `text`: prefer pre-rendered `transcript` list; fall back to `history` join (parity with
  collector).
- `full`: walk `history[].user/assistant`, extract tool_use/tool_result/thinking segments
  (confirmed present, research/06).
- `splitRemote` flag: route each row's lane by `"meshclaw" in key.lower()` (research/08).
  Local kiro → no split.

**Tests (`test/local-ops/kiro-sqlite.test.ts`).** Build a tiny in-test sqlite fixture
(temp file) with 2 rows: one meshclaw-keyed, one not, each carrying tool detail.
- window select returns both; `splitRemote` routes them to `meshclaw-remote` vs
  `kiro-remote`.
- full-tier recovers tool_use/tool_result; text-tier prefers `transcript`.
- by-id select returns exactly one; ro-open (no write lock taken).

**Integration.** Second source parser feeding the reader (Step 4).

**Demo.** `bun test test/local-ops/kiro-sqlite.test.ts` green; script parses the fixture db
and shows the two lanes split correctly.

---

### Step 3: Markdown renderer + truncation signal
**Objective.** Render a `RawTranscript` to markdown (tool/thinking inline in `full`, omitted
in `text`) and implement the `maxChars` cap with an explicit `truncated`/`omittedChars`.

**Guidance.** New file `src/core/local-ops/render.ts`: `toMarkdown(t)`; a `applyCap(text,
maxChars)` returning `{text, truncated, omittedChars}`. Frontmatter (id/lane/date) + turns;
` ```tool_use / tool_result ``` ` fenced blocks and `> thinking` blockquotes in `full`.

**Tests (`test/local-ops/render.test.ts`).**
- full markdown includes tool/thinking blocks; text markdown does not.
- cap under limit → `truncated:false, omittedChars:0`; over limit → trims + exact
  `omittedChars`; never silent.

**Integration.** Populates `markdown` + cap fields on every `RawTranscript`.

**Demo.** Snapshot test shows a fixture rendered both tiers; a >maxChars fixture reports
truncation counts.

---

### Step 4: Reader — lane resolution, window mode, single-source dedup
**Objective.** `readRawTranscripts(opts)` in window mode: resolve requested lanes to
sources, walk/parse, merge newest-first, apply cap+render, dedup the one physical remote
kiro DB across its two lanes.

**Guidance.** New file `src/core/local-ops/session-transcripts.ts`.
- Lane→source table (design §4.1 map). Recursive `.jsonl` walk (copy `discoverTranscripts`'s
  `walk()`+`pruneDir` ~30 lines; comment the shared origin — research/07).
- If both `kiro-remote` and `meshclaw-remote` requested, read the remote DB ONCE, route
  rows to lanes (no double open).
- Respect `fidelity`, `days`, `limit`, `lanes`, `maxChars`.

**Tests (`test/local-ops/reader-window.test.ts`).** Point opts at a temp tree with
fixtures for each lane (local jsonl dir, local kiro db, mirror claude dir, mirror remote
kiro db).
- returns newest-first across lanes; `limit` respected; `lanes` filter works.
- both remote-kiro lanes requested → remote db opened once (spy/counter), rows split.
- fidelity flows through to segments/markdown.

**Integration.** First end-to-end read path (fixtures). Uses Steps 1–3.

**Demo.** Script: `readRawTranscripts({days:30, fidelity:'full'})` over fixtures prints a
merged newest-first list with full segments.

---

### Step 5: Reader — session-by-id mode + missing-lane warnings
**Objective.** Add `sessionId` mode (resolve to a jsonl stem or kiro conversation_id) and
non-silent warnings when a lane dir/mirror is absent.

**Guidance.** Extend `session-transcripts.ts`: `sessionId` short-circuits window logic;
search lanes for a matching file/row; return the single full transcript. Collect
`warnings[]` for missing lanes/mirror-not-populated; surface via a `_meta` field on the
result. Never return a silent `[]` without a reason.

**Tests (`test/local-ops/reader-session.test.ts`).**
- by-id returns exactly the one session (jsonl and kiro cases); unknown id → empty +
  `warnings:['session … not found …']`.
- missing mirror dir → lane skipped WITH a warning (asserted), other lanes still returned.

**Integration.** Completes the reader's two access modes (design R3).

**Demo.** `readRawTranscripts({sessionId:'<stem>', fidelity:'full'})` returns one full
transcript; a run with the mirror dir removed shows the warning, not a silent empty.

---

### Step 6: The local op + trust gate + registration seam
**Objective.** Define `get_raw_transcripts` and register it fork-locally with a single
low-conflict line.

**Guidance.** New `src/core/local-ops/session-transcripts-op.ts`:
- Op: `scope:'read'`, `localOnly:true`, params `{fidelity, days, limit, session_id, lanes,
  max_chars, format}`, handler re-checks `ctx.remote===true → permission_denied` (verbatim
  posture of the upstream op), returns JSON rows or `markdown` per `format`. Local
  description const (NOT `operations-descriptions.ts`). `cliHints:{name:'raw-transcripts'}`.
  Export `localOps=[get_raw_transcripts]`.
- `src/core/operations.ts`: ONE import line + ONE trailing array line
  `...localOps, // FORK-LOCAL (davidtwu) — do not upstream` (design §4.5).

**Tests (`test/local-ops/op.test.ts`).**
- handler with `remote:true` → `permission_denied`; with `remote:false` → returns rows.
- `format:'markdown'` returns strings; default returns structured objects.
- op present in the exported `operations` array.

**Integration.** The reader is now reachable through gbrain's op contract (dispatch, CLI).

**Demo.** `gbrain call get_raw_transcripts '{"days":7,"fidelity":"full"}'` returns real
LOCAL sessions with tool detail (local lanes work even before the mirror exists).

---

### Step 7: CLI surface + merge-safety & drift guards
**Objective.** Ensure `gbrain raw-transcripts …` works; lock in guard tests protecting the
merge-clean invariant.

**Guidance.** Verify the generic op→CLI path surfaces the command (cliHints); add a thin
command mapping only if required (keep any cli.ts touch to one line). Add flags
`--fidelity --days --limit --session --lanes --max-chars --json`.

**Tests.**
- `test/local-ops/merge-safety.test.ts`: assert upstream `get_recent_transcripts` op is
  unchanged (name, `localOnly`, description const identity, still `.txt`/corpus-based) —
  fails if a merge reshapes it.
- `test/local-ops/drift-guard.test.ts`: assert our copied walk accepts `.jsonl` (and the
  text-tier accepts `.md`+`.txt`, recursive) — the divergence class that caused the
  original bug.
- CLI smoke (existing harness pattern): `raw-transcripts --json --days 1` exits 0, emits
  JSON.

**Integration.** User- and cron-facing entry point complete for the gbrain-src plane.

**Demo.** `gbrain raw-transcripts --fidelity full --days 3 --json | jq '.[0].segments'`
shows tool calls from a real local session.

---

### Step 8: Out-of-repo — durable raw mirror + retention (cloud collector)
**Objective.** Make remote (cloud desktop) lanes available at full fidelity by persisting
the pulled raw sources, so the reader's remote lanes work offline.

**Guidance.** Edit `~/.gbrain-bin/gbrain-collect-sessions-cloud` (+ `.py` if needed):
- rsync remote Claude jsonl → persistent `~/.gbrain-sessions-raw/claude-remote/` (drop its
  `rm -rf`).
- keep the pulled remote kiro snapshot → `~/.gbrain-sessions-raw/kiro-remote/data.sqlite3`
  (ONE db → both lanes; no pre-split).
- retention: prune raw-mirror entries older than `SESS_CUTOFF_DAYS` (30d).
- `mkdir -p` + `chmod 700` + ensure `.gitignore`. Staging/import path UNCHANGED.

**Tests/verification.** `SESS_DRY=1` dry-run prints the new durable targets + retention
plan without writing. Manual: run the cloud lane, confirm files persist and reader's
remote lanes return full fidelity; re-run confirms retention prune + no unbounded growth.

**Integration.** The reader (Step 4/5) now returns all 5 lanes at full fidelity, not just
local.

**Demo.** After a cloud-lane run: `gbrain raw-transcripts --lanes meshclaw-remote,claude-remote
--fidelity full --json` returns remote sessions with tool detail; a second run shows
retention holding size steady.

---

### Step 9: Out-of-repo — dw-improve `read.method: raw`
**Objective.** Point the self-improvement loop at full fidelity.

**Guidance.** In `DavidwuAICapabilities/.../context/dw-improve/`: add a `raw` branch to
`select.py` that invokes `gbrain raw-transcripts --fidelity full --json` (respecting
`sources`/`max_sessions_scanned`/window); add `read.method: raw` to `config.yaml`. Keep
`dry_run:true`/`auto_dispatch:false` defaults. Update dw-improve's own tests
(`test_improve_select.py`) for the new branch.

**Tests.** dw-improve unit test: `read.method: raw` selects via the new reader (mock the
CLI call), returns full-fidelity records; existing staging/gbrain_query branches
unaffected.

**Integration.** Closes the confirmed value gap (research/06): the loop now sees
tool/thinking signal.

**Demo.** A dw-improve dry-run with `read.method: raw` produces a proposal that cites a
tool-call pattern (e.g. repeated command) that the text-only view could not have surfaced.

---

### Step 10: End-to-end verification + docs
**Objective.** Prove the whole chain and document it.

**Guidance.**
- Run `bun test` (redirect to file per CLAUDE.md iron rule; check real exit code) — all
  new + existing green.
- `bun run typecheck` clean.
- Manual E2E: local + remote, window + session, text + full, JSON + markdown, cap
  truncation signal, `remote:true` rejection.
- Docs: short usage note (CLI + op) in the appropriate fork doc; note the fork-local
  nature + the optional upstream PR for the `.md` twin. If any CLAUDE.md/reference edit,
  run `bun run build:llms` (iron rule).

**Tests.** Full suite + typecheck are the gate.

**Demo.** One transcript-style walkthrough: ad hoc `gbrain raw-transcripts --session <id>
--fidelity full` AND a dw-improve raw-mode dry-run, side by side — the same raw session,
one for a human, one for the cron.

---

## Sequencing / value milestones
- **After Step 7:** gbrain-src plane fully working on LOCAL lanes (real value; ships/mergeable
  independently). This is the natural first landing point if we ever split the all-in-one.
- **After Step 8:** remote/cloud full fidelity.
- **After Step 9:** self-improvement loop upgraded.
- **Step 10:** verified + documented.

## Merge-clean invariants (hold throughout)
- All gbrain-src logic in `src/core/local-ops/` + `test/local-ops/` (fork-only paths).
- Upstream files touched: `operations.ts` only (2 lines). Guarded by Step 7 merge-safety
  test. Upstream `get_recent_transcripts` byte-unchanged.
- No new embedding/ingest behavior (NG1); staging/import untouched.
