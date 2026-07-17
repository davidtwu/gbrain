# `take_proposals` review-queue pattern — end-to-end reference

Research for the `entity_proposals` queue (its mirror). Read-only investigation of
branch `feat/entity-schema-pack`. All file:line refs are to that checkout.

## TL;DR / headline finding

`take_proposals` is a **propose-only queue that is HALF-BUILT**. The `propose_takes`
cycle phase fully populates the queue (idempotent, budgeted, fence-deduped). But the
**accept/reject/promote side does NOT exist in code**:

- The columns that model human review — `acted_at`, `acted_by`, `promoted_row_num`,
  and the `accepted`/`rejected`/`superseded` status values — are defined in the DDL
  (`src/schema.sql:1288-1290`, migrate `src/core/migrate.ts:3426-3428`) but are
  **never written by any code path**.
- The doc comment in `propose-takes.ts:23` promises `gbrain takes propose --accept N`
  as "the only path from queue to canonical fence," but `src/commands/takes.ts` has
  **no `propose` subcommand** (dispatcher at `takes.ts:565-578` — subcommands are
  search/add/update/supersede/resolve/scorecard/calibration/revisit/extract only).
- There is **no MCP tool** for the proposal queue (only `takes_list`/`takes_search`/
  `takes_scorecard`/`takes_calibration` over the *canonical* takes, `operations.ts:1728+`).
- Live DB confirms: all 17 rows are `status='pending'`, `acted_at`/`promoted_row_num`
  all NULL. Nothing has ever been acted on.

So the pattern to mirror is: **the propose→queue half is real and well-tested; the
review→promote half is a schema-only design intent.** `entity_proposals` can copy the
propose-half wholesale and must *build* the promote-half (which for entities differs
fundamentally — see §6).

---

## 1. Table schema (exact DDL)

Source of truth: `src/schema.sql:1270-1300` (mirrored in `src/core/migrate.ts:3408-3438`
as migration `take_proposals_v0_36`, and in the PGLite schema `src/core/pglite-schema.ts:765`
+ `src/core/schema-embedded.ts:1294`; engine parity is an invariant).

```sql
CREATE TABLE IF NOT EXISTS take_proposals (
  id                          BIGSERIAL PRIMARY KEY,
  source_id                   TEXT         NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  page_slug                   TEXT         NOT NULL,
  content_hash                TEXT         NOT NULL,
  prompt_version              TEXT         NOT NULL,
  wave_version                TEXT         NOT NULL DEFAULT 'v0.36.1.0',
  proposed_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  proposal_run_id             TEXT         NOT NULL,
  status                      TEXT         NOT NULL DEFAULT 'pending'
                                           CHECK (status IN ('pending','accepted','rejected','superseded')),
  claim_text                  TEXT         NOT NULL,
  kind                        TEXT         NOT NULL,
  holder                      TEXT         NOT NULL,
  weight                      REAL         NOT NULL,
  domain                      TEXT,
  dedup_against_fence_rows    JSONB,
  model_id                    TEXT         NOT NULL,
  acted_at                    TIMESTAMPTZ,
  acted_by                    TEXT,
  promoted_row_num            INTEGER,
  predicted_brier             REAL,
  predicted_brier_bucket_n    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS take_proposals_idempotency_idx
  ON take_proposals (source_id, page_slug, content_hash, prompt_version);
CREATE INDEX IF NOT EXISTS take_proposals_pending_idx
  ON take_proposals (source_id, status, proposed_at DESC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS take_proposals_run_id_idx
  ON take_proposals (proposal_run_id);
```

### Column purposes

| Column | Purpose |
|---|---|
| `id` | Surrogate PK; referenced by `take_nudge_log.proposal_id` (FK, `schema.sql:1333`). |
| `source_id` | Multi-source isolation. FK to `sources`, `ON DELETE CASCADE`. Part of idempotency key. |
| `page_slug` | Which page's prose the claim was extracted from. Part of idempotency key. |
| `content_hash` | SHA-256 of the page body (`propose-takes.ts:164-166`). Part of idempotency key — this is what makes an unchanged page a cache hit. |
| `prompt_version` | The extractor prompt version (`PROPOSE_TAKES_PROMPT_VERSION = 'v0.36.1.0-tuned-cat15'`, `propose-takes.ts:56`). Part of idempotency key — bumping it cleanly invalidates the cache and forces re-extraction on every page. |
| `wave_version` | Release-wave tag (default `'v0.36.1.0'`), audit only. |
| `proposed_at` | Insert time; drives the `pending_idx` DESC ordering (newest first). |
| `proposal_run_id` | Groups all proposals from one cycle run (`propose-{ISO}-{uuid8}`, `propose-takes.ts:310`). Enables bulk `--rollback <run_id>` of a bad-prompt run (design intent per migrate comment `migrate.ts:3399-3401`; rollback itself not implemented). |
| `status` | Lifecycle enum: `pending`→`accepted`/`rejected`/`superseded`. Only `pending` is ever written today (default). |
| `claim_text` | The extracted gradeable claim (≤200 chars target, ≤500 enforced at parse `propose-takes.ts:269`). |
| `kind` | `'prediction'\|'judgment'\|'bet'` per prompt; parser also tolerates `fact\|take\|bet\|hunch` and defaults to `take` (`propose-takes.ts:270-272`). |
| `holder` | Whose claim: `world\|people/<slug>\|companies/<slug>\|brain` (defaults `brain`). |
| `weight` | Conviction 0..1 inferred from hedging language; clamped at parse (`propose-takes.ts:274-275`). |
| `domain` | Optional short tag (`tactics\|macro\|hiring\|…`). |
| `dedup_against_fence_rows` | JSONB snapshot of the fence rows the extractor was shown at proposal time — audit of "did the LLM see existing takes?" (F2 dedup, `migrate.ts:3396-3398`). |
| `model_id` | Extractor model (default `claude-sonnet-4-6`). |
| **`acted_at`** | **(review side — UNWRITTEN)** when a human accepted/rejected. |
| **`acted_by`** | **(review side — UNWRITTEN)** who acted (holder slug / operator). |
| **`promoted_row_num`** | **(review side — UNWRITTEN)** on accept, the `row_num` of the canonical takes-fence row this proposal became. This is the queue→canonical linkage. |
| `predicted_brier` / `predicted_brier_bucket_n` | (E5, UNWRITTEN) forecasted Brier at proposal time so the review UX could show "your historical Brier in this bucket is 0.31" (`migrate.ts:3402-3404`). |

### Idempotency key

`UNIQUE (source_id, page_slug, content_hash, prompt_version)` — `take_proposals_idempotency_idx`.
This is the whole cost-control story: an unchanged page (same body hash, same prompt
version) is a cache hit and never re-spends LLM tokens. Bumping `prompt_version`
invalidates the cache while leaving old proposals as audit history.

### Status enum

`CHECK (status IN ('pending','accepted','rejected','superseded'))`. Default `'pending'`.
In practice only `pending` is ever set (live DB: 17/17 pending, 0 acted).

---

## 2. The propose phase — `src/core/cycle/propose-takes.ts` (fully implemented)

`ProposeTakesPhase extends BaseCyclePhase`, phase name `propose_takes`
(`propose-takes.ts:286-287`). Entry point `runPhaseProposeTakes(ctx, opts)` at line 460.

**Eligible-page selection** (`propose-takes.ts:322-327`): `engine.listPages({ ...scope,
limit: pageLimit (default 100), sort: 'updated_desc' })`. Source-scoped via
`BaseCyclePhase`'s `ScopedReadOpts`. Skips pages with empty body (`:338-339`); optionally
skips pages that already carry a complete takes fence when `skipPagesWithFence`
(`:340`, default false).

**Dedup — two mechanisms:**
1. **Idempotency cache** (`:347-357`): before any LLM call, `SELECT id FROM take_proposals
   WHERE (source_id,page_slug,content_hash,prompt_version)`; if a row exists → count as
   cache hit and `continue`. This is the "prior proposals" fence.
2. **F2 fence dedup** (`:342-343`, `extractExistingTakesForDedup` `:183-211`): parses the
   page's existing `<!-- gbrain:takes:begin -->` fence into rows and passes them to the
   extractor as "already captured — do NOT propose duplicates" (prompt slot
   `{EXISTING_TAKES_JSON}`, `:111-112`). Strikethrough (`~~`) rows are treated as inactive
   and excluded (`:199`).

**Extractor prompt** (`EXTRACT_TAKES_PROMPT`, `:86-116`): defines "gradeable claim",
lists NOT-gradeable cases, conviction-inference rules, output = JSON array only. The LLM
call is injected via `opts.extractor` (`defaultExtractor` `:223-238` calls
`gateway.chat`); `parseExtractorOutput` (`:246-280`) is defensive (strips code fences,
extracts first array/object, returns `[]` on any parse failure — one bad page never
aborts the phase).

**Budget/cap enforcement** (`:288-289`, `:361-372`): `budgetUsdKey =
'cycle.propose_takes.budget_usd'`, default `$5.0`. Before each LLM call,
`this.checkBudget({ modelId, estimatedInputTokens:1500, maxOutputTokens:500 })`; on
exhaustion sets `budget_exhausted`, pushes a warning, and `break`s the page loop (phase
returns `status:'warn'`).

**Writing proposals** (`:392-415`): one `INSERT ... ON CONFLICT (source_id,page_slug,
content_hash,prompt_version) DO NOTHING` per claim (NOT a bulk upsert — a bulk upsert
would collapse a multi-claim page into one row since the idempotency key is per-page,
`:390-391`). Errors are swallowed per-page.

**Re-run behavior:** unchanged pages hit the cache (skip); changed pages get a new
`content_hash` (miss → re-extract). Bumping `PROPOSE_TAKES_PROMPT_VERSION` invalidates
all rows.

**Receipts/rollup** (`:422-446`): writes a `takes.proposed` receipt + rollup when
proposals were inserted (source-scoped).

Test coverage: `test/propose-takes.test.ts` (cache-hit path, insert-per-claim,
budget). Covers propose only — no accept/reject tests (they'd have nothing to test).

---

## 3. The accept/reject/promote path — **DOES NOT EXIST**

This is the most important finding for the mirror design.

- **No CLI verb.** `propose-takes.ts:6,23` reference `gbrain takes propose [--accept N]`,
  but `runTakes` (`src/commands/takes.ts:530-579`) has no `propose` case. The
  implemented `takes` subcommands operate on the **canonical** takes fence, not the
  queue: `add`/`update`/`supersede`/`resolve`/`list`/`search`/`scorecard`/`calibration`/
  `revisit`/`extract`.
- **No writer for the review columns.** Grep across `src/` + `test/`: `acted_at`,
  `acted_by`, `promoted_row_num`, and `status='accepted'/'rejected'` appear ONLY in
  DDL files (`schema.sql`, `migrate.ts`, `pglite-schema.ts`, `schema-embedded.ts`).
  No `UPDATE take_proposals` statement exists anywhere.
- **Live DB confirms:** `SELECT status,count(*) …` → 17 pending, 0 acted, 0 promoted.
- **No MCP surface** (see §4).
- The only non-cycle *reader* of the queue is the calibration nudge subsystem
  (`src/core/calibration/nudge.ts` + `take_nudge_log.proposal_id` FK), which can fire a
  reminder on a pending proposal — it does not accept or promote.

### What `--accept N` was *designed* to do (from the DDL/comments, to be built)

The intended semantics, reconstructed from `propose-takes.ts:20-23` and the column
purposes:

1. `N` is a **queue row identifier** the operator picks from a listing of pending
   proposals (row/id in the queue — NOT a fence row_num).
2. Accept = **promote the pending proposal to a canonical takes-fence row**: write it
   into the page's `<!-- gbrain:takes:begin -->` markdown fence via
   `upsertTakeRow` (`src/core/takes-fence.ts`, returns the new `rowNum`), mirror to the
   `takes` DB table (as `takes add` does at `takes.ts:189-204`), then set the proposal's
   `status='accepted'`, `acted_at=now()`, `acted_by=<operator>`, and
   **`promoted_row_num = <the new fence row_num>`** (the queue→canonical link).
3. Reject = set `status='rejected'`, `acted_at`, `acted_by`; the rejected content_hash
   stays in the table so the idempotency cache prevents that exact page/prompt from
   re-proposing the same claim (a rejected row is "dead" for dedup purposes). Note: dedup
   is keyed per-page-hash, not per-claim-text, so this is coarse.

The transaction shape (design): fence write + DB take insert + proposal status update
should be atomic per accept; the existing `takes add` path uses `withPageLock(slug, …)`
(`takes.ts:189`) — markdown is canonical, DB is mirror.

---

## 4. MCP surface

**None for the proposal queue.** The takes MCP operations in `src/core/operations.ts`
all target the **canonical** takes table, not `take_proposals`:

- `takes_list` (`operations.ts:1728-1758`) → `engine.listTakes(...)` — lists canonical
  takes filtered by holder/kind/active/resolved; server-side holder allowlist for remote
  callers.
- `takes_search` (`:1760-1775`) → `engine.searchTakes`.
- `takes_scorecard` (`:1785+`), `takes_calibration` — calibration aggregates over
  resolved bets.

There is **no** `takes_proposals_list` / `takes_propose_accept` / etc. The queue is not
exposed to any remote caller. So a mirror `entity_proposals` review flow would be
greenfield on the MCP side too — decide deliberately whether to expose it (and behind
which `mcp.*` gate + trust tier, given the write/promote nature).

---

## 5. Cycle registration & gating

`propose_takes` is a member of the `CyclePhase` union (`cycle.ts:68`) and registered in
`ALL_PHASES` (`cycle.ts:151`), ordered **after `consolidate`** so the extractor sees
freshly-consolidated takes for fence-dedup, and before `grade_takes` / `embed`
(`cycle.ts:140-153`).

- `PHASE_SCOPE.propose_takes = 'source'` (`cycle.ts:221`) — per-source parallelizable.
- In `NEEDS_LOCK_PHASES` (`cycle.ts:289`) — mutates DB, coordinates via the cycle lock.
- Because it is `'source'` (not `'global'`), it runs in the per-source autopilot cycle,
  NOT the single-flight `autopilot-global-maintenance` job (`GLOBAL_PHASES` /
  `NON_GLOBAL_PHASES` split, `cycle.ts:258-259`).

**Base-wave vs pack-gated (the difference to note for `entity_proposals`):**

- `propose_takes` is a **base-wave phase**: its dispatch block (`cycle.ts:2012-2037`)
  runs **whenever `phases.includes('propose_takes')`**, with the only guard being
  `if (engine)`. There is **no pack gate** — it runs for every brain regardless of the
  active schema pack.
- Contrast `extract_atoms` / `synthesize_concepts`, which are **pack-gated**: their
  dispatch (`cycle.ts:1778-1801`) calls `await packDeclaresPhase(engine, 'extract_atoms')`
  and no-ops with `details:{ reason:'not_in_active_pack', pack_gated:true }` when the
  active pack doesn't declare the phase.

**Design decision for `entity_proposals`:** if entity extraction is meant to be a
capability of the *entity schema pack* specifically (likely, given the branch name),
its propose phase should be **pack-gated** like `extract_atoms` — i.e. declared in the
pack's `phases:` list and guarded by `packDeclaresPhase(...)` — NOT a base-wave phase
like `propose_takes`. This is the single biggest registration divergence from the
take_proposals mirror.

---

## 6. `entity_proposals` — COPY vs. DIFFER

### Copy (the propose→queue half is a proven, reusable shape)

- **Table shape & idempotency key.** Reuse `(source_id, page_slug, content_hash,
  prompt_version)` UNIQUE + the `pending` partial index + a `proposal_run_id` for
  bulk rollback. Keep `status` enum, `wave_version`, `model_id`, `dedup_against_*` JSONB,
  and the (currently unwritten but well-designed) review columns `acted_at`/`acted_by`/
  `acted…`.
- **`BaseCyclePhase` propose phase.** Mirror `ProposeTakesPhase`: page selection via
  `listPages`, SHA-256 `content_hash` cache-check before the LLM, injected extractor,
  defensive JSON parse, `INSERT … ON CONFLICT DO NOTHING` per proposed entity, budget
  meter via `budgetUsdKey`, receipts/rollup.
- **`prompt_version` invalidation** discipline and the fence/prior-proposal dedup idea.

### Differ

1. **The promote target — this is the core divergence.**
   - A take is promoted into a **fence row on an existing page**: `upsertTakeRow` appends
     a row to that page's `<!-- gbrain:takes:begin -->` table and returns a `row_num`;
     `promoted_row_num` records that row_num. The canonical object is a *sub-row of a page*.
   - An entity proposal must be promoted into a **whole new page** (a person/project/
     company page) via **`put_page`** (`operations.ts:738-755`) — content = markdown +
     YAML frontmatter, which chunks/embeds/reconciles tags/graph-links. There is no
     "row_num" for a page.
   - **Therefore the linkage column must change:** replace `promoted_row_num INTEGER`
     with something like `promoted_slug TEXT` (and possibly `promoted_source_id`) — the
     slug of the page `put_page` created. The accept handler calls `put_page`, not
     `upsertTakeRow`, and the transaction records the resulting slug.
2. **Idempotency granularity.** Take proposals dedup per (page, body-hash) — a claim is
   *from* one page. An entity is often *mentioned across many pages*, so a per-source-page
   content_hash key may over-propose the same entity from N pages. Consider a dedup key
   that also folds a normalized entity identity (name/type) or a resolve-against-existing-
   pages check (analogous to the fence-dedup but against the *page namespace*, e.g.
   `resolve_slugs`), so the same person isn't proposed once per mentioning page.
3. **`kind`/`holder`/`weight`/`domain` columns** are take-specific (claim semantics).
   Entity proposals want entity fields instead: e.g. `entity_type` (person|project|
   company), `proposed_slug`, `display_name`, evidence/mention refs, confidence.
4. **Pack gating (see §5).** `entity_proposals` propose phase should be **pack-gated**
   to the entity schema pack (like `extract_atoms`), not a base-wave phase like
   `propose_takes`.
5. **Build the review half for real.** Unlike `take_proposals`, do not ship the
   accept/reject columns as dead schema. Implement the CLI verb (or MCP op) that (a)
   lists pending entity proposals, (b) `--accept` → `put_page` + status/acted/
   promoted_slug in one locked transaction, (c) `--reject` → dead-row so it's not
   re-proposed. Decide the dedup semantics of a rejected entity (per-page-hash coarse
   dedup will not stop the same entity re-proposing from another page — likely want a
   rejection keyed on entity identity).

---

## Flow diagram

```mermaid
sequenceDiagram
    autonumber
    participant Cycle as dream cycle (propose_takes phase)
    participant Pages as pages (markdown prose)
    participant LLM as extractor LLM (gateway.chat)
    participant Q as take_proposals queue
    participant User as operator (CLI review)
    participant Fence as canonical takes fence + takes table

    Note over Cycle: base-wave phase (NOT pack-gated); runs after consolidate
    Cycle->>Pages: listPages(scope, limit=100, updated_desc)
    loop each page with prose
        Cycle->>Q: SELECT by (source_id,page_slug,content_hash,prompt_version)
        alt cache hit (unchanged page + same prompt_version)
            Q-->>Cycle: row exists -> skip (no LLM spend)
        else cache miss
            Cycle->>Cycle: checkBudget (cap $5, break on exhaust)
            Cycle->>LLM: prompt + EXISTING fence rows (F2 dedup)
            LLM-->>Cycle: JSON array of gradeable claims
            Cycle->>Q: INSERT ... ON CONFLICT DO NOTHING (status='pending')
        end
    end

    Note over User,Fence: REVIEW HALF — designed in schema, NOT IMPLEMENTED
    User->>Q: gbrain takes propose (list pending)  %% verb missing
    User->>Fence: --accept N -> upsertTakeRow (new row_num) + mirror to takes table
    User->>Q: UPDATE status='accepted', acted_at, acted_by, promoted_row_num=<row_num>
    User->>Q: --reject -> UPDATE status='rejected' (row stays -> dedup keeps it dead)

    Note over User,Fence: entity_proposals MIRROR — promote step DIFFERS
    User->>Fence: --accept -> put_page(new person/project PAGE) [NOT a fence row]
    User->>Q: UPDATE status='accepted', promoted_slug=<new page slug>
```

---

## Key file:line index

- `src/schema.sql:1270-1300` — `take_proposals` DDL + indexes (canonical).
- `src/core/migrate.ts:3388-3439` — migration `take_proposals_v0_36` + design comments.
- `src/core/pglite-schema.ts:765`, `src/core/schema-embedded.ts:1294` — engine-parity DDL.
- `src/core/cycle/propose-takes.ts` — the propose phase (whole file):
  - `:56` `PROPOSE_TAKES_PROMPT_VERSION`; `:86-116` prompt; `:164-166` `contentHash`;
  - `:183-211` fence dedup parse; `:246-280` defensive output parse;
  - `:288-289` budget key/default; `:322-357` selection + idempotency cache;
  - `:361-372` budget enforcement; `:392-415` INSERT-per-claim; `:460` entry point.
- `src/commands/takes.ts:530-579` — `runTakes` dispatcher (NO `propose` subcommand);
  `:189-204` the `takes add` fence+DB mirror pattern an accept handler would reuse.
- `src/core/takes-fence.ts:106-107` fence markers; `:404-434` `renderTakesFence`;
  `upsertTakeRow` returns new `rowNum` (the take promote target).
- `src/core/operations.ts:738-755` `put_page` (the entity promote target);
  `:1728-1775` `takes_list`/`takes_search` MCP ops (canonical takes, NOT the queue).
- `src/core/cycle.ts:68,151` union + `ALL_PHASES` membership; `:221` `PHASE_SCOPE='source'`;
  `:289` `NEEDS_LOCK_PHASES`; `:2012-2037` **ungated** dispatch (base-wave);
  `:1778-1801` `extract_atoms` **pack-gated** dispatch (the contrast to follow for entities).
- `src/core/calibration/nudge.ts` + `take_nudge_log` (`schema.sql:1329-1348`) — only
  non-cycle consumer of the queue (reminders on pending proposals).
- Live DB: `take_proposals` = 17 rows, all `status='pending'`, `acted_at`/`promoted_row_num` NULL.
