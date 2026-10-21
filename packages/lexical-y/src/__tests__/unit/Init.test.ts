/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import * as Y from '@y/y';
import {
  $getRoot,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  configExtension,
  createEditor,
  defineExtension,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {writeEditorToYDoc, YBinding, YCollabExtension} from '../..';
import {writeUpgradeNotice} from '../../server';
import {$p, $selectIn, NODES, setup} from '../utils/harness';

function client(doc: Y.Doc, text: string | null, root?: Y.Node) {
  const editor = createEditor({
    nodes: NODES,
    onError: e => {
      throw e;
    },
  });
  if (text !== null) {
    editor.update(() => $getRoot().clear().append($p(text)), {discrete: true});
  }
  const warnings: string[] = [];
  const binding = new YBinding(editor, doc, {
    onWarn: m => warnings.push(m),
    root,
  });
  binding.start();
  return {binding, editor, warnings};
}

const text = (editor: ReturnType<typeof createEditor>) =>
  editor.getEditorState().read(() => $getRoot().getTextContent());

describe('@lexical/y initialization', () => {
  test('undo right after initialization does not undo it', async () => {
    const t = await setup(() => $getRoot().append($p('initial content')));
    expect(t.a.binding.undoManager!.canUndo()).toBe(false);
    t.a.binding.undo();
    expect(t.a.describe()).toBe('paragraph("initial content")');
    expect(t.a.binding.root.getAttr('lexical-y')).toBe(1);
    t.a.update(() => $selectIn([0], 7).insertText('!'));
    t.a.undo();
    t.a.undo();
    await t.sync();
    expect(t.b.describe()).toBe('paragraph("initial content")');
    expect(t.b.binding.root.getAttr('lexical-y')).toBe(1);
  });

  test('two clients initializing with the same content write one copy', () => {
    const d1 = new Y.Doc();
    const d2 = new Y.Doc();
    const a = client(d1, 'Same seed');
    const b = client(d2, 'Same seed');
    a.binding.initialize();
    b.binding.initialize();
    // Exchange the concurrent initializations.
    const u1 = Y.encodeStateAsUpdate(d1);
    const u2 = Y.encodeStateAsUpdate(d2);
    Y.applyUpdate(d1, u2);
    Y.applyUpdate(d2, u1);
    expect(text(a.editor)).toBe('Same seed');
    expect(text(b.editor)).toBe('Same seed');
    expect(Y.encodeStateAsUpdate(d1)).toEqual(Y.encodeStateAsUpdate(d2));
    // The clients keep their own ids for later edits.
    expect(d1.clientID).not.toBe(d2.clientID);
  });

  for (const content of [null, 'Same seed']) {
    test(`two clients initializing two different roots with equal content keep both (${content ?? 'empty'})`, () => {
      const d1 = new Y.Doc({gc: false});
      const d2 = new Y.Doc({gc: false});
      const a = client(d1, content, d1.get('a'));
      const b = client(d2, content, d2.get('b'));
      a.binding.initialize();
      b.binding.initialize();
      const u1 = Y.encodeStateAsUpdate(d1);
      const u2 = Y.encodeStateAsUpdate(d2);
      Y.applyUpdate(d1, u2);
      Y.applyUpdate(d2, u1);
      const roots = (d: Y.Doc) =>
        JSON.stringify({a: d.get('a').toJSON(), b: d.get('b').toJSON()});
      expect(roots(d1)).toBe(roots(d2));
      for (const name of ['a', 'b']) {
        const d = new Y.Doc();
        Y.applyUpdate(d, Y.encodeStateAsUpdate(d1));
        const reader = client(d, null, d.get(name));
        reader.binding.initialize();
        expect(reader.binding.status).toBe('active');
        expect(text(reader.editor)).toBe(content ?? '');
      }
    });
  }

  test('two clients initializing with different content converge', () => {
    const d1 = new Y.Doc();
    const d2 = new Y.Doc();
    const a = client(d1, 'First');
    const b = client(d2, 'Second');
    a.binding.initialize();
    b.binding.initialize();
    const u1 = Y.encodeStateAsUpdate(d1);
    const u2 = Y.encodeStateAsUpdate(d2);
    Y.applyUpdate(d1, u2);
    Y.applyUpdate(d2, u1);
    expect(text(a.editor)).toBe(text(b.editor));
    expect(['First\n\nSecond', 'Second\n\nFirst']).toContain(text(a.editor));
  });

  test('only older layout roots block initialization', () => {
    const appDoc = new Y.Doc();
    appDoc.get('comments').setAttr('c1', {text: 'hello'});
    const app = client(appDoc, 'x');
    app.binding.initialize();
    expect(app.binding.status).toBe('active');

    const oldDoc = new Y.Doc();
    oldDoc.get('root-v2').insert(0, [new Y.Node('paragraph')]);
    const old = client(oldDoc, 'x');
    old.binding.initialize();
    expect(old.binding.status).toBe('readonly');
    expect(old.warnings.length).toBe(1);
  });

  test('an upgrade notice does not block initialization', () => {
    for (const root of ['root-v2', 'root'] as const) {
      const doc = new Y.Doc();
      writeUpgradeNotice(doc, 'Reload please', root);
      const c = client(doc, 'fresh');
      c.binding.initialize();
      expect(c.binding.status).toBe('active');
      expect(text(c.editor)).toBe('fresh');
    }
  });

  test('YCollabExtension forwards convert, selfCheck and selfCheckSample', () => {
    const doc = new Y.Doc();
    doc.get('root-v2').insert(0, [new Y.Node('paragraph')]);
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          configExtension(YCollabExtension, {
            convert: true,
            doc,
            selfCheck: false,
            selfCheckSample: 0.25,
            synced: true,
          }),
        ],
        name: 'app',
        nodes: NODES,
      }),
    );
    const {binding, status} = getExtensionDependencyFromEditor(
      editor,
      YCollabExtension,
    ).output;
    // convert: initializes the layout root next to the old one.
    expect(status.value).toBe('active');
    const options = (binding as unknown as {options: Record<string, unknown>})
      .options;
    expect(options.selfCheck).toBe(false);
    expect(options.selfCheckSample).toBe(0.25);
    editor.dispose();
  });

  test('converting in place next to an older layout root', () => {
    const doc = new Y.Doc();
    doc.get('root-v2').insert(0, [new Y.Node('paragraph')]);
    const source = createEditor({
      nodes: NODES,
      onError: e => {
        throw e;
      },
    });
    source.update(() => $getRoot().append($p('converted')), {discrete: true});
    writeEditorToYDoc(source, doc);
    writeUpgradeNotice(doc);
    const c = client(doc, null);
    expect(c.binding.status).toBe('active');
    expect(text(c.editor)).toBe('converted');
    expect(() => writeEditorToYDoc(source, doc)).toThrow();
  });

  test('the extension: status signal, undo state, conflicts with history', () => {
    const doc = new Y.Doc();
    const canUndo: boolean[] = [];
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [configExtension(YCollabExtension, {doc})],
        name: 'app',
        nodes: NODES,
        register: ed =>
          ed.registerCommand(
            CAN_UNDO_COMMAND,
            value => {
              canUndo.push(value);
              return false;
            },
            COMMAND_PRIORITY_CRITICAL,
          ),
      }),
    );
    const {binding, status} = getExtensionDependencyFromEditor(
      editor,
      YCollabExtension,
    ).output;
    expect(status.value).toBe('pending');
    expect(editor.isEditable()).toBe(false);
    binding.initialize();
    expect(status.value).toBe('active');
    expect(editor.isEditable()).toBe(true);
    editor.update(() => $getRoot().append($p('typed')), {discrete: true});
    expect(canUndo[canUndo.length - 1]).toBe(true);
    editor.dispose();
    expect(() =>
      buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            configExtension(YCollabExtension, {doc: new Y.Doc()}),
            HistoryExtension,
          ],
          name: 'conflict',
        }),
      ),
    ).toThrow();
  });
});
