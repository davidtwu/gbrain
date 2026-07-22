# Research 06 — Closing the must-verify items

## ✅ Kiro sqlite DOES hold full tool fidelity (all 3 Kiro/meshclaw lanes)
`~/Library/Application Support/kiro-cli/data.sqlite3` (983 MB). `conversations_v2.value`
JSON blob top-level keys include: `history`, `transcript`, `tools`, `context_manager`,
`latest_summary`, `model_info`, … The `history[].user/assistant` payload contains
`tool_use` / `ToolUse` / `execute_bash` / `fs_read` markers — i.e. the FULL tool-call and
tool-result detail is present. The collector currently prefers the pre-rendered
`transcript` list (4 lines in the sample) and thus DROPS the tool detail, but it is
recoverable from the same blob.
- **Implication:** full fidelity is achievable for ALL 5 lanes (2 Claude jsonl + 3 Kiro
  sqlite). The remote Kiro lanes need the durable sqlite mirror (research 05 R1); the
  detail itself is there.
- Remote Kiro/meshclaw sqlite is the SAME schema (it's a Kiro data.sqlite3), so the
  extraction logic is shared local↔remote.

## ✅ dw-improve reads the LOSSY staging view today (confirmed)
`context/dw-improve/config.yaml`:
```
read:
  method: staging      # staging (lock-free, allowlisted) | gbrain_query
  sources: [claude-code, kiro-cli, meshclaw, kiro-remote, claude-remote]
  max_sessions_scanned: 500
```
- `method: staging` = reads the staged `.md` files = the **33% text-only view**. The
  only alternative (`gbrain_query`) reads the embedded chunks of the SAME `.md` — also
  text-only. **Neither existing method reaches raw tool/thinking fidelity.**
- So the self-improvement loop has been detecting toil/friction/redundancy from
  conversation text WITHOUT the tool-call/result trace — the exact signal that reveals
  "ran the same command 5×", "re-read the same file", "retry storms". This is a concrete,
  confirmed value gap the fix closes.
- Design consequence: the raw-fidelity reader (D) should be consumable by dw-improve as a
  THIRD `read.method` (e.g. `raw` / `raw_full`) — a clean integration seam that already
  exists in dw-improve's config. dw-improve edit is out-of-repo (DavidwuAICapabilities),
  a separate workstream, but the gbrain-src reader must expose an interface it can call
  (CLI `gbrain transcripts --fidelity full --json` or a library entry).

## Consolidated fidelity math (why this matters, one number)
- Text-only view = **33%** of the raw session; the missing 67% = tool_use (29%) +
  tool_result (38%) + thinking. For self-improvement, the missing 67% IS the signal.

## Design is now fully informed. Final option set → requirements
Decisions locked by the user: **D+A**, **full fidelity everywhere (5 lanes)**, **both
consumers**, reader **local-only**.

Confirmed-feasible building blocks:
1. gbrain-src: raw-fidelity reader over a uniform local file tree
   (`~/.claude/projects` + durable remote mirror), `fidelity: text|full`, `days`,
   configurable cap (raise/remove the 100 KB truncation), local-only, CLI + library.
2. gbrain-src: fix the `.md` twin (`listRecentTranscripts`) — `.md` + recurse + shared
   walker with `discoverTranscripts` + drift-guard test. This is the text tier of the
   same reader (unify rather than keep two).
3. out-of-repo scripts: durable raw mirror for the 2 remote Claude + 2 remote Kiro
   lanes (stop deleting `/tmp` copies; retain under retention window); recover Kiro tool
   detail. Separate workstream.
4. out-of-repo dw-improve: add `read.method: raw` to consume (1). Separate workstream.

## Remaining requirements questions (small, mostly confirmations)
- Cap policy: raise 100 KB → what? (param w/ sane default? uncapped for `full`?)
- Retention/disk for the durable raw mirror (default = SESS_CUTOFF_DAYS 30d?).
- Output shape for `full`: structured turns (role + tool_use + tool_result as typed
  segments, JSON) vs a richer flattened markdown that INCLUDES tool blocks? (Structured
  JSON is better for programmatic self-improve; markdown better for human/LLM reading.
  Likely: `--json` structured + a markdown render.)
- Sequencing: ship gbrain-src reader first (works on local raw immediately), then the
  durable-mirror script change, then dw-improve rewire? (recommend yes — incremental value.)
