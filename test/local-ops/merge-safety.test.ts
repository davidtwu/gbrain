// FORK-LOCAL (davidtwu) — MERGE-SAFETY GUARD (Step 7, design §7 / R7).
//
// The whole point of the fork-local `get_raw_transcripts` design is merge-cleanliness with
// upstream (origin/master = garrytan/gbrain): the UPSTREAM `get_recent_transcripts` op must
// stay BYTE-UNCHANGED and DISTINCT from our fork op. If a future `git merge origin/master`
// (or a careless local edit) reshapes the upstream op — renames it, drops its localOnly
// gate, swaps its description, or worst of all folds our raw reader into it — THIS test
// fails and we notice before shipping a merge that breaks the invariant.
//
// It pins the STABLE invariants of BOTH ops:
//   - upstream get_recent_transcripts: name, scope, localOnly, cliHints, description
//     IDENTITY (=== the imported const), its text/summary/corpus param shape, and that it
//     is a DISTINCT object/handler from our fork op.
//   - fork-local get_raw_transcripts: exists, localOnly, scope 'read', is the fork addition.
//
// Design ref: .agents/planning/2026-07-21-gbrain-jsonl-transcript-bridge/design/detailed-design.md
// §4.5 (registration/merge-clean), §7 (Testing Strategy — merge-safety guard, R7);
// research/07-merge-clean-strategy.md.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations, type Operation } from '../../src/core/operations.ts';
import { GET_RECENT_TRANSCRIPTS_DESCRIPTION } from '../../src/core/operations-descriptions.ts';
import { get_raw_transcripts } from '../../src/core/local-ops/session-transcripts-op.ts';

function findOp(name: string): Operation {
  const op = operations.find((o) => o.name === name);
  expect(op, `operation '${name}' must be present in the exported operations array`).toBeDefined();
  return op!;
}

describe('merge-safety — upstream get_recent_transcripts is UNCHANGED', () => {
  test('name / scope / localOnly / cliHints pinned to the upstream shape', () => {
    const up = findOp('get_recent_transcripts');
    expect(up.name).toBe('get_recent_transcripts');
    expect(up.scope).toBe('read');
    // localOnly is the trust posture our fork op deliberately mirrors — it must NOT drift.
    expect(up.localOnly).toBe(true);
    // Upstream surfaces it on the CLI as `transcripts`, hidden from the tool-list.
    expect(up.cliHints?.name).toBe('transcripts');
    expect(up.cliHints?.hidden).toBe(true);
  });

  test('description IDENTITY — still the upstream const (a reshape/swap would break this)', () => {
    const up = findOp('get_recent_transcripts');
    // Reference-identity pin: the op must keep using the upstream description const verbatim.
    expect(up.description).toBe(GET_RECENT_TRANSCRIPTS_DESCRIPTION);
    // Belt-and-suspenders: the upstream op is the light TEXT scanner, not our full-fidelity
    // reader. If a merge folded the raw reader into it, these markers would flip.
    expect(up.description).toContain('raw conversation transcripts');
    expect(up.description.toLowerCase()).not.toContain('tool_use');
    expect(up.description.toLowerCase()).not.toContain('full fidelity');
  });

  test('param shape is the upstream text/summary/corpus one (NOT the raw op params)', () => {
    const up = findOp('get_recent_transcripts');
    // Upstream params: days / summary / limit. `summary` is the upstream-only text knob.
    expect(Object.keys(up.params).sort()).toEqual(['days', 'limit', 'summary']);
    // It must NOT have grown the fork op's params — that would be a reshape.
    for (const forkParam of ['fidelity', 'session_id', 'lanes', 'max_chars', 'format']) {
      expect(up.params[forkParam], `upstream op must NOT carry '${forkParam}'`).toBeUndefined();
    }
  });

  test('still corpus/.txt-based (the upstream reader intent, source-level guard)', () => {
    // The upstream op routes through src/core/transcripts.ts:listRecentTranscripts, which
    // walks the dream-cycle corpus dirs and filters to `.txt`. This is DELIBERATELY a
    // different reader from our local-ops `.jsonl` walk — pinning `.txt` here keeps the
    // "two readers, two extensions" split visible so a merge can't silently converge them.
    const upstreamReaderSrc = readFileSync(
      join(import.meta.dir, '../../src/core/transcripts.ts'),
      'utf8',
    );
    expect(upstreamReaderSrc).toContain(".endsWith('.txt')");
  });

  test('upstream op is DISTINCT from the fork-local get_raw_transcripts', () => {
    const up = findOp('get_recent_transcripts');
    const raw = findOp('get_raw_transcripts');
    expect(up.name).not.toBe(raw.name);
    // Distinct objects and distinct handlers — the raw op is an addition, not a mutation.
    expect(up).not.toBe(raw);
    expect(up.handler).not.toBe(raw.handler);
    expect(raw).toBe(get_raw_transcripts); // the registered op IS our fork const
  });
});

describe('merge-safety — get_raw_transcripts is the fork-local ADDITION', () => {
  test('exists, localOnly, scope read, registered via the fork const', () => {
    const raw = findOp('get_raw_transcripts');
    expect(raw.localOnly).toBe(true);
    expect(raw.scope).toBe('read');
    expect(raw.cliHints?.name).toBe('raw-transcripts');
    // Same trust posture as upstream (defense in depth) but a separate op.
    expect(raw.name).toBe('get_raw_transcripts');
  });
});
