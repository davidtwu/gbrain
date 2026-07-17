# Implementation Plan — `gbrain-shake` Entity Schema Pack + Entity Extraction

TDD, incrementally demoable. Each step ends in working, demonstrable functionality that
builds on the previous and wires in (no orphaned code). Core end-to-end value (a populated
graph from existing entities) lands by Step 5 — discovery + review surface build on top.

Design of record: `../design/detailed-design.md`. Decisions: `../idea-honing.md`.
Branch: `feat/entity-schema-pack` (gbrain-src). Live engine: Postgres (:5433, colima).

## Progress checklist

- [ ] Step 1 — Pack manifest `gbrain-shake` (full corpus-matched type set, NOT active yet)
- [ ] Step 2 — `linkable` manifest field + pack-aware gazetteer helper (base parity preserved)
- [ ] Step 3 — Reversible backfill command (`--dry-run/--apply/--revert` + snapshot table)
- [ ] Step 4 — Pre-activation type-coverage guard + activate pack + collector typing fix
- [ ] Step 5 — `ner_link` cycle phase (DB-sourced, pack-gated) → **first graph edges**
- [ ] Step 6 — NER precision knobs (allow/ignore list, first-name rejection)
- [ ] Step 7 — `entity_proposals` table (4-place migration, both engines)
- [ ] Step 8 — `discover_entities` cycle phase (LLM, budgeted, pack-gated) → proposals
- [ ] Step 9 — Review + promote CLI (`gbrain entities propose --list/--accept/--reject`)
- [ ] Step 10 — Review MCP tools + wire both new phases into cycle ALL_PHASES + pinning tests
- [ ] Step 11 — End-to-end growth-loop validation on the live brain

---

Step 1: Author the `gbrain-shake` pack manifest (full corpus-matched taxonomy)

Objective: create `src/core/schema-pack/base/gbrain-shake.yaml` — `extends: gbrain-base-v2`,
declaring the COMPLETE type set the corpus uses (person, project, meeting + session,
slack-channel-via-slack-alias, action, brag-book + carried concept/note/email/atom/media/
source/analysis/writing/event/diary), dropping deal/tweet/social-digest, dropping VC link
verbs (founded/invested_in/led_round/yc_partner/advises), keeping mentions/relates_to/
discusses/works_at/attended. `phases: [discover_entities, ner_link]` declared (phases don't
exist yet — declaration is inert until Steps 5/8). `linkable`/`path_prefixes` fields included
even though the code that reads `linkable` lands in Step 2.

Guidance: model on gbrain-base-v2.yaml structure. Do NOT set it active (config unchanged).

Tests: manifest loads + validates against manifest-v1 schema; declares the required types;
slack aliases include slack-channel; excludes deal/tweet/social-digest; a corpus-coverage
unit test asserts every DISTINCT stored type (fixture list from live brain) is covered by
pack types+aliases.

Integrates with: nothing yet — a standalone, inactive artifact.

Demo: `gbrain schema lint gbrain-shake` passes; a test prints the covered-vs-corpus type
diff showing 0 uncovered types.

---

Step 2: `linkable` manifest field + pack-aware gazetteer helper (R4 / TODO-1)

Objective: add `linkable: boolean` (default false) to PageTypeSchema (manifest-v1.ts,
alongside expert_routing/extractable). Add `linkableTypesFromPack(engine)` helper. Rewire
`buildGazetteer` + `buildTargetTypeMap` (by-mention.ts) AND the twin type filter
(extract-ner.ts:206) to read the helper instead of the hardcoded `LINKABLE_ENTITY_TYPES`.
Mark base + base-v2 person/company/organization/entity `linkable: true`; mark gbrain-shake
person/project true, meeting false.

Guidance: keep the const as the fallback when no pack/linkable info is available (safety).
Audit the other 4-type-filter copies (onboard/checks, impact-capture, init-nudge, doctor) —
move linking-related ones to the helper; leave expert-routing ones.

Tests: `linkableTypesFromPack` → {person,project} for shake, {person,company,organization,
entity} for base-v2 (byte-for-byte parity). Integration: project page is a gazetteer target
under shake, not under base-v2. Regression: base-v2 gazetteer output unchanged.

Integrates with: Step 1's pack (reads its linkable flags). Gazetteer now pack-aware but no
behavior change until shake is active + project pages exist.

Demo: test shows the same brain yields different linkable-type sets under base-v2 vs shake.

---

Step 3: Reversible backfill command (R2)

Objective: `src/commands/backfill-entity-types.ts` with `--dry-run/--apply/--revert`. Lazy
`CREATE TABLE IF NOT EXISTS backfill_entity_types_20260716`. Re-types
doppelganger-cortex/relationships__*→person, initiatives__*→project, meetings__*→meeting.
Snapshot-before-write; idempotent; wrong-brain guard.

**ADDED (Step 1 finding):** ALSO retype the 103 `slack-channel` pages → `slack` (a DECLARED
type NAME). Reason: the `*unknown*→note` catch-all matches on names only, NOT aliases — so the
slack-channel alias is not a runtime shield. Backfilling to the declared `slack` name makes
those pages catch-all-safe. Snapshot them too (reversible). This is the ONLY type-family where
alias≠safety bit us; reference/extract_receipt/vault-cleanup are declared as own names in the pack.

Guidance: reuse backfill-base.ts idioms (keyset pagination, reserved connection, config
checkpoint). Snapshot table NOT in static schema (disposable). `--apply` requires prior
`--dry-run` or `--yes`.

Tests: dry-run reports N, writes nothing. apply re-types fixture pages + writes snapshot.
revert restores exact old types (round-trip identity). Crash-resume: kill mid-apply, re-run,
no double-processing. Wrong-brain guard aborts when expected slugs absent.

Integrates with: operates on live pages; independent of pack activation (can apply before
activation, revert after). Does NOT activate anything.

Demo: `--dry-run` on live brain prints "57 pages would re-type (27 person, 8 project, 22
meeting)"; apply then revert leaves the brain identical (verified by type-count query).

---

Step 4: Pre-activation type-coverage guard + activate pack + collector fix (R1b, R3, §6.2)

Objective: (a) a pre-activation check (`gbrain schema check-coverage gbrain-shake` or a guard
in the activation path) that asserts every DISTINCT stored `pages.type` is covered by the
pack's types+aliases; ABORT with the uncovered list otherwise. (b) After backfill (Step 3)
+ coverage passes, activate: `gbrain config set schema_pack gbrain-shake`. (c) Collector fix
in `~/.gbrain-bin/gbrain-refresh-vault`: rewrite frontmatter `type:` per subfolder during
staging, gated on active pack == gbrain-shake.

Guidance: the coverage guard is the safety net that makes R1b enforceable — it prevents the
`*unknown*→note` catch-all from flattening the 2,862 undeclared-type pages. Run backfill
(Step 3 --apply) BEFORE activation so entity pages are already typed.

**CRITICAL (Step 1 finding):** the coverage guard MUST require every stored type to match a
declared type NAME — alias coverage is INSUFFICIENT, because the catch-all
(unify-types-handler.ts:189) exempts on names only, not aliases. So the guard's covered-set =
pack type NAMES only (not names∪aliases). Any stored type that maps only to an alias (e.g.
slack-channel before Step 3's backfill) must be flagged uncovered → abort. This is why Step 3
retypes slack-channel→slack first.

Tests: coverage check passes for shake against the live type set; fails (with list) for a
deliberately-incomplete fixture pack. Collector test: staging a Relationships file rewrites
type: person only when shake is active. Post-activation: `SELECT DISTINCT type` unchanged
(no catch-all flattening).

Integrates with: Steps 1+3. This is the activation gate — after it, shake is live and
gazetteer sees person/project targets (but no NER phase runs them yet).

Demo: run coverage check (passes, 0 uncovered), activate, show `get_stats` type counts
unchanged; re-sync vault, show a relationship page now imports as type: person.

---

Step 5: `ner_link` cycle phase — FIRST GRAPH EDGES (R6)

Objective: `src/core/cycle/ner-link.ts` — BaseCyclePhase wrapping `extractNerLinks`,
DB-sourced, pack-gated, `!engine` guard ONLY (never brainDir). Writes mentions edges from
source pages → linkable entity pages. Register in ALL_PHASES after where discover_entities
will go (Step 8 slots in before it); update pinning tests minimally for this one phase.

Guidance: this is the payoff step — after Steps 1-4, entity pages exist + are linkable, so
running this phase links transcripts/meetings to them. Meeting→person (attended, hardcoded)
already fires at ingest; this adds mentions edges.

Tests: fixture brain (1 person + 3 transcripts naming them) → 3 mentions edges; re-run → 0
(idempotent). `!engine` guard: runs on checkout-less DB brain, does NOT skip no_brain_dir.
meeting→project mentions + meeting→person attended both fire on a fixture meeting.

Integrates with: the live activated brain from Step 4. `gbrain dream --phase ner_link`
produces real edges NOW.

Demo: `gbrain dream --phase ner_link` on the live brain → `get_stats` link_count goes from 0
to N; `get_backlinks doppelganger-cortex/relationships__mike-stuck` shows transcripts/meetings
that mention him. **The graph is populated.**

---

Step 6: NER precision knobs (R5)

Objective: read `ner.allow_list`, `ner.ignore_list`, `ner.reject_first_names` from config in
the gazetteer/matcher path. allow_list force-includes short handles (F2, Cue) past
MIN_NAME_LENGTH; ignore_list suppresses ambiguous domain words unless exact-title match;
reject_first_names requires multi-token/alias for person targets. Seed defaults.

Guidance: malformed-config → fall back to defaults + warn (never crash, never silently
disable). Wire into by-mention.ts matcher + extract-ner.ts.

Tests: per-knob units (F2 links with allow_list; "returns" suppressed by ignore_list; bare
"Mike" rejected, "Mike Stuck"/alias accepted); malformed-config fallback.

Integrates with: Step 5's ner_link phase — improves edge precision. Re-run NER shows fewer
false-positive edges.

Demo: seed a transcript with "returns" + "Mike" + "Mike Stuck"; NER before knobs links all;
after knobs links only "Mike Stuck". Show the edge-count/precision delta.

---

Step 7: `entity_proposals` table (4-place migration, R8 data model)

Objective: migration v123 adding `entity_proposals` (DDL per design §5.1) in ALL FOUR places:
migrate.ts, src/schema.sql, pglite-schema.ts template, regenerate schema-embedded.ts via
`bun run build:schema`. Engine methods: insertEntityProposal, listEntityProposals(status?),
actEntityProposal(id, action).

Guidance: mirror take_proposals DDL but promoted_slug (not promoted_row_num) + entity columns
+ org_hint. Idempotency UNIQUE (source_id, source_page_slug, content_hash, prompt_version).

Tests: fresh Postgres install → table exists w/ correct DDL; fresh PGLite → same; v122→v123
migration adds it, idempotent re-run. Engine methods round-trip.

Integrates with: schema layer only; no phase writes to it yet (Step 8).

Demo: fresh-install both engines in test → entity_proposals present; insert+list+act a row
via engine methods.

---

Step 8: `discover_entities` cycle phase (R7)

Objective: `src/core/cycle/discover-entities.ts` — BaseCyclePhase, LLM via gateway
(Bedrock Opus), budget-metered ($0.50/src, $2/run), pack-gated, `!engine` guard. Scans recent
source pages, prompts for NEW person/project not already pages, dedups vs existing pages +
pending proposals, writes to entity_proposals (≤15/run, idempotent). Org signals → org_hint
attribute, never type=organization.

Guidance: model on ProposeTakesPhase (propose-takes.ts). content_hash + prompt_version
idempotency. Malformed completions dropped with warn. Proxy-down → soft fail.

Tests: stubbed gateway → proposes person/project from fixture transcript; max_proposals cap;
dedup vs existing+pending; idempotent re-run; NO type=organization emitted; budget cap
enforced.

Integrates with: writes to Step 7's table; reads live pages. `gbrain dream --phase
discover_entities` fills the queue.

Demo: `gbrain dream --phase discover_entities` on live brain → entity_proposals has N pending
person/project rows sourced from real transcripts.

---

Step 9: Review + promote CLI (R8)

Objective: `src/commands/entities.ts` — `propose --list [--status]`, `--accept N`,
`--reject N`. Accept: transactional put_page creates the person/project page + stamps
promoted_slug + status=accepted. Reject: status=rejected (not re-proposed). Double-accept +
slug-collision handled.

Guidance: this is the net-new review half take_proposals never got. Accept must respect
put_page's never-overwrite invariant (slug collision → surface, don't clobber).

Tests: --list shows pending; --accept creates page (verify get) + stamps; --reject marks +
not re-proposed next discover run; accept transactionality (put_page fail → stays pending);
slug-collision path; double-accept rejected.

Integrates with: Steps 7+8 (reads/acts the queue) + Steps 2/5 (accepted entity becomes a
linkable gazetteer target → next ner_link links it).

Demo: `gbrain entities propose --list` shows proposals; `--accept 3` creates the page;
`get` confirms it; next `gbrain dream --phase ner_link` links transcripts to the new entity.

---

Step 10: Review MCP tools + full cycle wiring + pinning tests

Objective: MCP tools `entity_proposals_list` / `entity_proposals_act` (mirror CLI). Finalize
both new phases' positions in ALL_PHASES (discover_entities before ner_link) and update the
three pinning tests (cycle.serial.test.ts:202, autopilot-global-maintenance.test.ts:32-43,
lens-pack-manifests.test.ts).

Guidance: MCP parity with CLI accept/reject. Confirm pack-gating skips both phases cleanly
when a non-shake pack is active.

Tests: MCP list/act parity with CLI; pinning tests green with both phases in expected order;
non-shake pack → both phases skip with pack_gated reason.

Integrates with: completes the feature surface. Full `gbrain dream` now runs discover→ner
end-to-end when shake is active.

Demo: full `gbrain dream` cycle on live brain runs both new phases; review a proposal via MCP
(the gbrain MCP tools David uses), accept it, see it promoted.

---

Step 11: End-to-end growth-loop validation on the live brain

Objective: validate the whole loop against the real 4,282-page brain: backfill types → pack
active → full dream cycle → discover proposes → review/accept → next cycle NER links. Confirm
brain_score / link_count / orphan movement; confirm the decoupling invariant (edges to a
discovered entity appear only AFTER accept, next cycle).

Guidance: this is acceptance, not new code. Capture before/after get_stats + run_doctor.
Confirm no data loss (type counts intact per §6.2). Confirm reversibility (backfill --revert
+ pack deactivate cleanly restores).

Tests: e2e integration test (seed→backfill→activate→cycle→discover→accept→cycle→edges) already
in Step-by-step suites; here it's a live-brain acceptance run with recorded metrics.

Integrates with: everything. This is the ship gate.

Demo: live brain shows link_count > 0, transcripts linked to real people/projects, a
discovered entity accepted + linked, and a clean revert path demonstrated. brain_score
components (link_density, no_orphans) improved for the entity-bearing subset.
