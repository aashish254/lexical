/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Other shared types in the same document.
// @vitest-environment node
import * as Y from '@y/y';
import {$getRoot, createEditor} from 'lexical';
import {describe, expect, test} from 'vitest';

import {YBinding} from '../..';
import {$p, NODES} from '../utils/harness';

const mk = () =>
  createEditor({
    namespace: 'x',
    nodes: NODES,
    onError: e => {
      throw e;
    },
  });

describe('other roots in the same doc', () => {
  test('app metadata root written before initialize', () => {
    const doc = new Y.Doc();
    doc.get('meta').setAttr('title', 'My doc');
    const ed = mk();
    ed.update(() => $getRoot().clear().append($p('hello')), {discrete: true});
    const warnings: string[] = [];
    const b = new YBinding(ed, doc, {onWarn: m => warnings.push(m)});
    b.start();
    b.initialize();
    expect(b.status).toBe('active');
  });
  test('two bindings on two roots of one doc (main editor + a second editor)', () => {
    const doc = new Y.Doc();
    const e1 = mk();
    e1.update(() => $getRoot().clear().append($p('main')), {discrete: true});
    const b1 = new YBinding(e1, doc, {root: doc.get('main')});
    b1.start();
    b1.initialize();
    const e2 = mk();
    e2.update(() => $getRoot().clear().append($p('caption')), {discrete: true});
    const warnings: string[] = [];
    const b2 = new YBinding(e2, doc, {
      onWarn: m => warnings.push(m),
      root: doc.get('caption-1'),
    });
    b2.start();
    b2.initialize();
    expect(b2.status).toBe('active');
  });
});
