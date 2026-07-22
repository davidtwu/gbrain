# Idea Honing — gbrain transcript fidelity fix

Research-first (see research/01–06). Requirements captured as resolved decisions.

## Q1. Raw-file reader (A) vs page-backed (B) vs raw-jsonl full-fidelity (D)?
**A: D+A.** Build a raw-`.jsonl` full-fidelity reader (D) AND fix the broken `.md` twin
(A) as the text tier of the same unified reader. Rationale: only raw fidelity serves the
self-improvement use case; text tier still needed so the existing tool stops returning
[]. (research/03, 04)

## Q2. Remote (cloud desktop) full fidelity in scope?
**A: Full fidelity everywhere — all 5 lanes.** 2 Claude jsonl + 3 Kiro/meshclaw sqlite.
Confirmed feasible: Kiro sqlite holds tool_use/tool_result detail; remote raw needs a
durable mirror (currently rsync'd to /tmp then deleted). (research/05, 06)

## Q3. Primary consumer?
**A: Both equally.** Self-improve crons (dw-improve, offline → needs durable local
mirror, not live SSH) AND ad hoc CLI. Reader stays LOCAL-ONLY (raw jsonl = most
sensitive); NOT MCP-exposed. (research/04, 06)

## Q4. Output shape for fidelity:'full'?
**A: Structured JSON + markdown render.** Primary = typed segments
(role, text, tool_use{name,input}, tool_result, thinking) as JSON for programmatic
consumers. Plus a markdown renderer that includes tool blocks for human/LLM reading.

## Q5. 100KB cap policy?
**A: Param, default larger, uncapped for full.** Add maxChars/limit param (default
raised, ~500KB); fidelity:'full' effectively uncapped. Explicit truncation signal when
the cap trims output (no silent 22% returns).

## Q6. Sequencing of the 4 workstreams?
**A: All-in-one.** All four land together:
  1. gbrain-src: unified raw-fidelity reader (fidelity text|full, days, cap param, JSON+md)
  2. gbrain-src: fix .md twin (listRecentTranscripts) — share walker w/ discoverTranscripts + drift-guard test
  3. out-of-repo scripts: durable raw mirror for 4 remote lanes + recover Kiro tool detail
  4. out-of-repo dw-improve: add read.method: raw to consume (1)

## Assumptions stated (low-stakes; correct me if wrong)
- **Retention** for the durable raw mirror = SESS_CUTOFF_DAYS (30d) with pruning, so it
  doesn't grow unbounded. Raw ≈ 3× staged footprint.
- **Privacy:** durable raw mirror lives under $HOME (e.g. ~/.gbrain-sessions-raw/),
  explicit .gitignore, local-only, never uploaded/embedded (only the text-tier .md
  continues to be imported/embedded as today).
- **On-demand remote full fidelity** returns the latest cron-refreshed mirror snapshot
  (not a live SSH pull at read time) — offline-capable for crons.
- **Embedding unchanged:** we do NOT start embedding raw tool/thinking content into the
  brain (would bloat recall + cost). Raw fidelity is a READ surface over files, separate
  from the ingest/recall path.

## Q7. Extend upstream op, or new op? + provenance
**A: NEW LOCAL op.** `get_recent_transcripts` is UPSTREAM (Garry Tan, v0.29) — not ours.
Fork is 0-behind/17-ahead of origin/master; merges are real. So: add a fork-local op,
leave the upstream op untouched, keep `git merge origin/master` easy. All new code lives
in a fork-only `src/core/local-ops/` dir (structurally conflict-free). (research/07)

## Q8. Access pattern?
**A: Both — by-window AND by-session.** One op, two modes: "recent N days" batch reads
(ad hoc "what have I worked on") + "read this one session by id/slug" at full fidelity
(self-improve drilling into a flagged session).

## Q9. Op name?
**A: `get_raw_transcripts`.** Emphasizes the raw/full-fidelity distinction vs the
upstream text-only `get_recent_transcripts`. Local-only. CLI surface e.g.
`gbrain raw-transcripts` / `gbrain sessions`.

## Requirements COMPLETE → proceed to detailed design.
