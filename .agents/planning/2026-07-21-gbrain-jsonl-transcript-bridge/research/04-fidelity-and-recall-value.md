# Research 04 — Fidelity gap & what provides recall value

Motivated by the user's question: "Will we get the full transcripts with Option A? We
might not need the full transcript. Research what provides the most value from a recall
perspective — but self-improvement loops WILL want the full transcript to find
redundancy/improvement opportunities."

## There are THREE fidelity tiers, not two

```
 RAW .jsonl (4.1 MB, 1819 records)   ← ground truth: every tool call, result, thinking block
        │  collector py: keep only user/assistant TEXT blocks
        ▼
 STAGED .md (452 KB = 33% of raw)    ← what the brain actually ingests
        │  ├─ gbrain import → chunk (300w/6KB, 50w overlap) → embed  ═► FULL .md embedded (86 chunks)
        │  └─ get_recent_transcripts reader → raw.slice(0, 100 KB)   ═► only ~22% of the .md
        ▼
 RECALL SURFACES
```

### Measured on a real 4.1 MB yc session (`d344fe76`)
| Bucket | chars | % of raw | In staged .md? |
|---|---:|---:|---|
| tool_result | 513,332 | 37.9% | **DROPPED** |
| tool_use | 390,561 | 28.8% | **DROPPED** |
| assistant text | 318,611 | 23.5% | kept |
| user text (str+block) | 132,318 | 9.8% | kept |
| thinking (121 blocks) | present | — | **DROPPED** |
| **KEPT total** | **450,929** | **33.3%** | |
| **DROPPED total** | 903,893 | 66.7% | |

**The 67% that's dropped (tool_use + tool_result + thinking) is exactly what a
self-improvement loop needs**: what the agent *did*, what commands it ran, what failed,
where it repeated work. Conversation text alone tells you *what was discussed*, not
*what was done*. So Option A (read the staged `.md`) structurally cannot serve the
self-improvement use case — the fidelity was lost upstream at staging, not at read time.

## Key correction: import is NOT 100KB-capped; recall already sees the whole .md
- Import chunker (`src/core/chunkers/recursive.ts`): 300-word chunks, 6000-char hard
  cap, 50-word overlap, lossless reassembly. Confirmed live: a 248 KB session page →
  **86 chunks, fully embedded**. No import-time truncation.
- So `search`/`query`/`recall` ALREADY retrieve from the entire staged `.md`.
- The **only** place the 100 KB cap bites is `listRecentTranscripts` (`raw.slice(0,
  100*1024)`). That cap is a `get_recent_transcripts`-specific artifact, not a brain-wide
  limit.

## Two distinct consumer profiles (this is the real design fork)
| Consumer | Needs | Best-served by |
|---|---|---|
| **Recall / "what did I decide / work on"** | topical text, newest-first, cheap | ALREADY works via `search`/`query`/`recall` over the embedded chunks. `get_recent_transcripts` adds a "recent raw, un-ranked, chronological" view the ranked search doesn't. |
| **Self-improvement loop** ("find toil, redundancy, friction, improvement ops") | tool calls, results, errors, thinking — the FULL raw `.jsonl` | Neither the staged `.md` NOR Option A. Must read raw `~/.claude/projects/**/*.jsonl` (local) + the rsync'd remote copy. |

The user already runs a `dw-improve` self-improvement agent (see global CLAUDE.md) that
"reads David's agent sessions (5 sources via gbrain)". Worth confirming whether it reads
the lossy pages or the raw jsonl — if the former, it's been improving against a 33% view.

## What actually provides recall value (findings)
1. **For factual recall, the staged text is enough** and is already retrievable. Fixing
   `get_recent_transcripts` to read `.md` (Option A) adds a *chronological recent-window*
   view — useful for "what have I been working on this week" scans that ranked search
   doesn't naturally give. Value: real but incremental.
2. **The 100 KB cap should be raised or made a param** regardless — it silently returns
   22% of a session with no signal to the caller. Cheap win.
3. **For self-improvement, the raw `.jsonl` is the only sufficient source.** Options that
   serve it:
   - **D. Raw-jsonl reader**: a new (or extended) op/reader that reads
     `~/.claude/projects/**/*.jsonl` directly, preserving tool_use/tool_result/thinking,
     with a mode flag (`fidelity: 'text' | 'full'`). Local-only (raw jsonl is the most
     sensitive surface). This is what the prior session actually wanted.
   - **E. Richer staging**: teach the collector to ALSO emit tool/thinking content (a
     `--full` staging lane) so the brain ingests actionable detail. Bigger blast radius
     (out-of-repo scripts + storage cost + noise in recall) — probably wrong default.

## Revised option landscape (supersedes research/03 recommendation)
| Opt | What | Serves recall? | Serves self-improve? | Cost |
|---|---|---|---|---|
| A | reader reads `.md` + recurse + default corpus | yes (chrono window) | **no** | S |
| A+ | A, plus raise/param the 100KB cap | yes | no | S |
| B | op reads `type: session` pages | yes (dup of query) | no | M |
| **D** | raw-`.jsonl` reader, `fidelity` flag, local-only | yes (full) | **yes** | M |
| E | richer staging (tool/thinking) | yes | yes | L, risky |

**Emerging recommendation:** the highest-value target is **D** (raw-jsonl reader with a
fidelity flag), because it's the only one that unblocks BOTH the original "read my recent
sessions" ask AND the self-improvement use case the user flagged — and the raw files are
present locally (+ rsync'd for remote). A (fix the `.md` twin) becomes the cheap
text-tier fallback, still worth doing so the existing tool stops lying. Confirm scope in
requirements.

## Open questions surfaced for requirements
- Does `get_recent_transcripts` need FULL fidelity (tool/thinking) or is text enough?
  → likely a `fidelity: 'text' | 'full'` param rather than one-or-the-other.
- Remote/cloud raw jsonl is only present transiently (rsync'd to `/tmp` then deleted).
  A raw-jsonl reader on the laptop sees LOCAL raw + STAGED remote (text-only). Full
  fidelity for remote sessions would need the collector to retain raw or run the reader
  cloud-side. Is remote full-fidelity in scope?
- Who is the primary consumer — the user ad hoc, or `dw-improve`/self-improvement crons?
  Determines whether this is an MCP-exposed op (no — stays local-only) or a CLI/library
  the agents call.
