/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The implementation lives under ./internal and is bundled into this entry
// (no public subpaths besides `@lexical/y/server`), so this module imports
// and exports rather than re-exporting from private files.
import {
  YBinding,
  type YBindingOptions,
  type YBindingStatus,
  type YCursor,
} from './internal/Binding';
import {type ClientIDRange, createYDoc} from './internal/ClientID';
import {DEFAULT_ROOT_NAME, LAYOUT_VERSION} from './internal/constants';
import {writeEditorToYDoc} from './internal/Headless';
import {type YCollabConfig, YCollabExtension} from './internal/YExtension';

export type {
  ClientIDRange,
  YBindingOptions,
  YBindingStatus,
  YCollabConfig,
  YCursor,
};
export {
  createYDoc,
  DEFAULT_ROOT_NAME,
  LAYOUT_VERSION,
  writeEditorToYDoc,
  YBinding,
  YCollabExtension,
};
