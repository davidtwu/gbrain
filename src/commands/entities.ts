/**
 * v0.43 (gbrain-shake pack, R8 / Step 9): `gbrain entities` CLI — the review +
 * promote surface for the `discover_entities` proposal queue. This is the
 * net-new half that the `take_proposals` path never got (propose side only).
 *
 * Subcommands:
 *   entities propose --list [--status pending|accepted|rejected] [--source id] [--json]
 *                                        List proposals (default: pending).
 *   entities propose --accept N [--by <who>]
 *                                        Promote proposal id N to a REAL
 *                                        person/project page via put_page, then
 *                                        stamp the proposal (status=accepted,
 *                                        promoted_slug). If put_page fails the
 *                                        proposal stays pending (retryable).
 *                                        Slug collision → surfaced, never
 *                                        clobbers the existing page.
 *   entities propose --reject N [--by <who>]
 *                                        Mark rejected — discover_entities dedups
 *                                        against non-pending, so it is never
 *                                        re-proposed.
 *
 * Accept ordering (design §6.5): getProposalById → status guard → slug-collision
 * guard → create page → stamp proposal. put_page opens its OWN internal
 * transaction (import-file.ts:732), so we cannot wrap create+stamp in a single
 * outer transaction; instead the ORDERING gives the same observable invariant —
 * a create failure never reaches the stamp, so the proposal stays pending and is
 * retryable. actEntityProposal itself only transitions a row still in `pending`
 * (double-accept guard at the DB layer).
 *
 * The core lifecycle functions (listProposals / acceptProposal / rejectProposal /
 * getProposalById / buildEntityPageContent) are exported for unit tests, with the
 * page-creation step injected as a `PageCreator` so tests run hermetically
 * without the gateway. The default creator routes through the `put_page`
 * operation so accept exercises the same write-through path the MCP server uses.
 */

import type { BrainEngine } from '../core/engine.ts';
import type {
  EntityProposalRow,
  EntityProposalStatus,
  PageInput,
} from '../core/types.ts';

// ─── arg helpers (mirrors takes.ts) ─────────────────────────────────

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function flagPresent(args: string[], name: string): boolean {
  return args.includes(name);
}

// ─── page creation seam (injected in tests) ─────────────────────────

/**
 * Creates a real page for an accepted proposal. Injected so tests run without
 * the gateway (and can simulate a put_page failure). Production routes through
 * the `put_page` operation for write-through parity with MCP.
 */
export type PageCreator = (
  engine: BrainEngine,
  slug: string,
  page: PageInput,
  sourceId?: string,
) => Promise<void>;

/**
 * Default production page creator — routes the write through the `put_page`
 * operation (same path `gbrain capture` + the MCP server use), so an accepted
 * entity gets chunking, embedding, auto-link, and provenance write-through.
 */
export const defaultPageCreator: PageCreator = async (engine, slug, page, sourceId) => {
  const { operations } = await import('../core/operations.ts');
  const { loadConfig } = await import('../core/config.ts');
  const putPageOp = operations.find((o) => o.name === 'put_page');
  if (!putPageOp) throw new Error('put_page operation missing (gbrain build issue)');
  const content = pageInputToMarkdown(page);
  const cfg = loadConfig();
  await putPageOp.handler(
    {
      engine,
      config: (cfg ?? { engine: 'pglite' as const }) as never,
      logger: {
        info: (m: string) => process.stderr.write(`[entities] ${m}\n`),
        warn: (m: string) => process.stderr.write(`[entities] WARN: ${m}\n`),
        error: (m: string) => process.stderr.write(`[entities] ERROR: ${m}\n`),
      },
      dryRun: false,
      // Trusted LOCAL caller: the review CLI runs on the host by the operator.
      remote: false,
      ...(sourceId ? { sourceId } : {}),
    } as never,
    {
      slug,
      content,
      source_kind: 'entity-accept',
      ingested_via: 'entities-review-cli',
    },
  );
};

// ─── page-content builder ───────────────────────────────────────────

/** YAML-safe scalar: quote when it could be misparsed, else bare. */
function yamlScalar(v: string): string {
  if (v.length === 0) return "''";
  // Quote anything with YAML-significant chars or leading/trailing space.
  if (/[:#\-?*&!|>'"%@`{}\[\],]|^\s|\s$/.test(v)) {
    return `'${v.replace(/'/g, "''")}'`;
  }
  return v;
}

/**
 * Build the person/project page markdown (frontmatter + stub body) for an
 * accepted proposal. `type:` in the frontmatter is authoritative — the importer
 * honors it over path-prefix inference (markdown.ts:135). Aliases + org_hint are
 * carried into frontmatter so downstream tooling can see them; only emitted when
 * present so a project with no extras stays clean.
 */
export function buildEntityPageContent(p: EntityProposalRow): string {
  const lines: string[] = ['---'];
  lines.push(`type: ${p.proposed_type}`);
  lines.push(`title: ${yamlScalar(p.proposed_title)}`);
  if (p.proposed_aliases && p.proposed_aliases.length > 0) {
    lines.push('aliases:');
    for (const a of p.proposed_aliases) lines.push(`  - ${yamlScalar(a)}`);
  }
  if (p.org_hint) {
    lines.push(`org_hint: ${yamlScalar(p.org_hint)}`);
  }
  // Provenance of the promotion — auditable link back to the discovery source.
  lines.push(`discovered_in: ${yamlScalar(p.source_page_slug)}`);
  lines.push('promoted_from_proposal: true');
  lines.push('---');
  lines.push('');
  lines.push(`# ${p.proposed_title}`);
  lines.push('');
  lines.push(
    `_Promoted from an entity proposal discovered in ${p.source_page_slug}._`,
  );
  lines.push('');
  return lines.join('\n');
}

/** Convert a PageInput back to markdown for the put_page op (default creator). */
function pageInputToMarkdown(page: PageInput): string {
  const lines: string[] = ['---'];
  lines.push(`type: ${page.type}`);
  lines.push(`title: ${yamlScalar(page.title)}`);
  const fm = page.frontmatter ?? {};
  for (const [k, v] of Object.entries(fm)) {
    if (k === 'type' || k === 'title') continue;
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${yamlScalar(String(item))}`);
    } else if (v !== null && v !== undefined) {
      lines.push(`${k}: ${yamlScalar(String(v))}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(page.compiled_truth ?? '');
  return lines.join('\n');
}

// ─── lifecycle functions (exported for tests) ───────────────────────

export interface ListProposalsOpts {
  status?: EntityProposalStatus;
  sourceId?: string;
  limit?: number;
}

/** List proposals; defaults to pending when no status is given. */
export async function listProposals(
  engine: BrainEngine,
  opts: ListProposalsOpts,
): Promise<EntityProposalRow[]> {
  return engine.listEntityProposals({
    status: opts.status ?? 'pending',
    ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
  });
}

/** Fetch a single proposal by id (list-and-filter; no dedicated engine method). */
export async function getProposalById(
  engine: BrainEngine,
  id: number,
): Promise<EntityProposalRow | null> {
  // Scan across all statuses; the queue is small (≤15/run) so a full list is fine.
  for (const status of ['pending', 'accepted', 'rejected'] as const) {
    const rows = await engine.listEntityProposals({ status, limit: 1000 });
    const found = rows.find((r) => r.id === id);
    if (found) return found;
  }
  return null;
}

export type AcceptReason = 'not_found' | 'not_pending' | 'slug_collision' | 'create_failed';

export interface AcceptResult {
  ok: boolean;
  reason?: AcceptReason;
  promotedSlug?: string;
  /** The pre-existing page's slug on a collision (for the operator message). */
  collisionSlug?: string;
  message?: string;
}

export interface AcceptOpts {
  actedBy: string;
  /** Injected page creator (tests); defaults to the put_page-op creator. */
  createPage?: PageCreator;
}

/**
 * Promote a pending proposal to a real page. Ordering guarantees the design's
 * §6.5 invariants: status guard (no double-accept), slug-collision guard (never
 * clobber an existing page), create-before-stamp (put_page failure → proposal
 * stays pending, retryable).
 */
export async function acceptProposal(
  engine: BrainEngine,
  id: number,
  opts: AcceptOpts,
): Promise<AcceptResult> {
  const createPage = opts.createPage ?? defaultPageCreator;

  const proposal = await getProposalById(engine, id);
  if (!proposal) return { ok: false, reason: 'not_found', message: `No proposal with id ${id}.` };
  if (proposal.status !== 'pending') {
    return {
      ok: false,
      reason: 'not_pending',
      message: `Proposal ${id} is already ${proposal.status}` +
        (proposal.promoted_slug ? ` (promoted to ${proposal.promoted_slug})` : '') + '.',
    };
  }

  // Slug-collision guard: respect put_page's never-overwrite invariant. If a
  // page already occupies the slug (authored meanwhile), surface it and ask the
  // operator to merge/alias — do NOT clobber, do NOT stamp.
  const existing = await engine.getPage(proposal.proposed_slug, { sourceId: proposal.source_id });
  if (existing) {
    return {
      ok: false,
      reason: 'slug_collision',
      collisionSlug: proposal.proposed_slug,
      message:
        `A page already exists at '${proposal.proposed_slug}'. ` +
        `Not overwriting. Merge or alias it manually (e.g. add '${proposal.proposed_title}' ` +
        `to that page's aliases), then reject this proposal.`,
    };
  }

  // Create the page FIRST. If it fails, the proposal is never stamped and stays
  // pending (retryable) — the observable half of the "one transaction" intent
  // (put_page owns its own transaction, so a true outer wrap isn't possible).
  const page: PageInput = {
    type: proposal.proposed_type,
    title: proposal.proposed_title,
    compiled_truth: `_Promoted from an entity proposal discovered in ${proposal.source_page_slug}._`,
    frontmatter: {
      ...(proposal.proposed_aliases.length > 0 ? { aliases: proposal.proposed_aliases } : {}),
      ...(proposal.org_hint ? { org_hint: proposal.org_hint } : {}),
      discovered_in: proposal.source_page_slug,
      promoted_from_proposal: true,
    },
  };
  try {
    await createPage(engine, proposal.proposed_slug, page, proposal.source_id);
  } catch (err) {
    return {
      ok: false,
      reason: 'create_failed',
      message: `Failed to create page '${proposal.proposed_slug}': ${(err as Error).message}. Proposal stays pending (retryable).`,
    };
  }

  // Stamp the proposal. actEntityProposal only transitions a row still pending,
  // so a race that flipped it out from under us returns null (guard holds).
  const stamped = await engine.actEntityProposal(id, {
    status: 'accepted',
    acted_by: opts.actedBy,
    promoted_slug: proposal.proposed_slug,
  });
  if (!stamped) {
    // Extremely narrow race: the page got created but the proposal is no longer
    // pending. Surface it; the page exists, the proposal wasn't ours to stamp.
    return {
      ok: false,
      reason: 'not_pending',
      promotedSlug: proposal.proposed_slug,
      message: `Page '${proposal.proposed_slug}' created, but proposal ${id} was already acted on concurrently.`,
    };
  }
  return { ok: true, promotedSlug: proposal.proposed_slug };
}

export type RejectReason = 'not_found' | 'not_pending';

export interface RejectResult {
  ok: boolean;
  reason?: RejectReason;
  message?: string;
}

/** Mark a pending proposal rejected (never re-proposed — discover dedups non-pending). */
export async function rejectProposal(
  engine: BrainEngine,
  id: number,
  opts: { actedBy: string },
): Promise<RejectResult> {
  const proposal = await getProposalById(engine, id);
  if (!proposal) return { ok: false, reason: 'not_found', message: `No proposal with id ${id}.` };
  if (proposal.status !== 'pending') {
    return { ok: false, reason: 'not_pending', message: `Proposal ${id} is already ${proposal.status}.` };
  }
  const stamped = await engine.actEntityProposal(id, { status: 'rejected', acted_by: opts.actedBy });
  if (!stamped) {
    return { ok: false, reason: 'not_pending', message: `Proposal ${id} was already acted on concurrently.` };
  }
  return { ok: true };
}

// ─── human-readable rendering ───────────────────────────────────────

function renderProposalTable(rows: EntityProposalRow[]): string {
  if (rows.length === 0) return '(no proposals)';
  const out: string[] = [];
  const header = ['id', 'type', 'slug', 'title', 'source', 'conf'];
  out.push(header.join('  '));
  out.push('-'.repeat(72));
  for (const r of rows) {
    const conf = r.confidence == null ? '—' : r.confidence.toFixed(2);
    out.push(
      [
        String(r.id).padEnd(4),
        r.proposed_type.padEnd(7),
        r.proposed_slug,
        r.proposed_title,
        r.source_page_slug,
        conf,
      ].join('  '),
    );
  }
  return out.join('\n');
}

// ─── CLI dispatcher ─────────────────────────────────────────────────

const HELP = `Usage: gbrain entities propose <action> [options]

Review + promote the entity-discovery proposal queue (gbrain-shake pack).

Actions:
  entities propose --list [--status pending|accepted|rejected] [--source <id>] [--json]
                                       List proposals (default: pending).
  entities propose --accept N [--by <who>]
                                       Promote proposal id N to a real
                                       person/project page (via put_page), then
                                       stamp it accepted. Never overwrites an
                                       existing page (slug collision is surfaced).
  entities propose --reject N [--by <who>]
                                       Mark proposal id N rejected (never
                                       re-proposed by discover_entities).

Options:
  --status <s>   pending (default) | accepted | rejected  (for --list)
  --source <id>  Scope --list to one source.
  --by <who>     Actor recorded in acted_by (default: cli).
  --json         Machine-readable output (for --list).
  --help, -h     Show this help.
`;

export async function runEntities(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const sub = args[0];
  if (sub !== 'propose') {
    console.error(`Unknown entities subcommand: ${sub}. Expected 'propose'.`);
    process.exit(1);
  }
  const rest = args.slice(1);

  const actedBy = flagValue(rest, '--by') ?? 'cli';

  // --accept N
  const acceptRaw = flagValue(rest, '--accept');
  if (acceptRaw !== undefined) {
    const id = parseInt(acceptRaw, 10);
    if (!Number.isInteger(id) || id <= 0) {
      console.error(`Invalid --accept id "${acceptRaw}". Expected a positive integer.`);
      process.exit(1);
    }
    const res = await acceptProposal(engine, id, { actedBy });
    if (res.ok) {
      console.log(`Accepted proposal ${id} → created page '${res.promotedSlug}'.`);
      console.log(`The page is now a linkable gazetteer target; the next 'gbrain dream --phase ner_link' will link sources to it.`);
      return;
    }
    console.error(res.message ?? `Accept failed: ${res.reason}`);
    process.exit(1);
  }

  // --reject N
  const rejectRaw = flagValue(rest, '--reject');
  if (rejectRaw !== undefined) {
    const id = parseInt(rejectRaw, 10);
    if (!Number.isInteger(id) || id <= 0) {
      console.error(`Invalid --reject id "${rejectRaw}". Expected a positive integer.`);
      process.exit(1);
    }
    const res = await rejectProposal(engine, id, { actedBy });
    if (res.ok) {
      console.log(`Rejected proposal ${id}. It will not be re-proposed.`);
      return;
    }
    console.error(res.message ?? `Reject failed: ${res.reason}`);
    process.exit(1);
  }

  // --list (default action)
  if (flagPresent(rest, '--list') || rest.length === 0 || rest.every((a) => a.startsWith('--'))) {
    const statusRaw = flagValue(rest, '--status');
    let status: EntityProposalStatus | undefined;
    if (statusRaw !== undefined) {
      if (statusRaw !== 'pending' && statusRaw !== 'accepted' && statusRaw !== 'rejected') {
        console.error(`Invalid --status "${statusRaw}". Expected: pending, accepted, rejected.`);
        process.exit(1);
      }
      status = statusRaw;
    }
    const sourceId = flagValue(rest, '--source');
    const rows = await listProposals(engine, { status, ...(sourceId ? { sourceId } : {}) });
    if (flagPresent(rest, '--json')) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    console.log(`# Entity proposals (${status ?? 'pending'})\n`);
    console.log(renderProposalTable(rows));
    return;
  }

  console.error('Nothing to do. Pass --list, --accept N, or --reject N.');
  process.exit(1);
}
