import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HtmlEntries } from "./html-entry.ts";
import { dynamicImports, isJs, staticImports } from "./metafile.ts";
import type {
  ChunkMeta,
  EsbuildMetafile,
  EsbuildOutput,
  Summary,
  TreemapNode,
  TreeKind,
  TreeNode,
  VisualizerData,
} from "./types.ts";

export interface BuildOptions {
  title: string;
  /** Bundle directory (used to read chunk sources for best-effort route paths). */
  dir: string;
  /** Max original-module names shown in a chunk's `[...]` label. */
  topModules: number;
}

/** Friendly short name for an input module path (file basename). */
function shortName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/** Build the `[mod-a, mod-b, …]` label and total module count for a chunk. */
function chunkLabel(out: EsbuildOutput, top: number): { label: string[]; moduleCount: number } {
  const inputs = out.inputs ?? {};
  const entries = Object.entries(inputs).sort(
    (a, b) => b[1].bytesInOutput - a[1].bytesInOutput,
  );
  const label = entries.slice(0, top).map(([p]) => shortName(p));
  if (entries.length > top) label.push(`…(+${entries.length - top})`);
  return { label, moduleCount: entries.length };
}

/** Nest a chunk's input modules into a hierarchy for the treemap (by path segments). */
function buildContents(file: string, out: EsbuildOutput): TreemapNode {
  const root: TreemapNode = { name: file, children: [] };
  for (const [path, { bytesInOutput }] of Object.entries(out.inputs ?? {})) {
    if (bytesInOutput <= 0) continue;
    const segments = path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const isLeaf = i === segments.length - 1;
      if (isLeaf) {
        (node.children ??= []).push({ name: seg, value: bytesInOutput });
      } else {
        let child = (node.children ??= []).find((c) => c.name === seg && c.children);
        if (!child) {
          child = { name: seg, children: [] };
          node.children.push(child);
        }
        node = child;
      }
    }
  }
  return root;
}

function makeChunkMeta(
  file: string,
  out: EsbuildOutput,
  entrySet: Set<string>,
  preloadSet: Set<string>,
  top: number,
): ChunkMeta {
  const { label, moduleCount } = chunkLabel(out, top);
  return {
    file,
    bytes: out.bytes,
    label: label.length ? label : [file],
    moduleCount,
    entryPoint: out.entryPoint,
    isEntryHtml: entrySet.has(file),
    isModulePreload: preloadSet.has(file),
    inEager: false, // filled in after the eager BFS
    contents: buildContents(file, out),
  };
}

/**
 * BFS from the index.html roots over static edges, producing a tree + the eager
 * set. Both the `<script>` entries and the `modulepreload` hints are seeded as
 * top-level roots: esbuild lists exactly the chunks the entries statically
 * import, so the browser fetches them up front, and they belong beside the
 * scripts rather than buried under whichever entry happens to import them. A
 * preload that an entry also imports then renders as a back-reference there.
 */
function buildEagerTree(
  entries: string[],
  preloads: string[],
  jsOutputs: Map<string, EsbuildOutput>,
): { tree: TreeNode; eager: Set<string> } {
  const owner = new Set<string>(); // chunks already placed in the tree
  const nodeOf = new Map<string, TreeNode>();
  const queue: string[] = [];

  const root: TreeNode = { file: "index.html", kind: "html", children: [] };

  const seed = (file: string, kind: TreeKind): void => {
    if (!jsOutputs.has(file) || owner.has(file)) return;
    const node: TreeNode = { file, kind, edge: "html", children: [] };
    root.children.push(node);
    nodeOf.set(file, node);
    owner.add(file);
    queue.push(file);
  };

  for (const entry of entries) seed(entry, "entry");
  for (const preload of preloads) seed(preload, "eager");

  while (queue.length) {
    const file = queue.shift()!;
    const parent = nodeOf.get(file)!;
    const out = jsOutputs.get(file);
    if (!out) continue;
    for (const target of staticImports(out)) {
      if (!jsOutputs.has(target)) continue;
      if (owner.has(target)) {
        parent.children.push({
          file: target,
          kind: "ref",
          edge: "static",
          ref: true,
          refReason: "seen",
          children: [],
        });
        continue;
      }
      const child: TreeNode = { file: target, kind: "eager", edge: "static", children: [] };
      parent.children.push(child);
      nodeOf.set(target, child);
      owner.add(target);
      queue.push(target);
    }
  }

  return { tree: root, eager: owner };
}

/** Cache of bundle source files read for best-effort route-path extraction. */
class SourceCache {
  private readonly cache = new Map<string, string | null>();
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  async read(file: string): Promise<string | null> {
    if (this.cache.has(file)) return this.cache.get(file)!;
    let text: string | null = null;
    try {
      text = await readFile(join(this.dir, file), "utf-8");
    } catch {
      text = null;
    }
    this.cache.set(file, text);
    return text;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Best-effort: find the Angular route `path` that triggers `import("./target")`
 * inside `importer`'s source. Returns e.g. `/blog`, `/` (empty path), or undefined.
 * Works on unminified (dev) bundles; silently gives up otherwise.
 */
async function routePathFor(
  importer: string,
  target: string,
  sources: SourceCache,
): Promise<string | undefined> {
  const text = await sources.read(importer);
  if (!text) return undefined;
  const impRe = new RegExp(`import\\(\\s*["'\`]\\./${escapeRe(target)}["'\`]`, "g");
  const pathRe = /path\s*:\s*["'`]([^"'`]*)["'`]/g;
  for (let m = impRe.exec(text); m !== null; m = impRe.exec(text)) {
    const windowStart = Math.max(0, m.index - 600);
    const before = text.slice(windowStart, m.index);
    let last: RegExpExecArray | null = null;
    for (let pm = pathRe.exec(before); pm !== null; pm = pathRe.exec(before)) last = pm;
    pathRe.lastIndex = 0;
    if (last) {
      const seg = last[1]!;
      return "/" + seg.replace(/^\/+/, "");
    }
  }
  return undefined;
}

/**
 * Build the dynamic-route forest. Every `import()` reachable from the eager app
 * becomes a route root; its subtree shows the lazy chunk's own static closure
 * (chunks already loaded eagerly are shown as shared-refs) plus nested routes.
 */
async function buildRouteForest(
  eager: Set<string>,
  jsOutputs: Map<string, EsbuildOutput>,
  sources: SourceCache,
): Promise<TreeNode[]> {
  // All dynamic edges, grouped by importer.
  const dynamic = new Map<string, string[]>();
  for (const [file, out] of jsOutputs) {
    const targets = dynamicImports(out).filter((t) => jsOutputs.has(t));
    if (targets.length) dynamic.set(file, targets);
  }

  const expanded = new Set<string>(); // lazy chunks whose subtree was already emitted

  const buildLazySubtree = async (
    file: string,
    importer: string,
  ): Promise<TreeNode> => {
    const routePath = await routePathFor(importer, file, sources);
    const node: TreeNode = {
      file,
      kind: "lazy",
      edge: "dynamic",
      children: [],
      ...(routePath !== undefined ? { routePath } : {}),
    };
    if (expanded.has(file)) {
      node.ref = true;
      node.refReason = "seen";
      return node;
    }
    expanded.add(file);

    // Static closure that is *new* for this lazy bundle.
    const localOwner = new Set<string>([file]);
    const localQueue: string[] = [file];
    const localNode = new Map<string, TreeNode>([[file, node]]);
    while (localQueue.length) {
      const cur = localQueue.shift()!;
      const parent = localNode.get(cur)!;
      const out = jsOutputs.get(cur);
      if (!out) continue;
      for (const target of staticImports(out)) {
        if (!jsOutputs.has(target)) continue;
        if (eager.has(target)) {
          parent.children.push({
            file: target,
            kind: "ref",
            edge: "static",
            ref: true,
            refReason: "shared-eager",
            children: [],
          });
          continue;
        }
        if (localOwner.has(target)) {
          parent.children.push({
            file: target,
            kind: "ref",
            edge: "static",
            ref: true,
            refReason: "seen",
            children: [],
          });
          continue;
        }
        const child: TreeNode = { file: target, kind: "eager", edge: "static", children: [] };
        parent.children.push(child);
        localOwner.add(target);
        localNode.set(target, child);
        localQueue.push(target);
      }
    }

    // Nested dynamic routes from this bundle and everything statically pulled with it.
    for (const owned of localOwner) {
      for (const target of dynamic.get(owned) ?? []) {
        node.children.push(await buildLazySubtree(target, owned));
      }
    }
    return node;
  };

  // Roots: dynamic imports that fire from the eager (already-booted) app.
  const roots: TreeNode[] = [];
  for (const [importer, targets] of dynamic) {
    if (!eager.has(importer)) continue;
    for (const target of targets) {
      roots.push(await buildLazySubtree(target, importer));
    }
  }
  roots.sort((a, b) => (a.routePath ?? "~").localeCompare(b.routePath ?? "~"));
  return roots;
}

export async function buildModel(
  meta: EsbuildMetafile,
  html: HtmlEntries,
  opts: BuildOptions,
): Promise<VisualizerData> {
  const jsOutputs = new Map<string, EsbuildOutput>();
  for (const [file, out] of Object.entries(meta.outputs)) {
    if (isJs(file)) jsOutputs.set(file, out);
  }

  const entrySet = new Set(html.scripts.filter((f) => jsOutputs.has(f)));
  const preloadSet = new Set(html.modulePreloads.filter((f) => jsOutputs.has(f)));

  const chunks: Record<string, ChunkMeta> = {};
  for (const [file, out] of jsOutputs) {
    chunks[file] = makeChunkMeta(file, out, entrySet, preloadSet, opts.topModules);
  }

  const entries = html.scripts.filter((f) => jsOutputs.has(f));
  const preloads = html.modulePreloads.filter((f) => jsOutputs.has(f));
  const { tree, eager } = buildEagerTree(entries, preloads, jsOutputs);
  for (const file of eager) {
    const c = chunks[file];
    if (c) c.inEager = true;
  }

  const sources = new SourceCache(opts.dir);
  const routes = await buildRouteForest(eager, jsOutputs, sources);

  // Summary.
  let totalJsBytes = 0;
  let staticEdgeCount = 0;
  let dynamicEdgeCount = 0;
  for (const [, out] of jsOutputs) {
    totalJsBytes += out.bytes;
    staticEdgeCount += staticImports(out).length;
    dynamicEdgeCount += dynamicImports(out).length;
  }
  let eagerJsBytes = 0;
  for (const file of eager) eagerJsBytes += jsOutputs.get(file)?.bytes ?? 0;

  const summary: Summary = {
    totalJsBytes,
    eagerJsBytes,
    lazyJsBytes: totalJsBytes - eagerJsBytes,
    jsChunkCount: jsOutputs.size,
    eagerChunkCount: eager.size,
    lazyChunkCount: jsOutputs.size - eager.size,
    dynamicEdgeCount,
    staticEdgeCount,
  };

  return {
    title: opts.title,
    generatedAt: new Date().toISOString(),
    summary,
    chunks,
    tree,
    routes,
  };
}
