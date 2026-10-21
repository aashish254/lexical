/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  ContentType,
  createRelativePositionFromJSON,
  Doc,
  encodeStateAsUpdate,
  Item,
  iterateStructsByIdSet,
  Node as YNode,
  RelativePosition,
  relativePositionToJSON,
  type Transaction,
  UndoManager,
} from '@y/y';
import {
  $createRangeSelection,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COLLABORATION_TAG,
  type EditorState,
  type ElementNode,
  HISTORY_MERGE_TAG,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type PointType,
  type RangeSelection,
  SKIP_COLLAB_TAG,
} from 'lexical';

import {type ClientIDRange, constrainClientID} from './ClientID';
import {DEFAULT_ROOT_NAME, LEGACY_ROOTS, NOTICE_KEY} from './constants';
import {Hidden, shownLength} from './Hidden';
import {isDeleted, Reader} from './Read';
import {
  findListMerges,
  PAD_KEY,
  type Repair,
  REPAIR_VERSION,
  tableRepair,
  tablesOf,
} from './Repair';
import {
  $groupFields,
  $isWrapper,
  FIELD_PREFIX,
  getContainerGroupSpec,
  getGroupSpec,
  klassOf,
  LAYOUT_KEY,
  LAYOUT_VERSION,
  MARKER,
  RUN_END,
  stableStringify,
} from './Schema';
import {$checkWrite, checkContainer} from './SelfCheck';
import {
  type CS,
  isEndItem,
  nameOf,
  prevLiveEnd,
  Roles,
  State,
  typeOf,
} from './State';
import {type WritePlan, Writer} from './Write';

export {DEFAULT_ROOT_NAME};

const REFRESH_TAG = 'lexical-y-refresh';
const REPAIR_TAG = 'lexical-y-repair';

export type YBindingStatus =
  /** Waiting for the first sync: nothing is written. */
  | 'pending'
  /** Reading and writing. */
  | 'active'
  /** The document uses a layout this version cannot write: read only. */
  | 'readonly';

export interface YBindingOptions {
  /** The shared root to bind; defaults to `doc.get('lexical-y')`. */
  root?: YNode;
  /** Undo capture timeout in ms (default 500); null disables undo. */
  captureTimeout?: number | null;
  /** Called with warnings (newer layout, foreign content). */
  onWarn?: (message: string) => void;
  /** Called when `status` changes. */
  onStatus?: (status: YBindingStatus) => void;
  /**
   * Read every line a local write touched back from Yjs and compare it with
   * the editor; mismatches are reported through the editor's onWarn.
   * Structural changes (and remote changes) also compare a fresh read of
   * the whole container: every time for containers of up to 256 lines and
   * nodes, and with probability 256 / size for bigger ones, so the expected
   * cost of an edit stays bounded. Default: on in development, off in production.
   */
  selfCheck?: boolean;
  /** Fraction of local writes the self-check samples (default 1). */
  selfCheckSample?: number;
  /**
   * Initialize even when an older layout's root has content: for a
   * converter writing the layout root of an existing document.
   */
  convert?: boolean;
  /**
   * The range of the document's client ids: `'uint53'` (default, Yjs 14's
   * ids, left as they are) or `'uint32'` (kept in 32 bits, for servers on
   * yrs before 0.28; see {@link ClientIDRange}).
   */
  clientIDRange?: ClientIDRange;
}

export interface YCursor {
  anchor: unknown;
  focus: unknown;
}

/**
 * @experimental A Yjs 14 binding for one editor and one shared root.
 *
 * Every container (the root, and every node stored as its own Y.Node) holds
 * one sequence of text, child nodes and line markers; see the package README
 * for the layout.
 */
export class YBinding {
  readonly editor: LexicalEditor;
  readonly doc: Doc;
  readonly root: YNode;
  status: YBindingStatus = 'pending';
  undoManager: UndoManager | null = null;
  private state: State;
  private readonly options: YBindingOptions;
  private disposers: (() => void)[] = [];
  /** Origin of the initialization transaction (not tracked by undo). */
  private readonly initOrigin = {binding: this};
  /** Origin of repairs of remote changes (not tracked by undo). */
  private readonly repairOrigin = {binding: this, repair: true};
  /** Repairs written from the shared content: read back like remote changes. */
  private readonly sharedRepairOrigin = {binding: this, sharedRepair: true};
  private readonly repairQueue = new Set<YNode>();
  private repairing = false;
  /** Origin of read-only scans (no changes). */
  private readonly scanOrigin = {binding: this, scan: true};
  /** Stored nodes the running undo/redo restores (see isKeptByUndo). */
  private restoring: Set<string> | null = null;
  /** Stored nodes the running undo/redo deletes (it inserted them). */
  private removing: Set<Item> | null = null;
  private wasEditable = true;
  private undoCache = new WeakMap<YNode, Set<number>>();
  private readonly afterTransaction: (tr: Transaction) => void;
  private readonly beforeTransaction: (tr: Transaction) => void;
  private readonly beforeObserverCalls = (tr: Transaction): void => {
    tr.changed.forEach((_subs, type) => {
      if (this.state.containers.has(type)) {
        type._hasFormatting = false;
      }
    });
  };
  /** The local selection before the remote transaction being applied. */
  private pendingCursor: YCursor | null = null;
  /** Node transforms the binding registers (not run by flushRefresh). */
  private readonly ownTransforms = new Set<(node: LexicalNode) => void>();

  constructor(editor: LexicalEditor, doc: Doc, options: YBindingOptions = {}) {
    this.editor = editor;
    this.doc = doc;
    this.options = options;
    this.root = options.root || doc.get(DEFAULT_ROOT_NAME);
    this.state = new State(editor, doc, this.root);
    this.afterTransaction = tr => this.onAfterTransaction(tr);
    this.beforeTransaction = tr => {
      this.pendingCursor =
        this.status !== 'pending' &&
        tr.origin !== this &&
        tr.origin !== this.initOrigin &&
        tr.origin !== this.repairOrigin &&
        tr.origin !== this.sharedRepairOrigin
          ? this.getCursor()
          : null;
    };
  }

  /** Start listening; read the document if it is already initialized. */
  start(): () => void {
    if (this.options.clientIDRange === 'uint32') {
      this.disposers.push(constrainClientID(this.doc));
    }
    // Lexical records explicit node moves (read by the writer, which then
    // rewrites what moved rather than what it passed).
    const recordedMoves = this.editor._recordNodeMoves;
    this.editor._recordNodeMoves = true;
    this.disposers.push(() => {
      this.editor._recordNodeMoves = recordedMoves;
    });
    // Fail closed: not editable until the layout record has been read.
    this.wasEditable = this.editor.isEditable();
    this.editor.setEditable(false);
    // Yjs cleans up formats after a remote transaction by rescanning every
    // type that has formats (whole containers here, so O(document) per remote
    // bold). The binding writes no redundant formats itself (the writer
    // cleans its own gaps), so its containers opt out: they are marked as
    // having no formats before Yjs decides whether to clean up. The
    // document's flag and the app's other types are left alone.
    this.doc.on('beforeObserverCalls', this.beforeObserverCalls);
    this.disposers.push(() =>
      this.doc.off('beforeObserverCalls', this.beforeObserverCalls),
    );
    this.doc.on('beforeTransaction', this.beforeTransaction);
    this.disposers.push(() =>
      this.doc.off('beforeTransaction', this.beforeTransaction),
    );
    this.doc.on('afterTransaction', this.afterTransaction);
    this.disposers.push(() =>
      this.doc.off('afterTransaction', this.afterTransaction),
    );
    this.disposers.push(
      this.editor.registerUpdateListener(payload => {
        this.onUpdate(payload);
        if (
          this.state.hidden !== null &&
          this.editor._compositionKey === null
        ) {
          this.flushHidden();
        }
        // Repairs held back while composing (or behind a pending update).
        if (this.repairQueue.size > 0 && !this.repairing) {
          this.runRepairs([]);
        }
      }),
    );
    const canonicalize = (node: LexicalNode) =>
      $canonicalizeGroup(node as ElementNode);
    this.ownTransforms.add(canonicalize);
    for (const {klass} of this.editor._nodes.values()) {
      const spec = getGroupSpec(klass);
      if (spec !== null && spec.klass === klass) {
        this.disposers.push(
          this.editor.registerNodeTransform(klass, canonicalize),
        );
      }
    }
    if (this.options.captureTimeout !== null) {
      const um = new UndoManager(this.root, {
        captureTimeout: this.options.captureTimeout ?? 500,
        deleteFilter: item => !this.isKeptByUndo(item),
        trackedOrigins: new Set([this]),
      });
      this.undoManager = um;
      this.disposers.push(() => um.destroy());
    }
    this.evaluate();
    return () => this.dispose();
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) {
      d();
    }
    // A pending or read-only binding made the editor non-editable: give it
    // back as it was before the binding.
    if (this.status !== 'active') {
      this.editor.setEditable(this.wasEditable);
    }
    this.state.clear();
    this.undoManager = null;
  }

  /**
   * Call after the provider's first sync. An empty root is marked with this
   * layout and gets the editor's current content, unless an older layout's
   * root (`root`, `root-v2`) has content other than an upgrade notice: such a
   * document must be converted (`writeEditorToYDoc`) instead. Anything else
   * is read.
   *
   * The initial content is written with a client id derived from the layout
   * version and the content itself, so that two clients initializing the same
   * document with the same content at once write the same items (one copy),
   * and is not part of the undo history.
   */
  initialize(): void {
    if (this.status !== 'pending') {
      return;
    }
    if (this.root.length === 0 && this.root.getAttr(LAYOUT_KEY) === undefined) {
      const legacy = this.options.convert ? [] : this.legacyRootsWithContent();
      if (legacy.length > 0) {
        this.warn(
          `@lexical/y: the document has content in ${legacy.join(', ')} (an older layout); convert it to this layout instead of initializing it.`,
        );
        this.setStatus('readonly');
        return;
      }
      const editorState = this.editor.getEditorState();
      const realClientID = this.doc.clientID;
      this.doc.clientID = this.initClientIDFor(editorState);
      try {
        this.doc.transact(tr => {
          this.$writeInitial(this.state, this.root, tr, editorState);
        }, this.initOrigin);
      } finally {
        this.doc.clientID = realClientID;
      }
      this.setStatus('active');
      return;
    }
    this.evaluate();
  }

  /** Write the layout record and the editor's content into an empty root. */
  private $writeInitial(
    state: State,
    root: YNode,
    tr: Transaction,
    editorState: EditorState,
  ): void {
    root.setAttr(LAYOUT_KEY, LAYOUT_VERSION);
    editorState.read(() => {
      const roles = new Roles(state);
      const cs = state.newCS(root, 'root', 'b');
      const writer = new Writer(state, roles, tr, editorState, {
        attrs: new Set(),
        inline: new Set(),
        lines: new Set(),
        removedText: new Map(),
        structural: new Set(['root']),
      });
      writer.$writeContainer(cs, $getRoot());
    });
  }

  /**
   * The init transaction's client id: a hash of which shared type is being
   * initialized (its top-level name, or its item id when nested) and of the
   * exact items the initialization writes (encoded from a scratch document
   * with a fixed client id), so two clients share an id only when they would
   * write the same items into the same type.
   */
  private initClientIDFor(editorState: EditorState): number {
    let target: string;
    const item = this.root._item;
    if (item !== null) {
      target = `i:${item.id.client}:${item.id.clock}`;
    } else {
      target = 'r:';
      this.doc.share.forEach((type, name) => {
        if (type === this.root) {
          target = 'r:' + name;
        }
      });
    }
    const scratch = new Doc({gc: false});
    scratch.clientID = 1;
    const sroot = scratch.get('init');
    const sstate = new State(this.editor, scratch, sroot);
    scratch.transact(tr => this.$writeInitial(sstate, sroot, tr, editorState));
    const bytes = encodeStateAsUpdate(scratch);
    scratch.destroy();
    let content = '';
    for (let i = 0; i < bytes.length; i += 4096) {
      content += String.fromCharCode.apply(
        null,
        Array.from(bytes.subarray(i, i + 4096)),
      );
    }
    return initClientID(
      LAYOUT_VERSION + '\u0000' + target + '\u0000' + content,
    );
  }

  /** Older layouts' roots holding content other than upgrade notices. */
  private legacyRootsWithContent(): string[] {
    const notices = this.root.getAttr(NOTICE_KEY);
    const isNotice = (name: string, it: Item): boolean =>
      Array.isArray(notices) &&
      notices.some(
        n =>
          n !== null &&
          typeof n === 'object' &&
          n.root === name &&
          n.client === it.id.client &&
          n.clock <= it.id.clock &&
          it.id.clock < n.clock + n.len,
      );
    const out: string[] = [];
    for (const name of LEGACY_ROOTS) {
      const type = this.doc.share.get(name);
      if (type === undefined) {
        continue;
      }
      let content = type._map.size > 0;
      for (let it = type._start; it !== null && !content; it = it.right) {
        if (!it.deleted && !isNotice(name, it)) {
          content = true;
        }
      }
      if (content) {
        out.push(name);
      }
    }
    return out;
  }

  private evaluate(): void {
    const version = this.root.getAttr(LAYOUT_KEY);
    if (version === undefined) {
      if (this.root.length > 0) {
        this.warn(
          '@lexical/y: the shared root has content but no layout version; it is read only.',
        );
        this.setStatus('readonly');
        this.readAll();
      }
      return;
    }
    if (
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version < 1 ||
      version > LAYOUT_VERSION
    ) {
      this.warn(
        `@lexical/y: the document uses layout ${String(version)}, not one this version supports (1 to ${LAYOUT_VERSION}); it is read only.`,
      );
      this.setStatus('readonly');
    } else {
      this.setStatus('active');
    }
    this.readAll();
  }

  /** Self-check of containers a remote change rebuilt (see checkContainer). */
  private checkRead(rebuilt: ReadonlySet<CS>): void {
    const check =
      this.options.selfCheck ?? process.env.NODE_ENV !== 'production';
    if (
      !check ||
      rebuilt.size === 0 ||
      Math.random() >= (this.options.selfCheckSample ?? 1)
    ) {
      return;
    }
    const editorState = this.editor.getEditorState();
    const problems: string[] = [];
    const wrong: CS[] = [];
    for (const cs of rebuilt) {
      if (sampleWholeContainer(cs)) {
        const found = checkContainer(this.state, cs, editorState);
        if (found.length > 0) {
          problems.push(...found);
          wrong.push(cs);
        }
      }
    }
    if (problems.length > 0) {
      this.editor._onWarn(
        new Error(
          '@lexical/y self-check (remote): ' + problems.slice(0, 5).join('; '),
        ),
      );
      // After a remote change the shared content is right and the editor is
      // wrong (a reader bug): read those containers again in full, which
      // moves this client to what every fresh reader shows.
      this.rereadContainers(wrong);
    }
  }

  private rereadContainers(list: CS[]): void {
    let error: unknown = null;
    this.editor.update(
      () => {
        try {
          const reader = new Reader(this.state);
          for (const cs of list) {
            const el = cs.y === this.root ? $getRoot() : $getNodeByKey(cs.key);
            if ($isElementNode(el) && el.isAttached()) {
              reader.$readFull(cs, el);
            }
          }
        } catch (e) {
          error = e;
        }
      },
      {
        discrete: true,
        skipTransforms: true,
        tag: [COLLABORATION_TAG, HISTORY_MERGE_TAG],
      },
    );
    if (error !== null) {
      this.recoverRead(error);
    }
  }

  /** Fail closed when a read found node types this editor lacks. */
  private checkUnknownTypes(): void {
    const unknown = this.state.unknownTypes;
    if (unknown.size > 0 && this.status === 'active') {
      this.warn(
        `@lexical/y: the document has node types this editor does not register (${[
          ...unknown,
        ]
          .sort()
          .join(
            ', ',
          )}); it is read only, so that content is not hidden and then deleted.`,
      );
      this.setStatus('readonly');
    }
  }

  private setStatus(status: YBindingStatus): void {
    const changed = this.status !== status;
    this.status = status;
    if (changed && this.options.onStatus) {
      this.options.onStatus(status);
    }
    this.editor.setEditable(status === 'active' && this.wasEditable);
  }

  private warn(message: string): void {
    if (this.options.onWarn) {
      this.options.onWarn(message);
    } else if (process.env.NODE_ENV !== 'production') {
      console.warn(message);
    }
  }

  private readAll(): void {
    this.editor.update(
      () => {
        const reader = new Reader(this.state);
        let cs = this.state.containers.get(this.root);
        if (cs === undefined) {
          cs = this.state.newCS(this.root, 'root', 'b');
        }
        reader.$readFull(cs, $getRoot());
        $setSelection(null);
      },
      {
        discrete: true,
        skipTransforms: true,
        tag: [COLLABORATION_TAG, HISTORY_MERGE_TAG],
      },
    );
    this.checkUnknownTypes();
    this.flushRefresh();
  }

  // -------------------------------------------------------------------------
  // Remote -> Lexical

  private onAfterTransaction(tr: Transaction): void {
    if (
      tr.origin === this ||
      tr.origin === this.initOrigin ||
      tr.origin === this.repairOrigin ||
      tr.origin === this.scanOrigin
    ) {
      return;
    }
    if (this.status === 'pending') {
      if (this.root.getAttr(LAYOUT_KEY) !== undefined) {
        this.evaluate();
      }
      return;
    }
    const state = this.state;
    const childItems = new Map<YNode, Item[]>();
    const add = (s: unknown) => {
      if (
        s instanceof Item &&
        s.parentSub === null &&
        s.parent instanceof YNode
      ) {
        if (!state.containers.has(s.parent)) {
          return;
        }
        let list = childItems.get(s.parent);
        if (list === undefined) {
          list = [];
          childItems.set(s.parent, list);
        }
        list.push(s);
      }
    };
    iterateStructsByIdSet(tr, tr.insertSet, add);
    iterateStructsByIdSet(tr, tr.deleteSet, add);
    const attrKeys = new Map<YNode, Set<string>>();
    tr.changed.forEach((subs, type) => {
      const keys = new Set<string>();
      subs.forEach(k => {
        if (k !== null) {
          keys.add(k);
        }
      });
      if (keys.size === 0) {
        return;
      }
      if (type === this.root) {
        if (keys.has(LAYOUT_KEY)) {
          this.evaluate();
        }
        return;
      }
      const isOurs =
        state.keyByY.has(type) ||
        (type.name === MARKER &&
          type._item !== null &&
          state.unitByEnd.has(type._item));
      if (isOurs) {
        attrKeys.set(type, keys);
      }
    });
    if (childItems.size === 0 && attrKeys.size === 0) {
      return;
    }
    // A local update still pending (an editor.update() in the same task,
    // e.g. from an app's observer of another shared type) is committed and
    // written first: the remote read must not absorb it untagged-as-local.
    if (this.editor._pendingEditorState !== null) {
      this.editor.update(() => {}, {discrete: true});
    }
    const cursor = this.pendingCursor;
    this.pendingCursor = null;
    const changedKeys: NodeKey[] = [];
    let rebuilt: ReadonlySet<CS> = new Set();
    let readError: unknown = null;
    this.editor.update(
      () => {
        try {
          this.$readRemote(
            state,
            childItems,
            attrKeys,
            cursor,
            changedKeys,
            r => {
              rebuilt = r;
            },
          );
        } catch (e) {
          readError = e;
        }
      },
      {
        discrete: true,
        skipTransforms: true,
        tag: [COLLABORATION_TAG, HISTORY_MERGE_TAG],
      },
    );
    if (readError !== null) {
      this.recoverRead(readError);
      return;
    }
    this.checkUnknownTypes();
    this.checkRead(rebuilt);
    this.flushRefresh();
    if (childItems.size > 0) {
      this.runRepairs([...childItems.keys()]);
    }
  }

  private $readRemote(
    state: State,
    childItems: Map<YNode, Item[]>,
    attrKeys: Map<YNode, Set<string>>,
    cursor: YCursor | null,
    changedKeys: NodeKey[],
    setRebuilt: (rebuilt: ReadonlySet<CS>) => void,
  ): void {
    const reader = new Reader(state);
    setRebuilt(reader.rebuilt);
    const composing = this.$composingOwner();
    reader.composingKey = composing;
    reader.$apply(childItems, attrKeys);
    // Remote inserts into the line being composed are shown when the
    // composition ends (see Hidden).
    let hidden = state.hidden;
    if (
      hidden !== null &&
      (reader.composingRead || hidden.ownerKey !== composing)
    ) {
      if (!reader.composingRead) {
        state.hidden = null;
        reader.$refreshComposed(hidden.ownerKey);
      }
      hidden = null;
    }
    if (!reader.composingRead && reader.deferred.length > 0) {
      if (hidden === null) {
        hidden = new Hidden(composing!);
      }
      for (const it of reader.deferred) {
        hidden.add(it.id.client, it.id.clock, it.length);
      }
    }
    state.hidden = hidden;
    if (cursor !== null) {
      this.$restoreSelection(cursor);
    }
    $clampSelection();
    for (const y of childItems.keys()) {
      const key = state.keyByY.get(y);
      if (key !== undefined) {
        changedKeys.push(key);
      }
    }
  }

  /**
   * A remote read that throws (a reader bug) must not leave this client
   * showing something else than the document for good: the editor is
   * rebuilt from the shared content (a fresh reader's result, which every
   * client converges on) in a fresh update, and the failure is reported.
   */
  private recoverRead(error: unknown): void {
    this.warn(
      `@lexical/y: a remote change could not be read and the editor was rebuilt from the document: ${String(
        error instanceof Error ? error.message : error,
      )}`,
    );
    try {
      this.rebuildFromDocument();
    } catch (e) {
      this.editor._onError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** Replace the editor's content with a fresh read of the shared root. */
  private rebuildFromDocument(): void {
    this.state = new State(this.editor, this.doc, this.root);
    let error: unknown = null;
    this.editor.update(
      () => {
        try {
          const root = $getRoot();
          root.clear();
          const reader = new Reader(this.state);
          const cs = this.state.newCS(this.root, 'root', 'b');
          reader.$readFull(cs, root);
          $setSelection(null);
        } catch (e) {
          error = e;
        }
      },
      {
        discrete: true,
        skipTransforms: true,
        tag: [COLLABORATION_TAG, HISTORY_MERGE_TAG],
      },
    );
    if (error !== null) {
      throw error;
    }
    this.checkUnknownTypes();
    this.flushRefresh();
  }

  /**
   * The line or inline container holding the node being composed (IME), if
   * the binding stores it as one.
   */
  private $composingOwner(): NodeKey | null {
    const key = this.editor._compositionKey;
    const node = key === null ? null : $getNodeByKey(key);
    if (node === null || !node.isAttached()) {
      return null;
    }
    const owner = $isTextNode(node) ? $ownerOf(node) : null;
    if (owner === null) {
      return null;
    }
    const ownerKey = owner.getKey();
    const unit = this.state.unitByKey.get(ownerKey);
    if (unit !== undefined && unit.kind === 'line') {
      return ownerKey;
    }
    const cs = this.state.csByKey.get(ownerKey);
    return cs !== undefined && cs.kind === 'i' ? ownerKey : null;
  }

  /** Show the remote content hidden during a composition that has ended. */
  private flushHidden(): void {
    const hidden = this.state.hidden;
    if (hidden === null) {
      return;
    }
    const cursor = this.getCursor();
    this.state.hidden = null;
    this.editor.update(
      () => {
        new Reader(this.state).$refreshComposed(hidden.ownerKey);
        if (cursor !== null) {
          this.$restoreSelection(cursor);
        }
      },
      {
        discrete: true,
        skipTransforms: true,
        tag: [COLLABORATION_TAG, HISTORY_MERGE_TAG],
      },
    );
  }

  /**
   * Repair shapes concurrent edits left in the containers a remote change
   * touched (see Repair): one repair at a time, each a pure function of the
   * shared content, written under a client id derived from its inputs and
   * output, so every client that sees the shape writes the same items. Not
   * while the local editor is composing or has a pending update (queued until
   * then). Repairs are not part of the undo history.
   */
  private runRepairs(changed: Iterable<YNode>): void {
    for (const y of changed) {
      this.repairQueue.add(y);
    }
    if (
      this.repairing ||
      this.status !== 'active' ||
      this.editor._compositionKey !== null ||
      this.editor._pendingEditorState !== null ||
      this.state.hidden !== null
    ) {
      return;
    }
    this.repairing = true;
    try {
      for (let guard = 0; this.repairQueue.size > 0 && guard < 256; guard++) {
        const ys = [...this.repairQueue].filter(y => !isDeleted(y));
        this.repairQueue.clear();
        const repair = this.nextRepair(ys);
        if (repair === null) {
          continue;
        }
        // Look at the same containers again after this repair.
        for (const y of ys) {
          this.repairQueue.add(y);
        }
        this.applyRepair(repair);
      }
    } finally {
      this.repairing = false;
      this.repairQueue.clear();
    }
  }

  private nextRepair(ys: YNode[]): Repair | null {
    for (const table of tablesOf(ys)) {
      if (!isDeleted(table)) {
        const repair = tableRepair(table);
        if (repair !== null) {
          return repair;
        }
      }
    }
    const nodes = this.editor._nodes;
    const keyOf = (node: YNode): string | null => {
      const name = String(node.name ?? '');
      const info = nodes.get(name.slice(2));
      const spec =
        info === undefined ? null : getContainerGroupSpec(info.klass);
      if (spec === null) {
        return null;
      }
      const f = spec.key[0];
      return f === undefined
        ? ''
        : stableStringify(node.getAttr(FIELD_PREFIX + f) ?? null);
    };
    for (const y of ys) {
      const merges = findListMerges(y, keyOf);
      if (merges.length > 0) {
        return merges[0];
      }
    }
    return null;
  }

  private applyRepair(repair: Repair): void {
    const real = this.doc.clientID;
    this.doc.clientID = initClientID(
      'repair\u0000' +
        REPAIR_VERSION +
        '\u0000' +
        LAYOUT_VERSION +
        '\u0000' +
        repair.seed,
    );
    try {
      this.doc.transact(tr => repair.write(tr), this.sharedRepairOrigin);
    } finally {
      this.doc.clientID = real;
    }
  }

  /** Let group transforms (list numbering) run on groups a sync rebuilt. */
  /**
   * Recompute the derived fields (list numbering) of the groups a read or a
   * change touched. The group class's own transforms run directly, with the
   * group's siblings hidden: a transform that would also restructure (merge
   * an adjacent equal list) must not, as each peer would write that merge
   * (duplicating its items) and a fresh reader would build another tree.
   */
  private flushRefresh(): void {
    const state = this.state;
    if (state.refresh.size === 0) {
      return;
    }
    const keys = [...state.refresh];
    state.refresh.clear();
    this.editor.update(
      () => {
        for (const key of keys) {
          const node = $getNodeByKey(key);
          if (!$isElementNode(node) || !node.isAttached()) {
            continue;
          }
          const info = this.editor._nodes.get(node.getType());
          if (info === undefined) {
            continue;
          }
          const writable = node.getWritable();
          const {__prev, __next} = writable;
          writable.__prev = null;
          writable.__next = null;
          try {
            for (const transform of info.transforms) {
              if (!this.ownTransforms.has(transform) && writable.isAttached()) {
                transform(writable);
              }
            }
          } finally {
            writable.__prev = __prev;
            writable.__next = __next;
          }
        }
      },
      {
        discrete: true,
        skipTransforms: true,
        tag: [HISTORY_MERGE_TAG, REFRESH_TAG],
      },
    );
  }

  // -------------------------------------------------------------------------
  // Lexical -> Yjs

  private onUpdate({
    dirtyElements,
    dirtyLeaves,
    editorState,
    prevEditorState,
    tags,
  }: {
    dirtyElements: Map<NodeKey, boolean>;
    dirtyLeaves: Set<NodeKey>;
    editorState: EditorState;
    prevEditorState: EditorState;
    tags: Set<string>;
  }): void {
    if (!tags.has(REFRESH_TAG) && !tags.has(SKIP_COLLAB_TAG)) {
      // Every group whose children (or whose items' children) changed
      // recomputes its derived fields (list item values) in a refresh: remote
      // reads skip Lexical's transforms, and a local change inside an item
      // (a nested list appearing or going away) does not mark its list
      // dirty, so readers and the writer would number it differently.
      const prevMap = prevEditorState._nodeMap;
      const isGroup = (n: LexicalNode | null | undefined) =>
        n !== null &&
        n !== undefined &&
        $isElementNode(n) &&
        getGroupSpec(klassOf(n)) !== null;
      editorState.read(() => {
        for (const [key, intentional] of dirtyElements) {
          if (!intentional) {
            continue;
          }
          const node = $getNodeByKey(key);
          if (!$isElementNode(node)) {
            continue;
          }
          if (isGroup(node)) {
            // Its children changed (a remote read refreshes the groups it
            // rebuilds itself).
            if (!tags.has(COLLABORATION_TAG)) {
              this.state.refresh.add(key);
            }
            continue;
          }
          // An item that starts or stops holding a nested list.
          const parent = node.getParent();
          if (!isGroup(parent)) {
            continue;
          }
          const prev = prevMap.get(key);
          const wasWrapper =
            prev !== undefined &&
            $isElementNode(prev) &&
            prev.__first !== null &&
            isGroup(prevMap.get(prev.__first));
          if (wasWrapper !== isGroup(node.getFirstChild())) {
            this.state.refresh.add(parent!.getKey());
          }
        }
      });
    }
    if (
      this.status !== 'active' ||
      tags.has(COLLABORATION_TAG) ||
      tags.has(SKIP_COLLAB_TAG) ||
      (dirtyElements.size === 0 && dirtyLeaves.size === 0)
    ) {
      return;
    }
    const state = this.state;
    editorState.read(() => {
      const roles = new Roles(state);
      const plan = Writer.$plan(
        roles,
        dirtyElements,
        dirtyLeaves,
        prevEditorState,
      );
      const movedNodes = editorState._movedNodes;
      plan.moved =
        movedNodes === null ? null : movedNodes.get(prevEditorState._nodeMap);
      if (
        plan.structural.size === 0 &&
        plan.inline.size === 0 &&
        plan.lines.size === 0 &&
        plan.attrs.size === 0
      ) {
        return;
      }
      let writer: Writer | null = null;
      // Follow-up updates of a remote change (group refresh, repairs) are
      // not the user's edits: keep them out of the undo history.
      const origin =
        tags.has(REFRESH_TAG) || tags.has(REPAIR_TAG)
          ? this.repairOrigin
          : this;
      try {
        this.doc.transact(tr => {
          writer = new Writer(state, roles, tr, prevEditorState, plan);
          writer.$run();
        }, origin);
      } catch (e) {
        // A write that fails part way must not leave the document silently
        // behind the editor: rewrite every container (a diff against the
        // shared content, so nothing a peer wrote is lost) in a fresh
        // transaction, and report it.
        writer = null;
        this.editor._onWarn(
          new Error(
            '@lexical/y: a write failed and the document was rewritten: ' +
              String(e instanceof Error ? e.message : e),
          ),
        );
        try {
          this.doc.transact(tr => {
            const all: WritePlan = {
              attrs: new Set(state.yByKey.keys()),
              inline: new Set(),
              lines: new Set(state.unitByKey.keys()),
              removedText: plan.removedText,
              structural: new Set(),
            };
            for (const [key, cs] of state.csByKey) {
              (cs.kind === 'b' ? all.structural : all.inline).add(key);
            }
            const rewriter = new Writer(
              state,
              new Roles(state),
              tr,
              prevEditorState,
              all,
            );
            rewriter.rewriteAll = true;
            rewriter.$run();
          }, origin);
        } catch (e2) {
          this.editor._onError(
            e2 instanceof Error ? e2 : new Error(String(e2)),
          );
        }
      }
      const check =
        this.options.selfCheck ?? process.env.NODE_ENV !== 'production';
      if (
        check &&
        writer !== null &&
        Math.random() < (this.options.selfCheckSample ?? 1)
      ) {
        const problems = $checkWrite(writer);
        // Whole containers: structural writes, and containers where a group
        // item's marker was written (group fields are shared by its items).
        const containers = new Set<CS>();
        for (const key of plan.structural) {
          const cs = state.csByKey.get(key);
          if (cs !== undefined) {
            containers.add(cs);
          }
        }
        for (const cs of (writer as Writer).groupWrites) {
          containers.add(cs);
        }
        for (const cs of containers) {
          if (sampleWholeContainer(cs)) {
            problems.push(...checkContainer(state, cs, editorState));
          }
        }
        if (problems.length > 0) {
          this.editor._onWarn(
            new Error(
              '@lexical/y self-check: ' + problems.slice(0, 5).join('; '),
            ),
          );
        }
      }
    });
    if (!tags.has(REFRESH_TAG)) {
      this.flushRefresh();
    } else {
      state.refresh.clear();
    }
  }

  // -------------------------------------------------------------------------
  // Undo

  /**
   * Undo keeps a container a peer has put content in, whole: with its
   * fields and the undoing client's own content in it (deleting those would
   * leave a malformed container).
   */
  private isKeptByUndo(item: Item): boolean {
    // A container this undo also restores elsewhere was moved (deleted and
    // written again): keeping the new copy would duplicate it.
    const moved = (it: Item): boolean =>
      this.restoring !== null && this.restoring.has(nameOf(it));
    if (isNonEmptyContainer(item, this.undoCache)) {
      return !moved(item);
    }
    for (
      let t: unknown = item.parent;
      t instanceof YNode && t !== this.root;
      t = t._item === null ? null : t._item.parent
    ) {
      // Only a container this undo deletes (one it inserted): the content
      // of other containers is undone as usual.
      if (
        t._item !== null &&
        this.removing !== null &&
        this.removing.has(t._item) &&
        isNonEmptyContainer(t._item, this.undoCache)
      ) {
        return !moved(t._item);
      }
    }
    return false;
  }

  undo(): boolean {
    const um = this.undoManager;
    if (um === null) {
      return false;
    }
    this.undoCache = new WeakMap();
    this.scanStackItem(um.undoStack);
    try {
      return um.undo() !== null;
    } finally {
      this.restoring = null;
      this.removing = null;
    }
  }

  redo(): boolean {
    const um = this.undoManager;
    if (um === null) {
      return false;
    }
    this.undoCache = new WeakMap();
    this.scanStackItem(um.redoStack);
    try {
      return um.redo() !== null;
    } finally {
      this.restoring = null;
      this.removing = null;
    }
  }

  /**
   * The stored nodes the next stack item restores (by name) and deletes
   * (items), for the undo delete filter.
   */
  private scanStackItem(stack: UndoManager['undoStack']): void {
    const top = stack[stack.length - 1];
    this.restoring = null;
    this.removing = null;
    if (top === undefined) {
      return;
    }
    const names = new Set<string>();
    const removing = new Set<Item>();
    const isStored = (s: unknown): s is Item => {
      if (!(s instanceof Item) || !(s.content instanceof ContentType)) {
        return false;
      }
      const name = nameOf(s);
      return name !== MARKER && name !== RUN_END;
    };
    this.doc.transact(tr => {
      iterateStructsByIdSet(tr, top.deletes, s => {
        if (isStored(s)) {
          names.add(nameOf(s));
        }
      });
      iterateStructsByIdSet(tr, top.inserts, s => {
        if (isStored(s)) {
          removing.add(s);
        }
      });
    }, this.scanOrigin);
    this.restoring = names;
    this.removing = removing;
  }

  // -------------------------------------------------------------------------
  // Cursors

  /** The local selection as relative positions (JSON), or null. */
  getCursor(): YCursor | null {
    return this.editor.getEditorState().read(() => {
      try {
        return this.$captureCursor();
      } catch (_e) {
        // A selection the editor itself left invalid: no cursor.
        return null;
      }
    });
  }

  /**
   * The current selection as relative positions. A collapsed caret is
   * anchored to the character on its left, so that it stays after what the
   * user just typed when a peer inserts at the same place; a range is
   * anchored to its first and last characters, so it does not grow over
   * concurrent inserts at its edges.
   */
  private $captureCursor(): YCursor | null {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      return null;
    }
    const collapsed = selection.isCollapsed();
    const backward = selection.isBackward();
    const anchor = this.$relativePosition(
      selection.anchor,
      collapsed || backward,
    );
    const focus = this.$relativePosition(
      selection.focus,
      collapsed || !backward,
    );
    return anchor === null || focus === null ? null : {anchor, focus};
  }

  /** Resolve a cursor to Lexical points (call inside a read or update). */
  $resolveCursor(
    cursor: YCursor,
  ): {anchor: PointType; focus: PointType} | null {
    const anchor = this.$resolvePosition(cursor.anchor);
    const focus = this.$resolvePosition(cursor.focus);
    if (anchor === null || focus === null) {
      return null;
    }
    const selection = $createRangeSelection();
    selection.anchor.set(anchor.key, anchor.offset, anchor.type);
    selection.focus.set(focus.key, focus.offset, focus.type);
    return {anchor: selection.anchor, focus: selection.focus};
  }

  /**
   * Map the local selection through a remote change: resolve the cursor
   * captured before the transaction; points that cannot be resolved are
   * clamped to their node.
   */
  private $restoreSelection(cursor: YCursor): void {
    const current = $getSelection();
    if (current !== null && !$isRangeSelection(current)) {
      return;
    }
    let selection: RangeSelection | null = current;
    const anchor = this.$resolvePosition(cursor.anchor);
    const focus = this.$resolvePosition(cursor.focus);
    if (anchor !== null && focus !== null) {
      if (selection === null) {
        selection = $createRangeSelection();
        $setSelection(selection);
      }
      const same = (
        p: PointType,
        q: {key: NodeKey; offset: number; type: 'text' | 'element'},
      ) => p.key === q.key && p.offset === q.offset && p.type === q.type;
      if (!same(selection.anchor, anchor) || !same(selection.focus, focus)) {
        selection.anchor.set(anchor.key, anchor.offset, anchor.type);
        selection.focus.set(focus.key, focus.offset, focus.type);
      }
      return;
    }
    if (selection !== null) {
      for (const point of [selection.anchor, selection.focus]) {
        const node = $getNodeByKey(point.key);
        if (node === null || !node.isAttached()) {
          $setSelection(null);
          return;
        }
        const size = $isTextNode(node)
          ? node.getTextContentSize()
          : $isElementNode(node)
            ? node.getChildrenSize()
            : 0;
        if (point.offset > size) {
          point.set(point.key, size, point.type);
        }
      }
    }
  }

  private $relativePosition(point: PointType, preferLeft: boolean): unknown {
    const node = point.getNode();
    // Find the line (or inline container) and the atom offset within it.
    let offset = 0;
    let owner: ElementNode | null = null;
    let target: LexicalNode = node;
    if ($isTextNode(node)) {
      offset = point.offset;
    } else if ($isElementNode(node)) {
      const child = node.getChildAtIndex(point.offset);
      if (child === null) {
        // At the end of an element: the end of a line, or of the content of
        // a container or wrapper whose last child is the target.
        const last = node.getLastChild();
        if (last === null) {
          const unit = this.state.unitByKey.get(node.getKey());
          return unit !== undefined && unit.end !== null
            ? relativePositionToJSON(
                new RelativePosition(null, null, unit.end.id, 0),
              )
            : null;
        }
        target = last;
        offset = $atomSize(last);
      } else {
        target = child;
      }
      preferLeft = false;
    }
    const parent = $ownerOf(target);
    if (parent === null) {
      return null;
    }
    owner = parent;
    offset += $atomsBefore(parent, target);
    const unit = this.state.unitByKey.get(owner.getKey());
    let start: Item | null;
    if (unit !== undefined && unit.end !== null) {
      const left = prevLiveEnd(unit.end);
      start = left === null ? unit.cs.y._start : left.right;
    } else {
      const cs = this.state.csByKey.get(owner.getKey());
      if (cs === undefined || cs.kind !== 'i') {
        return null;
      }
      start = cs.y._start;
    }
    const at = (it: Item, d: number, assoc: number) =>
      relativePositionToJSON(
        new RelativePosition(
          null,
          null,
          {client: it.id.client, clock: it.id.clock + d} as Item['id'],
          assoc,
        ),
      );
    // Offsets count what the editor shows (not hidden remote content).
    const hidden = this.state.hidden;
    const unitAt = (it: Item, shown: number) =>
      hidden === null ? shown : hidden.unitAt(it, shown);
    let lastLive: Item | null = null;
    let lastLen = 0;
    for (let it = start; it !== null; it = it.right) {
      const len = shownLength(it, hidden);
      if (len === 0) {
        if (isEndItem(it) && !it.deleted) {
          break;
        }
        continue;
      }
      if (offset < len) {
        if (preferLeft && offset > 0) {
          return at(it, unitAt(it, offset - 1), -1);
        }
        if (preferLeft && offset === 0 && lastLive !== null) {
          return at(lastLive, unitAt(lastLive, lastLen - 1), -1);
        }
        return at(it, unitAt(it, offset), 0);
      }
      offset -= len;
      lastLive = it;
      lastLen = len;
      if (isEndItem(it)) {
        break;
      }
    }
    return null;
  }

  private $resolvePosition(
    json: unknown,
  ): {key: NodeKey; offset: number; type: 'text' | 'element'} | null {
    const rel = createRelativePositionFromJSON(json);
    if (rel.item === null) {
      return null;
    }
    const store = this.doc.store;
    if (store.getClock(rel.item.client) <= rel.item.clock) {
      return null;
    }
    const found = store.getItem(rel.item);
    if (!(found instanceof Item)) {
      return null;
    }
    let item: Item | null = found;
    let diff = rel.item.clock - found.id.clock;
    if (rel.assoc < 0) {
      // After a character: before the next live one.
      if (!found.deleted && found.countable && diff + 1 < found.length) {
        diff += 1;
      } else {
        let p: Item | null = found;
        if (found.deleted || !found.countable) {
          // The character is gone: after the nearest live one on its left.
          p = found.left;
          while (p !== null && (p.deleted || !p.countable)) {
            p = p.left;
          }
        }
        item = p === null ? (found.parent as YNode)._start : p.right;
        diff = 0;
      }
    }
    const hidden = this.state.hidden;
    while (item !== null && shownLength(item, hidden) === 0) {
      item = item.right;
      diff = 0;
    }
    if (item === null) {
      return null;
    }
    // Walk to the unit end; count atoms from the unit start.
    let end: Item | null = item;
    while (end !== null && (end.deleted || !isEndItem(end))) {
      end = end.right;
    }
    const parentY = item.parent as YNode;
    const unit = end === null ? undefined : this.state.unitByEnd.get(end);
    let ownerKey: NodeKey | undefined;
    let start: Item | null;
    if (unit !== undefined && unit.key !== null && unit.kind === 'line') {
      ownerKey = unit.key;
      const left = prevLiveEnd(end);
      start = left === null ? parentY._start : left.right;
    } else {
      const cs = this.state.containers.get(parentY);
      if (cs === undefined || cs.kind !== 'i') {
        return null;
      }
      ownerKey = cs.key;
      start = parentY._start;
    }
    let offset = 0;
    for (let it = start; it !== null && it !== item; it = it.right) {
      offset += shownLength(it, hidden);
    }
    offset +=
      item === end
        ? 0
        : hidden === null
          ? diff
          : hidden.shownBefore(item, diff);
    const owner = $getNodeByKey(ownerKey);
    if (!$isElementNode(owner)) {
      return null;
    }
    return $pointAtAtom(owner, offset);
  }

  /** @internal for tests: the container states. */
  _containers(): Map<NodeKey, CS> {
    return this.state.csByKey;
  }
}

function $atomSize(node: LexicalNode): number {
  if ($isTextNode(node)) {
    return node.getTextContentSize();
  }
  if ($isWrapper(node)) {
    return (node as ElementNode)
      .getChildren()
      .reduce((n, c) => n + $atomSize(c), 0);
  }
  return 1;
}

/** Keep the selection's points inside their nodes after a remote read. */
function $clampSelection(): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return;
  }
  for (const point of [selection.anchor, selection.focus]) {
    const node = $getNodeByKey(point.key);
    if (node === null || !node.isAttached()) {
      $setSelection(null);
      return;
    }
    const size = $isTextNode(node)
      ? node.getTextContentSize()
      : $isElementNode(node)
        ? node.getChildrenSize()
        : 0;
    if (point.offset > size) {
      point.set(point.key, size, point.type);
    }
  }
}

/** The line or inline container whose content holds `node`. */
function $ownerOf(node: LexicalNode): ElementNode | null {
  let parent = node.getParent();
  while (parent !== null && $isWrapper(parent)) {
    parent = parent.getParent();
  }
  return parent;
}

function $atomsBefore(owner: ElementNode, target: LexicalNode): number {
  let n = 0;
  const visit = (el: ElementNode): boolean => {
    for (const c of el.getChildren()) {
      if (c.is(target)) {
        return true;
      }
      if ($isWrapper(c)) {
        if (visit(c as ElementNode)) {
          return true;
        }
      } else {
        n += $atomSize(c);
      }
    }
    return false;
  };
  visit(owner);
  return n;
}

function $pointAtAtom(
  owner: ElementNode,
  offset: number,
): {key: NodeKey; offset: number; type: 'text' | 'element'} {
  let remaining = offset;
  let lastText = null as LexicalNode | null;
  const visit = (
    el: ElementNode,
  ): {key: NodeKey; offset: number; type: 'text' | 'element'} | null => {
    const children = el.getChildren();
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if ($isWrapper(c)) {
        const r = visit(c as ElementNode);
        if (r !== null) {
          return r;
        }
        continue;
      }
      const size = $atomSize(c);
      if ($isTextNode(c)) {
        lastText = c;
        if (remaining <= size) {
          return {key: c.getKey(), offset: remaining, type: 'text'};
        }
      } else if (remaining === 0) {
        return {key: el.getKey(), offset: i, type: 'element'};
      }
      remaining -= size;
    }
    return null;
  };
  const found = visit(owner);
  if (found !== null) {
    return found;
  }
  if (lastText !== null) {
    const t = lastText as LexicalNode;
    return {key: t.getKey(), offset: $atomSize(t), type: 'text'};
  }
  return {
    key: owner.getKey(),
    offset: owner.getChildrenSize(),
    type: 'element',
  };
}

/**
 * A client id for the initialization transaction: a 32-bit hash (the range
 * of Yjs' random client ids, so references to it cost what references to
 * any client cost) of the layout version, the target type and the encoded
 * initial items. Equal seeds give equal ids, so concurrent identical
 * initializations write identical items. Different seeds give different ids except with the
 * probability of a 32-bit collision, the same as two random Yjs client ids;
 * a shared id with different items would diverge.
 */
export function initClientID(seed: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const id = (h1 ^ h2) >>> 0;
  return id === 0 ? 1 : id;
}

/**
 * Undo must not delete a container a peer has put content in (its content
 * would go with it): a container holding live content of a client other
 * than the one that created it. The clients of each subtree are computed
 * once per undo (`cache`).
 */
/**
 * Containers of up to this many units (lines and nodes) get the
 * whole-container self-check after every structural change; bigger ones are
 * sampled (see YBindingOptions.selfCheck).
 */
const SELF_CHECK_FULL_UNITS = 256;

function sampleWholeContainer(cs: CS): boolean {
  const n = cs.units.length;
  return (
    n <= SELF_CHECK_FULL_UNITS || Math.random() < SELF_CHECK_FULL_UNITS / n
  );
}

/**
 * A table cell a repair added to pad a row, still empty: not content of
 * anyone (an undo that removes its row removes it too).
 */
function isEmptyPadding(it: Item): boolean {
  if (!(it.content instanceof ContentType)) {
    return false;
  }
  const y = it.content.type as YNode;
  if (y.getAttr(PAD_KEY) !== true) {
    return false;
  }
  let live = 0;
  for (let c = y._start; c !== null; c = c.right) {
    if (!c.deleted && c.countable) {
      if (++live > 1 || nameOf(c) !== MARKER) {
        return false;
      }
    }
  }
  return true;
}

function isNonEmptyContainer(
  item: Item,
  cache: WeakMap<YNode, Set<number>>,
): boolean {
  if (!(item.content instanceof ContentType)) {
    return false;
  }
  const name = nameOf(item);
  if (name === MARKER || name === RUN_END) {
    return false;
  }
  const clientsOf = (type: YNode): Set<number> => {
    let clients = cache.get(type);
    if (clients === undefined) {
      clients = new Set();
      for (let it = type._start; it !== null; it = it.right) {
        if (it.deleted || isEmptyPadding(it)) {
          continue;
        }
        if (it.countable) {
          clients.add(it.id.client);
        }
        if (it.content instanceof ContentType) {
          for (const c of clientsOf(it.content.type)) {
            clients.add(c);
          }
        }
      }
      cache.set(type, clients);
    }
    return clients;
  };
  for (const c of clientsOf(item.content.type)) {
    if (c !== item.id.client) {
      return true;
    }
  }
  return false;
}

/**
 * Keep local groups in the shape readers rebuild: adjacent top-level groups
 * with equal key fields are one group.
 */
function $canonicalizeGroup(node: ElementNode): void {
  const spec = getGroupSpec(klassOf(node));
  if (spec === null || !node.isAttached()) {
    return;
  }
  // A group without items has no shared representation (its items carry
  // it): remove it, with a nested-level wrapper it leaves empty.
  if (node.getChildrenSize() === 0) {
    const parent = node.getParent();
    node.remove();
    if (
      parent !== null &&
      parent.getChildrenSize() === 0 &&
      spec.items.includes(klassOf(parent)) &&
      parent.getParent() !== null &&
      getGroupSpec(klassOf(parent.getParent()!)) === spec
    ) {
      parent.remove();
    }
    return;
  }
  // The first declared key field only (see the reader's grouping).
  const sameKey = (a: ElementNode, b: ElementNode) => {
    if (klassOf(a) !== klassOf(b)) {
      return false;
    }
    const fa = $groupFields(a, spec);
    const fb = $groupFields(b, spec);
    return spec.key
      .slice(0, 1)
      .every(
        f => stableStringify(fa[f] ?? null) === stableStringify(fb[f] ?? null),
      );
  };
  // Its own items: two adjacent wrapper items each holding an equal group
  // read back as one wrapper (an item between them was moved away).
  const nestedIn = (w: LexicalNode | null): ElementNode | null => {
    if (
      !$isElementNode(w) ||
      w.getChildrenSize() !== 1 ||
      !spec.items.includes(klassOf(w))
    ) {
      return null;
    }
    const g = w.getFirstChild();
    return $isElementNode(g) && getGroupSpec(klassOf(g)) === spec ? g : null;
  };
  for (let child = node.getFirstChild(); child !== null; ) {
    const next = child.getNextSibling();
    const a = nestedIn(child);
    const b = nestedIn(next);
    if (a !== null && b !== null && sameKey(a, b)) {
      $appendMerging(a, b, sameKey);
      next!.remove();
      continue;
    }
    child = next;
  }
  // Nested levels: two adjacent wrapper items each holding an equal group
  // read back as one wrapper.
  const wrapper = node.getParent();
  if (
    wrapper !== null &&
    wrapper.getChildrenSize() === 1 &&
    spec.items.includes(klassOf(wrapper))
  ) {
    const nestedOf = (w: LexicalNode | null): ElementNode | null => {
      if (!$isElementNode(w) || w.getChildrenSize() !== 1) {
        return null;
      }
      const g = w.getFirstChild();
      return $isElementNode(g) && klassOf(g) === klassOf(node) ? g : null;
    };
    const before = nestedOf(wrapper.getPreviousSibling());
    if (before !== null && sameKey(before, node)) {
      $appendMerging(before, node, sameKey);
      wrapper.remove();
      return;
    }
    const after = nestedOf(wrapper.getNextSibling());
    if (after !== null && sameKey(node, after)) {
      const afterWrapper = after.getParent()!;
      $appendMerging(node, after, sameKey);
      afterWrapper.remove();
    }
  }
  const prev = node.getPreviousSibling();
  if (
    $isElementNode(prev) &&
    getGroupSpec(klassOf(prev)) !== null &&
    sameKey(prev, node)
  ) {
    $appendMerging(prev, node, sameKey);
    node.remove();
    return;
  }
  const next = node.getNextSibling();
  if (
    $isElementNode(next) &&
    getGroupSpec(klassOf(next)) !== null &&
    sameKey(node, next)
  ) {
    $appendMerging(node, next, sameKey);
    next.remove();
  }
}

/**
 * Move the children of `source` to the end of `target`. Where the two
 * meet, two wrapper items each holding an equal nested group are merged
 * too (recursively), as a reader builds them: consecutive deeper items share
 * one wrapper.
 */
function $appendMerging(
  target: ElementNode,
  source: ElementNode,
  sameKey: (a: ElementNode, b: ElementNode) => boolean,
): void {
  const last = target.getLastChild();
  const children = source.getChildren();
  target.append(...children);
  const first = children[0];
  const nestedOf = (w: LexicalNode | null | undefined): ElementNode | null => {
    if (!$isElementNode(w) || w.getChildrenSize() !== 1) {
      return null;
    }
    const g = w.getFirstChild();
    return $isElementNode(g) && getGroupSpec(klassOf(g)) !== null ? g : null;
  };
  const a = nestedOf(last);
  const b = nestedOf(first);
  if (a !== null && b !== null && sameKey(a, b)) {
    $appendMerging(a, b, sameKey);
    first!.remove();
  }
}

export {typeOf};
