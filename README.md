# angular-esbuild-visualizer

Visualize the **import branch** of an Angular production bundle built with the
esbuild/Vite builder (`@angular/build` / `@angular-devkit/build-angular:application`),
starting from `index.html`.

Unlike flat bundle analyzers that dump every emitted output, this tool walks the
graph the way the browser actually loads it:

- **What ships on first paint** — the eager closure reachable from the
  `<script>` tags in `index.html` via static `import` edges.
- **What loads later** — each `import()` (lazy route / `@defer`) becomes a
  route root, and its subtree shows the lazy chunk's *own* static closure, with
  chunks already paid for eagerly marked as shared references.
- **What's inside each chunk** — the original source modules that esbuild merged
  into it, as a size treemap plus a sortable table.
- **Why a module is there** — the reverse import chain that pulled it in, traced
  up to the entry, so you can see exactly which edge to cut.

It produces a single self-contained HTML file (no runtime dependencies, no
server) from the build's `stats.json` (the esbuild **metafile**) and `index.html`.

## Why

The esbuild builder emits a metafile, but generic metafile viewers
(`esbuild-visualizer`, Bundle Buddy, etc.) treat every output equally and don't
understand Angular's two-tier loading model. The questions this tool answers:

- *What is actually in my initial download, and how big is it?*
- *Why is that 500 KB module in my initial download — which chain of imports
  pulled it in, and which edge do I cut to remove it?*
- *Which route pulls in that heavy library — and does it duplicate something
  already loaded eagerly?*
- *Which original modules dominate a given chunk?*

## Requirements

- **Node.js ≥ 22.6** — installed from npm the CLI runs as compiled JavaScript
  (no flags needed); run from a clone it executes the TypeScript sources
  directly via Node's `--experimental-strip-types`.
- A production build with the **esbuild application builder** and the
  **metafile** enabled.

### Producing the `stats.json` metafile

Enable `statsJson` for the build target in `angular.json`:

```jsonc
{
  "projects": {
    "my-app": {
      "architect": {
        "build": {
          "options": {
            "statsJson": true
          }
        }
      }
    }
  }
}
```

…or pass it on the command line:

```bash
ng build --stats-json
```

This writes `stats.json` (the esbuild metafile) into the build output directory,
alongside `index.html` and the emitted chunks.

## Usage

```bash
# from a clone
npm install            # only needed for `npm run build` / typecheck
npm start -- <dir> [options]

# or run the CLI directly (Node ≥ 22.6)
node --experimental-strip-types src/cli.ts <dir> [options]

# or, once published, without installing
npx angular-esbuild-visualizer <dir> [options]
```

`<dir>` is the build output directory containing both `stats.json` and
`index.html`. It defaults to the current directory.

### Example

```bash
angular-esbuild-visualizer dist/my-app/browser \
  -o /tmp/deps.html \
  --title "my-app — import map" \
  --open
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `<dir>` | `cwd` | Build output dir (contains `stats.json` + `index.html`). |
| `--stats <path>` | `<dir>/stats.json` | Path to the esbuild metafile. |
| `--html <path>` | `<dir>/index.html` | Path to `index.html`. |
| `-o, --filename <path>` | `./angular-deps.html` | Output HTML file. |
| `--title <text>` | `Angular Import Visualizer` | Document title. |
| `--top <n>` | `3` | Module names shown in each chunk's `[…]` label. |
| `--open` | off | Open the result in the default browser. |
| `-h, --help` | | Show help. |

## The output

A single HTML page: a navigable tree on the left and a detail/inspector pane on
the right (drag the divider to resize). The tree is one unified import graph,
ordered the way the app loads:

- The synthetic **`index.html`** root → entry scripts → their transitive static
  imports — everything the browser downloads before the app boots. This first
  node is expanded by default.
- Then each **dynamic route** hangs off it: a forest of `import()`-triggered
  bundles. Each root is best-effort labelled with its Angular route `path`
  (e.g. `/blog`), and its subtree shows the lazy chunk's own static closure
  (chunks already paid for eagerly marked as shared references) and any nested
  lazy routes.

### Analyzing size

- **Merged bundle view** — clicking a *boundary* row (`index.html` or any lazy
  route) opens an aggregate treemap + module table of everything that node loads
  (each contributing chunk's original modules merged, coloured by `node_modules`
  package). The row's size is this bundle's total:
  - **`index.html`** → the *entire* eager closure — what fills your first-load
    budget. This is the default view; reopen it by clicking the `index.html` row.
  - **a lazy route** → the route's own static closure (the lazy chunk plus
    everything it statically pulls in, stopping at nested lazy routes) — i.e.
    what downloads when you navigate there. The sub-line also notes the
    already-eager weight it *shares* (free on navigation).

    *What counts toward a route's size:* a statically-imported chunk is part of
    the route's **own** download only if it isn't already eager — chunks in the
    initial bundle load regardless, so they're excluded from the size and
    reported separately as *shared eager*. A non-eager chunk shared by several
    lazy routes is counted in **each** of their bundles, because every one of
    those navigations really does fetch it. ("Eager" is decided once: a chunk
    reached only through `import()` is never eager, even if many routes share
    it.)
- **Inspect a single chunk** — expand a route and click its **first child**, the
  route's own entry chunk (or click any non-boundary chunk row): a squarified
  **treemap** of the original modules plus a table sorted by contributed bytes.
- **“Why is this loaded?”** — click any module (a table row **or a treemap
  tile**) to trace its **reverse import chain**; a **Back** button returns to the
  view you came from. When you open it from a bundle, the chain is the path
  *within that bundle* — up to the bundle's own entry (e.g. the route you're
  inspecting),
  answering "what pulled it in *here*" rather than whichever entry is nearest
  globally. Each hop is labelled `import` / `require` / `dynamic` and clickable to
  walk further (keeping the bundle context), plus the module's direct importers.
  A banner classifies *why* it's in the bundle:
  - **eager** — statically reachable from an `index.html` entry; cut a static
    edge in the chain to drop it from the initial bundle.
  - **grouped** — *not* statically reachable from an entry; it sits in an eager
    chunk only because esbuild co-located it with eager code (its real consumer
    is a lazy route).
  - **lazy** — only reached by crossing a dynamic `import()`.

### Navigating

- **Search** filters across the whole model (chunk names, route paths, module
  labels, entry points) — including not-yet-expanded nodes — and keeps the
  ancestor path of every match.
- **Jump to definition** — clicking a `ref` / `shared` back-reference badge
  reveals and scrolls to the chunk's canonical, fully-expanded node.
- **Back / Forward** — every navigation (chunk, module, merged bundle, ref jump)
  is a browser history entry, and the current view is deep-linkable via the URL
  hash.
- **Badges**: `entry` (referenced by a `<script>`), `preload`
  (`<link rel=modulepreload>`), `eager`, `lazy`, and `shared` / `ref` (clickable)
  for back-references that keep the DAG rendered as a tree.

## How it works

1. `loadMetafile` reads `stats.json` and validates it's an esbuild metafile.
2. `parseHtmlEntries` extracts the real execution roots from `index.html`: the
   `<script src>` tags and `<link rel=modulepreload>` hints.
3. `buildEagerTree` seeds both the `<script>` entries and the `modulepreload`
   hints as top-level roots, then BFSes over `import-statement` (static) edges →
   the **eager set** and the import tree.
4. `buildRouteForest` expands each lazy chunk **once** and refs it everywhere
   else. Its owner is the `import()` caller whose folder *contains* the chunk's
   entry module (deepest container wins; ties or unrelated callers → no owner).
   It only **nests** under that owner when the owner is itself a canonical lazy
   route (a single stable home); if the owner is eager or a shared non-route
   chunk (pulled into many bundles, so no single home), or there's no owner, the
   chunk goes to the **top level** and each triggering bundle refs it. An eager
   `import()` of a nested chunk also shows as a top-level ref into its route. Each
   subtree expands its static closure (already-eager → `shared-eager` refs), and
   every other `import()` of a chunk → a `seen` ref, keeping the DAG a tree.
5. Route labels are recovered best-effort by scanning the importer's source for
   the route-object key nearest each `import("./chunk")`: an explicit
   `path: "…"` → `/…`, or a `matcher:` (a custom `UrlMatcher`, whose url is
   decided at runtime and can't be read statically) → a generic `(matcher)`. The
   `path`/`matcher` keys survive minification, so this works on prod bundles;
   it's silently skipped when neither sits beside the import.
6. `buildModuleGraph` embeds a compact reverse import graph of the *original*
   modules (interned paths, packed edges, plus the entry-module indices). The
   client walks it to answer **“why is this module loaded?”** — the shortest
   chain of importers up to the nearest `index.html` or route entry.

The computed model is serialized into the HTML and rendered by a small
dependency-free client (`src/client/`).

## Limitations

- **Route-path labels** are read from the `path:` / `matcher:` key beside each
  `import()`. A `matcher:` route shows a generic `(matcher)` (its url is computed
  at runtime); and when the route config lives in a different chunk than the
  import, the lazy chunk still appears, just without a label.
- Only the **JS import graph** is analyzed; CSS bundles and assets are out of
  scope.
- Sizes are esbuild's `bytes` / `bytesInOutput` (pre-gzip).

## Development

```bash
npm run typecheck    # tsc --noEmit
npm run build        # compile dist/ (tsc + copy client assets, normalize shebang)
```

For local development no build is needed — `npm start` executes the TypeScript
sources directly via type-stripping. `npm run build` compiles `dist/`, which is
what gets published to npm (the `bin` points at `dist/cli.js`); `prepublishOnly`
runs it automatically.

## License

[MIT](./LICENSE)