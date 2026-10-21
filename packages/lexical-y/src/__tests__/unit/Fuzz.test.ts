/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Deterministic randomized runs: 3 peers, every delivery mode, typing,
// formats, links, comments, lists, tables, containers, undo and redo. Each
// seed checks convergence, a fresh reader, canonical shape, the self-check,
// and that no typed text is lost or duplicated.
//
// Longer runs: FUZZ_SEED_START=1 FUZZ_SEEDS=10000 FUZZ_GC_SEEDS=2500.
// One seed with its op trace: FUZZ_SEED=123 (add FUZZ_GC=1 for gc).
// Differential: the same scripts on #9386's block markers and on the
// default v2 layout of @lexical/yjs as it is in this stack (origin/main's v2
// plus the stack's fix that writes only changed text attributes):
// FUZZ_DIFF=1 with the same seed variables. Two checks per seed:
// - absolute, on @lexical/y's full script: no divergence, exception,
//   fragmented token, self-check warning or fresh-reader mismatch;
// - relative: @lexical/y never loses or duplicates more tokens, diverges,
//   throws or splits a token where both other layouts do not. Ops pick their
//   targets in the current document, so each pair is compared on the script
//   cut before the first op the two runs resolved differently. Text typed
//   into a container a peer removed, which the other layout keeps only by
//   bringing back deleted content, is not counted as lost
//   (resurrectionExcuse).
//
// Not checked here (documented limits): block moves (a move is a delete and
// a reinsert, so a concurrent edit of the moved block can duplicate or lose
// it), and text typed inside a container a peer removed (delete wins).

import {describe, expect, test} from 'vitest';

import {
  absoluteFindings,
  genScript,
  runLayouts,
  runScript,
  worseThanBoth,
} from '../utils/fuzz';

const START = Number(process.env.FUZZ_SEED_START ?? 1);
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 300);
const GC_SEEDS = Number(process.env.FUZZ_GC_SEEDS ?? 100);
const CHUNK = 50;

// Seeds whose finding is shared by the Yjs 13 layouts (the same tokens are
// lost there), skipped so a regression elsewhere fails.
const KNOWN_OPEN = new Map<number, string>([
  // Typing at the end of a paragraph held by a list item ‖ a range delete
  // that ends there: Lexical removes the paragraph node, and the typed text
  // goes with it (#9386 and the default v2 layout lose the same token).
  [199, 'typing into a held paragraph a peer removes'],
]);

function allowed(sig: string): boolean {
  return (
    sig.startsWith('limit:') ||
    sig.startsWith('nit:') ||
    sig === 'loss(container)'
  );
}

function runSeeds(from: number, to: number, gc: boolean): string[] {
  const prev = process.env.FUZZ_GC;
  process.env.FUZZ_GC = gc ? '1' : '';
  const found: string[] = [];
  try {
    for (let seed = from; seed < to; seed++) {
      if (KNOWN_OPEN.has(seed)) {
        continue;
      }
      const res = runScript(genScript(seed, {moves: false}));
      const sigs = res.failures.map(f => f.sig).filter(s => !allowed(s));
      if (sigs.length > 0) {
        found.push(`seed ${seed}${gc ? ' (gc)' : ''}: ${sigs.join(', ')}`);
      }
    }
  } finally {
    process.env.FUZZ_GC = prev;
  }
  return found;
}

function chunks(start: number, count: number): [number, number][] {
  const out: [number, number][] = [];
  for (let s = start; s < start + count; s += CHUNK) {
    out.push([s, Math.min(s + CHUNK, start + count)]);
  }
  return out;
}

if (process.env.FUZZ_DIFF === '1') {
  test('differential', () => {
    const worse: string[] = [];
    for (let seed = START; seed < START + SEEDS; seed++) {
      const runs = runLayouts(genScript(seed));
      // Absolute: @lexical/y's own full-script run.
      const own = absoluteFindings(runs);
      if (own.length > 0) {
        worse.push(`seed ${seed}: ${own.join(', ')} (full script)`);
      }
      // Relative: each pair on its cut script.
      const cats = worseThanBoth(runs);
      if (cats.length > 0) {
        worse.push(`seed ${seed}: worse than both in ${cats.join(', ')}`);
      }
    }
    expect(worse).toEqual([]);
  }, 3_600_000);
} else if (process.env.FUZZ_SEED !== undefined) {
  test('one seed with its trace', () => {
    const res = runScript(
      genScript(Number(process.env.FUZZ_SEED), {moves: false}),
      true,
    );
    // eslint-disable-next-line no-console
    console.log(
      [...(res.trace ?? []), ...res.failures.map(f => f.detail)].join('\n'),
    );
    expect(res.failures.map(f => f.sig).filter(s => !allowed(s))).toEqual([]);
  });
} else {
  describe('@lexical/y fuzz', () => {
    test.each(chunks(START, SEEDS))(
      'seeds %i..%i',
      (from, to) => {
        expect(runSeeds(from, to, false)).toEqual([]);
      },
      600_000,
    );
    test.each(chunks(START, GC_SEEDS))(
      'gc seeds %i..%i',
      (from, to) => {
        expect(runSeeds(from, to, true)).toEqual([]);
      },
      600_000,
    );
  });
}
