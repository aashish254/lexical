/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import * as Y from '@y/y';
import {$getRoot} from 'lexical';
import {describe, expect, test} from 'vitest';

import {expectConverged, type Peer, setup} from '../utils/harness';
import {$initDoc, scriptedSession, SIZE_OPS} from '../utils/sizeOps';

// Bytes added to the document per operation: deterministic (gc off, pinned
// client ids in the range of Yjs' random ids, so references cost what they
// cost in practice), so budgets are tight. Measured as the size of the updates the
// editing client emits. The same script measures the Yjs 13 layouts (see the
// commit message for the comparison).

const IDS = [2654435769, 2246822519];

function emitted(peer: Peer, fn: () => void): number {
  let bytes = 0;
  const onUpdate = (u: Uint8Array, origin: unknown) => {
    if (
      origin !== 'load' &&
      (origin === peer.binding || origin === peer.binding.undoManager)
    ) {
      bytes += u.length;
    }
  };
  peer.doc.on('update', onUpdate);
  try {
    fn();
  } finally {
    peer.doc.off('update', onUpdate);
  }
  return bytes;
}

// Budgets in bytes: [op, undo, redo], about 10% over what @y/y
// 14.0.0-rc.28 measures; a change that grows any of them should be
// deliberate.
const BUDGETS: Record<string, [number, number, number]> = {
  'Backspace join': [13, 31, 13],
  'Enter mid line': [31, 13, 31],
  'add a comment (NodeState)': [74, 13, 74],
  'bold a range': [67, 13, 67],
  'delete a container (table)': [15, 622, 13],
  'heading toggle': [55, 13, 44],
  'indent list item': [72, 32, 67],
  'link a word': [116, 13, 116],
  'list type change': [21, 68, 13],
  'move a block': [97, 104, 97],
  'outdent list item': [32, 67, 32],
  'paste 1k chars': [1129, 15, 1130],
  'quote toggle': [32, 13, 29],
  'remove a comment (NodeState)': [13, 74, 13],
  'table row delete': [15, 210, 13],
  'table row insert': [210, 13, 209],
  'type a char at line end': [29, 13, 29],
  'type a char at line start': [29, 13, 29],
  'type a char mid line': [29, 13, 29],
  unlink: [13, 116, 13],
};

export const SIZE_RESULTS: Record<string, [number, number, number]> = {};

describe('@lexical/y bytes per operation', () => {
  for (const op of SIZE_OPS) {
    test(op.name, async () => {
      const t = await setup($initDoc, {ids: IDS});
      if (op.prepare) {
        t.a.update(op.prepare);
        await t.sync();
      }
      const um = t.a.binding.undoManager!;
      um.clear();
      um.stopCapturing();
      const doBytes = emitted(t.a, () => t.a.update(op.run));
      const after = t.a.describe();
      um.stopCapturing();
      const undoBytes = emitted(t.a, () => t.a.binding.undo());
      const redoBytes = emitted(t.a, () => t.a.binding.redo());
      await t.sync();
      await expectConverged(t.peers, after);
      SIZE_RESULTS[op.name] = [doBytes, undoBytes, redoBytes];
      const [b0, b1, b2] = BUDGETS[op.name];
      expect(doBytes).toBeLessThanOrEqual(b0);
      expect(undoBytes).toBeLessThanOrEqual(b1);
      expect(redoBytes).toBeLessThanOrEqual(b2);
    });
  }

  test('growth over a scripted session of 10,000 edits', async () => {
    const t = await setup($initDoc, {ids: IDS});
    const before = Y.encodeStateAsUpdate(t.a.doc).length;
    for (const edit of scriptedSession(10000)) {
      t.a.update(edit);
    }
    await t.sync();
    const after = Y.encodeStateAsUpdate(t.a.doc).length;
    const text = t.a.read(() => $getRoot().getTextContentSize());
    SIZE_RESULTS['session growth'] = [after - before, text, 0];
    expect(t.b.describe()).toBe(t.a.describe());
    expect(after - before).toBeLessThanOrEqual(243000);
  }, 120000);
});
