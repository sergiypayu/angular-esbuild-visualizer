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
the right (drag the divider to resize). The tree has two views:

- **Import tree (from `index.html`)** — the eager initial-load graph. The
  synthetic `index.html` root → entry scripts → their transitive static
  imports. This is everything the browser downloads before the app boots.
- **Dynamic routes** — a forest of `import()`-triggered bundles. Each root is
  best-effort labelled with its Angular route `path` (e.g. `/blog`), and its
  subtree shows the chunk's static closure and any nested lazy routes.

### Analyzing size

- **Eager initial bundle breakdown** — the detail pane opens on an aggregate
  treemap + module table of the *entire* eager closure (every initial chunk's
  original modules merged, coloured by `node_modules` package), so you can see
  what fills your first-load budget at a glance. Click the **eager initial**
  stat in the header to return to it.
- **Click a chunk** to inspect its contents: a squarified **treemap** of the
  original modules plus a table sorted by contributed bytes.
- **“Why is this loaded?”** — click any module row (in the eager breakdown or a
  chunk) to trace its **reverse import chain** up to the nearest entry, each hop
  labelled `import` / `require` / `dynamic` and clickable to walk further, plus
  the module's direct importers. A banner classifies *why* it's in the bundle:
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
  reveals and scrolls to the chunk's canonical, fully-expanded node (switching
  view if needed).
- **Back / Forward** — every navigation (chunk, module, eager bundle, tab, ref
  jump) is a browser history entry, and the current view is deep-linkable via
  the URL hash.
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
4. `buildRouteForest` collects every `dynamic-import` edge that fires from the
   eager app as a route root; each lazy subtree expands its own static closure,
   marking already-eager chunks as `shared-eager` refs and previously-expanded
   lazy chunks as `seen` refs. A chunk that is itself a top-level route stays
   canonical at its own root — incidental cross-route imports of it become refs.
5. Route paths are recovered best-effort by scanning the importer's source for
   the `path: "…"` nearest each `import("./chunk")` — works on unminified
   bundles, silently skipped otherwise.
6. `buildModuleGraph` embeds a compact reverse import graph of the *original*
   modules (interned paths, packed edges, plus the entry-module indices). The
   client walks it to answer **“why is this module loaded?”** — the shortest
   chain of importers up to the nearest `index.html` or route entry.

The computed model is serialized into the HTML and rendered by a small
dependency-free client (`src/client/`).

## Limitations

- **Route-path labels** rely on readable (unminified) source near the
  `import()` call. With aggressive minification the lazy chunks still appear,
  just without a `/path` label.
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