# Idea Honing — Entity Schema Pack + Entity Extraction

Requirements clarification Q&A. One question at a time; answers recorded as decided.

## Pre-established decisions (from investigation prior to formal PDD)

- **Reuse vs create:** custom pack extending `gbrain-base-v2`.
- **Link targets:** person + project + meeting (widen hardcoded `LINKABLE_ENTITY_TYPES`).
- **Discovery output:** review queue mirroring `take_proposals` (no auto-create).
- **Backfill:** must be reversible.
- **Branch:** `feat/entity-schema-pack` in gbrain-src.

---

### Q1. Exact entity page-type set

What entity page types should the pack declare? We've locked person + project + meeting.
The question is whether to also add `company`/`organization` (Amazon orgs, partner teams,
vendors) and whether `meeting` should be a linkable *entity* at all vs. just a source page.

Context from the corpus:
- Vault has Relationships (27→person), Initiatives (8→project), Meetings (22→meeting),
  Companies (0 files), Accounts (0 files).
- `meeting` is philosophically a *source/event*, not an *entity you mention* — linking
  transcripts to a meeting page is different from linking to a person/project.
- Adding types with zero backing pages ships dead schema (the engineer-pack author
  explicitly warns: "shipping types nobody authors is worse than no types at all").

**Answer (CONFIRMED):** **Option D**: `person` + `project` **linkable** (in gazetteer); `meeting`
declared as a **source page, NOT gazetteer-linked** (keeps outbound `attended` edges via
frontmatter_links attendees→person); `organization`/`company` **deferred for v1** (not
declared).

Evidence:
- Gazetteer `LINKABLE_ENTITY_TYPES` = ['person','company','organization','entity'] —
  contains NEITHER project nor meeting. So making `project` linkable REQUIRES adding
  'project' to that constant in by-mention.ts:33 (unavoidable for any project-linking option).
  `person` is free (already present).
- `project` earns the edit: SHAKE/Rufus/Mosaic appear as distinctive proper nouns in
  ~754 sessions (survive MIN_NAME_LENGTH=4).
- `meeting` NOT linkable: referenced generically ("the meeting/our sync/standup", ~150
  hits), titles are date+topic descriptors, never name-mentioned in other pages. It's an
  event/source, not a mentioned entity. Keep meeting→attended OUTBOUND edges only.
- `organization`/`company` deferred: 0 authored pages (dead-schema), and org names here are
  either ignore-listed bigcos (Amazon/Google, 1109 hits) or common words ("team/org/group"
  625 hits) → severe false-positive risk. High-value proper nouns (SHAKE/Rufus) are caught
  by `project` anyway. Revisit in v2 once discovery yields a clean org sample.
- **Latent hazard flagged:** `company`/`organization` are ALREADY in LINKABLE_ENTITY_TYPES,
  so if the discovery phase ever writes type='company'/'organization' pages they become
  gazetteer-linked with zero code change → must gate discovery's org output until vetted.
- Open dependency: whether the new pack `extends: gbrain-base` (inherits attended
  inference + attendees frontmatter_link) or is standalone (must re-declare them). TBD in design.

**Follow-up confirmed (meeting→project / meeting→person edges):** The NER walk
(`extract-ner.ts:155`) scans pages as SOURCES by body text; `typeFilter` is optional.
Gazetteer TARGETS and source-walk are independent. So meeting pages — excluded from the
gazetteer as targets — are still walked as sources. Because meeting pages are entity-dense
(a real one names Alexander Collado / Amit Agrawal / Mike Stuck AND projects like
"Cost-Aware Return Scoring", "Returns Adjustment in Search Ranking", "DAPT"), Option D
yields for FREE:
  - meeting → person edges (gazetteer mention + `attended` frontmatter_link)
  - meeting → project edges (gazetteer mention)
Caveat: meeting→project coverage depends on project pages existing as gazetteer targets;
today only 8 Initiatives exist, so coverage grows as the discovery phase proposes+approves
more `project` pages. Meeting pages are high-QUALITY sources (curated) vs. noisy raw transcripts.

---

### Q2. NER / mention precision controls

The gazetteer matcher can produce false-positive edges. `by-mention.ts` already ships some
guards; we need to decide the precision posture for this brain. Known knobs (from code):
- `MIN_NAME_LENGTH = 4` — drops 2-3 char names (would drop real handles "F2", "Cue").
- `DEFAULT_IGNORE_LIST` — ~8 built-in ambiguous tokens dropped from gazetteer UNLESS a
  page with that exact title exists (CK12: ignore applied at build time, overridable by an
  explicit page).
- Maximal-munch longest-match matcher; aliases from page frontmatter feed the gazetteer.
- Person names: common first names ("David", "Mike") risk over-linking across unrelated people.

Decision needed: (a) keep MIN_NAME_LENGTH=4 or lower it for real short project handles?
(b) do we need a David-specific ignore/allow list (e.g. suppress "returns"/"fit"/"size" as
project tokens, allow "F2"/"Cue")? (c) how to disambiguate common first-name-only mentions
to the right person page — require last name / alias match, or accept first-name links?

**Answer (CONFIRMED — precision-over-recall posture):**
- (a) Keep `MIN_NAME_LENGTH = 4` as the default floor, BUT add an explicit **allow-list**
  for real short handles ("F2", "Cue") so they link while random 2-3 char tokens stay
  suppressed. (Allow-list is the inverse of the ignore-list: force-include specific tokens.)
- (b) Ship a David-specific **domain ignore-list** of ambiguous English/domain words
  ("returns", "fit", "size", "compatibility", "discovery", "signal", …) so these only
  produce edges when the page title is unambiguously that entity (e.g. a project titled
  exactly "Returns Signal"), never on the bare common word.
- (c) **Require last-name or alias disambiguation** for person links: accept
  "Mike Stuck" / "mikstuck" (alias), REJECT bare first-name "Mike". Precision over recall;
  aliases can be added over time via review. Rationale: bare first names ("David", "Mike",
  "Alex") recur across unrelated people and would conflate distinct person pages.

Posture rationale: this is an institutional-memory brain where a wrong edge is worse than a
missing one, and discovery already routes through a review queue — so bias the deterministic
NER pass toward precision. Implementation detail (design phase): the allow-list / ignore-list
should be pack- or config-driven, not hardcoded, so it's tunable without a source edit.

**Implementation note:** by-mention.ts currently has a hardcoded `DEFAULT_IGNORE_LIST` (~8
tokens) and `MIN_NAME_LENGTH`. Design must decide: extend those hardcoded lists vs. make
them config/pack-driven (preferred). The first-name-rejection rule (c) is NOT in the current
matcher — it's new logic (require multi-token OR alias match for person-typed targets).

---

### Q3. LLM entity-discovery phase — scope, model, budget, review surface

Decided already: discovery proposes NEW entity pages (person/project) from transcripts into a
review queue mirroring `take_proposals` (pending table + list + explicit accept/reject; no
auto-promotion). Remaining decisions:
- (a) **What it proposes:** person + project only (matches gazetteer targets)? Or also emit
  org candidates (flagged, since company/organization are latently gazetteer-linkable —
  Q1 hazard)? 
- (b) **Model + budget:** which tier drives it (Bedrock Opus 4.8 is the only proxied chat
  model; Haiku/Sonnet aren't routed), and what per-run / per-source cost cap? Existing phases
  use caps like $0.30/source (extract_atoms), $0.50/skill (skillopt).
- (c) **Cadence + volume:** run every dream cycle, or less often? Cap N proposals/run so the
  review queue stays reviewable (17 take-proposals already pending)?
- (d) **Review surface:** CLI verb + MCP tool naming (e.g. `gbrain entities propose --list`
  / `--accept N` / `--reject N`), mirroring the takes-propose surface.

**Answer (CONFIRMED):**
- (a) **person + project only.** Org-like signals surface as a TAG/attribute on
  person/project proposals ("works at X"), NEVER as `type=organization` pages — because
  company/organization are latently gazetteer-linkable (Q1 hazard), auto-discovered orgs
  would create noisy edges on accept. Orgs deferred to v2.
- (b) **Bedrock Opus 4.8** (only proxied chat model). Budget: **$0.50/source/run**
  (config key e.g. `cycle.discover_entities.budget_usd`), brain-wide backstop **$2.00/run**.
- (c) **Every dream cycle, capped at ~15 new proposals/run.** Idempotent via content-hash
  (mirrors take_proposals) so the same entity isn't re-proposed. Per-run cap keeps the queue
  reviewable (17 take-proposals already pending — queue-pileup is the real failure mode).
- (d) **Mirror the takes surface exactly:** CLI `gbrain entities propose --list / --accept N
  / --reject N`; MCP `entity_proposals_list` / `entity_proposals_act`. D17 guarantee:
  explicit accept is the ONLY path from queue → real page.

Implementation notes for design phase:
- New table `entity_proposals` (parallel to `take_proposals`): status pending/accepted/
  rejected, proposed slug+type+aliases, source page_slug, content_hash+prompt_version
  idempotency key, model_id, confidence, acted_at/acted_by.
- Accept promotes proposal → real person/project page (enters gazetteer next NER pass).
- New cycle phase `discover_entities`, pack-gated (only fires when this pack is active),
  ordered relative to NER (discovery BEFORE ner so accepted entities can link same-cycle —
  though accept is manual, so realistically links land the cycle AFTER approval).

---

### Q4. Backfill reversibility mechanism

The backfill re-types ~57 existing pages (doppelganger-cortex/relationships__* → person,
initiatives__* → project, meetings__* → meeting) on the LIVE Postgres brain. Locked:
reversible. HOW?

Options:
- (i) **Snapshot table**: before UPDATE, copy (id, slug, old_type) into a `backfill_YYYYMMDD`
  table; revert = UPDATE pages FROM snapshot. Simple, self-contained, one-command undo.
- (ii) **Reversible migration**: write an up/down migration in the gbrain migration system.
  Fits the repo's schema-version machinery, but heavier for a data (not schema) change.
- (iii) **Tagged rows**: set a marker (e.g. tag `backfill-2026-07-16` or a column) on touched
  rows; revert = re-type all tagged rows back to concept. Leaves an audit trail on the page.
- Also: idempotency (safe re-run), and interaction with the COLLECTOR FIX — once the vault
  collector assigns correct types at import, a future re-sync would re-assert `person` anyway,
  so "revert" semantics must be clear (revert the DB rows, AND/OR revert the collector?).

**Answer (CONFIRMED):** **(i) Snapshot table.**
- Before the UPDATE, copy `(id, slug, source_id, old_type)` of every touched row into a
  `backfill_entity_types_20260716` table. Revert = `UPDATE pages ... FROM snapshot`.
- Expose a script with `--dry-run` (show what would change), `--apply`, `--revert`.
- Idempotent: `--apply` skips rows already snapshotted; `--revert` restores from snapshot.
- Right scope: a one-time DATA operation on David's brain, NOT a schema migration that would
  ship with the pack (rejected option ii) and NOT tag-pollution on pages (rejected option iii).
- **Collector-fix interaction (accepted):** the vault collector's entity-typing is GATED on
  the pack being active. So a clean revert = restore snapshot + deactivate pack; there's no
  drift where the DB says `concept` but a re-sync re-asserts `person`. Collector fix and pack
  are one feature behind one switch.

---

### Q5. Pack name + extends target

- **Pack name:** `gbrain-shake` (CONFIRMED, "for now" — David's SHAKE team context).
### Q6 (post-research). Discovery scope + linkable-widening mechanism

- **RO-1 discovery scope:** **FULL** — build `discover_entities` phase + `entity_proposals`
  table + the COMPLETE review path (accept/reject/promote-to-page) with CLI
  (`gbrain entities propose --list/--accept/--reject`) AND MCP tools
  (`entity_proposals_list`/`entity_proposals_act`). This is net-new (the take_proposals
  review half was never coded), not a mirror. Accept → `put_page` creates a real
  person/project page → enters gazetteer next NER pass.
- **RO-3 linkable widening:** **TODO-1 pack-aware `linkable` flag** — add a `linkable:`
  boolean to PageTypeSchema (mirrors existing `expert_routing`/`extractable` per-type
  booleans), rewire `buildGazetteer`/`buildTargetTypeMap` (by-mention.ts) AND the twin
  filter in extract-ner.ts to read linkable types from the active pack manifest instead of
  the hardcoded const. Scopes `project` linkability to gbrain-shake (not global). Base-pack
  parity: mark base/base-v2 person/company/organization/entity as `linkable: true` so
  existing behavior is preserved.

### Q7 (post-research, user-raised). Corpus-matched type set — data-loss guard

Because `extends` does NOT merge at runtime, gbrain-shake must declare the FULL active type
set. Verified against base-v2 + live corpus:
- **ADD real generated types base-v2 omits:** session (2711), slack-channel (103), action (39),
  brag-book (9) = 2,862 pages / 67% of brain. base-v2's `*unknown*→note` catch-all would
  silently retype ALL of these to `note` on a unify-types pass. **This is the highest-severity
  correctness item in the whole project** — without it, activating a pack that lacks these
  types risks flattening two-thirds of the brain.
- **FIX slack:** base-v2 `slack` aliases = slack-message/slack-thread, NOT slack-channel (the
  actual stored type). Decision: add `slack-channel` as an alias of `slack`.
- **DROP:** deal, tweet, social-digest (VC/social artifacts, 0 pages, 0 relevance).
- **CARRY:** concept, note, email, atom, media, source, analysis, writing, event, diary +
  person/project/meeting. gbrain-shake = full corpus-matched taxonomy minus VC cruft.
- Keep `*unknown*→note` catch-all as a safety net (won't fire once real types declared).
- Consider dropping VC link verbs (founded/invested_in/led_round/yc_partner/advises) under
  no-merge; keep mentions/relates_to/discusses/works_at/attended.

**Checkpoint rulings (CONFIRMED):**
- slack: **`slack-channel` = alias of `slack`** (one temporal type, less surface).
- VC link verbs: **DROP** founded/invested_in/led_round/yc_partner/advises from gbrain-shake
  (no-merge means we hand-author the verb list; these are dead for Amazon PE work). Keep
  mentions/relates_to/discusses/works_at/attended.
- Growth loop: **KEEP manual-accept gate** (discovered entity becomes linkable only after
  approval; edges land next cycle). Graph grows at review cadence — accepted. No auto-accept.

### Q5 resolution (recap)
- **extends target:** **CONFIRMED `extends: gbrain-base-v2`** (subagent debate, code-verified).
  BUT the reasoning corrects the premise:
  - **`extends` does NOT merge at runtime** (registry.ts:277 — "Full extends-merging is the
    v0.41+ T20 follow-up"; resolved manifest = child alone). So parent choice is near-inert
    today: gbrain-shake MUST self-declare person/project/meeting/link_types regardless.
  - **meeting→person `attended` edge is HARDCODED, pack-independent** (link-extraction.ts:703
    + FRONTMATTER_LINK_MAP:792) — fires for any `type:meeting` + `attendees:` under either
    parent. Not inherited from a pack.
  - **base-v2 has NO `meeting` type** (only `note` + `*unknown*→note` catch-all), so
    gbrain-shake declares `meeting` itself either way.
  - Deciding reasons for v2: (1) corpus is ALREADY typed under base-v2's 15-type canonical
    set (matches reality); (2) base-v2 is the active pack (least-surprise "successor"
    lineage); (3) IF T20 merge ever lands, unioning against base-v2's clean 15 types is
    merge-safe, vs base's 39-type YC/legacy sprawl (#1479 built v2 to kill that).
  - Orphan-risk tie-breaker RESOLVED: no interaction. `schema_review_orphans` counts
    `type IS NULL OR ''`, NOT "type absent from active pack"; put_page type-check is a soft
    WARN, never reject/null. Parent choice can't orphan the typed corpus.
  - **Migration flag (research/design):** base-v2's `*unknown*→note` catch-all would retype
    meetings→note IF a `unify-types` pass ran (base-v2 has no meeting type). Existing 22
    meeting pages are currently `type:concept`. The backfill must set them to `type:meeting`
    AND gbrain-shake must declare `meeting` so they aren't demoted to note. Verify before
    activating pack.






