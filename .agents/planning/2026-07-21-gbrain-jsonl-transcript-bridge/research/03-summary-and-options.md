# Research 03 — Summary & fix options

## The one-paragraph truth
`get_recent_transcripts` returns `[]` not because transcripts are missing but because
its reader (`listRecentTranscripts`) is a **stale twin**. The user's sessions (local +
cloud-desktop, 5 lanes) are flattened to `.md` daily by `~/.gbrain-bin/gbrain-collect-
sessions*`, staged in `~/.gbrain-sessions-staging/<lane>/`, and imported into the brain
as `type: session` pages (queryable via `search`/`query` — verified live). The dream
cycle's `discoverTranscripts` was upgraded in v0.30.3 (#708) to read `.txt` **and**
`.md` **recursively** with descent-time pruning. But `listRecentTranscripts` never got
that upgrade: it is still `.txt`-only, single-level, and reads two **unset** config keys
— so it short-circuits to `[]`.

## The divergence (the actual bug)
| Capability | `discoverTranscripts` (cycle) | `listRecentTranscripts` (get_recent_transcripts) |
|---|---|---|
| `.md` support | ✅ since #708 | ❌ `.txt` only |
| Recursive walk | ✅ `walk()` + `pruneDir` | ❌ single `readdirSync` |
| Corpus dir | same two config keys | same two config keys (unset) |
| Self-consumption guard | ✅ `.md` too | ✅ (isDreamOutput) |

Two readers, one domain, drifted apart. This is a textbook "fix the twin + add a guard
test so they can't drift again" change.

## MCP refusal & whoami — resolved, likely OUT OF SCOPE
- The MCP `permission_denied` is **by design** (`localOnly:true` + `ctx.remote` gate).
  The prior session's "call via the gbrain CLI" advice was correct guidance; it only
  failed because the CLI reader is ALSO broken (the twin bug above). Once the reader is
  fixed, the CLI path works and the local-only posture stays intact. **No change needed
  to the trust gate.**
- `whoami` `unknown_transport` over stdio MCP is intended fail-closed behavior (stdio =
  remote=true + no auth). Cosmetic at worst. Recommend NOT bundling into this fix.

## Fix options (for requirements decision)

### Option A — Fix the twin (RECOMMENDED, smallest correct fix)
In `listRecentTranscripts`:
1. Accept `.md` alongside `.txt`.
2. Recurse (reuse the same walk/prune approach as `discoverTranscripts` — ideally
   **share** the file-walk so they can't drift again).
3. Default corpus dir to `~/.gbrain-sessions-staging` when the config keys are unset
   (or document that the user must `gbrain config set …`). Recursion means one root
   covers all 5 lanes.
4. (polish) Strip frontmatter in `buildSummary` so the summary shows `**user:** …` not `---`.
- **Pros:** tiny, preserves the "raw file reader" semantics the tool advertises, makes
  both CLI and dream cycle consistent, one shared walker kills the drift class.
- **Cons:** still filesystem-coupled to the staging layout; if staging moves, breaks
  again (mitigated by defaulting to the known staging path + a doctor check).

### Option B — Re-point the op at imported pages
Reimplement `get_recent_transcripts` to read `type: session` pages from the DB
(newest-first by `date`), ignoring the filesystem.
- **Pros:** single source of truth (the brain); immune to staging-dir layout; naturally
  includes cloud sessions; no config to set.
- **Cons:** changes op semantics (raw file → page body); partially duplicates
  `query --type session`; the tool's own description ("raw transcripts … canonical, not
  flattened") becomes a lie since pages ARE the flattened form. Bigger behavioral change.

### Option C — Config-only, zero code
Just `gbrain config set dream.synthesize.session_corpus_dir ~/.gbrain-sessions-staging`.
- **Pros:** unblocks the dream cycle immediately (it already reads .md recursively).
- **Cons:** does NOT fix `get_recent_transcripts` (still `.txt`-only + non-recursive).
  So the original tool stays broken. Insufficient alone; useful as a complement to A.

## Recommendation going into requirements
**Option A + the Option C config default baked into code** (fall back to
`~/.gbrain-sessions-staging` when unset), with a shared file-walk between the two
readers and a drift-guard test. Leave the trust gate and `whoami` alone. Confirm with
the user in requirements:
- A (raw-file reader, fixed) vs B (page-backed reader)?
- Should the corpus dir default to `~/.gbrain-sessions-staging` in code, or stay
  config-driven (explicit `gbrain config set`)?
- Is the dream-cycle path in scope, or only `get_recent_transcripts`?
- `whoami`/stdio: in or out? (recommend out)
- Where does the fix land — only `gbrain-src` (the reader), or also the out-of-repo
  collector scripts? (recommend gbrain-src only)
```
