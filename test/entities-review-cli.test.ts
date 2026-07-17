/**
 * `gbrain entities propose` review + promote CLI (gbrain-shake pack, R8) — Step 9.
 *
 * The net-new review/promote half the take_proposals path never got. Covers the
 * design §7.7 test matrix against an ephemeral PGLite brain (no live gateway, no
 * live brain), exercising the exported subcommand handlers directly:
 *   - `--list` shows pending; `--status` filter works.
 *   - `--accept N` creates the person/project page (verify via getPage) + stamps
 *     promoted_slug + status=accepted + acted_at.
 *   - `--reject N` marks rejected; a subsequent discover dedup sees it as
 *     non-pending (rejected slugs stay out of the pending re-propose set).
 *   - Accept transactionality: a put_page failure leaves the proposal pending.
 *   - Slug-collision: proposed_slug already exists → surfaced, page NOT clobbered.
 *   - Double-accept guard; unknown-id error.
 *
 * Canonical PGLite block per CLAUDE.md test-isolation rules.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  listProposals,
  acceptProposal,
  rejectProposal,
  getProposalById,
  buildEntityPageContent,
  type PageCreator,
} from '../src/commands/entities.ts';
import type { EntityProposalInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// ─── Fixtures / helpers ─────────────────────────────────────────────

const personRow: EntityProposalInput = {
  source_id: 'default',
  source_page_slug: 'meetings/2026-04-03',
  proposed_slug: 'people/alice-example',
  proposed_type: 'person',
  proposed_title: 'Alice Example',
  proposed_aliases: ['Alice', 'A. Example'],
  org_hint: 'acme-example',
  content_hash: 'hash-person',
  prompt_version: 'v1',
  proposal_run_id: 'run-1',
  confidence: 0.91,
  model_id: 'anthropic:claude-opus-4-8',
};

const projectRow: EntityProposalInput = {
  source_id: 'default',
  source_page_slug: 'meetings/2026-04-03',
  proposed_slug: 'projects/mosaic',
  proposed_type: 'project',
  proposed_title: 'Mosaic',
  proposed_aliases: [],
  org_hint: null,
  content_hash: 'hash-project',
  prompt_version: 'v1',
  proposal_run_id: 'run-1',
  confidence: 0.8,
  model_id: 'anthropic:claude-opus-4-8',
};

/** Real page creator that writes straight through engine.putPage (no gateway). */
const directCreator: PageCreator = async (eng, slug, page, sourceId) => {
  await eng.putPage(slug, page, sourceId ? { sourceId } : undefined);
};

/** A creator that always fails — models a put_page failure for the txn test. */
const failingCreator: PageCreator = async () => {
  throw new Error('simulated put_page failure');
};

// ─── --list ─────────────────────────────────────────────────────────

describe('entities propose --list', () => {
  test('lists pending proposals by default', async () => {
    await engine.insertEntityProposal(personRow);
    await engine.insertEntityProposal(projectRow);

    const rows = await listProposals(engine, {});
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    const slugs = rows.map((r) => r.proposed_slug).sort();
    expect(slugs).toEqual(['people/alice-example', 'projects/mosaic']);
  });

  test('--status filter surfaces accepted / rejected separately', async () => {
    const p = await engine.insertEntityProposal(personRow);
    await engine.insertEntityProposal(projectRow);
    await engine.actEntityProposal(p!.id, {
      status: 'accepted',
      acted_by: 'cli',
      promoted_slug: 'people/alice-example',
    });

    expect((await listProposals(engine, { status: 'pending' })).length).toBe(1);
    expect((await listProposals(engine, { status: 'accepted' })).length).toBe(1);
    expect((await listProposals(engine, { status: 'rejected' })).length).toBe(0);
  });
});

// ─── --accept ───────────────────────────────────────────────────────

describe('entities propose --accept N', () => {
  test('creates the person page and stamps promoted_slug + status + acted_at', async () => {
    const ins = await engine.insertEntityProposal(personRow);

    const res = await acceptProposal(engine, ins!.id, { actedBy: 'david', createPage: directCreator });
    expect(res.ok).toBe(true);
    expect(res.promotedSlug).toBe('people/alice-example');

    // Page really exists with the right type/title.
    const page = await engine.getPage('people/alice-example');
    expect(page).not.toBeNull();
    expect(page!.type).toBe('person');
    expect(page!.title).toBe('Alice Example');

    // Proposal stamped.
    const stamped = await getProposalById(engine, ins!.id);
    expect(stamped!.status).toBe('accepted');
    expect(stamped!.promoted_slug).toBe('people/alice-example');
    expect(stamped!.acted_by).toBe('david');
    expect(stamped!.acted_at).toBeInstanceOf(Date);
  });

  test('creates a project page for a project proposal', async () => {
    const ins = await engine.insertEntityProposal(projectRow);
    const res = await acceptProposal(engine, ins!.id, { actedBy: 'cli', createPage: directCreator });
    expect(res.ok).toBe(true);
    const page = await engine.getPage('projects/mosaic');
    expect(page!.type).toBe('project');
  });

  test('transactionality: put_page failure leaves the proposal pending, no page', async () => {
    const ins = await engine.insertEntityProposal(personRow);

    const res = await acceptProposal(engine, ins!.id, { actedBy: 'david', createPage: failingCreator });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('create_failed');

    // Proposal is STILL pending (retryable), no promoted_slug.
    const still = await getProposalById(engine, ins!.id);
    expect(still!.status).toBe('pending');
    expect(still!.promoted_slug).toBeNull();
    // No page was created.
    expect(await engine.getPage('people/alice-example')).toBeNull();
  });

  test('slug-collision: existing page is surfaced and NOT clobbered', async () => {
    // A page already occupies the proposed slug (authored meanwhile).
    await engine.putPage('people/alice-example', {
      type: 'person',
      title: 'Alice (pre-existing)',
      compiled_truth: 'do not touch me',
    });
    const ins = await engine.insertEntityProposal(personRow);

    const res = await acceptProposal(engine, ins!.id, { actedBy: 'david', createPage: directCreator });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('slug_collision');

    // Existing page untouched.
    const page = await engine.getPage('people/alice-example');
    expect(page!.title).toBe('Alice (pre-existing)');
    expect(page!.compiled_truth).toContain('do not touch me');
    // Proposal stays pending (operator decides merge/alias).
    const still = await getProposalById(engine, ins!.id);
    expect(still!.status).toBe('pending');
  });

  test('double-accept is rejected with a clear reason', async () => {
    const ins = await engine.insertEntityProposal(personRow);
    await acceptProposal(engine, ins!.id, { actedBy: 'david', createPage: directCreator });

    const res = await acceptProposal(engine, ins!.id, { actedBy: 'someone-else', createPage: directCreator });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_pending');

    // Still exactly one accepted, still owned by the first actor.
    const stamped = await getProposalById(engine, ins!.id);
    expect(stamped!.status).toBe('accepted');
    expect(stamped!.acted_by).toBe('david');
  });

  test('unknown id errors cleanly', async () => {
    const res = await acceptProposal(engine, 999999, { actedBy: 'david', createPage: directCreator });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_found');
  });
});

// ─── --reject ───────────────────────────────────────────────────────

describe('entities propose --reject N', () => {
  test('marks rejected; the slug is no longer in the pending re-propose set', async () => {
    const ins = await engine.insertEntityProposal(personRow);

    const res = await rejectProposal(engine, ins!.id, { actedBy: 'david' });
    expect(res.ok).toBe(true);

    const stamped = await getProposalById(engine, ins!.id);
    expect(stamped!.status).toBe('rejected');
    expect(stamped!.promoted_slug).toBeNull();
    expect(stamped!.acted_at).toBeInstanceOf(Date);

    // The discover dedup universe reads pending proposals only; a rejected
    // slug is NOT re-surfaced as pending (won't be re-proposed).
    const pending = await engine.listEntityProposals({ status: 'pending' });
    expect(pending.some((p) => p.proposed_slug === 'people/alice-example')).toBe(false);
  });

  test('double-reject / unknown id error cleanly', async () => {
    const ins = await engine.insertEntityProposal(personRow);
    await rejectProposal(engine, ins!.id, { actedBy: 'david' });

    const dbl = await rejectProposal(engine, ins!.id, { actedBy: 'david' });
    expect(dbl.ok).toBe(false);
    expect(dbl.reason).toBe('not_pending');

    const missing = await rejectProposal(engine, 424242, { actedBy: 'david' });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe('not_found');
  });
});

// ─── page-content builder ───────────────────────────────────────────

describe('buildEntityPageContent', () => {
  test('emits frontmatter with type, title, aliases, and org_hint', async () => {
    const ins = await engine.insertEntityProposal(personRow);
    const p = await getProposalById(engine, ins!.id);
    const content = buildEntityPageContent(p!);
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('type: person');
    expect(content).toContain('Alice Example');
    expect(content).toContain('Alice');
    expect(content).toContain('acme-example');
  });

  test('omits org_hint + aliases when absent', async () => {
    const ins = await engine.insertEntityProposal(projectRow);
    const p = await getProposalById(engine, ins!.id);
    const content = buildEntityPageContent(p!);
    expect(content).toContain('type: project');
    expect(content).not.toContain('org_hint');
    expect(content).not.toContain('aliases');
  });
});
