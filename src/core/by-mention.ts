/**
 * v0.42.0.0 Part B — Auto-link entity mentions to known entity pages.
 * Migration #1 of the consolidated #1409 design doc (orphan reduction).
 *
 * `buildGazetteer` queries the brain for entity-typed pages and produces a
 * token-Map lookup structure suitable for fast body-text scanning.
 *
 * `findMentionedEntities` is a pure function that scans body text against
 * the gazetteer, applies the maximal-munch matcher (longest gazetteer
 * entry wins at each offset), self-link guard, cross-source guard, and
 * per-page first-mention-only cap (1 link per (source_slug, target_slug)).
 *
 * Design decisions locked in /plan-eng-review for v0.42.0.0:
 *  - D2/D10  Hardcoded entity-type filter (not pack-aware) — pack v2
 *            extension filed as TODO-1.
 *  - D6      Token-Map + multi-word phrase pass (no new deps, no regex
 *            alternation, no Aho-Corasick).
 *  - D7      DB-source only — caller restricts page WALK to DB iteration.
 *  - D12     `link_source='mentions'` writes filtered out of backlink-count
 *            for search ranking (see postgres-engine.ts/pglite-engine.ts).
 *  - D13     Self-link guard.
 *  - CK12    Ignore-list applied at gazetteer-build time, NOT match time.
 *            Built-in ambiguous tokens (Apple, Amazon, Square, Stripe, Box)
 *            are dropped from the gazetteer ONLY when no corresponding
 *            entity page exists. If a page DOES exist, the user explicitly
 *            created it and we trust the gazetteer presence.
 */

import type { BrainEngine } from './engine.ts';
import { stripCodeBlocks } from './link-extraction.ts';
import { LINKABLE_ENTITY_TYPES, linkableTypesFromPack } from './schema-pack/linkable-types.ts';
import { normalizeAliasList } from './search/alias-normalize.ts';

/**
 * Legacy hardcoded gazetteer link-target types. Re-exported from
 * `schema-pack/linkable-types.ts` (the single source of truth as of Step 2 /
 * R4). Retained here for back-compat with importers + the regression pin.
 * The FALLBACK when the active pack has not adopted the `linkable` flag.
 */
export { LINKABLE_ENTITY_TYPES };

/**
 * Minimum title length for gazetteer inclusion. Filters out 2-3 char names
 * (AI, YC, X, IBM) that produce dense false-positive auto-links in body text.
 * Codex CK13 noted v1 will under-deliver on 3-char real entities; the
 * pack-aware follow-up (TODO-1) can let users opt specific 3-char entity
 * types in.
 */
const MIN_NAME_LENGTH = 4;

/**
 * Built-in ignore list — common ambiguous tokens whose body-text mentions
 * are usually NOT references to the named brand/entity. Suppressed at
 * gazetteer-build time when no corresponding entity page exists.
 *
 * Per CK12 (codex outside-voice): if the user has explicitly created
 * `companies/apple` as a page, they want auto-link → ignore-list does
 * not override gazetteer presence. The list only suppresses entries
 * that would NOT otherwise be in the gazetteer.
 */
const DEFAULT_IGNORE_LIST = ['Apple', 'Amazon', 'Square', 'Stripe', 'Box', 'Meta', 'Target', 'Oracle'];

// ============================================================
// NER precision knobs (R5 / Step 6) — config-driven
// ============================================================

/**
 * Config keys (JSON values in the `config` table) for the three NER precision
 * knobs. Wired here so the gazetteer/matcher path is tunable without a source
 * edit (idea-honing Q2 ruling: allow/ignore lists must be config-driven).
 */
export const NER_ALLOW_LIST_KEY = 'ner.allow_list';
export const NER_IGNORE_LIST_KEY = 'ner.ignore_list';
export const NER_REJECT_FIRST_NAMES_KEY = 'ner.reject_first_names';

/**
 * R5.1 default allow-list: short real handles (below MIN_NAME_LENGTH) that
 * SHOULD link. The escape hatch that keeps MIN_NAME_LENGTH=4 as the floor
 * while letting deliberate 2-3 char entities through.
 */
export const DEFAULT_NER_ALLOW_LIST = ['F2', 'Cue'];

/**
 * R5.2 default domain ignore-list: ambiguous English/domain words that recur
 * as common nouns in this brain. Suppressed as BARE single-token matches;
 * a multi-word title that merely starts with one (e.g. "Returns Signal") is
 * the "exact unambiguous match" exception and still links via the full phrase.
 */
export const DEFAULT_NER_IGNORE_LIST = ['returns', 'fit', 'size', 'compatibility', 'discovery', 'signal'];

/** R5.3 default: require a multi-token name or explicit alias for person links. */
export const DEFAULT_NER_REJECT_FIRST_NAMES = true;

/**
 * Resolved NER precision knobs. Produced by `loadNerKnobs` (config-driven,
 * malformed → defaults + warn) or supplied directly by callers/tests.
 */
export interface NerKnobs {
  /** Titles (case-insensitive) that bypass the MIN_NAME_LENGTH floor. */
  allowList: string[];
  /** Bare single tokens (normalized) suppressed as body matches. */
  ignoreList: string[];
  /** When true, person targets only link on multi-token titles or aliases. */
  rejectFirstNames: boolean;
}

/** The default knob set (used when config is absent OR malformed). */
export function defaultNerKnobs(): NerKnobs {
  return {
    allowList: [...DEFAULT_NER_ALLOW_LIST],
    ignoreList: [...DEFAULT_NER_IGNORE_LIST],
    rejectFirstNames: DEFAULT_NER_REJECT_FIRST_NAMES,
  };
}

let warnedMalformedKnob = new Set<string>();

/** Test seam: reset the once-per-process malformed-config warning guard. */
export function __resetNerKnobWarnings(): void {
  warnedMalformedKnob = new Set<string>();
}

function warnOnceMalformed(key: string, detail: string): void {
  if (warnedMalformedKnob.has(key)) return;
  warnedMalformedKnob.add(key);
  console.warn(`[ner] malformed config '${key}' (${detail}); falling back to default. Guard remains ENABLED.`);
}

/** Parse a JSON-array config value into a string[]; malformed → null (caller warns + defaults). */
function parseJsonStringArray(raw: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: string[] = [];
  for (const v of parsed) {
    if (typeof v !== 'string') return null; // any non-string element → treat whole value as malformed
    const t = v.trim();
    if (t.length > 0) out.push(t);
  }
  return out;
}

/**
 * Load the three NER precision knobs from the DB config plane. Each key is
 * read independently: a malformed value falls back to THAT knob's default and
 * warns once — never crashes, never silently disables the guard (§6.4).
 * A missing key silently uses the default (not a misconfiguration).
 */
export async function loadNerKnobs(
  engine: Pick<BrainEngine, 'getConfig'>,
): Promise<NerKnobs> {
  const knobs = defaultNerKnobs();

  // allow_list
  try {
    const raw = await engine.getConfig(NER_ALLOW_LIST_KEY);
    if (raw != null && raw !== '') {
      const arr = parseJsonStringArray(raw);
      if (arr === null) warnOnceMalformed(NER_ALLOW_LIST_KEY, 'not a JSON string array');
      else knobs.allowList = arr;
    }
  } catch (e) {
    warnOnceMalformed(NER_ALLOW_LIST_KEY, (e as Error).message);
  }

  // ignore_list
  try {
    const raw = await engine.getConfig(NER_IGNORE_LIST_KEY);
    if (raw != null && raw !== '') {
      const arr = parseJsonStringArray(raw);
      if (arr === null) warnOnceMalformed(NER_IGNORE_LIST_KEY, 'not a JSON string array');
      else knobs.ignoreList = arr;
    }
  } catch (e) {
    warnOnceMalformed(NER_IGNORE_LIST_KEY, (e as Error).message);
  }

  // reject_first_names (bool; accepts JSON true/false OR the string "true"/"false")
  try {
    const raw = await engine.getConfig(NER_REJECT_FIRST_NAMES_KEY);
    if (raw != null && raw !== '') {
      const t = raw.trim().toLowerCase();
      if (t === 'true') knobs.rejectFirstNames = true;
      else if (t === 'false') knobs.rejectFirstNames = false;
      else warnOnceMalformed(NER_REJECT_FIRST_NAMES_KEY, `expected true/false, got '${raw}'`);
    }
  } catch (e) {
    warnOnceMalformed(NER_REJECT_FIRST_NAMES_KEY, (e as Error).message);
  }

  return knobs;
}

export interface GazetteerEntry {
  /** Canonical page slug (e.g. `companies/acme-corp`). */
  slug: string;
  /** Source id (multi-source brains). 'default' for single-source. */
  source_id: string;
  /** Original title (preserved for the mention payload). */
  title: string;
  /** Lowercase title tokens in order. Length 1 = single-word entity. */
  tokens: string[];
  /** Page type of the target (Step 6: gates the reject_first_names rule). */
  type?: string;
  /**
   * True when this entry was produced from a frontmatter `aliases:` entry
   * rather than the page title (Step 5 alias indexing). Alias entries are
   * exempt from the reject_first_names single-token drop — an explicit alias
   * (even a bare first name like "Mike" or a handle like "mikstuck") is a
   * deliberate match key.
   */
  is_alias?: boolean;
}

/**
 * Gazetteer is keyed by lowercase FIRST token. Multiple entries can
 * share a first token (e.g. "Acme" + "Acme Corp" + "Acme Foundation").
 * At match time, the scanner picks the entry with the most tokens that
 * matches the body-text token sequence at the current offset (maximal
 * munch).
 */
export type Gazetteer = Map<string, GazetteerEntry[]>;

export interface Mention {
  /** Target page slug (the entity being mentioned). */
  slug: string;
  /** Target source id (cross-source guard). */
  source_id: string;
  /** Display name (original title). */
  name: string;
  /** Character offset in the ORIGINAL (un-stripped) body where the mention starts. */
  offset: number;
}

export interface BuildGazetteerOpts {
  /**
   * Optional user-supplied additional ignore-list entries (case-sensitive
   * raw title match). Merged with DEFAULT_IGNORE_LIST.
   */
  extraIgnore?: string[];
  /**
   * Step 6 (R5): resolved NER precision knobs. When omitted, buildGazetteer
   * loads them from config via `loadNerKnobs(engine)` (malformed → defaults +
   * warn). Pass explicitly in tests to drive a specific knob configuration.
   */
  knobs?: NerKnobs;
}

export interface FindMentionsOpts {
  /** Source slug of the page being scanned. Used for self-link guard. */
  fromSlug: string;
  /** Source id of the page being scanned. Used for cross-source guard. */
  fromSourceId: string;
  /**
   * Step 6 (R5.3): when true, a `person`-typed target only links on a
   * multi-token TITLE match OR an explicit alias entry. A bare single
   * first-name token ("Mike") matching a person title is rejected. Aliases
   * (including a bare-first-name alias) are always allowed — the alias is the
   * deliberate disambiguation. Default false (no first-name rejection) so the
   * pure matcher stays backward-compatible for callers that don't opt in.
   */
  rejectFirstNames?: boolean;
}

// ============================================================
// Gazetteer construction
// ============================================================

/**
 * Token-only tokenizer. Returns `[token, offset]` pairs for every
 * `[a-zA-Z0-9]+` run, lowercased. Non-ASCII (CJK, accented) is
 * deliberately not tokenized in v1 — entity gazetteer is English-dominant
 * in production today. Widening to `\p{L}+` is a future option once a
 * real CJK entity catalog appears (filed under TODO-1 + a TODO for
 * Unicode-aware tokenization).
 *
 * Possessive "Acme's" tokenizes as ['acme', 's'] (single-quote breaks the
 * run) — single-word "Acme" lookup succeeds at offset 0; the trailing 's'
 * is harmless noise.
 */
const TOKEN_RE = /[a-zA-Z0-9]+/g;

interface ScannedToken {
  text: string;       // lowercase
  offset: number;     // index in source
  length: number;     // original length (for span tracking)
}

function tokenizeForScan(text: string): ScannedToken[] {
  const out: ScannedToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    out.push({ text: m[0].toLowerCase(), offset: m.index, length: m[0].length });
  }
  return out;
}

function tokenizeTitle(title: string): string[] {
  const tokens: string[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(title)) !== null) tokens.push(m[0].toLowerCase());
  return tokens;
}

/**
 * Build a token-Map gazetteer from all entity-typed pages in the brain.
 *
 * Hardcoded type filter per D2 (pack-awareness is TODO-1). Soft-deleted
 * pages excluded. Pages with too-short titles excluded (MIN_NAME_LENGTH).
 * Ignore-list applied per CK12: built-in ambiguous tokens dropped unless
 * the user has explicitly created the corresponding page.
 *
 * Returned gazetteer is keyed by lowercase first token; entries with the
 * same first token co-exist in the same bucket (e.g. "Acme" + "Acme Corp").
 */
export async function buildGazetteer(
  engine: BrainEngine,
  opts: BuildGazetteerOpts = {},
): Promise<Gazetteer> {
  // Step 2 / R4: linkable target types come from the active pack (pack-aware),
  // falling back to the legacy LINKABLE_ENTITY_TYPES const when the pack has
  // not adopted the `linkable` flag. Empty type list → empty gazetteer.
  const linkableTypes = await linkableTypesFromPack(engine);
  if (linkableTypes.length === 0) return new Map();

  // Step 6 (R5): resolve the precision knobs. Caller may inject; otherwise
  // read config (malformed → defaults + warn, never crash).
  const knobs = opts.knobs ?? await loadNerKnobs(engine);
  // allow_list is a case-insensitive title/alias set that bypasses the
  // MIN_NAME_LENGTH floor (R5.1).
  const allowSet = new Set<string>(knobs.allowList.map(s => s.toLowerCase()));
  // ignore_list suppresses BARE single-token matches (R5.2). Normalized so it
  // matches the tokenizer's lowercase output.
  const ignoreTokenSet = new Set<string>(knobs.ignoreList.map(s => s.trim().toLowerCase()));

  const typeList = linkableTypes.map(t => `'${t.replace(/'/g, "''")}'`).join(', ');
  // Step 5: also project frontmatter so we can index `aliases:` as match keys.
  const rows = await engine.executeRaw<{ slug: string; source_id: string | null; title: string | null; type: string | null; frontmatter: unknown }>(
    `SELECT slug, source_id, title, type, frontmatter
     FROM pages
     WHERE type IN (${typeList})
       AND deleted_at IS NULL`,
    [],
  );

  // Pre-build the existing-title Set so the ignore-list rule can check
  // "does this name already correspond to a real page?" in O(1).
  const existingTitles = new Set<string>();
  for (const r of rows) {
    if (r.title) existingTitles.add(r.title);
  }
  const ignoreSet = new Set<string>([...DEFAULT_IGNORE_LIST, ...(opts.extraIgnore ?? [])]);

  const gazetteer: Gazetteer = new Map();

  const addEntry = (entry: GazetteerEntry): void => {
    const key = entry.tokens[0]!;
    const bucket = gazetteer.get(key);
    if (bucket) bucket.push(entry);
    else gazetteer.set(key, [entry]);
  };

  // Length gate helper (R5.1/R5.4): a single-token key below MIN_NAME_LENGTH
  // is dropped UNLESS the raw match text is on the allow-list. Multi-token
  // titles are always length-OK (the phrase disambiguates).
  const passesLength = (matchText: string, tokens: string[]): boolean => {
    if (tokens.length > 1) return true;
    if (allowSet.has(matchText.trim().toLowerCase())) return true;
    return tokens[0]!.length >= MIN_NAME_LENGTH;
  };

  for (const row of rows) {
    const type = row.type ?? undefined;

    // ── Title entry ──
    if (row.title && !(ignoreSet.has(row.title) && !existingTitles.has(row.title))) {
      const tokens = tokenizeTitle(row.title);
      if (tokens.length > 0 && passesLength(row.title, tokens)) {
        // R5.2: a bare single-token title that IS an ignore-list domain word
        // is suppressed (never links on the common word). A multi-token title
        // starting with that word is the exact-match exception and links.
        const bareIgnored = tokens.length === 1 && ignoreTokenSet.has(tokens[0]!);
        if (!bareIgnored) {
          addEntry({ slug: row.slug, source_id: row.source_id ?? 'default', title: row.title, tokens, type });
        }
      }
    }

    // ── Alias entries (Step 5 decision a) ──
    // Index frontmatter `aliases:` as additional match keys pointing to the
    // SAME target page. Aligns with Q2's require-alias-match rule so an
    // accepted entity ("Mike Stuck" with alias "mikstuck") links on both.
    const fm = (typeof row.frontmatter === 'string'
      ? safeParseJson(row.frontmatter)
      : row.frontmatter) as Record<string, unknown> | null | undefined;
    if (fm && 'aliases' in fm) {
      // normalizeAliasList lowercases/trims; we re-tokenize each alias for the
      // maximal-munch matcher (multi-word aliases supported).
      const aliasNorms = normalizeAliasList(fm.aliases);
      for (const alias of aliasNorms) {
        const tokens = tokenizeTitle(alias);
        if (tokens.length === 0) continue;
        if (!passesLength(alias, tokens)) continue;
        // Aliases are deliberate: an ignore-list bare token that a user made
        // an alias is still indexed (explicit intent overrides the domain
        // suppression, mirroring CK12's title-presence rule).
        addEntry({
          slug: row.slug,
          source_id: row.source_id ?? 'default',
          // Preserve the page title as the mention display name so downstream
          // link context reads the canonical entity, not the raw alias token.
          title: row.title ?? alias,
          tokens,
          type,
          is_alias: true,
        });
      }
    }
  }

  // Sort each bucket by token-count DESC so maximal-munch walks longest-first.
  // Tie-break: title entries before alias entries (deterministic, and a title
  // match is the "primary" identity when both would match at equal length).
  for (const bucket of gazetteer.values()) {
    bucket.sort((a, b) => {
      if (b.tokens.length !== a.tokens.length) return b.tokens.length - a.tokens.length;
      return (a.is_alias ? 1 : 0) - (b.is_alias ? 1 : 0);
    });
  }
  return gazetteer;
}

/** Parse JSON; return null on any error (frontmatter is best-effort). */
function safeParseJson(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ============================================================
// Body-text scanner (pure)
// ============================================================

/**
 * Scan body text for mentions of gazetteer entities. Pure function — no
 * IO. Returns `Mention[]` ordered by offset, deduped per
 * `(fromSlug → entry.slug)` pair (first-mention-only cap).
 *
 * Matcher is maximal-munch: at each token offset, the longest gazetteer
 * entry that matches the body-token sequence wins. Single-word entries
 * are length-1 maximal matches.
 *
 * Guards (deterministic):
 *  - D13 self-link: skip when `fromSlug === entry.slug`.
 *  - Cross-source: skip when `fromSourceId !== entry.source_id` (mention
 *    in source A of an entity in source B is suppressed; design doc
 *    treats this as deliberate isolation in v1, can relax in a follow-up).
 *  - First-mention-only cap: dedup by `entry.slug` (one link per
 *    target page regardless of how many body mentions there are).
 *
 * Code-block stripping via `stripCodeBlocks` (preserves offsets, so the
 * returned mention offsets index into the ORIGINAL text not the stripped
 * text — useful for downstream debugging tools).
 */
export function findMentionedEntities(
  text: string,
  gazetteer: Gazetteer,
  opts: FindMentionsOpts,
): Mention[] {
  if (!text || gazetteer.size === 0) return [];
  const stripped = stripCodeBlocks(text);
  const tokens = tokenizeForScan(stripped);
  if (tokens.length === 0) return [];

  const out: Mention[] = [];
  const seenSlugs = new Set<string>();
  let i = 0;

  while (i < tokens.length) {
    const head = tokens[i]!;
    const bucket = gazetteer.get(head.text);
    if (!bucket) {
      i++;
      continue;
    }

    // Maximal-munch: bucket is pre-sorted longest-first. Find the first
    // entry whose subsequent tokens all match the body sequence.
    let matched: GazetteerEntry | null = null;
    let matchedTokens = 0;
    for (const entry of bucket) {
      // R5.3 first-name rejection: a bare single-token PERSON TITLE never
      // links when the knob is on. Alias entries (is_alias) are exempt — an
      // explicit alias, even a bare first name, is a deliberate match key.
      // We skip the candidate (rather than post-match guard) so a co-bucketed
      // alias or multi-token entry can still win at this offset.
      if (
        opts.rejectFirstNames &&
        entry.tokens.length === 1 &&
        entry.type === 'person' &&
        !entry.is_alias
      ) {
        continue;
      }
      if (entry.tokens.length === 1) {
        matched = entry;
        matchedTokens = 1;
        break;
      }
      // Multi-word: validate subsequent tokens.
      if (i + entry.tokens.length > tokens.length) continue;
      let allMatch = true;
      for (let k = 1; k < entry.tokens.length; k++) {
        if (tokens[i + k]!.text !== entry.tokens[k]) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        matched = entry;
        matchedTokens = entry.tokens.length;
        break;
      }
    }

    if (!matched) {
      i++;
      continue;
    }

    // Guards.
    if (matched.slug === opts.fromSlug) {
      i += matchedTokens;
      continue;
    }
    if (matched.source_id !== opts.fromSourceId) {
      i += matchedTokens;
      continue;
    }
    if (seenSlugs.has(matched.slug)) {
      i += matchedTokens;
      continue;
    }

    out.push({
      slug: matched.slug,
      source_id: matched.source_id,
      name: matched.title,
      offset: head.offset,
    });
    seenSlugs.add(matched.slug);
    i += matchedTokens;
  }

  return out;
}
