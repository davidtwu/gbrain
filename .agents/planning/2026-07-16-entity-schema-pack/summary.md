# Summary — `gbrain-shake` Entity Schema Pack + Entity Extraction (PDD)

Transformed a rough idea ("build/reuse a domain-matched schema pack + entity extraction so
gbrain's graph isn't empty") into a full design + TDD implementation plan via the
Prompt-Driven Development SOP.

## Artifacts

```
gbrain-src/.agents/planning/2026-07-16-entity-schema-pack/
├── rough-idea.md                              # diagnosis, locked decisions, environment
├── idea-honing.md                             # Q1–Q7 requirements Q&A (all resolved)
├── research/
│   ├── 00-synthesis.md                        # cross-cutting findings + reopened decisions
│   ├── take-proposals-pattern.md              # R3: review-queue pattern (half-built!)
│   ├── cycle-phase-registration.md            # R4: how to add pack-gated phases
│   ├── migrations-and-tables.md               # R6: 4-place table decl, backfill, config
│   └── collector-typing-and-linkable-types.md # R5/R7: import typing, const widening, websearch
├── design/
│   └── detailed-design.md                     # 8 sections, 3 mermaid diagrams, full DDL
├── implementation/
│   └── plan.md                                # 11 TDD steps + progress checklist
└── summary.md                                 # this file
```

## What we're building

A domain-matched schema pack (`gbrain-shake`) plus entity-linking + discovery so David's
transcript+PKM brain forms a real graph. The current graph is empty (0 edges / 4,282 pages)
because the active pack (`gbrain-base-v2`) is a YC-investor ontology mismatched to the corpus,
and entity linking is disabled.

## Design in one paragraph

Activate `gbrain-shake` (declares the FULL corpus-matched taxonomy — critical, since `extends`
doesn't merge at runtime — with `person`/`project` marked `linkable` via a new pack-aware
manifest flag). A reversible backfill re-types the ~57 authored entity pages; a pre-activation
coverage check prevents the base-v2 `*unknown*→note` catch-all from flattening the 2,862
undeclared-type pages (67% of the brain). A DB-sourced `ner_link` cycle phase then links
transcripts/meetings to those entities (mentions + attended edges). An LLM `discover_entities`
phase proposes new person/project entities from transcripts into an `entity_proposals` review
queue; explicit accept promotes a proposal to a real page (net-new review path — the
take_proposals review half was never coded), which becomes linkable on the next cycle. Whole
feature is pack-gated and reversible.

## Key decisions (idea-honing.md)

- Custom pack `gbrain-shake`, `extends: gbrain-base-v2`.
- Linkable entity types: person + project (meeting = source-only, gives free meeting→person/
  project edges); org deferred to v2.
- Full corpus-matched type set in the pack (R1b) — data-loss guard against the catch-all.
- Pack-aware `linkable` flag (TODO-1), not a global const edit.
- NER precision: config-driven allow/ignore lists + first-name rejection.
- Discovery: full build (phase + queue + accept/reject/promote CLI + MCP); Opus, $0.50/src,
  ≤15/run, review-queue (manual accept only).
- Backfill: snapshot table + --dry-run/--apply/--revert.

## Implementation approach

11 incremental TDD steps. Core value (a populated graph from existing entities) lands at
**Step 5** (ner_link → first edges). Steps 6–11 add precision, discovery, the review surface,
and live validation. Each step ends demoable; no orphaned code.

## Suggested next steps

1. Review `design/detailed-design.md` (esp. §2 Requirements incl. R1b, §6 Error Handling) and
   `implementation/plan.md`.
2. Begin implementation at Step 1 (pack manifest) on branch `feat/entity-schema-pack`.
3. Gate: do NOT activate the pack (Step 4) until the pre-activation coverage check passes —
   that's the guard against flattening 67% of the brain.

## Areas that may need refinement

- The `linkable` flag / pack-aware gazetteer is a TODO-1 the upstream gbrain project hasn't
  designed publicly — worth deciding whether to upstream it.
- org/company as a linkable type is deferred to v2 (needs a clean discovery sample first).
- The broken upstream take_proposals review path is left as-is (we build a parallel entity
  path); David's 17 stuck take-proposals remain un-actionable until that's separately fixed.
