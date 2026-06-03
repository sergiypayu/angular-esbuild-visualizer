// Shapes of the esbuild metafile (Angular's `--stats-json` output from the
// `@angular-devkit/build-angular:application` / `@angular/build` builder) and
// of the model we compute for the visualizer client.

/** A single import edge as recorded by esbuild in a metafile. */
export interface EsbuildImport {
  path: string;
  /** `import-statement` (eager), `dynamic-import` (lazy route/`@defer`), `url-token` (asset), `require-call`, ... */
  kind: string;
  external?: boolean;
}

/** One emitted output file (chunk, entry, css, sourcemap). */
export interface EsbuildOutput {
  bytes: number;
  /** Set only on entry-point outputs; the original source module that produced it. */
  entryPoint?: string;
  imports?: EsbuildImport[];
  exports?: string[];
  /** Original source modules that ended up inside this output, with their contributed size. */
  inputs?: Record<string, { bytesInOutput: number }>;
  cssBundle?: string;
}

/** One original source module as seen on the input side of the build. */
export interface EsbuildInput {
  bytes: number;
  imports?: EsbuildImport[];
  format?: string;
}

export interface EsbuildMetafile {
  inputs: Record<string, EsbuildInput>;
  outputs: Record<string, EsbuildOutput>;
}

// ---------------------------------------------------------------------------
// Computed model handed to the HTML client.
// ---------------------------------------------------------------------------

/** Hierarchical size data for one chunk's contents (drives the treemap). */
export interface TreemapNode {
  name: string;
  /** Bytes — only present on leaves. */
  value?: number;
  children?: TreemapNode[];
}

export interface ChunkMeta {
  /** Output basename, e.g. `chunk-NAQCUPD7.js`. */
  file: string;
  bytes: number;
  /** Original-module short names that make up the chunk, biggest first (the `[...]` label). */
  label: string[];
  /** Total number of original modules in the chunk. */
  moduleCount: number;
  /** Source module for entry chunks, e.g. `src/app/modules/blog/blog-routing.ts`. */
  entryPoint?: string;
  /** Referenced directly by a <script> in index.html. */
  isEntryHtml: boolean;
  /** Listed as <link rel=modulepreload> in index.html. */
  isModulePreload: boolean;
  /** Part of the eager initial-load closure (reachable from entries via static imports). */
  inEager: boolean;
  /** Contents hierarchy for the treemap. */
  contents: TreemapNode;
}

export type TreeKind = "html" | "entry" | "eager" | "lazy" | "ref";

/** A node in the import tree / dynamic-route forest. */
export interface TreeNode {
  /** Chunk basename, or `index.html` for the synthetic root. */
  file: string;
  kind: TreeKind;
  /** How this node was reached from its parent. */
  edge?: "static" | "dynamic" | "html";
  /** Best-effort Angular route path for lazy roots, e.g. `/blog`. */
  routePath?: string;
  /** True when this is a back-reference to a chunk expanded elsewhere (keeps the DAG a tree). */
  ref?: boolean;
  /** For ref nodes: why it's a ref. */
  refReason?: "seen" | "shared-eager";
  /** Top-level root with no single route owner (a shared lazy chunk); the client
   * groups these below the real routes under a divider. */
  shared?: boolean;
  children: TreeNode[];
}

export interface Summary {
  totalJsBytes: number;
  eagerJsBytes: number;
  lazyJsBytes: number;
  jsChunkCount: number;
  eagerChunkCount: number;
  lazyChunkCount: number;
  dynamicEdgeCount: number;
  staticEdgeCount: number;
}

/**
 * Module-level (original-source) reverse import graph, used by the client's
 * "why is this loaded?" analysis. Paths are interned to indices to keep the
 * inlined payload small; edges are stored reversed (importer of each module).
 */
export interface ModuleGraph {
  /** idx → module path (esbuild `inputs` key). */
  paths: string[];
  /**
   * idx → packed reverse edges. Each entry is `importerIdx * 4 + kind`, where
   * kind is 0 = import-statement, 1 = require-call, 2 = dynamic-import.
   */
  importers: number[][];
  /** Module indices that are the entryPoint of an index.html entry chunk. */
  htmlEntries: number[];
  /** Module indices that are the entryPoint of a lazy (route) chunk. */
  routeEntries: number[];
}

export interface VisualizerData {
  title: string;
  /** Friendly name of the analyzed bundle directory (its basename). */
  source: string;
  generatedAt: string;
  summary: Summary;
  chunks: Record<string, ChunkMeta>;
  /** Import tree rooted at index.html (static/eager edges). */
  tree: TreeNode;
  /** Forest of dynamically-imported route bundles. */
  routes: TreeNode[];
  /** Original-module reverse import graph for chain ("why loaded") analysis. */
  moduleGraph: ModuleGraph;
}
