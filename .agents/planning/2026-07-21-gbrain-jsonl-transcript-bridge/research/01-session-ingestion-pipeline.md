# Research 01 — The session-ingestion pipeline (ground truth)

**This is the most important finding. It reframes the whole problem.**

## Sessions are ALREADY ingested and queryable

There is a complete, working session-ingestion pipeline outside `gbrain-src`, driven
by launchd (`com.davidwu.gbrain-daily`) via `~/.gbrain-bin/gbrain-collect-sessions*`.
It stages 5 source lanes as **markdown** and imports them into the brain as
`type: session` pages.

### Pipeline (per `gbrain-collect-sessions` + `gbrain-collect-sessions.py`)

```
                       ┌─ local ─────────────────────────────┐
  ~/.claude/projects/**/*.jsonl  ──parse──▶ claude-code/*.md  │
  ~/Library/.../kiro-cli/data.sqlite3 ────▶ kiro-local/*.md   │
                       └──────────────────────────────────────┘
                       ┌─ cloud (SSH/rsync from devDesktop-kiro) ─┐
  remote ~/.claude/projects (rsync .jsonl) ─▶ claude-remote/*.md  │
  remote kiro data.sqlite3 (.backup+scp) ──▶ kiro-remote/*.md     │
                                          └─▶ meshclaw-remote/*.md │
                       └───────────────────────────────────────────┘
                                    │
                        ~/.gbrain-sessions-staging/<lane>/*.md   (1790 files, all today)
                                    │
                        gbrain import ~/.gbrain-sessions-staging  (embeds via Bedrock)
                                    │
                        brain pages  type: session  ← queryable via search/query
```

### Confirmed live
- `gbrain list --type session` returns pages incl. `claude-remote — …` (cloud desktop).
- `gbrain search "talent review calibration"` surfaces a `claude-remote` session page.
- So **the cloud-desktop sessions the user mentioned are already in the brain** and
  retrievable through the normal retrieval path (`search`, `query`, `recall`).

### The staged `.md` format (written by `write_page`, collector py line 75-84)
```markdown
---
title: claude-remote — <project> (<id8>)
source: claude-remote        # one of: claude-code|claude-remote|kiro-cli|kiro-remote|meshclaw
date: 2026-07-16T20:29:29.128Z   # ISO; first-turn ts (claude) or updated_at (kiro)
type: session
---

**user:** ...
**assistant:** ...
```
- Claude `.jsonl` → flattened: only `type in (user,assistant)` turns, text blocks only
  (tool calls/results dropped), `**role:** text` joined by blank lines.
- Noise filter drops `brazil-pkg-cache|/tmp/|benchmark-workspaces|node_modules|/build/`
  keys; `MIN_CHARS=200` skips near-empty convos.
- Default cutoff 30 days (`SESS_CUTOFF_DAYS`).
- Scope lanes: `all` (wipes whole staging root), `local`, `cloud` (failure-isolated;
  clear only owned subdirs). `gbrain-daily` runs local + cloud as separate lanes so a
  flaky SSH pull can't wipe local staging.

## Why `get_recent_transcripts` returns [] — restated against ground truth

`get_recent_transcripts` (`src/core/transcripts.ts`) is a SEPARATE, redundant access
path that reads **raw files from a corpus dir**, NOT the imported pages. It fails because:

1. **Corpus dir unset.** Reads `dream.synthesize.session_corpus_dir` +
   `.meeting_transcripts_dir`; both unset → `if (dirs.length===0) return []`.
2. **Wrong extension even if set.** Scans only `*.txt`
   (`if (!name.endsWith('.txt')) continue`). The staged sessions — the exact data it
   wants — are `*.md` in `~/.gbrain-sessions-staging/<lane>/`.

So the fix is far smaller than "build a jsonl bridge": the flatten-to-markdown bridge
**already exists** and runs daily. `get_recent_transcripts` just isn't pointed at its
output and can't read the extension.

## Implication for the fix (informs requirements)

Three plausible fixes, cheapest first:
- **A. Config + extension.** Default the corpus dir to `~/.gbrain-sessions-staging`
  (recursive) when unset, and accept `.md` alongside `.txt`. Smallest change; makes
  both CLI and (local) callers work against the same corpus the brain already ingests.
- **B. Read imported pages instead of files.** Reimplement `get_recent_transcripts` to
  query `type: session` pages from the DB (newest-first by `date`), sidestepping the
  filesystem entirely. More robust (single source of truth = the brain), works
  regardless of staging layout, but changes the op's semantics (raw file → page).
- **C. Both / layered.** Page-backed primary, filesystem fallback.

Open question for requirements: does the user want `get_recent_transcripts` to remain a
**raw-file reader** (A) or become a **page reader** (B)? The tool's description sells it
as "raw transcripts … canonical source," which argues for staying file-based (A) — the
imported pages are already reachable via `search`/`query`, so a page-backed
`get_recent_transcripts` would partly duplicate `query --type session`.

## Key source / script locations
- `~/.gbrain-bin/gbrain-collect-sessions` — wrapper: remote pull → py → `gbrain import`
- `~/.gbrain-bin/gbrain-collect-sessions.py` — the flatten/stage collector (5 lanes)
- `~/.gbrain-bin/gbrain-collect-sessions-{local,cloud}` — failure-isolated lanes
- `~/.gbrain-bin/gbrain-daily` — launchd driver (creds→vault→sessions→outlook→slack)
- `~/.gbrain-sessions-staging/{claude-code,claude-remote,kiro-local,kiro-remote,meshclaw-remote}/`
- NOTE: these scripts live OUTSIDE `gbrain-src` (not under version control here). A fix
  that touches them is a different change surface than a fix inside `gbrain-src`.
