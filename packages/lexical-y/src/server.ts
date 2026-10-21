/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  ContentType,
  decodeUpdate,
  type Doc,
  findRootTypeKey,
  Item,
  Node as YNode,
} from '@y/y';

import {DEFAULT_ROOT_NAME, NOTICE_KEY} from './internal/constants';

export {DEFAULT_ROOT_NAME, LAYOUT_VERSION} from './internal/constants';

type ID = {client: number; clock: number};

export type UpdateRoots = {
  /** Root names the update writes to (inserts and deletes). */
  roots: Set<string>;
  /**
   * Structs and deleted ranges whose root could not be resolved: their
   * parent is neither in the update nor in `doc`.
   */
  unresolved: number;
};

/** Structs of one client, sorted by clock, for binary search. */
function findStruct<T extends {id: ID; length: number}>(
  list: T[],
  clock: number,
): T | null {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = list[mid];
    if (clock < s.id.clock) {
      hi = mid - 1;
    } else if (clock >= s.id.clock + s.length) {
      lo = mid + 1;
    } else {
      return s;
    }
  }
  return null;
}

/**
 * @experimental Transport-agnostic server helper: the shared roots an
 * incoming Yjs update writes to (inserts and deletions). Pass the server's
 * copy of the document to resolve items nested in types, and deleted ranges,
 * that the update does not contain. Linear in the update size (each struct's
 * root is resolved once, lookups are binary searches).
 */
export function inspectUpdateRoots(update: Uint8Array, doc?: Doc): UpdateRoots {
  const {structs, ds} = decodeUpdate(update);
  const byClient = new Map<number, Item[]>();
  for (const s of structs) {
    if (s instanceof Item) {
      let list = byClient.get(s.id.client);
      if (list === undefined) {
        list = [];
        byClient.set(s.id.client, list);
      }
      list.push(s);
    }
  }
  for (const list of byClient.values()) {
    list.sort((a, b) => a.id.clock - b.id.clock);
  }
  const fromDoc = (id: ID): Item | null => {
    if (doc === undefined || doc.store.getClock(id.client) <= id.clock) {
      return null;
    }
    const s = doc.store.getItem(id as never);
    return s instanceof Item ? s : null;
  };
  const lookup = (id: ID): Item | null => {
    const list = byClient.get(id.client);
    const s = list === undefined ? null : findStruct(list, id.clock);
    return s !== null ? s : fromDoc(id);
  };
  // Root of every item resolved so far (null: unresolvable).
  const memo = new Map<Item, string | null>();
  const resolve = (start: Item): string | null => {
    // Follow parents (or, for an item encoded without its parent, its
    // origin) iteratively until something resolves, then record the result
    // for every item on the way.
    const chain: Item[] = [];
    let root: string | null = null;
    let item: Item | null = start;
    const seen = new Set<Item>();
    while (item !== null) {
      const known = memo.get(item);
      if (known !== undefined) {
        root = known;
        break;
      }
      if (seen.has(item)) {
        break;
      }
      seen.add(item);
      chain.push(item);
      const parent = item.parent as unknown;
      if (typeof parent === 'string') {
        root = parent;
        break;
      }
      if (parent instanceof YNode) {
        root = rootOfType(parent);
        break;
      }
      if (parent !== null && typeof parent === 'object') {
        const p = lookup(parent as ID);
        if (
          p !== null &&
          p.content instanceof ContentType &&
          p.content.type.doc !== null
        ) {
          root = rootOfType(p.content.type);
          break;
        }
        item = p;
        continue;
      }
      const neighbour = item.origin || item.rightOrigin;
      item = neighbour === null ? null : lookup(neighbour);
    }
    for (const c of chain) {
      memo.set(c, root);
    }
    return root;
  };
  const roots = new Set<string>();
  let unresolved = 0;
  for (const list of byClient.values()) {
    for (const it of list) {
      const root = resolve(it);
      if (root === null) {
        unresolved++;
      } else {
        roots.add(root);
      }
    }
  }
  // Deletions: the deleted structs live in the update or in the doc.
  ds.clients.forEach((ranges, client) => {
    for (const range of ranges.getIds()) {
      let clock = range.clock;
      const end = range.clock + range.len;
      while (clock < end) {
        const it = lookup({client, clock});
        if (it === null) {
          unresolved++;
          break;
        }
        const root = resolve(it);
        if (root === null) {
          unresolved++;
        } else {
          roots.add(root);
        }
        clock = it.id.clock + it.length;
      }
    }
  });
  return {roots, unresolved};
}

function rootOfType(type: YNode): string | null {
  let t: YNode = type;
  while (t.parent !== null) {
    t = t.parent;
  }
  try {
    return findRootTypeKey(t);
  } catch (_e) {
    return null;
  }
}

/**
 * @experimental Whether an update writes only to the layout root (and so
 * comes from an upgraded client). A server can reject other updates, for
 * example in a y-websocket or Hocuspocus hook. Pass the server's document
 * so that updates nested in existing types and deletions resolve.
 */
export function isUpdateForLayout(
  update: Uint8Array,
  options: {root?: string; doc?: Doc} = {},
): boolean {
  const root = options.root || DEFAULT_ROOT_NAME;
  const {roots, unresolved} = inspectUpdateRoots(update, options.doc);
  return unresolved === 0 && [...roots].every(r => r === root);
}

// Yjs 13 type refs of the old layouts' roots and children.
const XML_TEXT_REF = 6;

/**
 * @experimental Write a notice into an old layout's root (the Yjs 13
 * bindings' 'root-v2' XmlFragment, or the v1 'root' XmlText) so that a tab
 * still running an old client shows it instead of an empty document. The
 * notice is also recorded in an attribute of the layout root
 * (`lexical-y:notice`), so that initializing the layout root next to it is
 * not refused.
 */
export function writeUpgradeNotice(
  doc: Doc,
  message = 'This document was upgraded. Please reload the page.',
  oldRoot: 'root-v2' | 'root' = 'root-v2',
  options: {root?: string} = {},
): void {
  const root = doc.get(oldRoot);
  const layoutRoot = doc.get(options.root || DEFAULT_ROOT_NAME);
  doc.transact(() => {
    const clock = doc.store.getClock(doc.clientID);
    let len = 1;
    if (oldRoot === 'root-v2') {
      const paragraph = new YNode('paragraph');
      root.insert(root.length, [paragraph]);
      const text = new YNode(null);
      // A Yjs 13 XmlText, so that an old client reads the paragraph's text.
      text._legacyTypeRef = XML_TEXT_REF;
      paragraph.insert(0, [text]);
      text.insert(0, message);
    } else {
      root.insert(root.length, message);
      len = message.length;
    }
    // Recorded so that initializing the layout root is not refused because
    // of the notice (see YBinding#initialize).
    const notices = layoutRoot.getAttr(NOTICE_KEY);
    layoutRoot.setAttr(NOTICE_KEY, [
      ...(Array.isArray(notices) ? notices : []),
      {client: doc.clientID, clock, len, root: oldRoot},
    ]);
  });
}
