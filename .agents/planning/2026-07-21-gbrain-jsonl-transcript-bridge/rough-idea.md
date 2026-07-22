# Rough Idea

Fix the issue with `get_recent_transcripts` (gbrain).

## Symptom (from a prior session)
A prior session reported it could not read raw session transcripts:

> get_recent_transcripts is local-only and refused the MCP call ("call via the gbrain CLI").
> So everything above is from indexed session pages, not the full transcripts.

## Diagnosis (this session, confirmed against gbrain-src @ working copy)

Two distinct problems:

### Problem 1 — MCP refusal (partly by design, one real bug)
- `get_recent_transcripts` is intentionally **local-only**: the op gates on
  `ctx.remote === false`, so MCP/HTTP callers get `permission_denied`. This is the
  documented trust boundary for the user's most private data. **Working as designed.**
- BUT `whoami` over MCP throws `unknown_transport`:
  *"whoami called over a remote transport that did not thread ctx.auth. This is a
  transport bug — every remote call site must populate ctx.auth or set
  ctx.remote === false."* → a **real MCP-wiring defect** (fails closed, so safe, but
  it means remote calls reach handlers without `ctx.auth` threaded).

### Problem 2 — CLI returns `[]` too (the real, user-visible bug)
The suggested workaround ("call via the gbrain CLI") does NOT work:

```
$ gbrain call get_recent_transcripts '{"days":90,"limit":100}'
[]        # zero, even at 90 days
```

Root cause in `src/core/transcripts.ts` (`listRecentTranscripts`):
1. It reads two config keys — `dream.synthesize.session_corpus_dir` and
   `dream.synthesize.meeting_transcripts_dir`. **Both are unset** on this brain.
   Line ~70: `if (dirs.length === 0) return []` → silent empty result.
2. Even if a dir were set, it only scans **`.txt`** files
   (`if (!name.endsWith('.txt')) continue`). Claude Code writes **`.jsonl`**
   transcripts to `~/.claude/projects/**`. There are **213 `.jsonl` files in the
   last 30 days** (58 in this project's dir alone, some today). **No `.jsonl → .txt`
   conversion exists anywhere in the codebase.**

So the tool looks in an unconfigured directory for a file format the transcripts
aren't in — returning `[]` whether called over MCP or CLI. The reader
(`src/core/cycle/transcript-discovery.ts` `discoverTranscripts`) shares the same
`.txt`-only assumption.

## Goal
Make `get_recent_transcripts` (and, where it makes sense, the dream-cycle
`discoverTranscripts` corpus) actually surface the user's real recent sessions —
the Claude Code `.jsonl` logs in `~/.claude/projects/**` — so the original
brag-book / "what have I been working on" use case works. Optionally also fix the
`whoami`/`ctx.auth` MCP transport defect uncovered during investigation.

## Key source locations
- `src/core/transcripts.ts` — `listRecentTranscripts`, `buildSummary`
- `src/core/cycle/transcript-discovery.ts` — `discoverTranscripts`, dream guard
- `src/core/operations.ts` — `get_recent_transcripts` op definition (scope/localOnly)
- `src/core/operations-descriptions.ts` — tool description text
- `src/commands/transcripts.ts` — CLI command
- MCP transport / `ctx.auth` threading — `src/mcp/server.ts` (whoami defect)
