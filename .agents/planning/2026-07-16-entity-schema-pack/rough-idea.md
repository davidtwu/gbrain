# Rough Idea — Domain-Matched Schema Pack + Entity Extraction for gbrain

## The idea

Build (or extend) a gbrain schema pack that matches David Wu's actual brain content —
a transcript + PKM knowledge brain (work context: Amazon Stores, Fashion & Fitness,
reducing-returns / size-recommendation domain) — plus an entity-extraction pipeline so
the edge graph is actually populated. Today the graph is empty (0 links across 4,282
pages) because the active pack is a mismatch and entity linking is disabled.

## Why (diagnosis established during investigation)

1. **Active pack is `gbrain-base-v2` — a YC startup/investor ontology.** Its link verbs
   (`founded`, `invested_in`, `works_at`, `yc_partner`, `led_round`, `attended`, ...) and
   frontmatter-link rules key off page types `person`, `company`, `deal`, `meeting`.
2. **David's corpus has none of those page types.** `pages_by_type`: session 2711,
   email 633, concept 494, note 290, slack-channel 103, action 39, brag-book 9. So the
   entire frontmatter-link engine has nothing to bind to.
3. **The gazetteer (`by-mention.ts`) that powers entity-mention linking only reads
   stored `pages.type IN ('person','company','organization','entity')`** — a hardcoded
   constant (`LINKABLE_ENTITY_TYPES`, "pack-awareness is TODO-1"). David's ~57 authored
   entity pages (Relationships 27, Meetings 21, Initiatives 8) are all imported as
   `type: concept`, so the gazetteer skips them and NER never links transcripts to them.
4. **`path_prefixes` is a filing hint, not a read-time type override** — it does NOT
   rewrite the stored `type` column, so a pack alone can't re-type existing pages.
5. **The dream cycle's `extract` phase is filesystem-only** → permanently skipped on this
   DB-backed / checkout-less brain. Only `gbrain extract --stale` (DB-sourced) works, and
   even that produced 0 links (then 142 after enabling `link_resolution.global_basename`,
   all `link_type=source, link_source=frontmatter`, resolving to just 29 target pages).

Net: the empty graph is a **schema/content mismatch + disabled entity linking**, not a
bug. Embeddings are healthy (100% coverage, 9,348 chunks).

## What we want to build

1. **Custom pack** (`gbrain-dw` or similar) extending `gbrain-base-v2`, declaring
   `person` / `project` / `meeting` page types mapped to David's vault folders
   (doppelganger-cortex/Relationships, Initiatives, Meetings).
2. **Widen `LINKABLE_ENTITY_TYPES`** in `by-mention.ts` to include `project` + `meeting`
   (decided: YES — one-line source change to the gbrain checkout).
3. **Backfill** existing pages: re-type the ~57 entity pages concept → person/project/meeting.
   Must be REVERSIBLE (decided).
4. **Collector fix** so future vault syncs assign the correct types at import (else
   re-sync reverts them to `concept`).
5. **NER phase** in the dream cycle: link the ~3,447 transcript/email pages → entity pages
   via `mentions` / typed edges (deterministic gazetteer pass).
6. **LLM entity-discovery phase** → proposes NEW person/project pages found in transcripts
   into a **review queue** (decided). Mechanism mirrors the existing `take_proposals`
   pattern: pending table + list command + explicit accept/reject; no auto-promotion
   (D17: "the only path from queue to canonical is explicit accept"). 17 take proposals
   already sit pending from an earlier dream run — same UX.

## Decisions already locked (from clarification so far)

- Reuse vs create: **custom pack extending gbrain-base-v2** (no bundled pack matches:
  creator=tweetable atoms, investor=deals, engineer=code learnings).
- Link targets: **person + project + meeting** (widen the hardcoded gazetteer constant).
- Discovery output: **review queue** (mirror take_proposals), not auto-create.
- Backfill: **reversible**.
- Work happens on git branch `feat/entity-schema-pack` in the gbrain-src checkout.

## Environment facts

- Live engine: **Postgres** (`GBRAIN_DATABASE_URL=postgresql://...@localhost:5433/gbrain`
  in colima), NOT the PGLite in config.json — the env var overrides config.
- LLM: Bedrock Opus 4.8 via LiteLLM proxy (localhost:4000). `agent.use_gateway_loop=true`
  and `models.default=bedrock:us.anthropic.claude-opus-4-8` are set; dream cycle confirmed
  working end-to-end on Bedrock (no ANTHROPIC_API_KEY needed).
- Schema-inference tooling exists: `gbrain schema detect` (pure path-clustering) +
  `gbrain schema suggest` (LLM). Detect is directory-prefix based, so it can NOT
  distinguish relationships/meetings/initiatives (they're `__`-separated slug prefixes
  under one folder) — inference alone will not produce the semantic entity types.

## Open questions for clarification / research

- Exact page-type set: just person/project/meeting, or also company/organization?
- NER precision controls (ambiguous-name handling, min-name-length, ignore-list).
- Discovery phase: model tier, budget cap, review-queue schema + CLI/MCP surface.
- Whether to upstream the `LINKABLE_ENTITY_TYPES` change as pack-awareness (TODO-1) vs a
  local constant edit.
- Backfill reversibility mechanism (snapshot table vs. reversible migration vs. tagged rows).
