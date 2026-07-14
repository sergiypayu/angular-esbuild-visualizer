# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

A single-purpose CLI that turns an Angular **esbuild-builder** production build
into a self-contained HTML import-graph visualizer. Input: the build's
`stats.json` (esbuild **metafile**) + `index.html`. Output: one HTML file (no
runtime deps, no server) with an eager import tree, a dynamic-route forest, and a
per-chunk original-module treemap — or, with `--json`, a machine-readable report
on stdout (for AI agents / scripts; skips the HTML unless `-o` is also given).

See `README.md` for the user-facing docs (options, how to produce `stats.json`).

## Commands

```bash
# run the CLI directly — no build step needed (Node >= 22.6)
node --experimental-strip-types src/cli.ts <dir> [options]
npm start -- <dir> [options]          # same thing via the start script

npm run typecheck                     # tsc --noEmit
npm run build                         # compile dist/ (tsc + scripts/postbuild.mjs)
npm install                           # only needed for typecheck/build (typescript, @types/node)
```

There is **no test suite** and **no build required for local dev**. `npm start`
executes the TypeScript sources directly through Node's type-stripping. The
**published** package, however, ships compiled JS: `bin` points at
`dist/cli.js`, and `npm run build` (tsc + `scripts/postbuild.mjs`) emits `dist/`.
Type-stripping is forbidden under a consumer's `node_modules`, so an installed
package cannot run `.ts` directly — hence the compiled `dist/`.

## Requirements

- **Node ≥ 22.6** — local dev relies on `--experimental-strip-types` to run
  `.ts` directly (the `bin`/shebang in `src/cli.ts` does this for `npm start`).
  Don't add a build prerequisite for *local* CLI use; the build only matters for
  publishing.
- The input must come from the Angular **application/esbuild builder** with
  `statsJson` enabled (the `outputs`/`inputs` metafile shape). The webpack
  `stats.json` is a different format and is rejected by `loadMetafile`.

## Architecture

Pure ESM, no framework. The analysis pipeline has no third-party runtime deps;
the only runtime dependency is `open`, used solely by the `--open` flag (opens
the result via the OS default handler, like esbuild-visualizer). The pipeline
(driven by `src/cli.ts → main()`):

1. **`src/metafile.ts`** — `loadMetafile()` reads + validates `stats.json`;
   `isJs`, `staticImports` (`import-statement` edges), `dynamicImports`
   (`dynamic-import` edges) are the edge helpers used everywhere else.
2. **`src/html-entry.ts`** — `parseHtmlEntries()` regex-scrapes `index.html` for
   the real execution roots: `<script src>` tags and `<link rel=modulepreload>`
   hints (normalized to basenames).
3. **`src/graph.ts`** — `buildModel()` is the core. It:
   - BFS from the HTML entries over **static** edges → the **eager set** and the
     import tree (`buildEagerTree`).
   - Builds the dynamic-route forest (`buildRouteForest`): each lazy chunk is
     expanded once and ref'd elsewhere. Its owner is the `import()` caller whose
     directory *contains* the chunk's entry module, deepest wins
     (`ownersByProximity`). It nests under the owner **only if** the owner is a
     canonical lazy route (a stable home); an eager- or shared-chunk-owner (no
     single home) or no owner → top-level root, ref'd by each triggering bundle.
     An eager `import()` of a nested chunk also shows as a top-level ref. Each
     subtree expands its static closure (already-eager → `shared-eager` refs);
     every non-owner `import()` → a `seen` ref. Refs keep the DAG a tree.
   - Recovers route labels best-effort by scanning the importer's source for the
     route key nearest each `import("./chunk")` (`routePathFor` + `SourceCache`):
     an explicit `path:"…"` → `/…`, or any `matcher:` → a generic `(matcher)`
     (custom UrlMatcher, url not statically known). Survives minification;
     silently skipped when no key sits beside the import.
   - Builds each chunk's contents hierarchy for the treemap (`buildContents`).
4. **`src/render.ts`** — `renderHtml()` inlines `src/client/style.css` +
   `src/client/app.js` and the serialized model into one HTML document.
5. **`src/agent-report.ts`** — `buildAgentReport()` reshapes the model (+ the
   metafile) into the `--json` stdout report: size-annotated trees,
   pre-aggregated per-route download costs (mirroring the client's
   `collectBundle` semantics), per-chunk module lists and chunk-level import
   edges, plus an embedded `notes` legend. Its types live in the module itself,
   not `types.ts` (it's a CLI output format, not the client model).
6. **`src/client/app.js`** — the in-page app: tree rendering (lazy-populated on
   expand), search over the full model, and the squarified treemap + module
   table in the detail pane.

`src/types.ts` holds both the esbuild metafile shapes and the computed
`VisualizerData` model handed to the client. Keep these two in sync when
changing the model.

## Conventions & gotchas

- **Input layout**: the Angular application builder writes `stats.json` at the
  output *root* but `index.html` + chunks under `browser/`. The CLI accepts
  either directory as `<dir>`: `stats.json` is looked up at `<dir>/stats.json`
  then `<dir>/../stats.json`; `index.html` at `<dir>/index.html` then
  `<dir>/browser/index.html`. Route-label sources are read from
  `dirname(index.html)` (`BuildOptions.chunkDir`), where the chunks live. In an
  SSR build the metafile merges browser *and* server outputs — server bundles
  are `.mjs`, filtered out by `isJs`; metafile output keys carry no `browser/`
  prefix (they're raw esbuild paths, relative to the workspace root).

- **`src/client/app.js` is hand-written dependency-free browser JS** in a
  conservative style (`var`, IIFE, no modules) so it runs inline in any output.
  Don't introduce a bundler or framework for the client; match the existing
  style.
- **`safeJson()` in `render.ts`** escapes `<`, `>`, U+2028, U+2029 before
  embedding the model in a `<script>`. Preserve that when touching serialization
  — it's what keeps the inlined JSON safe and valid.
- Route-path detection is intentionally best-effort; never throw when it can't
  find a path — degrade to no label.
- Sizes are esbuild's raw `bytes` / `bytesInOutput` (pre-gzip). Only the JS
  graph is analyzed; CSS/assets are out of scope by design.
- `tsconfig.json` is strict with `noUncheckedIndexedAccess` and
  `verbatimModuleSyntax`; keep `import type` for type-only imports.

## Publishing

`package.json` ships **compiled `dist/`** (not the `.ts` sources): `files` is
`["dist", "README.md", "LICENSE"]`, `bin` → `dist/cli.js`, and `prepublishOnly`
runs `npm run build`. The build is `tsc` + `scripts/postbuild.mjs`, which copies
`src/client/` → `dist/client/` (the inlined assets `render.js` reads at runtime)
and normalizes `dist/cli.js`'s shebang to plain `node`. `dist/` is gitignored
and rebuilt on publish. Repo: `github.com/sergiypayu/angular-esbuild-visualizer`.
