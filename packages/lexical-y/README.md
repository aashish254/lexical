# `@lexical/y`

**EXPERIMENTAL PROTOTYPE. Not for production. The document layout may change
without a migration.**

A collaboration binding for Lexical on [Yjs 14](https://github.com/yjs/yjs)
(`@y/y`). It is a separate package from `@lexical/yjs` (Yjs 13), which is
unchanged: the two use different Yjs libraries and different document
layouts, and an app uses one or the other.

## Install

`@y/y` is a peer dependency pinned to a release candidate (npm's `latest` tag
points at an older one):

```sh
npm i @lexical/y @y/y@14.0.0-rc.28
```

`@y/y` rc.28's own type declarations do not type-check on their own (an
upstream issue): projects that type-check with `tsc` need `skipLibCheck: true`.
`@lexical/y`'s own declarations are clean.

## Entries

- `@lexical/y`: `YBinding` (framework independent, no DOM requirement),
  `YCollabExtension` (a Lexical extension: binding plus collaborative undo),
  `writeEditorToYDoc` (headless writer for converters), `createYDoc` (a
  document with client ids that fit a server's range), `LAYOUT_VERSION`,
  `DEFAULT_ROOT_NAME` (`'lexical-y'`), and the types `YBindingOptions`,
  `YBindingStatus`, `YCollabConfig`, `YCursor`, `ClientIDRange`.
- `@lexical/y/server`: `inspectUpdateRoots`, `isUpdateForLayout` (reject
  updates from clients that write to another root), `writeUpgradeNotice` (a
  notice that old clients show), `LAYOUT_VERSION`, `DEFAULT_ROOT_NAME` and the
  type `UpdateRoots`. No editor dependencies.
- `@lexical/y/migrate` is reserved for a converter from the Yjs 13 layouts.

## Usage

```ts
import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {YCollabExtension} from '@lexical/y';
import {configExtension, defineExtension} from 'lexical';

const editor = buildEditorFromExtensions(
  defineExtension({
    dependencies: [configExtension(YCollabExtension, {doc})],
    name: 'app',
  }),
);
// After the provider's first sync:
getExtensionDependencyFromEditor(editor, YCollabExtension).output.binding.initialize();
```

The editor stays read only until the document's layout record has been read
(the extension's `status` signal: `pending`, then `active` or `readonly`).
`initialize()` marks an empty layout root with the layout version and writes
the editor's content, with a client id derived from the target shared type
and the exact items written (two clients initializing the same content into
the same root at once write it once; different roots or content never share
an id) and outside the undo history. It refuses when an older layout's root (`root`, `root-v2`) has
content other than an upgrade notice: convert such a document with
`writeEditorToYDoc`, which writes the layout root next to the old one. A
document marked with a newer layout is read only.

The binding owns the formatting cleanup of its own types: it opts its
containers out of Yjs' remote formatting cleanup, which rescans a whole type
after a remote format change (the document's `cleanupFormatting` flag and the
app's other types are untouched).

In development (and in production with `selfCheck: true`, optionally sampled
with `selfCheckSample`), every local write is read back from Yjs and compared
with the editor; mismatches are reported through the editor's `onWarn`. Each
line a write touches is checked; a structural change also compares a fresh
read of the whole container, every time for containers of up to 256 lines and
nodes and sampled in proportion for bigger ones (a 2,000-block root is
checked on about one structural edit in eight), so Enter and Backspace stay
fast in development. `YCollabExtension` takes the same `selfCheck`,
`selfCheckSample` and `convert` options as `YBinding`; `selfCheck: false`
turns the check off.

## Servers

- Reject updates from clients of older layouts with
  `isUpdateForLayout(update, {doc})` from `@lexical/y/server` (pass the
  server's document so nested items and deletions resolve), and write
  `writeUpgradeNotice(doc)` into the old root so stale tabs show a notice.
  The notice also records itself in an attribute of the layout root
  (`lexical-y:notice`), so that the layout root can still be initialized
  next to it.
- **yrs before 0.28** (y-crdt relays and servers, e.g. on yrs 0.23) reads
  client ids as 32-bit numbers, while Yjs 14 draws 53-bit ones. Symptoms seen
  with Yjs 14's default ids:
  - with a ywasm 0.23.5 relay, the server stores an author's content under a
    truncated id, and the author receives its own content back as another
    client's on reconnect, duplicating it;
  - with a yrs 0.23 server, reconnect fails ("the awareness update is
    malformed") and edits made offline are lost.

  yrs/ywasm 0.28 handles 53-bit ids. For an older server, keep client ids in
  32 bits. Create the document with `createYDoc({compat: 'yrs-0.23'})`, or
  pass `clientIDRange: 'uint32'` to the binding (also on `YCollabExtension`
  and `writeEditorToYDoc`). Both also correct the id when Yjs draws a new one.
  The default, `'uint53'`, leaves Yjs 14's ids as they are. The id the
  binding uses for the initial content is always 32-bit.

  The binding does not create or own the awareness. An awareness takes the
  document's client id when it is created, so create it (and the provider)
  from a document that already has a 32-bit id. Use `createYDoc({compat:
  'yrs-0.23'})` for that. `clientIDRange: 'uint32'` applies when the binding
  starts, so an awareness created before that keeps a 53-bit id.

## Layout

The shared root is `doc.get('lexical-y')` (a new root name, so a client of an
older layout never edits this content), with attribute `lexical-y` = layout
version.

Every container (the root, and every node stored as its own `Y.Node`) holds
one sequence of children:

- text, with formats: the text node's type (`t`, when not `text`), one key
  per format (`f:bold`), its JSON fields (`p:<field>`), NodeState
  (`s:<key>`), a segment key (`k`) for nodes Lexical would not merge, and one
  key per inline wrapper declared `collab: {inline: 'format'}` (`w:link`,
  whose value holds the link's fields);
- `¶` markers: a line (a node declared `collab: {block: 'line'}`) is its
  inline content followed by its marker, a `Y.Node` whose attributes are the
  line's type (`t`, left out for a paragraph), schema fields, NodeState, and
  for an item of a group (`collab: {block: {mode: 'group'}}`: a list) the
  group's type, key fields and the item's level. Groups are rebuilt from
  consecutive items;
- `¦` run terminators: inline content that belongs to the container itself;
- `b:<type>` children: any other block (tables, rows, cells, block
  decorators, undeclared or not schema-complete classes), with the node's
  JSON as attributes and, for an element, its own sequence and its content
  kind (`c`: `b` blocks or `i` inline content, declared with
  `collab: {content}` or decided when it is created, never changed);
- `i:<type>` children: any other node inside inline content (inline
  decorators, inline elements that are not formats, a block inside a line).

## Recovery and repairs

- If writing a local change throws, every container is rewritten from the
  editor (a diff against the shared content) in a fresh transaction, and the
  failure is reported through `onWarn`.
- If reading a remote change throws, the editor is rebuilt from the shared
  content (what every fresh reader shows) and the failure is reported
  through `onWarn`. When the self-check finds the editor different from the
  shared content after a remote change, those containers are read again.
- Concurrent edits can leave shapes Lexical would normalize: a ragged table
  (row insert ‖ column insert) and two equal lists side by side inside a
  list item. Every client that sees one repairs it, so the repair happens
  whoever is online. A repair is a pure function of the shared content (it
  never reads the editor), and its client id is derived from a repair
  version, its inputs described independently of how items are split, and
  its output encoded on a scratch document: clients with the same inputs
  write the same items once, and clients with different inputs never share
  an id. Repairs wait while the editor is composing or has a pending update,
  and are not part of the undo history. Cells added to pad a row are marked,
  and an empty padding cell is removed again when its column goes away (an
  undo of the column insert).

## Limits

- A move is a delete and a reinsert: text a peer types into a moved block at
  the same time is lost or lands in its old neighbour. The cheaper side is
  rewritten: a long move rewrites the moved block, a swap of two blocks
  re-creates the smaller one (between equal blocks, the moved one). Two
  peers moving the same blocks can duplicate one.
- A container deleted by one peer takes what another peer typed into it
  concurrently (delete wins), as does unwrapping a container (a removal and
  a reinsertion of its lines). A join ‖ removal of the joined line also
  joins the next line (nothing deleted comes back).
- Lexical restructures written as moves (a list created from a paragraph
  inside a container that is not a shadow root, indenting or pasting list
  items that hold blocks) lose a peer's concurrent typing in the moved
  paragraph, or show an item twice when two peers indent it at once. Two
  peers pulling the same text across a container edge both copy it.
- Properties a node class keeps outside its `$config()` schema and NodeState
  are not synced (the binding warns, and stores such classes as nodes).
  Lexical itself drops them when it clones such a node (its generated clone
  copies schema fields only), so they cannot be kept in any case.
- MarkNode is an element with its own content: wrapping a range moves the
  text into it, and concurrent typing in that range stays outside. Use
  per-id NodeState for comments (MarkStateExtension).
- A split racing a type change gives the first half the splitter's type;
  text typed into a line a peer removed joins the next line.
- Slots are not synchronized; a link's fields merge as a whole (last writer
  wins). Bold ‖ bold on adjacent ranges of one line can leave part
  unformatted (Yjs format semantics, the same on Yjs 13).
- Editor instances (nested caption editors) are not synchronized; JSON
  snapshots of them are.
- Undo never deletes a container another client has put content in: it is
  kept whole. After two peers' lists inside one list item are merged, undoing
  either addition keeps the merged list; undoing the addition of the list a
  peer is merging away does nothing, and a later redo adds it again, so its
  items show twice. Two clients that repair the same
  shape from different content (one has an edit in one of the lists the
  other has not received yet) both apply their repair, so the moved list's
  items can show twice. A list that ends up right before a line of an equal
  nested list (a peer deleted the text between them) is shown inside that
  line's item rather than merged with its list (every client shows the
  same).
- The list merge copies the second list's content into the first and
  deletes the second, so text anyone types into the second list (its author
  included) before the merge reaches them is lost.
- A peer's repair can move the line the editor is composing in (IME): the
  development self-check may warn until the composition ends (it then
  converges), and composed text in the moved line follows the move ‖ typing
  limit above.
- Repair detection walks every container a remote change touched (linear;
  about 27 ms at 320,000 items in one container, some 8% of receiving a
  keystroke).
- Two clients initializing with different content at once both keep their
  content (converged).
- Several edits to one line in a single update are written as one replace
  (a peer's caret inside it moves to the edge).
- Structural edits in a large list cost time proportional to the list on
  both sides (regrouping and renumbering).
- The layout version must be an integer from 1 to `LAYOUT_VERSION`;
  anything else is read only.
- With Yjs 14's default 53-bit client ids, servers on yrs before 0.28
  duplicate content or lose offline edits on reconnect (see Servers).
- A node's NodeState keys keep the order of its author's local history in
  the author's editor (values are equal everywhere).
- Relies on @y/y internals (item and type fields), pinned to the tested
  release candidate.
