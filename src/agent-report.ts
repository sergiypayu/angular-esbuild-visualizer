// The `--json` stdout report: the computed model reshaped for machine
// consumption (AI agents, scripts, jq). Unlike the client model it is
// self-describing — sizes are joined onto tree nodes, route download costs are
// pre-aggregated, and packed structures (the module graph) are left out in
// favor of per-chunk module lists and chunk-level import edges.

import { dynamicImports, staticImports } from "./metafile.ts";
import type { EsbuildMetafile, Summary, TreeNode, VisualizerData } from "./types.ts";

/** One original source module inside a chunk. */
export interface AgentModule {
  path: string;
  /** Bytes this module contributes to the chunk (esbuild `bytesInOutput`). */
  bytes: number;
}

export interface AgentChunk {
  bytes: number;
  /** Source module for entry chunks, e.g. `src/app/blog/blog-routing.ts`. */
  entryPoint?: string;
  /** Referenced directly by a <script> in index.html. */
  isEntryHtml: boolean;
  /** Listed as <link rel=modulepreload> in index.html. */
  isModulePreload: boolean;
  /** Part of the initial download (reachable from index.html via static imports). */
  inEager: boolean;
  moduleCount: number;
  /** JS chunks this chunk imports statically. */
  staticImports: string[];
  /** JS chunks this chunk `import()`s. */
  dynamicImports: string[];
  /** Original source modules merged into this chunk, largest first. */
  modules: AgentModule[];
}

export interface AgentTreeNode {
  file: string;
  bytes?: number;
  kind: "html" | "entry" | "eager" | "lazy" | "ref";
  edge?: "static" | "dynamic" | "html";
  routePath?: string;
  ref?: true;
  refReason?: "seen" | "shared-eager";
  children?: AgentTreeNode[];
}

/** A lazy chunk expanded canonically under another route; see `routes` there. */
export interface AgentRouteRef {
  chunk: string;
  routePath?: string;
  ref: true;
}

export interface AgentRoute {
  /** The route's entry chunk. */
  chunk: string;
  /** Best-effort Angular route path, e.g. `/blog` or `(matcher)`. */
  routePath?: string;
  /** No single owning route — fetched by every bundle that references it. */
  shared?: true;
  /** What navigating here downloads: the route's own static closure. */
  downloadBytes: number;
  /** The chunks that make up `downloadBytes`. */
  chunks: string[];
  /** Weight of already-eager deps this route shares (free at navigation). */
  sharedEagerBytes: number;
  sharedEagerChunks: string[];
  /** Nested lazy routes triggered from this bundle. */
  routes?: (AgentRoute | AgentRouteRef)[];
}

export interface AgentReport {
  tool: "angular-esbuild-visualizer";
  formatVersion: 1;
  source: string;
  generatedAt: string;
  notes: string[];
  summary: Summary;
  initial: {
    bytes: number;
    chunkCount: number;
    /** Eager import tree rooted at index.html. */
    tree: AgentTreeNode;
  };
  routes: (AgentRoute | AgentRouteRef)[];
  chunks: Record<string, AgentChunk>;
}

const NOTES: string[] = [
  "All sizes are esbuild's raw pre-gzip bytes.",
  "initial.tree is the eager import graph: every chunk the browser downloads before the app boots, reached from index.html <script>/<link rel=modulepreload> tags via static imports.",
  "A tree node with ref=true is a back-reference to a chunk expanded elsewhere in this document; refReason 'shared-eager' means the chunk is already part of the initial download, 'seen' means it is expanded under another parent.",
  "routes[] is the dynamic-import (lazy route / @defer) forest. downloadBytes is the route's own static closure — what the browser fetches on navigation — excluding chunks already in the initial download (sharedEagerBytes/sharedEagerChunks) and nested routes (routes). A non-eager chunk shared by several routes is counted in each, because each navigation really fetches it.",
  "A route with shared=true has no single owning route; entries with ref=true point at a route expanded under another root.",
  "chunks{} maps every JS chunk to its metadata; modules[] are the original source modules esbuild merged into it, largest first. staticImports/dynamicImports are chunk-level edges for walking the graph.",
];

function mapTree(node: TreeNode, data: VisualizerData): AgentTreeNode {
  const bytes = data.chunks[node.file]?.bytes;
  const out: AgentTreeNode = { file: node.file, kind: node.kind };
  if (bytes !== undefined) out.bytes = bytes;
  if (node.edge) out.edge = node.edge;
  if (node.routePath !== undefined) out.routePath = node.routePath;
  if (node.ref) { out.ref = true; out.refReason = node.refReason; }
  if (node.children.length) out.children = node.children.map((c) => mapTree(c, data));
  return out;
}

/**
 * Aggregate one lazy-route subtree the same way the client's boundary view
 * does: walk the route's own static closure (stopping at dynamic edges and
 * already-eager refs), then recurse into the nested routes hanging off it.
 */
function mapRoute(node: TreeNode, data: VisualizerData): AgentRoute | AgentRouteRef {
  if (node.ref) {
    const ref: AgentRouteRef = { chunk: node.file, ref: true };
    if (node.routePath !== undefined) ref.routePath = node.routePath;
    return ref;
  }

  const own: string[] = [];
  const ownSeen = new Set<string>();
  const sharedSeen = new Set<string>();
  const nested: (AgentRoute | AgentRouteRef)[] = [];
  const walk = (n: TreeNode): void => {
    if (!ownSeen.has(n.file)) {
      ownSeen.add(n.file);
      own.push(n.file);
    }
    for (const c of n.children) {
      if (c.edge === "dynamic") { nested.push(mapRoute(c, data)); continue; }
      if (c.ref) { if (c.refReason === "shared-eager") sharedSeen.add(c.file); continue; }
      walk(c);
    }
  };
  walk(node);

  const bytesOf = (files: Iterable<string>): number => {
    let t = 0;
    for (const f of files) t += data.chunks[f]?.bytes ?? 0;
    return t;
  };

  const route: AgentRoute = {
    chunk: node.file,
    ...(node.routePath !== undefined ? { routePath: node.routePath } : {}),
    ...(node.shared ? { shared: true as const } : {}),
    downloadBytes: bytesOf(own),
    chunks: own,
    sharedEagerBytes: bytesOf(sharedSeen),
    sharedEagerChunks: [...sharedSeen],
  };
  if (nested.length) route.routes = nested;
  return route;
}

export function buildAgentReport(data: VisualizerData, meta: EsbuildMetafile): AgentReport {
  const chunks: Record<string, AgentChunk> = {};
  for (const [file, c] of Object.entries(data.chunks)) {
    const out = meta.outputs[file];
    const modules = Object.entries(out?.inputs ?? {})
      .map(([path, i]) => ({ path, bytes: i.bytesInOutput }))
      .sort((a, b) => b.bytes - a.bytes);
    chunks[file] = {
      bytes: c.bytes,
      ...(c.entryPoint !== undefined ? { entryPoint: c.entryPoint } : {}),
      isEntryHtml: c.isEntryHtml,
      isModulePreload: c.isModulePreload,
      inEager: c.inEager,
      moduleCount: c.moduleCount,
      staticImports: out ? staticImports(out).filter((f) => f in data.chunks) : [],
      dynamicImports: out ? dynamicImports(out).filter((f) => f in data.chunks) : [],
      modules,
    };
  }

  return {
    tool: "angular-esbuild-visualizer",
    formatVersion: 1,
    source: data.source,
    generatedAt: data.generatedAt,
    notes: NOTES,
    summary: data.summary,
    initial: {
      bytes: data.summary.eagerJsBytes,
      chunkCount: data.summary.eagerChunkCount,
      tree: mapTree(data.tree, data),
    },
    routes: data.routes.map((r) => mapRoute(r, data)),
    chunks,
  };
}
