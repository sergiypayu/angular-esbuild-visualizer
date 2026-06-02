/* Client for angular-esbuild-visualizer. Consumes window.__VIZ__ (see types.ts). */
(function () {
  "use strict";
  var DATA = window.__VIZ__;
  var chunks = DATA.chunks;

  // ---- helpers ----------------------------------------------------------
  function fmtBytes(n) {
    if (n == null) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function meta(file) {
    return chunks[file] || { file: file, bytes: 0, label: [file], moduleCount: 0, contents: { name: file, children: [] } };
  }
  function hashHue(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return ((h % 360) + 360) % 360;
  }
  function groupColor(path) {
    var parts = path.split("/").filter(Boolean);
    var key = parts[0] || path;
    var nm = parts.indexOf("node_modules");
    if (nm >= 0 && parts[nm + 1]) {
      key = parts[nm + 1][0] === "@" && parts[nm + 2] ? parts[nm + 1] + "/" + parts[nm + 2] : parts[nm + 1];
    } else if (parts.length > 1) {
      key = parts[0] + "/" + parts[1];
    }
    return "hsl(" + hashHue(key) + ",55%,62%)";
  }

  // ---- summary ----------------------------------------------------------
  var s = DATA.summary;
  var statRow = document.getElementById("stats");
  function stat(label, value) {
    var d = el("div", "stat");
    d.appendChild(el("b", null, value));
    d.appendChild(el("span", null, label));
    return d;
  }
  statRow.appendChild(stat("JS chunks", String(s.jsChunkCount)));
  var eagerStat = stat("eager initial", fmtBytes(s.eagerJsBytes) + " · " + s.eagerChunkCount);
  eagerStat.className = "stat clickable";
  eagerStat.title = "Show what fills the eager initial bundle";
  eagerStat.addEventListener("click", function () { selectEagerBundle(); });
  statRow.appendChild(eagerStat);
  statRow.appendChild(stat("lazy", fmtBytes(s.lazyJsBytes) + " · " + s.lazyChunkCount));
  statRow.appendChild(stat("total JS", fmtBytes(s.totalJsBytes)));
  statRow.appendChild(stat("dynamic imports", String(s.dynamicEdgeCount)));

  // ---- tree rendering (lazy: children built on first expand) ------------
  var maxBytes = 1;
  Object.keys(chunks).forEach(function (k) { if (chunks[k].bytes > maxBytes) maxBytes = chunks[k].bytes; });

  var treePane = document.getElementById("tree");
  var search = document.getElementById("search");
  var selectedRow = null;
  var roots = [DATA.tree];        // current forest (model nodes)
  var currentView = "tree";       // "tree" | "routes" — which forest is shown
  // How deep to auto-expand on (re)render: tree view opens index.html only
  // (its root children visible but collapsed); routes view stays fully collapsed.
  var autoExpandDepth = 1;

  function badges(node, m) {
    var frag = document.createDocumentFragment();
    if (node.ref) {
      var shared = node.refReason === "shared-eager";
      var b = el("span", "badge jump " + (shared ? "shared" : "ref"), shared ? "shared" : "ref");
      b.title = "Jump to where " + node.file + " is expanded";
      b.addEventListener("click", function (ev) { ev.stopPropagation(); revealCanonical(node.file); });
      frag.appendChild(b);
      return frag;
    }
    if (m.isEntryHtml) frag.appendChild(el("span", "badge entry", "entry"));
    if (m.isModulePreload) frag.appendChild(el("span", "badge preload", "preload"));
    if (node.kind === "lazy") frag.appendChild(el("span", "badge lazy", "lazy"));
    else if (node.kind !== "html") frag.appendChild(el("span", "badge eager", "eager"));
    return frag;
  }

  function buildRow(node) {
    var m = meta(node.file);
    var row = el("div", "row");
    var hasChildren = node.children && node.children.length > 0;
    var toggle = el("span", "toggle" + (hasChildren ? "" : " leaf"), hasChildren ? "▶" : "•");
    row.appendChild(toggle);
    if (node.routePath) row.appendChild(el("span", "route-path", node.routePath));
    var nameCls = "fname " + (node.ref ? "ref" : node.kind === "lazy" ? "lazy" : node.kind === "entry" ? "entry" : "");
    row.appendChild(el("span", nameCls, (node.ref ? "↪ " : "") + node.file));
    row.appendChild(badges(node, m));
    if (!node.ref && node.file !== "index.html") {
      var bar = el("span", "bar");
      bar.style.width = Math.max(3, Math.round((m.bytes / maxBytes) * 70)) + "px";
      row.appendChild(bar);
      row.appendChild(el("span", "size", fmtBytes(m.bytes)));
    }
    if (m.label && m.label.length && node.file !== "index.html") row.appendChild(el("span", "label", "[" + m.label.join(", ") + "]"));
    row._node = node;
    row.addEventListener("click", function () {
      if (selectedRow) selectedRow.classList.remove("selected");
      selectedRow = row; row.classList.add("selected");
      selectChunk(node.file);
    });
    return { row: row, toggle: toggle, hasChildren: hasChildren };
  }

  function populate(wrap) {
    if (wrap._populated) return;
    wrap._populated = true;
    var node = wrap._node, depth = wrap._depth;
    node.children.forEach(function (c) { wrap._kids.appendChild(renderNode(c, depth + 1)); });
  }

  function renderNode(node, depth) {
    var wrap = el("div", "node");
    var built = buildRow(node);
    wrap.appendChild(built.row);
    wrap._node = node; wrap._depth = depth; wrap._toggle = built.toggle;

    if (built.hasChildren) {
      var kids = el("div", "children collapsed");
      wrap._kids = kids;
      wrap.appendChild(kids);
      var expanded = depth < autoExpandDepth;
      if (expanded) { kids.classList.remove("collapsed"); built.toggle.textContent = "▼"; populate(wrap); }
      built.toggle.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var nowCollapsed = kids.classList.contains("collapsed");
        if (nowCollapsed) { populate(wrap); kids.classList.remove("collapsed"); built.toggle.textContent = "▼"; }
        else { kids.classList.add("collapsed"); built.toggle.textContent = "▶"; }
      });
    }
    return wrap;
  }

  function renderForest() {
    treePane.innerHTML = "";
    if (!roots.length) { treePane.appendChild(el("div", "empty", "Nothing to show.")); return; }
    roots.forEach(function (r) { treePane.appendChild(renderNode(r, 0)); });
    selectedRow = null;
  }

  function expandWrap(wrap) {
    if (!wrap._kids) return;
    populate(wrap);
    wrap._kids.classList.remove("collapsed");
    if (wrap._toggle) wrap._toggle.textContent = "▼";
    Array.prototype.forEach.call(wrap._kids.children, expandWrap);
  }
  function expandAll() { Array.prototype.forEach.call(treePane.children, expandWrap); }
  function collapseAll() {
    treePane.querySelectorAll(".children").forEach(function (k) {
      k.classList.add("collapsed");
      var t = k.parentElement.querySelector(".toggle");
      if (t && !t.classList.contains("leaf")) t.textContent = "▶";
    });
  }

  // ---- jump from a back-reference (ref/shared badge) to the chunk's --------
  //      canonical, fully-expanded node, revealing it in the tree.
  // A file has exactly one non-ref node per forest; eager chunks live in the
  // tree view, lazy chunks in the routes view. Find it, switch view if needed,
  // expand its ancestors, then select + scroll to it.
  function findPath(forestRoots, file) {
    var found = null;
    function dfs(node, trail) {
      trail.push(node);
      if (node.file === file && !node.ref) found = trail.slice();
      else for (var i = 0; i < node.children.length && !found; i++) dfs(node.children[i], trail);
      trail.pop();
    }
    for (var i = 0; i < forestRoots.length && !found; i++) dfs(forestRoots[i], []);
    return found;
  }
  function childWrapFor(container, node) {
    for (var i = 0; i < container.children.length; i++) {
      if (container.children[i]._node === node) return container.children[i];
    }
    return null;
  }
  function openWrap(wrap) {
    if (!wrap._kids) return;
    populate(wrap);
    wrap._kids.classList.remove("collapsed");
    if (wrap._toggle) wrap._toggle.textContent = "▼";
  }
  function revealCanonical(file) {
    var view = "tree", path = findPath([DATA.tree], file);
    if (!path) { path = findPath(DATA.routes, file); view = "routes"; }
    if (!path) return;
    // The DOM walk below needs the right forest, unfiltered and freshly laid out.
    if (search.value) { search.value = ""; activate(view); }
    else if (view !== currentView) activate(view);

    var container = treePane, wrap = null;
    for (var i = 0; i < path.length; i++) {
      wrap = childWrapFor(container, path[i]);
      if (!wrap) return; // tree changed under us; give up quietly
      if (i < path.length - 1) { openWrap(wrap); container = wrap._kids; }
    }
    var row = wrap.firstElementChild; // the node's own .row
    if (selectedRow) selectedRow.classList.remove("selected");
    selectedRow = row; row.classList.add("selected");
    selectChunk(file);
    row.scrollIntoView({ block: "center" });
    row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
  }

  // ---- search over the data model (finds not-yet-rendered nodes) --------
  function hay(node, m) {
    return (node.file + " " + (node.routePath || "") + " " + (m.label || []).join(" ") + " " + (m.entryPoint || "")).toLowerCase();
  }
  function filterRender(node, depth, q) {
    var m = meta(node.file);
    var selfMatch = hay(node, m).indexOf(q) >= 0;
    var childEls = [];
    (node.children || []).forEach(function (c) {
      var e = filterRender(c, depth + 1, q);
      if (e) childEls.push(e);
    });
    if (!selfMatch && childEls.length === 0) return null;
    if (childEls.length === 0) return renderNode(node, depth); // self-only: keep lazy/expandable
    var wrap = el("div", "node");
    var built = buildRow(node);
    wrap.appendChild(built.row);
    if (built.toggle) built.toggle.textContent = "▼";
    var kids = el("div", "children");
    childEls.forEach(function (e) { kids.appendChild(e); });
    wrap.appendChild(kids);
    return wrap;
  }
  function applySearch(q) {
    q = q.trim().toLowerCase();
    if (!q) { renderForest(); return; }
    treePane.innerHTML = "";
    var any = false;
    roots.forEach(function (r) {
      var e = filterRender(r, 0, q);
      if (e) { treePane.appendChild(e); any = true; }
    });
    if (!any) treePane.appendChild(el("div", "empty", "No matches for “" + q + "”."));
  }

  // ---- detail pane (chunk contents treemap) -----------------------------
  var detail = document.getElementById("detail");
  var tip = document.getElementById("tip");

  function sumValue(node) {
    if (node.value != null) return node.value;
    var t = 0; (node.children || []).forEach(function (c) { t += sumValue(c); }); node._v = t; return t;
  }
  function squarify(node, x, y, w, h, out, pathPrefix) {
    var children = node.children;
    if (!children || !children.length) {
      out.push({ name: node.name, path: pathPrefix, value: node.value || node._v || 0, x: x, y: y, w: w, h: h });
      return;
    }
    var items = children.map(function (c) { return { node: c, v: (c.value != null ? c.value : c._v) }; })
      .filter(function (i) { return i.v > 0; })
      .sort(function (a, b) { return b.v - a.v; });
    var total = items.reduce(function (a, i) { return a + i.v; }, 0);
    if (total <= 0) return;
    var rectX = x, rectY = y, rectW = w, rectH = h, i = 0;
    while (i < items.length) {
      var shortSide = Math.min(rectW, rectH);
      var best = Infinity, curRow = [], curSum = 0, j = i;
      while (j < items.length) {
        var trySum = curSum + items[j].v;
        var ratio = worstRatio(curRow.concat([items[j]]).map(function (it) { return it.v; }), trySum, shortSide, total, rectW * rectH);
        if (ratio <= best || curRow.length === 0) { best = ratio; curRow.push(items[j]); curSum = trySum; j++; }
        else break;
      }
      var row = curRow, rowSum = curSum; i = j;
      var frac = rowSum / total;
      if (rectW >= rectH) {
        var colW = frac * rectW, oy = rectY;
        row.forEach(function (it) { var hh = (it.v / rowSum) * rectH; squarify(it.node, rectX, oy, colW, hh, out, pathPrefix + "/" + it.node.name); oy += hh; });
        rectX += colW; rectW -= colW;
      } else {
        var rowH = frac * rectH, ox = rectX;
        row.forEach(function (it) { var ww = (it.v / rowSum) * rectW; squarify(it.node, ox, rectY, ww, rowH, out, pathPrefix + "/" + it.node.name); ox += ww; });
        rectY += rowH; rectH -= rowH;
      }
      total -= rowSum;
    }
  }
  function worstRatio(areas, sum, side, total, fullArea) {
    var scale = fullArea / Math.max(total, 1);
    var rowLen = (sum * scale) / Math.max(side, 1);
    var worst = 0;
    for (var k = 0; k < areas.length; k++) {
      var a = areas[k] * scale, w = a / Math.max(rowLen, 1e-6);
      var r = Math.max(rowLen / Math.max(w, 1e-6), w / Math.max(rowLen, 1e-6));
      if (r > worst) worst = r;
    }
    return worst;
  }
  function drawTreemap(container, contents) {
    container.innerHTML = "";
    sumValue(contents);
    var W = Math.max(300, container.clientWidth - 2), H = 420, rects = [];
    squarify(contents, 0, 0, W, H, rects, contents.name);
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "treemap"); svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("width", W); svg.setAttribute("height", H);
    rects.forEach(function (r) {
      if (r.w < 0.5 || r.h < 0.5) return;
      var rect = document.createElementNS(ns, "rect");
      rect.setAttribute("x", r.x); rect.setAttribute("y", r.y);
      rect.setAttribute("width", Math.max(0, r.w - 1)); rect.setAttribute("height", Math.max(0, r.h - 1));
      rect.setAttribute("fill", groupColor(r.path));
      rect.addEventListener("mousemove", function (ev) {
        tip.style.display = "block";
        tip.textContent = r.path.replace(/^[^/]*\//, "") + "  —  " + fmtBytes(r.value);
        // Default to lower-right of the cursor; flip to the other side when the
        // tip would overflow, so it stays on-screen (right edge tucked under
        // the cursor near the right border).
        var tw = tip.offsetWidth, th = tip.offsetHeight;
        var x = ev.clientX + 12, y = ev.clientY + 12;
        if (x + tw > window.innerWidth - 4) x = ev.clientX - tw - 12;
        if (y + th > window.innerHeight - 4) y = ev.clientY - th - 12;
        tip.style.left = Math.max(4, x) + "px";
        tip.style.top = Math.max(4, y) + "px";
      });
      rect.addEventListener("mouseleave", function () { tip.style.display = "none"; });
      svg.appendChild(rect);
      if (r.w > 46 && r.h > 14) {
        var t = document.createElementNS(ns, "text");
        t.setAttribute("x", r.x + 3); t.setAttribute("y", r.y + 11);
        t.textContent = clip(r.name, Math.floor(r.w / 6));
        svg.appendChild(t);
      }
    });
    container.appendChild(svg);
  }
  function clip(str, n) { return str.length > n ? str.slice(0, Math.max(1, n - 1)) + "…" : str; }
  function flatLeaves(node, prefix, out) {
    if (node.value != null) { out.push({ path: (prefix ? prefix + "/" : "") + node.name, bytes: node.value }); return; }
    (node.children || []).forEach(function (c) { flatLeaves(c, (prefix ? prefix + "/" : "") + node.name, out); });
  }
  // Render a title + sub-line + treemap + sorted module table into the detail
  // pane. Shared by the per-chunk view and the aggregate eager-bundle view.
  function renderTreemapDetail(titleText, subText, contents) {
    detail.innerHTML = "";
    detail.appendChild(el("h2", null, titleText));
    detail.appendChild(el("div", "sub", subText));
    var tm = el("div", null); detail.appendChild(tm); drawTreemap(tm, contents);
    var leaves = []; flatLeaves(contents, "", leaves); leaves.sort(function (a, b) { return b.bytes - a.bytes; });
    var table = el("table", "mods");
    var head = el("tr"); head.appendChild(el("th", null, "module (" + leaves.length + ")")); head.appendChild(el("th", "n", "bytes")); table.appendChild(head);
    leaves.slice(0, 300).forEach(function (l) {
      var modPath = l.path.replace(/^[^/]*\//, "");
      var tr = el("tr", "mrow"); tr.title = "Why is this loaded?";
      tr.appendChild(el("td", null, modPath));
      tr.appendChild(el("td", "n", fmtBytes(l.bytes)));
      tr.addEventListener("click", function () { selectModule(modPath); });
      table.appendChild(tr);
    });
    detail.appendChild(table);
  }
  function selectChunk(file) {
    detail._eager = false; detail._module = null;
    if (file === "index.html") {
      detail.innerHTML = ""; detail._file = null;
      detail.appendChild(el("div", "empty", "index.html — synthetic root. Pick a chunk, or click “eager initial” for the bundle breakdown."));
      return;
    }
    var m = meta(file);
    var sub = fmtBytes(m.bytes) + " · " + m.moduleCount + " module" + (m.moduleCount === 1 ? "" : "s")
      + (m.entryPoint ? " · entry: " + m.entryPoint : "") + (m.inEager ? " · eager" : " · lazy");
    renderTreemapDetail(m.file, sub, m.contents);
    detail._file = file;
  }

  // Merge every eager chunk's original-module hierarchy into one tree so the
  // treemap shows the whole initial bundle's content (by package/path), not
  // just one chunk. Directory nodes merge by name; module leaves are unique
  // per output, so their sizes simply accumulate.
  function mergeInto(target, children) {
    (children || []).forEach(function (child) {
      target.children = target.children || [];
      if (child.children) {
        var dir = null;
        for (var i = 0; i < target.children.length; i++) {
          if (target.children[i].name === child.name && target.children[i].children) { dir = target.children[i]; break; }
        }
        if (!dir) { dir = { name: child.name, children: [] }; target.children.push(dir); }
        mergeInto(dir, child.children);
      } else {
        target.children.push({ name: child.name, value: child.value });
      }
    });
  }
  function eagerContents() {
    var root = { name: "eager bundle", children: [] };
    Object.keys(chunks).forEach(function (file) {
      if (chunks[file].inEager) mergeInto(root, chunks[file].contents.children);
    });
    return root;
  }
  function selectEagerBundle() {
    detail._eager = true; detail._file = null; detail._module = null;
    if (selectedRow) { selectedRow.classList.remove("selected"); selectedRow = null; }
    var contents = eagerContents();
    var leaves = []; flatLeaves(contents, "", leaves);
    var attributed = leaves.reduce(function (a, l) { return a + l.bytes; }, 0);
    var sub = fmtBytes(s.eagerJsBytes) + " across " + s.eagerChunkCount + " chunks · "
      + leaves.length + " modules · " + fmtBytes(attributed) + " attributed to source";
    renderTreemapDetail("Eager initial bundle", sub, contents);
  }

  // ---- "why is this module loaded?" — reverse import-chain analysis ------
  var MG = DATA.moduleGraph || { paths: [], importers: [], htmlEntries: [], routeEntries: [] };
  var KINDNAME = ["import", "require", "dynamic"];
  var pathIdx = null;     // module path -> index
  var moduleLoc = null;   // module path -> { chunks:[file], bytes }
  var htmlStop = null, routeStop = null, allStop = null;
  function ensureModuleIndex() {
    if (pathIdx) return;
    pathIdx = {};
    for (var i = 0; i < MG.paths.length; i++) pathIdx[MG.paths[i]] = i;
    htmlStop = {}; MG.htmlEntries.forEach(function (n) { htmlStop[n] = true; });
    routeStop = {}; MG.routeEntries.forEach(function (n) { routeStop[n] = true; });
    allStop = {}; MG.htmlEntries.concat(MG.routeEntries).forEach(function (n) { allStop[n] = true; });
    moduleLoc = {};
    Object.keys(chunks).forEach(function (file) {
      var leaves = []; flatLeaves(chunks[file].contents, "", leaves);
      leaves.forEach(function (l) {
        var p = l.path.replace(/^[^/]*\//, "");
        var e = moduleLoc[p] || (moduleLoc[p] = { chunks: [], bytes: 0 });
        e.chunks.push(file); e.bytes += l.bytes;
      });
    });
  }
  function importersOf(idx) {
    return (MG.importers[idx] || []).map(function (n) { return { idx: n >> 2, kind: n & 3 }; });
  }
  // Shortest reverse path (over import/require edges, optionally crossing
  // dynamic-import) from `start` up to any module in `stop`.
  function bfsTo(start, stop, allowDynamic) {
    var seen = {}; seen[start] = true;
    var queue = [[{ idx: start, kind: -1 }]];
    while (queue.length) {
      var path = queue.shift();
      var head = path[path.length - 1].idx;
      if (stop[head]) return path;
      var imps = importersOf(head);
      for (var i = 0; i < imps.length; i++) {
        var im = imps[i];
        if (im.kind === 2 && !allowDynamic) continue;
        if (seen[im.idx]) continue;
        seen[im.idx] = true;
        queue.push(path.concat([{ idx: im.idx, kind: im.kind }]));
      }
    }
    return null;
  }
  function analyzeModule(idx) {
    var c = bfsTo(idx, htmlStop, false); if (c) return { status: "eager", chain: c };
    c = bfsTo(idx, allStop, false);      if (c) return { status: "grouped", chain: c };
    c = bfsTo(idx, allStop, true);       if (c) return { status: "lazy", chain: c };
    return { status: "orphan", chain: [{ idx: idx, kind: -1 }] };
  }
  var STATUS_TEXT = {
    eager: "Eager — statically imported from an index.html entry. Break a static import in this chain to drop it from the initial bundle.",
    grouped: "In an eager chunk by grouping — not statically reachable from an index.html entry; its real consumer is a lazy route, so esbuild only co-located it with eager code.",
    lazy: "Lazy — only reached by crossing a dynamic import().",
    orphan: "No import path to an entry was found.",
  };
  function shortName(p) { return p.replace(/^node_modules\//, ""); }
  function selectModule(path) {
    ensureModuleIndex();
    detail._eager = false; detail._file = null; detail._module = path;
    detail.innerHTML = "";
    detail.appendChild(el("h2", null, path.split("/").pop()));
    detail.appendChild(el("div", "sub mpath", path));
    var loc = moduleLoc[path] || { chunks: [], bytes: 0 };
    var inEager = loc.chunks.some(function (f) { return chunks[f] && chunks[f].inEager; });
    detail.appendChild(el("div", "sub", fmtBytes(loc.bytes) + " in bundle · "
      + (loc.chunks.length ? "in " + loc.chunks.join(", ") : "—") + " · " + (inEager ? "eager" : "lazy")));

    var idx = pathIdx[path];
    if (idx == null) { detail.appendChild(el("div", "muted", "Not present in the module graph.")); return; }
    var res = analyzeModule(idx);
    detail.appendChild(el("div", "why-status " + res.status, STATUS_TEXT[res.status]));

    detail.appendChild(el("div", "reasons-h", "Reverse import chain (nearest entry)"));
    var box = el("div", "mchain");
    res.chain.forEach(function (step, i) {
      var row = el("div", "mstep");
      if (i > 0) row.appendChild(el("span", "mkind" + (step.kind === 2 ? " dyn" : ""), "⟵ " + (KINDNAME[step.kind] || "")));
      var p = MG.paths[step.idx];
      var crumb = el("span", "mcrumb" + (i === 0 ? " current" : ""), shortName(p));
      if (i !== 0) crumb.addEventListener("click", function () { selectModule(p); });
      row.appendChild(crumb);
      if (i === res.chain.length - 1 && res.status !== "orphan") {
        var isHtml = htmlStop[step.idx];
        row.appendChild(el("span", "mtag " + (isHtml ? "entry" : "route"), isHtml ? "index.html entry" : "lazy route entry"));
      }
      box.appendChild(row);
    });
    detail.appendChild(box);

    var imps = importersOf(idx);
    detail.appendChild(el("div", "reasons-h", "Imported by " + imps.length + " module" + (imps.length === 1 ? "" : "s")));
    var chips = el("div", "chips");
    imps.slice(0, 60).forEach(function (im) {
      var p = MG.paths[im.idx];
      var c = el("span", "chip " + (im.kind === 2 ? "d" : "s"), KINDNAME[im.kind] + ": " + shortName(p));
      c.addEventListener("click", function () { selectModule(p); });
      chips.appendChild(c);
    });
    if (!imps.length) chips.appendChild(el("span", "muted", "none — this is an entry module"));
    detail.appendChild(chips);
  }

  // ---- tabs / toolbar ---------------------------------------------------
  var tabTree = document.getElementById("tab-tree");
  var tabRoutes = document.getElementById("tab-routes");
  function activate(which) {
    currentView = which;
    autoExpandDepth = which === "tree" ? 1 : 0; // tree: open index.html; routes: all collapsed
    tabTree.classList.toggle("active", which === "tree");
    tabRoutes.classList.toggle("active", which === "routes");
    roots = which === "tree" ? [DATA.tree] : DATA.routes;
    if (search.value) applySearch(search.value); else renderForest();
  }
  tabTree.addEventListener("click", function () { activate("tree"); });
  tabRoutes.addEventListener("click", function () { activate("routes"); });
  document.getElementById("expand-all").addEventListener("click", expandAll);
  document.getElementById("collapse-all").addEventListener("click", collapseAll);
  var searchTimer;
  search.addEventListener("input", function () { clearTimeout(searchTimer); searchTimer = setTimeout(function () { applySearch(search.value); }, 140); });
  function redrawDetail() {
    if (detail._eager) selectEagerBundle();
    else if (detail._module) selectModule(detail._module);
    else if (detail._file) selectChunk(detail._file);
  }
  window.addEventListener("resize", redrawDetail);

  // Draggable divider: let the user repartition the tree vs. detail panes.
  (function () {
    var mainEl = document.querySelector("main");
    var resizer = document.getElementById("resizer");
    var dragging = false, raf = 0;
    resizer.addEventListener("mousedown", function (ev) {
      dragging = true; resizer.classList.add("active");
      document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
      ev.preventDefault();
    });
    window.addEventListener("mousemove", function (ev) {
      if (!dragging) return;
      var rect = mainEl.getBoundingClientRect();
      var w = Math.max(280, Math.min(rect.width - 320 - 6, ev.clientX - rect.left));
      mainEl.style.gridTemplateColumns = w + "px 6px 1fr";
      if (!raf) raf = requestAnimationFrame(function () { raf = 0; redrawDetail(); });
    });
    window.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false; resizer.classList.remove("active");
      document.body.style.cursor = ""; document.body.style.userSelect = "";
      redrawDetail();
    });
  })();

  activate("tree");
  selectEagerBundle(); // land on the eager-bundle breakdown instead of an empty pane
})();
