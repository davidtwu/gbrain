# Research 08 — MeshClaw ⊂ remote Kiro sqlite (lane/source correction)

## Question
"Were meshclaw sessions handled under kiro within the remote?"

## Answer: YES — same physical remote sqlite, split per-convo by key.
- The cloud wrapper (`gbrain-collect-sessions-cloud`) pulls exactly ONE remote db:
  remote `~/.local/share/kiro-cli/data.sqlite3` → `/tmp/meshclaw-kiro-remote.sqlite3`
  (the temp filename encodes it).
- `collect_kiro(db, split_remote=True)` routes EACH `conversations_v2` row by its `key`:
  - `"meshclaw" in key.lower()` → lane/source `meshclaw-remote` / `meshclaw`
  - else → lane/source `kiro-remote` / `kiro-remote`
- Comment (collector py:135-137): "…the 24/7 MeshClaw agent's convos from David's
  interactive remote Kiro sessions, which share the same remote data.sqlite3."
- Live confirmation: meshclaw-remote 496 md, kiro-remote 110 md — both from that one db;
  claude-remote 35 md comes separately (rsync'd jsonl).

## Corrected lane↔source map (5 lanes → 4 physical sources)
| Lane | Physical source | Split? |
|---|---|---|
| claude-code | local `~/.claude/projects/**/*.jsonl` | — |
| kiro-local | local `~/Library/.../kiro-cli/data.sqlite3` | no |
| claude-remote | durable mirror `~/.gbrain-sessions-raw/claude-remote/**` (rsync jsonl) | — |
| kiro-remote | ┐ ONE durable mirror `~/.gbrain-sessions-raw/kiro-remote/data.sqlite3` | **yes, by `meshclaw`-in-key** |
| meshclaw-remote | ┘ (same file) | |

## Design impact (applied to detailed-design.md)
1. Durable mirror = ONE remote kiro db (not two). §4.6 corrected.
2. `kiro-sqlite.ts` reader gains a `splitRemote` flag mirroring the collector; local kiro
   has no split. §4.2 corrected.
3. Reader must read the single physical remote db ONCE even when both remote-kiro lanes
   are requested (dedup the file read; route rows to lanes). Add a unit test for the
   split + single-read dedup.

## Earlier docs to note (not rewritten; superseded by this)
- research/05 & 06 said "durable sqlite mirror" loosely as if kiro-remote were its own
  source. This note is the authoritative correction: kiro-remote and meshclaw-remote are
  one db, split at read time.
