/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Hidden} from './Hidden';

import {ContentType, type Doc, type Item, type Node as YNode} from '@y/y';
import {
  $getNodeByKey,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isRootNode,
  $isTextNode,
  type ElementNode,
  getDeclaredCollabConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
} from 'lexical';

import {type Formats} from './Cursor';
import {
  $isGroup,
  $isInlineChild,
  $isLine,
  $isWrapper,
  $nestedGroupOf,
  BLOCK_PREFIX,
  getGroupSpec,
  getLineSpec,
  type GroupSpec,
  klassOf,
  MARKER,
  RUN_END,
} from './Schema';

export type Kind = 'b' | 'i';

/** A shared container: the root, or a node stored as its own Y.Node. */
export type CS = {
  readonly y: YNode;
  key: NodeKey;
  kind: Kind;
  /** Units of a block container, in order. */
  units: Unit[];
};

export type UnitKind = 'line' | 'node' | 'run' | 'implicit';

/**
 * A unit of a block container: a line (inline content + marker), a node
 * (one child Y.Node), a run (inline content of the container itself, ended by
 * a run terminator) or an implicit line (inline content no marker ends, read
 * as a paragraph).
 */
export type Unit = {
  cs: CS;
  kind: UnitKind;
  /** The marker, run terminator or node item; null for an implicit line. */
  end: Item | null;
  /** The line or node key (null for a run). */
  key: NodeKey | null;
  /** First and last top-level Lexical children of the container it covers. */
  first: NodeKey | null;
  last: NodeKey | null;
  /** Group signature (group key attributes and level) of a group item. */
  sig: string;
  /** Formats in effect at the start of the unit (null: none). */
  start: Formats | null;
};

export type Role =
  | 'root'
  | 'container'
  | 'line'
  | 'group'
  | 'level'
  | 'wrapper'
  | 'leaf'
  | 'text';

export const EMPTY_FORMATS: Formats = new Map();

export function isEndItem(it: Item): boolean {
  if (!(it.content instanceof ContentType)) {
    return false;
  }
  const name = it.content.type.name;
  return (
    name === MARKER ||
    name === RUN_END ||
    (typeof name === 'string' && name.startsWith(BLOCK_PREFIX))
  );
}

/** The previous live end item before `it` in its container, or null. */
export function prevLiveEnd(it: Item | null): Item | null {
  for (let p = it === null ? null : it.left; p !== null; p = p.left) {
    if (!p.deleted && isEndItem(p)) {
      return p;
    }
  }
  return null;
}

export function nameOf(it: Item): string {
  return it.content instanceof ContentType
    ? ((it.content.type.name as string) ?? '')
    : '';
}

export function typeOf(it: Item): YNode {
  return (it.content as ContentType).type;
}

/** Mutable state shared by the read and write paths. */
export class State {
  readonly containers = new WeakMap<YNode, CS>();
  readonly csByKey = new Map<NodeKey, CS>();
  readonly unitByEnd = new Map<Item, Unit>();
  readonly unitByKey = new Map<NodeKey, Unit>();
  /** Stored nodes (b: and i:) by Lexical key, and back. */
  readonly yByKey = new Map<NodeKey, YNode>();
  readonly keyByY = new WeakMap<YNode, NodeKey>();
  /** Segment keys of text nodes Lexical would not merge. */
  readonly segments = new Map<NodeKey, string>();
  private segmentCounter = 0;
  /** Groups whose derived fields need a refresh. */
  readonly refresh = new Set<NodeKey>();
  /**
   * Node types found in the document that this editor does not register:
   * their content cannot be shown or rewritten, so the binding goes read
   * only rather than hide it and then delete it on the next edit.
   */
  readonly unknownTypes = new Set<string>();
  /** Remote content of the composing line not shown yet (see Hidden). */
  hidden: Hidden | null = null;
  constructor(
    readonly editor: LexicalEditor,
    readonly doc: Doc,
    readonly root: YNode,
  ) {}

  newSegment(key: NodeKey): string {
    const s =
      this.doc.clientID.toString(36) +
      '.' +
      (this.segmentCounter++).toString(36);
    this.segments.set(key, s);
    return s;
  }

  mapNode(key: NodeKey, y: YNode): void {
    this.yByKey.set(key, y);
    this.keyByY.set(y, key);
    const cs = this.containers.get(y);
    if (cs !== undefined) {
      cs.key = key;
      this.csByKey.set(key, cs);
    }
  }

  setUnit(unit: Unit): void {
    if (unit.end !== null) {
      this.unitByEnd.set(unit.end, unit);
    }
    if (
      unit.key !== null &&
      (unit.kind === 'line' || unit.kind === 'implicit')
    ) {
      this.unitByKey.set(unit.key, unit);
    }
  }

  dropUnit(unit: Unit): void {
    if (unit.end !== null && this.unitByEnd.get(unit.end) === unit) {
      this.unitByEnd.delete(unit.end);
    }
    if (unit.key !== null && this.unitByKey.get(unit.key) === unit) {
      this.unitByKey.delete(unit.key);
    }
  }

  newCS(y: YNode, key: NodeKey, kind: Kind): CS {
    const cs: CS = {key, kind, units: [], y};
    this.containers.set(y, cs);
    this.csByKey.set(key, cs);
    return cs;
  }

  clear(): void {
    this.csByKey.clear();
    this.unitByEnd.clear();
    this.unitByKey.clear();
    this.yByKey.clear();
    this.segments.clear();
    this.refresh.clear();
  }
}

// ---------------------------------------------------------------------------
// Roles (what each Lexical node is to the binding, in its context)

export class Roles {
  private readonly memo = new Map<NodeKey, Role>();
  private readonly kinds = new Map<NodeKey, Kind>();
  constructor(readonly state: State) {}

  $role(node: LexicalNode): Role {
    const key = node.getKey();
    let role = this.memo.get(key);
    if (role === undefined) {
      role = this.$compute(node);
      this.memo.set(key, role);
    }
    return role;
  }

  private $compute(node: LexicalNode): Role {
    if ($isRootNode(node)) {
      return 'root';
    }
    if ($isTextNode(node) || $isLineBreakNode(node)) {
      return 'text';
    }
    if (!$isElementNode(node) || $isDecoratorNode(node)) {
      return 'leaf';
    }
    if ($isWrapper(node)) {
      return 'wrapper';
    }
    const parent = node.getParent();
    if (parent === null) {
      return 'container';
    }
    const p = this.$role(parent);
    const blocksAllowed =
      p === 'root' ||
      p === 'group' ||
      p === 'level' ||
      (p === 'container' && this.$kind(parent) === 'b');
    if (blocksAllowed && $isLine(node)) {
      if (p === 'group') {
        const spec = getGroupSpec(klassOf(parent))!;
        if ($nestedGroupOf(node, spec) !== null) {
          return 'level';
        }
      }
      if (p !== 'level') {
        return 'line';
      }
    }
    if (blocksAllowed && p !== 'group' && $isGroup(node)) {
      return 'group';
    }
    return 'container';
  }

  /** Whether a container holds blocks ('b') or only inline content ('i'). */
  $kind(node: ElementNode): Kind {
    if ($isRootNode(node)) {
      return 'b';
    }
    const key = node.getKey();
    let kind = this.kinds.get(key);
    if (kind === undefined) {
      kind = $containerKind(node, this.state.csByKey.get(key));
      this.kinds.set(key, kind);
    }
    return kind;
  }

  /** The container (root or stored node) a line, group or level is in. */
  $containerOf(node: LexicalNode): ElementNode {
    let p: ElementNode | null = node.getParent();
    while (p !== null) {
      const r = this.$role(p);
      if (r === 'root' || r === 'container') {
        return p;
      }
      p = p.getParent() as ElementNode | null;
    }
    throw new Error('@lexical/y: node is not attached');
  }
}

/**
 * What a container holds, fixed when it is created and recorded in the
 * document ('c'): blocks ('b': lines, nodes and terminated inline runs) or
 * inline content ('i'). A block container that later gets inline children
 * stores them as runs; an inline container that gets a block child stores it
 * as an inline node. So the kind never changes, and every reader, fresh ones
 * included, reads leftover inline content of a block container as a line.
 */
export function $containerKind(node: ElementNode, cs: CS | undefined): Kind {
  if (cs !== undefined) {
    return cs.kind;
  }
  if ($isRootNode(node)) {
    return 'b';
  }
  const declared = getDeclaredCollabConfig(klassOf(node)).content;
  if (declared !== undefined) {
    return declared === 'inline' ? 'i' : 'b';
  }
  if (node.isShadowRoot()) {
    return 'b';
  }
  // A line class stored as its own node (inside another line) holds inline
  // content even while it is empty: storage follows the class.
  if (getLineSpec(klassOf(node)) !== null) {
    return 'i';
  }
  const first = node.getFirstChild();
  if (first === null) {
    return 'b';
  }
  for (let c: LexicalNode | null = first; c !== null; c = c.getNextSibling()) {
    if (!$isInlineChild(c)) {
      return 'b';
    }
  }
  return 'i';
}

export function $nodeOf(key: NodeKey | null): LexicalNode | null {
  return key === null ? null : $getNodeByKey(key);
}

export type {GroupSpec};
