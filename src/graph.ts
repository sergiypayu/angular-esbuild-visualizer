import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { HtmlEntries } from "./html-entry.ts";
import { dynamicImports, isJs, staticImports } from "./metafile.ts";
import type {
  ChunkMeta,
  EsbuildMetafile,
  EsbuildOutput,
  ModuleGraph,
  Summary,
  TreemapNode,
  TreeKind,
  TreeNode,
  VisualizerData,
} from "./types.ts";

/** esbuild import-edge kinds we keep in the module graph, packed into 2 bits. */
const MODULE_EDGE_KIND: Record<string, number> = {
  "import-statement": 0,
  "require-call": 1,
  "dynamic-import": 2,
};

/**
 * Build the interned, reversed original-module import graph + the entry-module
 * indices (split into index.html entries vs lazy-route entries). Drives the
 * client's reverse-import-chain ("why is this loaded?") analysis.
 */
function buildModuleGraph(
  meta: EsbuildMetafile,
  jsOutputs: Map<string, EsbuildOutput>,
  htmlEntryChunks: Set<string>,
): ModuleGraph {
  const paths = Object.keys(meta.inputs);
  const idxOf = new Map<string, number>(paths.map((p, i) => [p, i]));
  const importers: number[][] = paths.map(() => []);

  for (const [importerPath, input] of Object.entries(meta.inputs)) {
    const fromIdx = idxOf.get(importerPath)!;
    for (const imp of input.imports ?? []) {
      const kind = MODULE_EDGE_KIND[imp.kind];
      if (kind === undefined) continue;
      const toIdx = idxOf.get(imp.path);
      if (toIdx === undefined) continue; // external / unresolved
      importers[toIdx]!.push(fromIdx * 4 + kind);
    }
  }

  const htmlEntries: number[] = [];
  const routeEntries: number[] = [];
  for (const [file, out] of jsOutputs) {
    if (!out.entryPoint) continue;
    const idx = idxOf.get(out.entryPoint);
    if (idx === undefined) continue;
    (htmlEntryChunks.has(file) ? htmlEntries : routeEntries).push(idx);
  }

  return { paths, importers, htmlEntries, routeEntries };
}

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
 * Best-effort: find the Angular route label that triggers `import("./target")`
 * inside `importer`'s source. Returns e.g. `/blog`, `/` (empty path),
 * `(matcher)` for a custom-`UrlMatcher` route, or undefined.
 *
 * Reads the route-object key sitting just before the route's load import:
 *   - `path: "blog"`        → `/blog`
 *   - `matcher: <anything>` → `(matcher)` — a custom `UrlMatcher` is an arbitrary
 *     function that decides the path at runtime, so it can't be read statically;
 *     we only flag that the route exists rather than guess at its url.
 * The nearest such key before the import wins. `path`/`matcher` are Angular
 * Route API names, preserved through minification, so this works on prod bundles.
 */
async function routePathFor(
  importer: string,
  target: string,
  sources: SourceCache,
): Promise<string | undefined> {
  const text = await sources.read(importer);
  if (!text) return undefined;
  const impRe = new RegExp(`import\\(\\s*["'\`]\\./${escapeRe(target)}["'\`]`, "g");
  // Group 1: the value of an explicit `path:"…"`. The bare `matcher:` alternative
  // has no group, so a match with `last[1] === undefined` is a matcher route.
  const keyRe = /path\s*:\s*["'`]([^"'`]*)["'`]|matcher\s*:/g;
  for (let m = impRe.exec(text); m !== null; m = impRe.exec(text)) {
    const windowStart = Math.max(0, m.index - 600);
    const before = text.slice(windowStart, m.index);
    let last: RegExpExecArray | null = null;
    for (let pm = keyRe.exec(before); pm !== null; pm = keyRe.exec(before)) last = pm;
    keyRe.lastIndex = 0;
    if (last) return last[1] !== undefined ? "/" + last[1].replace(/^\/+/, "") : "(matcher)";
  }
  return undefined;
}

/**
 * Pick the canonical owner of each lazy chunk by **directory containment**.
 * Among a chunk's module-level `import()` callers, the owner is the one whose
 * source directory *contains* the chunk's entry module (is an ancestor dir),
 * choosing the deepest such container. e.g. `…/promo/index/index-routing.ts`
 * owns `…/promo/index/components/index.component` (its folder contains it), while
 * an incidental `…/shared/services/auth.service.ts` redirect does not — and a
 * *sibling* like `…/modules/events/…` never owns `…/modules/events-calendar/…`.
 *
 * With no container, a sole caller still owns it; otherwise (a tie between
 * containers, or several unrelated callers) the chunk is hoisted to a top-level
 * shared root with every caller referencing it.
 *
 * Returns chunk → owner chunk (or `null` to hoist). Only `import()` targets are
 * present.
 */
function ownersByProximity(
  meta: EsbuildMetafile,
  jsOutputs: Map<string, EsbuildOutput>,
  lazyChunks: Set<string>,
): Map<string, string | null> {
  const modChunk = new Map<string, string>(); // module path → containing chunk
  const chunkEntry = new Map<string, string>(); // chunk → its entry module
  for (const [file, out] of jsOutputs) {
    for (const m of Object.keys(out.inputs ?? {})) if (!modChunk.has(m)) modChunk.set(m, file);
    if (out.entryPoint) chunkEntry.set(file, out.entryPoint);
  }
  const dynImporters = new Map<string, string[]>(); // entry module → modules that import() it
  for (const [mod, input] of Object.entries(meta.inputs)) {
    for (const imp of input.imports ?? []) {
      if (imp.kind !== "dynamic-import") continue;
      const arr = dynImporters.get(imp.path);
      if (arr) arr.push(mod);
      else dynImporters.set(imp.path, [mod]);
    }
  }
  const dirOf = (p: string): string[] => { const s = p.split("/"); s.pop(); return s; };
  // a's directory is an ancestor of (or equal to) b's: a's segments prefix b's.
  const contains = (a: string[], b: string[]): boolean =>
    a.length <= b.length && a.every((seg, i) => seg === b[i]);

  const ownerOf = new Map<string, string | null>();
  for (const x of lazyChunks) {
    const ex = chunkEntry.get(x);
    let owner: string | null = null;
    if (ex !== undefined) {
      const exDir = dirOf(ex);
      let bestDepth = -1;
      const bestChunks = new Set<string>(); // deepest containing-dir callers
      const allChunks = new Set<string>(); // every resolvable caller (fallback)
      for (const m of dynImporters.get(ex) ?? []) {
        const c = modChunk.get(m);
        if (c === undefined || c === x) continue; // unresolved / self
        allChunks.add(c);
        const mDir = dirOf(m);
        if (!contains(mDir, exDir)) continue; // must contain the chunk's dir
        if (mDir.length > bestDepth) { bestDepth = mDir.length; bestChunks.clear(); bestChunks.add(c); }
        else if (mDir.length === bestDepth) bestChunks.add(c);
      }
      if (bestChunks.size === 1) owner = bestChunks.values().next().value!;
      else if (bestChunks.size === 0 && allChunks.size === 1) owner = allChunks.values().next().value!;
    }
    ownerOf.set(x, owner);
  }
  return ownerOf;
}

/**
 * Build the dynamic-route forest. Each lazy chunk is expanded **once** and
 * referenced everywhere else. It nests under its owner only when that owner is a
 * canonical lazy route (a single stable home, see {@link ownersByProximity});
 * if the owner is eager or a shared (non-route) chunk — which has no single home
 * — the chunk goes to the top level and each triggering bundle refs it. An eager
 * `import()` of a nested chunk also surfaces as a top-level ref into its route.
 */
async function buildRouteForest(
  meta: EsbuildMetafile,
  eager: Set<string>,
  jsOutputs: Map<string, EsbuildOutput>,
  sources: SourceCache,
): Promise<TreeNode[]> {
  // Chunk-level dynamic edges, grouped by importer, plus the inverse.
  const dynamic = new Map<string, string[]>();
  const importersOf = new Map<string, string[]>(); // target chunk → importer chunks
  for (const [file, out] of jsOutputs) {
    const targets = dynamicImports(out).filter((t) => jsOutputs.has(t));
    if (targets.length) dynamic.set(file, targets);
    for (const t of targets) {
      const arr = importersOf.get(t);
      if (arr) arr.push(file);
      else importersOf.set(t, [file]);
    }
  }

  const lazyChunks = new Set<string>(importersOf.keys());
  const ownerOf = ownersByProximity(meta, jsOutputs, lazyChunks);
  // The chunk a lazy chunk nests *under*, or null if it belongs at the top level.
  // We only nest under an owner that is itself a canonical lazy route — that's a
  // single, stable home. An owner that is eager or a shared (non-route) chunk has
  // no single home (it's pulled into many bundles), so the chunk goes top-level
  // and each triggering bundle refs it, rather than landing under an arbitrary one.
  const homeOf = (x: string): string | null => {
    const o = ownerOf.get(x);
    return o != null && lazyChunks.has(o) && !eager.has(o) ? o : null;
  };
  const isTopLevel = (x: string): boolean => homeOf(x) === null;

  const expanded = new Set<string>(); // lazy chunks already expanded canonically
  const refNode = (
    file: string,
    edge: "static" | "dynamic",
    reason: "seen" | "shared-eager",
    routePath?: string,
  ): TreeNode => ({
    file, kind: "ref", edge, ref: true, refReason: reason, children: [],
    ...(routePath !== undefined ? { routePath } : {}),
  });

  // Expand a lazy chunk canonically: its node, its new static closure, and its
  // nested dynamic routes (canonical when owned by the importing chunk, else ref).
  const expandLazy = async (file: string, pathSource: string | undefined): Promise<TreeNode> => {
    const routePath = pathSource !== undefined ? await routePathFor(pathSource, file, sources) : undefined;
    const node: TreeNode = {
      file, kind: "lazy", edge: "dynamic", children: [],
      ...(routePath !== undefined ? { routePath } : {}),
    };
    if (expanded.has(file)) { node.ref = true; node.refReason = "seen"; return node; }
    expanded.add(file);

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
        if (eager.has(target)) { parent.children.push(refNode(target, "static", "shared-eager")); continue; }
        if (localOwner.has(target)) { parent.children.push(refNode(target, "static", "seen")); continue; }
        const child: TreeNode = { file: target, kind: "eager", edge: "static", children: [] };
        parent.children.push(child);
        localOwner.add(target);
        localNode.set(target, child);
        localQueue.push(target);
      }
    }

    for (const owned of localOwner) {
      for (const target of dynamic.get(owned) ?? []) {
        if (homeOf(target) === owned) node.children.push(await expandLazy(target, owned));
        else node.children.push(refNode(target, "dynamic", "seen", await routePathFor(owned, target, sources)));
      }
    }
    return node;
  };

  const roots: TreeNode[] = [];

  // Canonical top-level roots: every chunk without a lazy-route home (eager-,
  // shared-, or hoisted-owner). The label is read from the owner's source (the
  // routing file that defines it), falling back to any importer otherwise. A
  // root not owned by the eager app has no single route owner → mark it `shared`
  // so the client groups it below the real routes.
  for (const x of lazyChunks) {
    if (!isTopLevel(x)) continue;
    const o = ownerOf.get(x);
    const node = await expandLazy(x, o ?? importersOf.get(x)?.[0]);
    if (!(o != null && eager.has(o))) node.shared = true;
    roots.push(node);
  }

  // Top-level refs: an eager chunk `import()`s a chunk that a lazy route owns —
  // surface that trigger here, jumping into the route where it's expanded.
  const refDone = new Set<string>();
  for (const [importer, targets] of dynamic) {
    if (!eager.has(importer)) continue;
    for (const target of targets) {
      if (isTopLevel(target) || refDone.has(target)) continue;
      refDone.add(target);
      roots.push(refNode(target, "dynamic", "seen", await routePathFor(importer, target, sources)));
    }
  }

  // Safety net for `import()` cycles: a chunk whose owner-chain never reaches a
  // top-level root. Hoist any still-unexpanded lazy chunk so nothing is lost.
  for (const x of lazyChunks) {
    if (!expanded.has(x)) {
      const node = await expandLazy(x, importersOf.get(x)?.[0]);
      node.shared = true;
      roots.push(node);
    }
  }

  // Real routes first (by path), then the shared/no-owner chunks (by size).
  const routeRoots = roots.filter((r) => !r.shared)
    .sort((a, b) => (a.routePath ?? "~").localeCompare(b.routePath ?? "~"));
  const sharedRoots = roots.filter((r) => r.shared)
    .sort((a, b) => (jsOutputs.get(b.file)?.bytes ?? 0) - (jsOutputs.get(a.file)?.bytes ?? 0));
  return routeRoots.concat(sharedRoots);
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
  const routes = await buildRouteForest(meta, eager, jsOutputs, sources);

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

  const moduleGraph = buildModuleGraph(meta, jsOutputs, entrySet);

  return {
    title: opts.title,
    source: basename(resolve(opts.dir)) || opts.dir,
    generatedAt: new Date().toISOString(),
    summary,
    chunks,
    tree,
    routes,
    moduleGraph,
  };
}
