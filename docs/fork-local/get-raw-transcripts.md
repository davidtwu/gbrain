# `get_raw_transcripts` — full-fidelity session reader (FORK-LOCAL)

> **Fork-local, do NOT upstream.** All logic lives under `src/core/local-ops/` +
> `test/local-ops/`; the only upstream touch is a 2-line registration in
> `src/core/operations.ts` (an import + a trailing `...localOps,`). This path is one
> upstream will never author, so `git merge origin/master` stays clean.

## What it is

`get_raw_transcripts` is the fork's **full-fidelity companion** to the upstream
`get_recent_transcripts`. The upstream op is text-only and exposes roughly a 33% slice of
each agent session; the 67% it drops — `tool_use`, `tool_result`, `thinking` — is exactly
the signal self-improvement loops need. This op reads RAW agent sessions at selectable
fidelity over a uniform local file tree covering all 5 ingest lanes, and returns structured
JSON plus a markdown renderer.

It does NOT touch the ingest/recall plane. The text-tier `.md` staging → import → embed
pipeline is unchanged; this is a READ surface over raw files, orthogonal to what lands in
the brain.

## CLI

```bash
gbrain raw-transcripts --fidelity full --days 3 --limit 5 --json
gbrain raw-transcripts --fidelity text --days 7 --json          # fast, conversation-only
gbrain raw-transcripts --session <id> --fidelity full --json    # single session
gbrain raw-transcripts --fidelity full --format markdown        # rendered markdown
gbrain raw-transcripts --lanes claude-code,kiro-local --json    # restrict lanes
```

## Fidelity — `text` | `full`

- **`text`** — conversation-only (user/assistant text join). Fast; supersedes the broken
  upstream `.md` twin. Default in window mode.
- **`full`** — ordered structured `Segment[]`: `text`, `thinking`, `tool_use {name,input}`,
  `tool_result {content,isError}`. Default in session (by-id) mode. This is the tier
  self-improvement crons consume.

## Access modes — window vs `--session`

- **Window mode** — `--days N` (default 7) + `--limit N` (default 50), newest-first across
  all requested lanes.
- **Session mode** — `--session <id>` (a Claude `.jsonl` stem or a Kiro `conversation_id`).
  Wins over the window and bypasses the age filter. Unknown id → empty `transcripts` plus a
  warning (never a silent `[]`).

(MCP-style callers use `session_id`; `--session` is the CLI alias, folded into `session_id`.)

## Lanes (5)

`claude-code`, `claude-remote`, `kiro-local`, `kiro-remote`, `meshclaw-remote`. Default is
all 5; `--lanes a,b` restricts (comma-separated). Four physical sources back the five lanes
— the remote Kiro sqlite is ONE db split per-conversation into `kiro-remote` vs
`meshclaw-remote` by a `meshclaw`-in-key test, and the reader opens it only once even when
both remote-Kiro lanes are requested.

## `--max-chars` and the truncation signal

`--max-chars N` caps the rendered markdown per transcript (default ~500 KB for `text`,
effectively uncapped for `full`). Truncation is never silent: each transcript carries
`truncated: boolean` + `omittedChars: number`.

## `--format` — `json` (default) | `markdown`

- `json` → `{ transcripts: RawTranscript[], warnings: string[] }`
- `markdown` → `{ transcripts: string[] /* rendered markdown */, warnings: string[] }`

The markdown renderer inlines ` ```tool_use ` / ` ```tool_result ` fenced blocks and
`> thinking` blockquotes in `full`; `text` omits them.

## Response shape — `{ transcripts, warnings }`

Both formats return a wrapper object. `warnings[]` surfaces missing-lane / mirror-not-yet-
populated / unknown-session-id notes explicitly (the reader also echoes them to stderr for a
human at the terminal; stdout stays clean JSON). This is deliberate: the prior tool's silent
`[]` was the bug this op kills. Each `RawTranscript` carries `id`, `lane`, `project`, `date`,
`mtime`, `bytes`, `truncated`, `omittedChars`, and either `segments` (full) or `text` (text),
plus a rendered `markdown` field.

## Local-only

`localOnly: true` hides the op from the HTTP/MCP tool-list, and the handler re-checks
`ctx.remote === true` → `permission_denied` (defense in depth, mirroring the upstream op).
Raw transcripts — tool calls, thinking, results — are the most sensitive surface and never
leave the local machine. Call it via the gbrain CLI, not over MCP.

## Related out-of-repo pieces (NOT in this repo)

- **Durable raw mirror** (`~/.gbrain-sessions-raw/`) — populated by the out-of-repo cloud
  collector in `~/.gbrain-bin` (rsync'd remote Claude jsonl + a retained remote Kiro sqlite
  snapshot, 30-day retention, `chmod 700`). Until it runs, the 4 remote lanes emit a
  "mirror not populated" warning and the local lanes (`claude-code`, `kiro-local`) work on
  their own. This op only READS that tree.
- **dw-improve `read.method: raw`** — the self-improvement loop's raw-reader branch, which
  shells `gbrain raw-transcripts --fidelity full --json` to consume full fidelity instead of
  the lossy staging view. Lives in the dw-improve config out-of-repo.

## Source layout (fork-local)

| File | Role |
|---|---|
| `src/core/local-ops/types.ts` | `Segment` / `RawTranscript` / `RawReadOpts` types |
| `src/core/local-ops/claude-jsonl.ts` | Claude `.jsonl` parser (text + full) |
| `src/core/local-ops/kiro-sqlite.ts` | Kiro sqlite parser (text + full, `splitRemote`) |
| `src/core/local-ops/render.ts` | markdown renderer + `maxChars` truncation |
| `src/core/local-ops/session-transcripts.ts` | reader: lane resolution, window + session modes |
| `src/core/local-ops/session-transcripts-op.ts` | the op + trust gate + `localOps` bundle |
| `test/local-ops/*` | unit + op + CLI-smoke + merge-safety + drift-guard tests |

See `.agents/planning/2026-07-21-gbrain-jsonl-transcript-bridge/design/detailed-design.md`
for the full design.
