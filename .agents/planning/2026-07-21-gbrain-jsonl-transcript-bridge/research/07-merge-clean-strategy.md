# Research 07 — Merge-clean strategy (fork stays mergeable with upstream)

User constraints locked: **add a NEW LOCAL op** (don't reshape the upstream
`get_recent_transcripts`), and **make `git merge origin/master` easy**.

## Provenance recap
- `get_recent_transcripts`, `listRecentTranscripts`, `discoverTranscripts` are ALL
  upstream (Garry Tan, v0.29 / #708). `origin` = garrytan/gbrain; `fork` = davidtwu/gbrain.
- Fork is currently **0 behind / 17 ahead** of origin/master (shallow 25-commit clone).
  So merges DO happen and we want to keep them painless.

## Merge-conflict hot spots (what to avoid editing)
| File | Why it conflicts | Our stance |
|---|---|---|
| `src/core/operations.ts` | central contract; **one big `operations: Operation[]` array** (line 5389-5470+) that upstream appends to almost every release → the array literal is a serial conflict magnet | DO NOT edit the array literal or add the op inline here |
| `src/core/operations-descriptions.ts` | upstream edits; desc strings pinned by tests | don't touch |
| `src/core/transcripts.ts` | upstream file (the `.md` twin) | see "twin fix" below — minimal, or relocate |
| `src/core/cycle/transcript-discovery.ts` | upstream cycle file | don't touch (already handles .md) |
| `src/cli.ts` | upstream command registry | avoid if possible |

## The clean seam: append ops at the CONSUMER, not in the array
`operations` is imported by ~10 consumers (cli.ts, mcp/server.ts, dispatch.ts, …). Two
strategies:

### Strategy 1 (preferred): local-ops module + tiny concat
- Put ALL our code in a NEW, fork-only file: `src/core/local-ops/session-transcripts.ts`
  (upstream will never create this path → zero merge conflicts on it, ever).
- Export the new op(s) + reader from there.
- Register with the SMALLEST possible upstream touch. Options, best-first:
  a. If any single consumer builds the effective op list, concat there:
     `[...operations, ...localOps]`. One line, in one file.
  b. If not, add a fork-only aggregator `src/core/local-ops/index.ts` exporting
     `allOperations = [...operations, ...localOps]`, and point our fork's consumers at it.
     (Slightly more surface but each edit is a 1-token import swap that merges trivially.)
- **Net upstream-file edit: ideally 1 line.** Everything else is in fork-only files.

### Strategy 2 (fallback): single-line array append
- Add `import { sessionTranscriptOps } from './local-ops/…'` at top of operations.ts and
  `...sessionTranscriptOps,` as the LAST entry of the array, on its own line with a
  `// FORK-LOCAL (davidtwu): do not upstream` marker.
- Upstream appends BEFORE our trailing line, so conflicts are rare and trivial (both add
  distinct lines near the end). Still, Strategy 1 is cleaner.

## The `.md` twin fix — keep it merge-safe too
Fixing `listRecentTranscripts` in-place edits an upstream file (`transcripts.ts`). To stay
merge-clean AND still fix the text tier, prefer:
- Our new reader (in local-ops) implements BOTH tiers (text + full). The fork's new op
  uses it. We DON'T edit upstream `transcripts.ts` at all — we simply stop routing through
  the broken upstream reader and route through ours.
- `get_recent_transcripts` (upstream op) is left exactly as-is (still text/.txt/unset-corpus
  → still returns [] on this brain, but that's fine — our new op supersedes it locally,
  and we can `gbrain config set …_corpus_dir` if we ever want the upstream op to work too).
- **Optional upstream contribution:** the twin `.md`+recurse fix is a genuine upstream bug
  worth a separate PR to garrytan/gbrain — but that's a clean-cherry-pick, NOT part of the
  fork-local change. Keeps concerns separate.
- Net: the twin bug is "fixed" for us by superseding, with ZERO edits to upstream
  transcript files. (Revisit only if we decide to upstream.)

## Shared file-walk (avoid re-introducing the drift)
`discoverTranscripts` already has a good recursive `.md`/`.txt` `walk()`+`pruneDir`. To
reuse without editing it, either:
- import its exported helper if one exists (check: `listTextFiles` is currently NOT
  exported), or
- copy the small walk into our local-ops reader (acceptable: it's ~30 lines, and keeping
  it fork-local avoids editing the upstream file). Document the shared origin so a future
  upstream change can be mirrored.

## Fork-local placement summary (proposed)
```
src/core/local-ops/                     ← NEW dir, fork-only, never conflicts
  session-transcripts.ts                ← the raw+text unified reader (jsonl + kiro sqlite + .md)
  session-transcripts-op.ts             ← the new local op definition(s)
  render.ts                             ← structured JSON ↔ markdown renderer
  index.ts                              ← export localOps = [ ...these ]
```
Plus the single registration touch (Strategy 1a/1b). Everything testable under
`test/local-ops/…` (new dir, no conflict).

## CLI surface
- New op gets `cliHints` so `gbrain <cmd>` works locally. If cli.ts needs a registration
  edit, keep it to one line near an obvious append point; otherwise rely on the generic
  op→CLI generation (the same path that already surfaces upstream ops).

## Net merge cost of this approach
- Upstream-file edits: **~1 line** (op registration), on its own line, low-conflict.
- Everything else lives in fork-only paths upstream will never author → **structurally
  conflict-free**.
- Out-of-repo scripts (durable mirror, dw-improve) are separate and don't affect the
  gbrain merge at all.
```
