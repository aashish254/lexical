/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {ClientIDRange} from './ClientID';
import type {Doc, Node as YNode} from '@y/y';
import type {LexicalEditor} from 'lexical';

import {YBinding} from './Binding';

/**
 * @experimental Write an editor's current document into the empty layout
 * root of `doc`: a converter can write it next to an older layout's root in
 * the same document. Throws when the layout root is not empty.
 */
export function writeEditorToYDoc(
  editor: LexicalEditor,
  doc: Doc,
  options: {root?: YNode; clientIDRange?: ClientIDRange} = {},
): void {
  const binding = new YBinding(editor, doc, {
    captureTimeout: null,
    clientIDRange: options.clientIDRange,
    convert: true,
    onWarn: message => {
      throw new Error(message);
    },
    root: options.root,
  });
  const stop = binding.start();
  try {
    if (binding.status !== 'pending') {
      throw new Error('@lexical/y: the shared root is not empty');
    }
    binding.initialize();
  } finally {
    stop();
  }
}
