# Summary — gbrain transcript fidelity fix (`get_raw_transcripts`)

## What we did
Started from "fix the `get_transcripts` issue," investigated it live, and — because the
naive fix would have been wrong — did research BEFORE requirements. Research reframed the
problem twice (sessions are already ingested; the loss is a 67% fidelity drop; meshclaw ⊂
remote kiro), producing a design that adds a fork-local full-fidelity reader while keeping
the fork mergeable with upstream.

## Artifacts created
```
.agents/planning/2026-07-21-gbrain-jsonl-transcript-bridge/
├── rough-idea.md                     initial diagnosis
├── idea-honing.md                    9 resolved requirements Q&A
├── research/
│   ├── 01-session-ingestion-pipeline.md   sessions already staged+imported (5 lanes)
│   ├── 02-reader-op-and-trust-boundary.md op/localOnly; whoami is by-design (out of scope)
│   ├── 03-summary-and-options.md          the stale-twin bug; option landscape
│   ├── 04-fidelity-and-recall-value.md    33% kept / 67% dropped; recall vs self-improve
│   ├── 05-remote-full-fidelity.md         durable mirror needed for remote lanes
│   ├── 06-findings-closed.md              kiro holds tool detail; dw-improve reads lossy view
│   ├── 07-merge-clean-strategy.md         fork-local dir seam; ~1-line upstream touch
│   └── 08-meshclaw-kiro-remote-split.md   meshclaw ⊂ one remote kiro db, split by key
├── design/detailed-design.md         full design (goals, components, data, errors, tests)
└── implementation/plan.md            10 TDD steps + checklist
```

## Design in one paragraph
Add a **fork-local, local-only** op `get_raw_transcripts` (in `src/core/local-ops/`, a
path upstream will never author → merge-clean) that reads agent sessions at
`fidelity: text | full` over a uniform local tree covering all 5 lanes (4 physical
sources; remote kiro is one db split into kiro-remote + meshclaw-remote by key). `full`
preserves tool_use / tool_result / thinking as typed segments; output is structured JSON +
a markdown renderer; the cap is a param with an explicit truncation signal. The upstream
`get_recent_transcripts` is left byte-unchanged; the broken `.md` twin is fixed by
superseding (no upstream edit). Two out-of-repo workstreams make remote lanes durable and
point `dw-improve` at the new full-fidelity reader.

## Key decisions (idea-honing.md)
- New local op (not extend upstream) — keeps `git merge origin/master` easy.
- Full fidelity for all 5 lanes; both consumers (ad hoc + self-improve crons).
- Structured JSON + markdown; cap param, uncapped for `full`.
- All-in-one delivery across 4 workstreams.
- whoami/stdio transport quirk = intended fail-closed → OUT of scope.

## Implementation approach
10 test-driven steps, each demoable: parsers (Claude jsonl, Kiro sqlite w/ split) →
renderer → reader (window + session) → op + registration → CLI + guard tests →
out-of-repo durable mirror → dw-improve rewire → E2E + docs. Natural first landing after
Step 7 (local lanes fully working, independently mergeable).

## Areas that may need refinement
- **Text-tier parity:** the reader's `text` output should match the collector's join
  closely; exact byte-parity vs "good enough" is a judgment call at implementation time.
- **Disk budget:** durable raw mirror ≈ 3× staged; retention set to 30d — revisit if the
  mirror grows faster than expected.
- **dw-improve token cost:** full fidelity is larger input; `max_sessions_scanned` / window
  may need tuning once it reads raw.
- **Optional upstream PR:** the `.md`+recurse twin fix is a genuine upstream bug worth a
  clean PR to garrytan/gbrain — tracked as optional, not part of the fork-local change.

## Implementation status: Steps 1–10 COMPLETE (2026-07-21)
All 10 steps implemented via subagents. Final verification:
- **typecheck:** clean (EXIT 0).
- **local-ops suite:** 74 pass / 0 fail (9 files).
- **interacting upstream suites** (operations-trust-boundary, v0_29-tool-surfaces,
  operations-descriptions, transcripts, cycle-synthesize-md-discovery): 67 pass / 0 fail.
- **live CLI:** `raw-transcripts` verified in all modes — `--fidelity full` (typed
  segments text/tool_use/tool_result), `--fidelity text` (text field), `--format markdown`.
- **upstream footprint:** exactly 2 lines in `src/core/operations.ts` (import + trailing
  `...localOps`). All else in fork-only paths (`src/core/local-ops/`, `test/local-ops/`,
  `docs/fork-local/get-raw-transcripts.md`).
- **out-of-repo:** durable raw mirror (Step 8, ~/.gbrain-bin, backed up) + dw-improve
  `read.method: raw` (Step 9, 242 pkg tests pass). Both left inactive/unflipped pending
  a live cloud-lane run + PATH confirmation.
- **full repo suite:** (running as final gate — see verification run).

## Next steps
1. Confirm the full-suite gate is green (final pre-ship check).
2. Ship gbrain-src via `/ship` (VERSION/CHANGELOG/merge conventions) — 2-line upstream
   footprint keeps the merge clean.
3. When ready to activate: flip dw-improve `read.method: raw` after a live cloud-lane run
   populates `~/.gbrain-sessions-raw/` and `gbrain raw-transcripts` is confirmed on PATH.
4. Optional: upstream the `.md`+recurse twin fix as a clean PR to garrytan/gbrain.
