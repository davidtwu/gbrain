# Research 05 — Full fidelity for remote (cloud desktop) sessions

User decided: **full fidelity everywhere** + consumers = both (self-improve crons AND
ad hoc) + fix = **D+A** (raw-jsonl reader with fidelity flag + fix the .md twin).

This makes the out-of-repo collector scripts IN SCOPE, because remote raw fidelity does
not currently survive on the laptop.

## Per-lane raw-fidelity availability (the hard constraint)
| Lane | Raw source | Durable on laptop? | Full-fidelity gap |
|---|---|---|---|
| `claude-code` (local) | `~/.claude/projects/**/*.jsonl` | ✅ persistent | none — reader reads it directly |
| `claude-remote` (cloud) | remote `~/.claude/projects` → rsync to `/tmp/remote-claude-projects` → **deleted** (cloud script line 65) | ❌ transient | need a DURABLE mirror |
| `kiro-local` | `~/Library/.../kiro-cli/data.sqlite3` | ✅ persistent | fidelity = whatever the sqlite holds (see below) |
| `kiro-remote` / `meshclaw-remote` | remote `~/.local/share/kiro-cli/data.sqlite3` → `.backup`+scp to `/tmp/…sqlite3` → **deleted** (line 64) | ❌ transient | need a DURABLE mirror |

### Two sub-questions full fidelity forces
1. **Claude jsonl (local + remote):** raw has tool_use/tool_result/thinking. Full
   fidelity = parse those blocks, not just text. Local files persist; remote needs a
   durable rsync target (stop deleting, or rsync to `~/.gbrain-sessions-raw/claude-remote/`).
2. **Kiro sqlite (local + 2 remote lanes):** fidelity is bounded by what the sqlite
   `conversations_v2` rows contain. Collector already prefers a pre-rendered
   `transcript` list, else walks `history[].user/assistant`. NEEDS A CHECK: does the
   Kiro sqlite even store tool-call/tool-result detail separately, or only rendered
   text? If the sqlite is already text-rendered, "full fidelity" for Kiro lanes = the
   sqlite's own ceiling (can't recover more than it stored). This bounds the promise.

## Architecture options for durable remote raw
- **R1. Durable raw mirror on the laptop.** Change the cloud lane's rsync target from
  `/tmp/remote-claude-projects` (deleted) to a persistent `~/.gbrain-sessions-raw/
  claude-remote/` and DON'T delete it. The raw-jsonl reader (D) then reads
  local + this mirror uniformly. Kiro remote: keep a durable copy of the pulled
  sqlite too (`~/.gbrain-sessions-raw/kiro-remote.sqlite3`). Cost: disk (raw is ~3×
  the staged size) + these dirs now hold sensitive raw content persistently (privacy —
  they're already gitignored under $HOME but worth an explicit .gitignore + local-only).
- **R2. Read cloud-side.** Run the raw reader ON the cloud desktop over SSH on demand.
  No durable local copy; always fresh; but requires live Midway/SSH at read time (the
  flaky path) and can't serve an offline self-improve cron. Rejected as primary.
- **R3. Hybrid:** durable mirror (R1) as the default read source; optional live SSH
  refresh. Best of both; more moving parts.

**Leaning R1** (durable mirror), because "both consumers" includes offline self-improve
crons that can't depend on live SSH, and D's reader wants one uniform local file tree.

## Blast-radius note (matters for the plan)
- The reader + fidelity flag + .md twin fix live in **gbrain-src** (version-controlled,
  shipped via /ship, testable).
- The durable-mirror change lives in **~/.gbrain-bin/gbrain-collect-sessions-cloud**
  (+ maybe `.py`), which is OUTSIDE this repo and not under version control here. That's
  a separate change surface with no test harness — treat as a distinct workstream in the
  plan, sequenced so gbrain-src ships independently of the script edit.
- Storage: a durable raw mirror roughly triples session disk footprint (raw ≈ 3× staged).
  Add retention (respect SESS_CUTOFF_DAYS = 30d; prune older raw) so it doesn't grow
  unbounded.

## Consumer wiring (both equally)
- The op stays **local-only** (raw jsonl = most sensitive). NOT MCP-exposed.
- `dw-improve` / self-improve crons call it via CLI/library (`gbrain transcripts
  --fidelity full --days N`) — offline-capable → argues for R1 durable mirror.
- Ad hoc: same CLI, default `--fidelity text` for cheap recent-session scans.

## Must-verify-before-design items
- [ ] Kiro sqlite fidelity ceiling — does it hold tool/thinking detail or only text?
      (Determines whether "full fidelity" is achievable for the 3 Kiro/meshclaw lanes or
      just the 2 Claude lanes.)
- [ ] Does `dw-improve` today read pages (33% view) or raw? (Confirms the win.)
- [ ] Disk budget for a 30-day durable raw mirror (local + remote Claude + Kiro).
