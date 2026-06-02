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

It produces a single self-contained HTML file (no runtime dependencies, no
server) from the build's `stats.json` (the esbuild **metafile**) and `index.html`.

## Why

The esbuild builder emits a metafile, but generic metafile viewers
(`esbuild-visualizer`, Bundle Buddy, etc.) treat every output equally and don't
understand Angular's two-tier loading model. The questions this tool answers:

- *What is actually in my initial download, and how big is it?*
- *Which route pulls in that heavy library — and does it duplicate something
  already loaded eagerly?*
- *Which original modules dominate a given chunk?*

## Requirements

- **Node.js ≥ 22.6** — the CLI runs TypeScript directly via Node's
  `--experimental-strip-types`; no build step needed to use it.
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

A single HTML page with two views:

- **Import tree (from `index.html`)** — the eager initial-load graph. The
  synthetic `index.html` root → entry scripts → their transitive static
  imports. This is everything the browser downloads before the app boots.
- **Dynamic routes** — a forest of `import()`-triggered bundles. Each root is
  best-effort labelled with its Angular route `path` (e.g. `/blog`), and its
  subtree shows the chunk's static closure and any nested lazy routes.

Other affordances:

- **Search** filters across the whole model (chunk names, route paths, module
  labels, entry points) — including not-yet-expanded nodes — and keeps the
  ancestor path of every match.
- **Click a chunk** to inspect its contents: a squarified **treemap** of the
  original modules (coloured by top-level / `node_modules` package) plus a table
  sorted by contributed bytes.
- **Badges**: `entry` (referenced by a `<script>`), `preload`
  (`<link rel=modulepreload>`), `eager`, `lazy`, and `shared` / `ref` for
  back-references that keep the DAG rendered as a tree.

## How it works

1. `loadMetafile` reads `stats.json` and validates it's an esbuild metafile.
2. `parseHtmlEntries` extracts the real execution roots from `index.html`: the
   `<script src>` tags and `<link rel=modulepreload>` hints.
3. `buildEagerTree` does a BFS from those entries over `import-statement`
   (static) edges → the **eager set** and the import tree.
4. `buildRouteForest` collects every `dynamic-import` edge that fires from the
   eager app as a route root; each lazy subtree expands its own static closure,
   marking already-eager chunks as `shared-eager` refs and previously-expanded
   lazy chunks as `seen` refs.
5. Route paths are recovered best-effort by scanning the importer's source for
   the `path: "…"` nearest each `import("./chunk")` — works on unminified
   bundles, silently skipped otherwise.

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
npm run build        # emit dist/ (tsc)
```

The runtime needs no build — `bin` and `npm start` execute the TypeScript
sources directly. `npm run build` exists for publishing a compiled `dist/`.

## License

[MIT](./LICENSE)