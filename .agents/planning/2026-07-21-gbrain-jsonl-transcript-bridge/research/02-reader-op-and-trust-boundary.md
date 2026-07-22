# Research 02 — Reader internals, op definition, trust boundary

## `get_recent_transcripts` op (`src/core/operations.ts:3697`)
```
scope: 'read'
localOnly: true          // hidden from HTTP tool-list AND runtime-rejected
cliHints: { name: 'transcripts', hidden: true }
handler:
  if (ctx.remote === true) throw permission_denied("… call via the gbrain CLI.")
  → listRecentTranscripts(ctx.engine, {days, summary, limit})
```
- **Defense in depth (intentional):** `localOnly:true` filters it from the HTTP
  tool-list (`serve-http.ts`), and the handler re-checks `ctx.remote===true`. Both the
  MCP permission_denied I hit AND the "hidden" CLI hint are by design.
- The op is deliberately NOT in the subagent allow-list (subagents run remote=true).

## The reader `listRecentTranscripts` (`src/core/transcripts.ts`)
Confirmed failure points (both must be fixed for a file-based fix):
1. `sessionDir = getConfig('dream.synthesize.session_corpus_dir')`,
   `meetingDir = getConfig('dream.synthesize.meeting_transcripts_dir')`. Both unset →
   `if (dirs.length === 0) return []`.
2. `for (name of readdirSync(dir))`: `if (!name.endsWith('.txt')) continue`. Staged
   sessions are `.md`.
3. Non-recursive: `readdirSync(dir)` reads one level. The staging dir is
   `~/.gbrain-sessions-staging/<lane>/*.md` — files are one level DOWN in lane
   subdirs. A file-based fix must recurse (or point at each lane).
4. `isDreamOutput(raw)` skip (self-consumption guard, `dream_generated: true`
   frontmatter). Staged sessions have `type: session` frontmatter, not the dream
   marker — so they pass. Good.
5. Summary mode = first non-empty line + ~250 chars. For a `.md` session file the
   first non-empty line after frontmatter is `**user:** …`. Acceptable; frontmatter
   isn't stripped though — `buildSummary` would show `---` as the first line. Minor
   polish item.

## Shared discovery (`src/core/cycle/transcript-discovery.ts`)
- `discoverTranscripts` is used by the **dream cycle** synthesize/extract-atoms phase.
  Same `.txt`-only + corpusDir assumptions. Fixing the reader's extension handling
  should be evaluated for the cycle too (if the cycle is meant to consume the staged
  sessions, it has the same blindness). BUT the cycle is a heavier, separately-gated
  path — touching it widens blast radius. Candidate to keep OUT of first fix.

## Config plumbing (`src/core/config.ts`)
- Keys exist in the typed config: `dream.synthesize.session_corpus_dir` +
  `.meeting_transcripts_dir` (lines 260-261, 747-765, 874-875). DB-config overlay
  supported. So a fix can either (a) set the DB config value, or (b) change the
  default resolution in code to fall back to `~/.gbrain-sessions-staging`.

## The `whoami` / `ctx.auth` "bug" — RE-CLASSIFIED after reading the code
My initial framing (a "transport defect") was too strong. Actual behavior:
- **stdio MCP** (`src/mcp/server.ts:43`) dispatches with `remote: true` and **no
  `ctx.auth`** — deliberately: "stdio MCP has no per-token auth (local pipe)". It sets
  remote=true so agent-facing callers stay untrusted for privacy-sensitive ops
  (takes/query holder allow-list = ['world']).
- **HTTP MCP** (`serve-http.ts` / oauth-provider) DOES populate `ctx.auth` from the
  bearer token.
- `whoami` (`operations.ts:3737`) returns `local` when `remote===false`, an oauth/legacy
  shape when `ctx.auth` present, and **throws `unknown_transport` when remote=true AND
  no auth** — which is EXACTLY the stdio case. This is intended fail-closed posture
  (v0.28.1), not a wiring accident.
- **Conclusion:** `whoami` is simply not meaningfully callable over stdio MCP. It's an
  awkward corner (stdio is neither cleanly "local" nor "oauth"), but it breaks nothing
  the user cares about and is orthogonal to the transcript problem. **Recommend
  deprioritizing / out of scope** unless the user specifically wants stdio `whoami` to
  return a `stdio` transport shape (small, separate change in server.ts + whoami).

## Enforcement summary
- `localOnly` gate happens in two places: thin-client CLI routing (`cli.ts:364`) and
  HTTP tool-list filtering; handler `ctx.remote` check is the runtime backstop.
- `gbrain call <op>` and `handleToolCall` set `remote:false` (trusted). That's why the
  local CLI call reached the reader (and returned [] for the corpus reasons above).
