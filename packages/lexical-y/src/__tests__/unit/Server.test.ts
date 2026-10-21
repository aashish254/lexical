/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import * as Y from '@y/y';
import {$getRoot, createEditor} from 'lexical';
import {describe, expect, test} from 'vitest';
import * as Y13 from 'yjs';

import {YBinding} from '../..';
import {
  inspectUpdateRoots,
  isUpdateForLayout,
  writeUpgradeNotice,
} from '../../server';
import {$p, $selectIn, NODES, setup} from '../utils/harness';

describe('@lexical/y server helpers', () => {
  test('updates of upgraded clients write only to the layout root', async () => {
    const t = await setup(() => $getRoot().append($p('hello')));
    const updates: Uint8Array[] = [];
    t.a.doc.on('update', (u: Uint8Array) => updates.push(u));
    t.a.update(() => $selectIn([0], 5).insertText('!'));
    t.a.update(() => $selectIn([0], 0).insertParagraph());
    expect(updates.length).toBe(2);
    for (const u of updates) {
      // Nested items resolve through the server's copy of the document.
      const r = inspectUpdateRoots(u, t.b.doc);
      expect([[...r.roots], r.unresolved]).toEqual([['lexical-y'], 0]);
      expect(isUpdateForLayout(u, {doc: t.b.doc})).toBe(true);
    }
    expect(isUpdateForLayout(Y.encodeStateAsUpdate(t.a.doc))).toBe(true);
  });

  test('an old client update is reported', () => {
    const old = new Y13.Doc();
    old
      .get('root-v2', Y13.XmlFragment)
      .insert(0, [new Y13.XmlElement('paragraph')]);
    const update = Y13.encodeStateAsUpdate(old);
    expect([...inspectUpdateRoots(update).roots]).toEqual(['root-v2']);
    expect(isUpdateForLayout(update)).toBe(false);
  });

  test('an upgrade notice is readable by an old (Yjs 13) client', () => {
    const doc = new Y.Doc();
    writeUpgradeNotice(doc, 'Reload please');
    const old = new Y13.Doc();
    Y13.applyUpdate(old, Y.encodeStateAsUpdate(doc));
    const fragment = old.get('root-v2', Y13.XmlFragment);
    const paragraph = fragment.get(0) as Y13.XmlElement;
    expect(paragraph.nodeName).toBe('paragraph');
    expect((paragraph.get(0) as Y13.XmlText).toString()).toBe('Reload please');
  });

  test('the editor is not editable until the layout record is read', () => {
    const doc = new Y.Doc();
    const editor = createEditor({
      nodes: NODES,
      onError: e => {
        throw e;
      },
    });
    const binding = new YBinding(editor, doc);
    binding.start();
    expect(binding.status).toBe('pending');
    expect(editor.isEditable()).toBe(false);
    binding.initialize();
    expect(editor.isEditable()).toBe(true);
  });
});
