/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  type CollabBlockGroupConfig,
  createEditor,
  ElementNode,
  getComposedSchemaFields,
  getDeclaredCollabConfig,
  getDeclaredSlots,
  getStaticNodeConfig,
  type Klass,
  type LexicalNode,
  type NodeKey,
  TEXT_TYPE_TO_FORMAT,
  type TextNode,
} from 'lexical';

/*
 * What each Lexical node class is to the binding, and how node properties
 * become Yjs attributes and formats.
 */

export type Attrs = Record<string, unknown>;

/** Name of a line marker child. */
export const MARKER = '\u00b6';
/** Name of the terminator of inline content that belongs to a container. */
export const RUN_END = '\u00a6';
/** Name prefix of a child node that is a unit of its container. */
export const BLOCK_PREFIX = 'b:';
/** Name prefix of a child node inside inline content. */
export const INLINE_PREFIX = 'i:';

export {LAYOUT_KEY, LAYOUT_VERSION} from './constants';
/** Container attribute: 'b' when it holds blocks, 'i' when inline content. */
export const KIND_KEY = 'c';

// Marker keys
export const TYPE_KEY = 't';

/**
 * A stored node's type: its name's (`b:<type>` / `i:<type>`, fixed when it
 * was created), or `t` when the node was replaced in place by a node of
 * another type (the shared node and its content are kept).
 */
export function storedTypeOf(y: {
  name: unknown;
  getAttr: (k: string) => unknown;
}): string {
  const t = y.getAttr(TYPE_KEY);
  return typeof t === 'string' ? t : String(y.name).slice(2);
}
export const GROUP_KEY = 'g';
export const GROUP_FIELD_PREFIX = 'g:';
export const LEVEL_KEY = 'l';
/**
 * The key fields of the outer groups of a nested group item (level > 0):
 * one array of key-field values per outer level, outermost first. An outer
 * group holding only nested items has no item of its own to carry its key.
 */
export const OUTER_KEY = 'o';
// Property keys (markers, nodes, text)
export const FIELD_PREFIX = 'p:';
export const STATE_PREFIX = 's:';
// Text format keys
export const TEXT_FORMAT_PREFIX = 'f:';
export const SEGMENT_KEY = 'k';
export const WRAPPER_PREFIX = 'w:';

const hasOwn = (obj: object, key: string) =>
  Object.prototype.hasOwnProperty.call(obj, key);

const warned = new Set<string>();
export function warnOnce(message: string): void {
  if (process.env.NODE_ENV !== 'production' && !warned.has(message)) {
    warned.add(message);
    console.warn(message);
  }
}

export const klassOf = (node: LexicalNode) =>
  node.constructor as Klass<LexicalNode>;

// ---------------------------------------------------------------------------
// Schema completeness

/**
 * Whether everything a node of `klass` holds is in its serialization schema
 * and NodeState, which is all a marker or a format stores. Every class from
 * `klass` up to (excluding) the class that declares the hint must declare its
 * own `$config()` and must not hand-write `exportJSON`, `updateFromJSON` or
 * `afterCloneFrom` (each can carry properties the schema does not describe).
 * The declaring class itself is trusted: the hint is its author's statement.
 */
/**
 * Whether a class wrote its own afterCloneFrom. Lexical synthesizes one for
 * every class whose $config declares fields (it copies those fields) and
 * marks it, as core's own declaresOwnAfterCloneFrom checks.
 */
function ownsHandWrittenAfterCloneFrom(k: Klass<LexicalNode>): boolean {
  if (!hasOwn(k.prototype, 'afterCloneFrom')) {
    return false;
  }
  const own = (k.prototype as unknown as {afterCloneFrom?: unknown})
    .afterCloneFrom as {__lexicalSynthesizedAfterCloneFrom?: true} | undefined;
  return own === undefined || own.__lexicalSynthesizedAfterCloneFrom !== true;
}

function isSchemaComplete(
  klass: Klass<LexicalNode>,
  declares: (k: Klass<LexicalNode>) => boolean,
): boolean {
  for (
    let k: Klass<LexicalNode> | null = klass;
    k !== null &&
    k !== ElementNode &&
    k !== (Object.getPrototypeOf(ElementNode) as Klass<LexicalNode>);
    k = Object.getPrototypeOf(k) as Klass<LexicalNode> | null
  ) {
    if (declares(k)) {
      return k === klass || !hasUndeclaredFields(klass, k);
    }
    const config = getStaticNodeConfig(k);
    if (
      !config.declaresOwnConfig ||
      hasOwn(k.prototype, 'exportJSON') ||
      hasOwn(k.prototype, 'updateFromJSON') ||
      ownsHandWrittenAfterCloneFrom(k)
    ) {
      return false;
    }
  }
  return false;
}

/**
 * Whether instances of `klass` carry own properties (`__name`) that neither
 * `declaring` (the class with the collab declaration) nor `klass`'s schema
 * declares: a subclass with its own $config and an extra property outside it
 * would lose that property silently in a line or a format.
 */
function hasUndeclaredFields(
  klass: Klass<LexicalNode>,
  declaring: Klass<LexicalNode>,
): boolean {
  let found = false;
  try {
    const probe = createEditor({
      namespace: '@lexical/y schema probe',
      nodes: [klass, declaring],
      onError: () => {},
    });
    probe.update(
      () => {
        const sub = new klass();
        const base = new declaring();
        const known = new Set(Object.keys(base));
        for (const f of Object.keys(getComposedSchemaFields(klass))) {
          known.add('__' + f);
        }
        const extra = Object.keys(sub).filter(
          k => k.startsWith('__') && !known.has(k),
        );
        if (extra.length > 0) {
          found = true;
          warnOnce(
            `@lexical/y: ${klass.name || 'a node class'} has properties outside its $config() schema (${extra.join(', ')}); they are not serialized, so they are not synced (and Lexical drops them when it clones the node): declare them in $config().`,
          );
        }
      },
      {discrete: true},
    );
  } catch (_e) {
    // A class that cannot be built without arguments: not checked.
    return false;
  }
  return found;
}

const declaresBlock = (k: Klass<LexicalNode>): boolean => {
  const c = getStaticNodeConfig(k);
  return (
    c.declaresOwnConfig &&
    c.ownNodeConfig !== undefined &&
    c.ownNodeConfig.collab !== undefined &&
    c.ownNodeConfig.collab.block !== undefined
  );
};

const declaresInline = (k: Klass<LexicalNode>): boolean => {
  const c = getStaticNodeConfig(k);
  return (
    c.declaresOwnConfig &&
    c.ownNodeConfig !== undefined &&
    c.ownNodeConfig.collab !== undefined &&
    c.ownNodeConfig.collab.inline !== undefined
  );
};

// ---------------------------------------------------------------------------
// Specs

export type LineSpec = {readonly fields: ReadonlySet<string>};
export type GroupSpec = {
  readonly klass: Klass<LexicalNode>;
  readonly items: readonly Klass<LexicalNode>[];
  readonly key: readonly string[];
  readonly nested: boolean;
  readonly derived: ReadonlySet<string>;
};
export type WrapperSpec = {readonly fields: ReadonlySet<string>};

const lineSpecs = new WeakMap<Klass<LexicalNode>, LineSpec | null>();
const groupSpecs = new WeakMap<Klass<LexicalNode>, GroupSpec | null>();
const wrapperSpecs = new WeakMap<Klass<LexicalNode>, WrapperSpec | null>();

function honoredBlockHint(
  klass: Klass<LexicalNode>,
): 'line' | CollabBlockGroupConfig | null {
  const block = getDeclaredCollabConfig(klass).block;
  if (block === undefined || block === 'node') {
    return null;
  }
  const name = klass.name || 'node class';
  if (!(klass.prototype instanceof ElementNode)) {
    warnOnce(
      `@lexical/y: ${name} declares collab.block but is not an ElementNode; it is stored as a node.`,
    );
    return null;
  }
  if (!isSchemaComplete(klass, declaresBlock)) {
    warnOnce(
      `@lexical/y: ${name} inherits collab.block but its serialization is not schema-complete (no own $config(), or a hand-written exportJSON/updateFromJSON/afterCloneFrom); it is stored as a node.`,
    );
    return null;
  }
  if (getDeclaredSlots(klass).length > 0) {
    warnOnce(
      `@lexical/y: ${name} declares collab.block and slots; it is stored as a node.`,
    );
    return null;
  }
  if (block === 'line') {
    return 'line';
  }
  if (
    typeof block !== 'object' ||
    block === null ||
    block.mode !== 'group' ||
    !Array.isArray(block.key) ||
    block.key.length === 0 ||
    typeof block.items !== 'function'
  ) {
    warnOnce(
      `@lexical/y: ${name} declares a collab.block group without key fields or items; it is stored as a node.`,
    );
    return null;
  }
  return block;
}

export function getLineSpec(klass: Klass<LexicalNode>): LineSpec | null {
  let spec = lineSpecs.get(klass);
  if (spec === undefined) {
    spec =
      honoredBlockHint(klass) === 'line'
        ? {fields: new Set(Object.keys(getComposedSchemaFields(klass)))}
        : null;
    lineSpecs.set(klass, spec);
  }
  return spec;
}

const containerGroupSpecs = new WeakMap<Klass<LexicalNode>, GroupSpec | null>();

/**
 * The group declaration of a class stored as a node (a subclass that is not
 * schema-complete): its children are already the group's items, so readers
 * must not wrap them in another group.
 */
export function getContainerGroupSpec(
  klass: Klass<LexicalNode>,
): GroupSpec | null {
  const honored = getGroupSpec(klass);
  if (honored !== null) {
    return honored;
  }
  let spec = containerGroupSpecs.get(klass);
  if (spec === undefined) {
    const block = getDeclaredCollabConfig(klass).block;
    spec =
      block !== undefined &&
      block !== 'node' &&
      block !== 'line' &&
      klass.prototype instanceof ElementNode
        ? {
            derived: new Set(block.derived || []),
            items: block.items(),
            key: block.key,
            klass,
            nested: block.nested === true,
          }
        : null;
    containerGroupSpecs.set(klass, spec);
  }
  return spec;
}

export function getGroupSpec(klass: Klass<LexicalNode>): GroupSpec | null {
  let spec = groupSpecs.get(klass);
  if (spec === undefined) {
    const block = honoredBlockHint(klass);
    spec = null;
    if (block !== null && block !== 'line') {
      const items = block.items();
      if (items.length === 0 || items.some(i => getLineSpec(i) === null)) {
        warnOnce(
          `@lexical/y: the items of the collab.block group ${klass.name} must be lines; it is stored as a node.`,
        );
      } else {
        spec = {
          derived: new Set(block.derived || []),
          items,
          key: block.key,
          klass,
          nested: block.nested === true,
        };
      }
    }
    groupSpecs.set(klass, spec);
  }
  return spec;
}

let elementFields: ReadonlySet<string> | undefined;
const getElementFieldNames = (): ReadonlySet<string> => {
  if (elementFields === undefined) {
    elementFields = new Set(Object.keys(getComposedSchemaFields(ElementNode)));
  }
  return elementFields;
};

export function getWrapperSpec(klass: Klass<LexicalNode>): WrapperSpec | null {
  let spec = wrapperSpecs.get(klass);
  if (spec === undefined) {
    spec = null;
    if (
      klass.prototype instanceof ElementNode &&
      getDeclaredCollabConfig(klass).inline === 'format'
    ) {
      const type = getStaticNodeConfig(klass).ownNodeType;
      if (typeof type === 'string' && type.includes(':')) {
        warnOnce(
          `@lexical/y: node type ${type} contains ":" and cannot be stored as a format; it is stored as a node.`,
        );
      } else if (!isSchemaComplete(klass, declaresInline)) {
        warnOnce(
          `@lexical/y: ${klass.name} inherits collab.inline "format" but its serialization is not schema-complete; it is stored as a node.`,
        );
      } else {
        const base = getElementFieldNames();
        spec = {
          fields: new Set(
            Object.keys(getComposedSchemaFields(klass)).filter(
              f => !base.has(f),
            ),
          ),
        };
      }
    }
    wrapperSpecs.set(klass, spec);
  }
  return spec;
}

/** An inline element stored as formats over the content it wraps. */
export function $isWrapper(node: LexicalNode | null): boolean {
  return (
    node !== null &&
    $isElementNode(node) &&
    node.isInline() &&
    getWrapperSpec(klassOf(node)) !== null
  );
}

export function $isLine(node: LexicalNode | null): node is ElementNode {
  return (
    node !== null &&
    $isElementNode(node) &&
    !node.isInline() &&
    getLineSpec(klassOf(node)) !== null
  );
}

/** A group node whose children are all items (or nesting levels). */
export function $isGroup(node: LexicalNode | null): node is ElementNode {
  if (node === null || !$isElementNode(node) || node.isInline()) {
    return false;
  }
  const spec = getGroupSpec(klassOf(node));
  if (spec === null) {
    return false;
  }
  let c = node.getFirstChild();
  if (c === null) {
    return false;
  }
  for (; c !== null; c = c.getNextSibling()) {
    if (!spec.items.includes(klassOf(c)) || !$isLine(c)) {
      return false;
    }
  }
  return true;
}

export function $hasBlockChild(node: ElementNode): boolean {
  for (let c = node.getFirstChild(); c !== null; c = c.getNextSibling()) {
    if (!$isInlineChild(c)) {
      return true;
    }
  }
  return false;
}

/** The group an item holds when it only is a nesting level. */
export function $nestedGroupOf(
  item: LexicalNode,
  spec: GroupSpec,
): ElementNode | null {
  if (!spec.nested || !$isElementNode(item)) {
    return null;
  }
  const first = item.getFirstChild();
  return first !== null &&
    first === item.getLastChild() &&
    $isElementNode(first) &&
    klassOf(first) === spec.klass &&
    $isGroup(first)
    ? first
    : null;
}

export const $isInlineChild = (n: LexicalNode): boolean =>
  $isTextNode(n) || $isLineBreakNode(n) || n.isInline();

export function isShadowRootKlass(node: LexicalNode): boolean {
  return $isElementNode(node) && node.isShadowRoot();
}

// ---------------------------------------------------------------------------
// Values

export const isPlainJSON = (v: unknown, depth = 0): boolean => {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') {
    return true;
  }
  if (typeof v === 'number') {
    return Number.isFinite(v);
  }
  if (depth > 32 || typeof v !== 'object') {
    return false;
  }
  if (Array.isArray(v)) {
    return v.every(x => isPlainJSON(x, depth + 1));
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  return Object.values(v as Attrs).every(x => isPlainJSON(x, depth + 1));
};

/**
 * `v` as plain JSON, as JSON.stringify would write it (object members that
 * are undefined are left out, array entries that are undefined become null),
 * or undefined when it is not JSON (a class instance such as a nested
 * editor, a function, a non-finite number, a cycle).
 */
export const toPlainJSON = (v: unknown, depth = 0): unknown => {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') {
    return v;
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : undefined;
  }
  if (depth > 32 || typeof v !== 'object') {
    return undefined;
  }
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v) {
      if (x === undefined) {
        out.push(null);
        continue;
      }
      const y = toPlainJSON(x, depth + 1);
      if (y === undefined) {
        return undefined;
      }
      out.push(y);
    }
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    return undefined;
  }
  const out: Attrs = {};
  for (const k of Object.keys(v as Attrs)) {
    const x = (v as Attrs)[k];
    if (x === undefined) {
      continue;
    }
    const y = toPlainJSON(x, depth + 1);
    if (y === undefined) {
      return undefined;
    }
    out[k] = y;
  }
  return out;
};

export const isUnsafeKey = (key: string) =>
  key === '__proto__' || key === 'constructor' || key === 'prototype';

export const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map(k => [k, v[k]]),
        )
      : v,
  );

export const equalValue = (a: unknown, b: unknown): boolean =>
  a === b ||
  (typeof a === 'object' &&
    typeof b === 'object' &&
    a !== null &&
    b !== null &&
    stableStringify(a) === stableStringify(b));

/**
 * Format values are compared one level deep by Yjs, so a value that is not
 * a primitive is stored as `{json: '<stable JSON>'}`.
 */
export const encodeFormatValue = (v: unknown): unknown =>
  v === null || typeof v !== 'object' ? v : {json: stableStringify(v)};

export const decodeFormatValue = (v: unknown): unknown => {
  if (v !== null && typeof v === 'object') {
    const json = (v as Attrs).json;
    if (typeof json === 'string') {
      try {
        return JSON.parse(json);
      } catch (_e) {
        return null;
      }
    }
  }
  return v;
};

/** Format attributes of a line break: its NodeState. */
export function $lineBreakAttrs(node: LexicalNode, wrapperAttrs: Attrs): Attrs {
  const own: Attrs = {};
  $stateAttrs(node, own);
  return {...wrapperAttrs, ...encodeFormats(own)};
}

/** The NodeState a line break's format attributes give it. */
export function lineBreakStateFromAttrs(encoded: Attrs): Attrs {
  const state: Attrs = {};
  for (const k of Object.keys(encoded).sort()) {
    if (k.startsWith(STATE_PREFIX)) {
      const f = k.slice(STATE_PREFIX.length);
      if (!isUnsafeKey(f)) {
        state[f] = decodeFormatValue(encoded[k]);
      }
    }
  }
  return state;
}

function encodeFormats(attrs: Attrs): Attrs {
  for (const k in attrs) {
    attrs[k] = encodeFormatValue(attrs[k]);
  }
  return attrs;
}

function putValue(attrs: Attrs, key: string, value: unknown, what: string) {
  if (value === undefined) {
    return;
  }
  const plain = toPlainJSON(value);
  if (plain === undefined) {
    warnOnce(
      `@lexical/y: ${what} is not plain JSON and is not synchronized (for example a nested editor instance; give it its own document).`,
    );
    return;
  }
  attrs[key] = plain;
}

/** NodeState entries as `s:<key>` attributes. */
export function $stateAttrs(node: LexicalNode, out: Attrs, prefix = ''): void {
  const state = node.__state;
  if (!state) {
    return;
  }
  const [unknown = {}, known] = state.getInternalState();
  // As NodeState#toJSON: a known value replaces an unknown one of its key
  // (read from JSON before the key's config was used), and a known value
  // at its default removes it.
  const knownKeys = new Set<string>();
  for (const [config] of known) {
    knownKeys.add(config.key);
  }
  for (const [k, v] of Object.entries(unknown)) {
    if (!knownKeys.has(k)) {
      putValue(out, prefix + STATE_PREFIX + k, v, `NodeState ${k}`);
    }
  }
  for (const [config, v] of known) {
    // A value reset to its default is not stored (as Lexical's JSON).
    if (config.isEqual(v, config.defaultValue)) {
      continue;
    }
    putValue(
      out,
      prefix + STATE_PREFIX + config.key,
      config.unparse(v),
      `NodeState ${config.key}`,
    );
  }
}

/**
 * The compact JSON the node's serialization schema writes (the base
 * LexicalNode.exportJSON, so an override does not change what is stored),
 * without NodeState.
 */
export function $schemaJSON(node: LexicalNode): Attrs {
  // ElementNode does not override exportJSON: this is LexicalNode's.
  const json = ElementNode.prototype.exportJSON.call(node, true) as Attrs;
  const state = node.__state ? node.__state.toJSON() : undefined;
  if (state !== undefined) {
    for (const key in state) {
      delete json[key];
    }
  }
  return json;
}

const STRUCTURAL_JSON_KEYS = new Set([
  'type',
  'version',
  'children',
  '$slots',
  '$',
]);

/**
 * Attributes of a node stored as its own Y.Node (a 'node' block, an inline
 * decorator or element): the class's own exportJSON, which is complete by
 * contract, split per key.
 */
export function $nodeAttrs(node: LexicalNode): Attrs {
  const latest = node.getLatest();
  // Compact: properties at their default are left out (parsing restores
  // them); a hand-written exportJSON may ignore the flag, which is fine.
  const json = latest.exportJSON(true) as unknown as Attrs;
  const attrs: Attrs = {};
  for (const key in json) {
    if (!STRUCTURAL_JSON_KEYS.has(key)) {
      putValue(
        attrs,
        FIELD_PREFIX + key,
        json[key],
        `${node.getType()}.${key}`,
      );
    }
  }
  const state = json.$ as Attrs | undefined;
  if (state) {
    for (const k in state) {
      putValue(attrs, STATE_PREFIX + k, state[k], `NodeState ${k}`);
    }
  }
  // An element's textFormat/textStyle are always stored (see $lineAttrs).
  if ($isElementNode(latest)) {
    const tf = latest.getTextFormat();
    const ts = latest.getTextStyle();
    if (tf !== 0) {
      attrs[FIELD_PREFIX + 'textFormat'] = tf;
    } else {
      delete attrs[FIELD_PREFIX + 'textFormat'];
    }
    if (ts !== '') {
      attrs[FIELD_PREFIX + 'textStyle'] = ts;
    } else {
      delete attrs[FIELD_PREFIX + 'textStyle'];
    }
  }
  return attrs;
}

/** The serialized form of a node stored with {@link $nodeAttrs}. */
export function nodeJSONFromAttrs(type: string, attrs: Attrs): Attrs {
  const json: Attrs = {type, version: 1};
  const state: Attrs = {};
  let hasState = false;
  // Sorted, so that every reader builds NodeState in the same key order.
  for (const key of Object.keys(attrs).sort()) {
    if (key.startsWith(FIELD_PREFIX)) {
      const f = key.slice(FIELD_PREFIX.length);
      if (!isUnsafeKey(f)) {
        json[f] = attrs[key];
      }
    } else if (key.startsWith(STATE_PREFIX)) {
      const f = key.slice(STATE_PREFIX.length);
      if (!isUnsafeKey(f)) {
        state[f] = attrs[key];
        hasState = true;
      }
    }
  }
  if (hasState) {
    json.$ = state;
  }
  return json;
}

// ---------------------------------------------------------------------------
// Text

let formatNames: string[] | undefined;
const getFormatNames = (): string[] =>
  formatNames || (formatNames = Object.keys(TEXT_TYPE_TO_FORMAT));

/** Whether Lexical would merge this text node with an equal neighbour. */
export const isMergeableText = (node: TextNode): boolean =>
  node.isSimpleText() && !node.isUnmergeable();

/**
 * Formats of a text node's characters: its type (`t`, when not 'text'), one
 * key per format bit (`f:bold`), its other JSON fields (`p:style`, ...), its
 * NodeState (`s:<key>`), and for a node Lexical would not merge with an equal
 * neighbour, a segment key (`k`) that keeps it apart.
 */
export function $textAttrs(node: TextNode, segment: string | null): Attrs {
  const latest = node.getLatest();
  const json = latest.exportJSON(true) as unknown as Attrs;
  const attrs: Attrs = {};
  if (latest.getType() !== 'text') {
    attrs[TYPE_KEY] = latest.getType();
  }
  const format = latest.getFormat();
  if (format !== 0) {
    for (const name of getFormatNames()) {
      if (format & TEXT_TYPE_TO_FORMAT[name]) {
        attrs[TEXT_FORMAT_PREFIX + name] = true;
      }
    }
  }
  for (const key in json) {
    if (key !== 'text' && key !== 'format' && !STRUCTURAL_JSON_KEYS.has(key)) {
      putValue(attrs, FIELD_PREFIX + key, json[key], `text.${key}`);
    }
  }
  const state = json.$ as Attrs | undefined;
  if (state) {
    for (const k in state) {
      putValue(attrs, STATE_PREFIX + k, state[k], `NodeState ${k}`);
    }
  }
  if (segment !== null) {
    attrs[SEGMENT_KEY] = segment;
  }
  return encodeFormats(attrs);
}

export function textJSONFromAttrs(text: string, encoded: Attrs): Attrs {
  const attrs: Attrs = {};
  for (const k in encoded) {
    attrs[k] = decodeFormatValue(encoded[k]);
  }
  const type =
    typeof attrs[TYPE_KEY] === 'string' ? (attrs[TYPE_KEY] as string) : 'text';
  const json: Attrs = {text, type, version: 1};
  let format = 0;
  const state: Attrs = {};
  let hasState = false;
  for (const key of Object.keys(attrs).sort()) {
    if (key.startsWith(TEXT_FORMAT_PREFIX)) {
      const bit = TEXT_TYPE_TO_FORMAT[key.slice(TEXT_FORMAT_PREFIX.length)];
      if (bit && attrs[key] === true) {
        format |= bit;
      }
    } else if (key.startsWith(FIELD_PREFIX)) {
      const f = key.slice(FIELD_PREFIX.length);
      if (!isUnsafeKey(f)) {
        json[f] = attrs[key];
      }
    } else if (key.startsWith(STATE_PREFIX)) {
      const f = key.slice(STATE_PREFIX.length);
      if (!isUnsafeKey(f)) {
        state[f] = attrs[key];
        hasState = true;
      }
    }
  }
  json.format = format;
  if (hasState) {
    json.$ = state;
  }
  return json;
}

/** Text keys this binding owns (and so may change or remove). */
export function isOwnedTextKey(
  key: string,
  isKnownWrapper: (type: string) => boolean,
): boolean {
  if (key.startsWith(WRAPPER_PREFIX)) {
    return isKnownWrapper(key.slice(WRAPPER_PREFIX.length));
  }
  return (
    key === TYPE_KEY ||
    key === SEGMENT_KEY ||
    key.startsWith(TEXT_FORMAT_PREFIX) ||
    key.startsWith(FIELD_PREFIX) ||
    key.startsWith(STATE_PREFIX)
  );
}

// ---------------------------------------------------------------------------
// Wrappers

/**
 * The format of one wrapper: one key, `w:<type>`, whose value is a flat
 * object of its schema fields and NodeState (`s:<key>`); a value that is not
 * a primitive is a JSON string, since Yjs compares format values one level
 * deep. One key keeps a link at two format items: concurrent changes to two
 * fields of one wrapper do not merge (the last one wins).
 */
/**
 * The key of a wrapper value that tells apart two adjacent wrappers with
 * equal fields (two links to the same URL), which would otherwise read as
 * one.
 */
export const INSTANCE_KEY = '#';

export function $wrapperAttrs(
  node: ElementNode,
  out: Attrs,
  instance: string | null = null,
): void {
  const spec = getWrapperSpec(klassOf(node))!;
  const own: Attrs = {};
  const json = $schemaJSON(node.getLatest());
  for (const f of spec.fields) {
    putValue(own, f, json[f], `${node.getType()}.${f}`);
  }
  $stateAttrs(node.getLatest(), own);
  $putTextFields(node.getLatest(), own);
  for (const k in own) {
    const v = own[k];
    if (v !== null && typeof v === 'object') {
      own[k] = '\u0000' + stableStringify(v);
    }
  }
  if (instance !== null) {
    own[INSTANCE_KEY] = instance;
  }
  // The innermost wrapper of a type wins.
  out[WRAPPER_PREFIX + node.getType()] = own;
}

export type WrapperValue = {
  readonly type: string;
  readonly sig: string;
  readonly json: Attrs;
  readonly instance: string | null;
};

/** Wrapper values in a format map, sorted by type. */
export function wrappersFromAttrs(
  attrs: Attrs,
  isKnownWrapper: (type: string) => boolean,
): WrapperValue[] {
  const result: WrapperValue[] = [];
  for (const key in attrs) {
    if (!key.startsWith(WRAPPER_PREFIX)) {
      continue;
    }
    const type = key.slice(WRAPPER_PREFIX.length);
    const value = attrs[key];
    if (!isKnownWrapper(type) || value === null || typeof value !== 'object') {
      continue;
    }
    const json: Attrs = {type, version: 1};
    const state: Attrs = {};
    let hasState = false;
    let instance: string | null = null;
    for (const f of Object.keys(value as Attrs).sort()) {
      let v = (value as Attrs)[f];
      if (f === INSTANCE_KEY) {
        instance = typeof v === 'string' ? v : null;
        continue;
      }
      if (typeof v === 'string' && v.startsWith('\u0000')) {
        try {
          v = JSON.parse(v.slice(1));
        } catch (_e) {
          continue;
        }
      }
      if (f.startsWith(STATE_PREFIX)) {
        const k = f.slice(STATE_PREFIX.length);
        if (!isUnsafeKey(k)) {
          state[k] = v;
          hasState = true;
        }
      } else if (!isUnsafeKey(f)) {
        json[f] = v;
      }
    }
    if (hasState) {
      json.$ = state;
    }
    result.push({
      instance,
      json,
      sig:
        type +
        '\u0000' +
        stableStringify(json) +
        (instance === null ? '' : '\u0000' + instance),
      type,
    });
  }
  result.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return result;
}

// ---------------------------------------------------------------------------
// Lines

/** Fields of a line stored on its marker (schema minus derived). */
export function $lineAttrs(
  line: ElementNode,
  derived: ReadonlySet<string> | null,
): Attrs {
  const latest = line.getLatest();
  // The most common type is left out: a marker without one is a paragraph.
  const attrs: Attrs =
    latest.getType() === 'paragraph' ? {} : {[TYPE_KEY]: latest.getType()};
  const spec = getLineSpec(klassOf(latest))!;
  const json = $schemaJSON(latest);
  for (const f of spec.fields) {
    if (derived === null || !derived.has(f)) {
      putValue(attrs, FIELD_PREFIX + f, json[f], `${latest.getType()}.${f}`);
    }
  }
  // Lexical serializes an element's textFormat/textStyle only while it has
  // no text (otherwise a reconcile derives them from the text), but keeps
  // them: every peer must hold the same values, so they are always stored.
  if (
    spec.fields.has('textFormat') &&
    (derived === null || !derived.has('textFormat'))
  ) {
    const tf = latest.getTextFormat();
    if (tf !== 0) {
      attrs[FIELD_PREFIX + 'textFormat'] = tf;
    } else {
      delete attrs[FIELD_PREFIX + 'textFormat'];
    }
  }
  if (
    spec.fields.has('textStyle') &&
    (derived === null || !derived.has('textStyle'))
  ) {
    const ts = latest.getTextStyle();
    if (ts !== '') {
      attrs[FIELD_PREFIX + 'textStyle'] = ts;
    } else {
      delete attrs[FIELD_PREFIX + 'textStyle'];
    }
  }
  $stateAttrs(latest, attrs);
  return attrs;
}

/**
 * The synchronized fields of a group: its schema fields (key fields and the
 * others, such as alignment) except derived ones, and its NodeState under
 * `$`. Adjacent groups with different fields are different groups, so all of
 * them identify a group (an item carries its group's fields).
 */
/**
 * An element's textFormat/textStyle, which Lexical serializes only while
 * the element has no text: every peer must hold the same values, so groups
 * and wrapper items always carry them (as lines do).
 */
function $putTextFields(node: ElementNode, out: Attrs): void {
  const tf = node.getTextFormat();
  if (tf !== 0) {
    out.textFormat = tf;
  } else {
    delete out.textFormat;
  }
  const ts = node.getTextStyle();
  if (ts !== '') {
    out.textStyle = ts;
  } else {
    delete out.textStyle;
  }
}

/** Set the textFormat/textStyle a group or wrapper item's fields record. */
export function $setTextFields(node: ElementNode, fields: Attrs): void {
  const tf = typeof fields.textFormat === 'number' ? fields.textFormat : 0;
  if (node.getTextFormat() !== tf) {
    node.setTextFormat(tf);
  }
  const ts = typeof fields.textStyle === 'string' ? fields.textStyle : '';
  if (node.getTextStyle() !== ts) {
    node.setTextStyle(ts);
  }
}

export function $groupFields(group: ElementNode, spec: GroupSpec): Attrs {
  const latest = group.getLatest();
  const json = $schemaJSON(latest);
  const out: Attrs = {};
  for (const f of Object.keys(json).sort()) {
    if (
      STRUCTURAL_JSON_KEYS.has(f) ||
      spec.derived.has(f) ||
      toPlainJSON(json[f]) === undefined
    ) {
      continue;
    }
    out[f] = toPlainJSON(json[f]);
  }
  $putTextFields(latest, out);
  const st: Attrs = {};
  $stateAttrs(latest, st);
  const state: Attrs = {};
  for (const k of Object.keys(st).sort()) {
    state[k.slice(STATE_PREFIX.length)] = st[k];
  }
  if (Object.keys(state).length > 0) {
    out.$ = state;
  }
  return out;
}

/**
 * The key of the fields of a nested level's wrapper item (the item that
 * holds a nested group) inside an OUTER_KEY entry.
 */
export const WRAPPER_FIELDS_KEY = '@';

/** The synchronized fields of a nested level's wrapper item. */
export function $levelItemFields(item: ElementNode, spec: GroupSpec): Attrs {
  const latest = item.getLatest();
  const json = $schemaJSON(latest);
  const out: Attrs = {};
  for (const f of Object.keys(json).sort()) {
    if (
      STRUCTURAL_JSON_KEYS.has(f) ||
      spec.derived.has(f) ||
      toPlainJSON(json[f]) === undefined
    ) {
      continue;
    }
    out[f] = toPlainJSON(json[f]);
  }
  $putTextFields(latest, out);
  const st: Attrs = {};
  $stateAttrs(latest, st);
  if (Object.keys(st).length > 0) {
    const state: Attrs = {};
    for (const k of Object.keys(st).sort()) {
      state[k.slice(STATE_PREFIX.length)] = st[k];
    }
    out.$ = state;
  }
  return out;
}

export function $groupKeyAttrs(group: ElementNode, spec: GroupSpec): Attrs {
  const attrs: Attrs = {[GROUP_KEY]: group.getType()};
  const fields = $groupFields(group, spec);
  for (const f in fields) {
    attrs[GROUP_FIELD_PREFIX + f] = fields[f];
  }
  return attrs;
}

export type NodeKeySet = ReadonlySet<NodeKey>;
